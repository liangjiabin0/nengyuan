#include "openTEPES.hpp"

#include <chrono>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <numeric>

double tp(const TEPES& m, const std::string& k, double def) {
    auto it = m.pThermalParams.find(k);
    return it == m.pThermalParams.end() ? def : it->second;
}
double dcp(const TEPES& m, const std::string& k, double def) {
    auto it = m.pDCParams.find(k);
    return it == m.pDCParams.end() ? def : it->second;
}

static void banner(const char* title) {
    std::cout << "\n------------------------------------------------------------\n";
    std::cout << title << "\n";
    std::cout << "------------------------------------------------------------\n";
}

static void kv(const char* key, const std::string& val) {
    std::ios saved(nullptr);
    saved.copyfmt(std::cout);
    std::cout << "  " << std::left << std::setw(34) << key << " ... " << val << "\n";
    std::cout.copyfmt(saved);
}

static double wind_pu(double v_ref) {
    const double a = 0.1893, vin = 2.4243, vr = 10.6489, vo = 25.0, K = 1.7398;
    double vh = v_ref * std::pow(30.0 / 10.0, a);
    if (vh < vin || vh > vo) return 0.0;
    if (vh >= vin && vh < vr) return std::pow((vh - vin) / (vr - vin), K);
    return 1.0;
}
static double pv_pu(double dni, double dhi, double temp) {
    double poa = std::max(0.0, dni * 0.95 + dhi * 0.8);
    double tcell = temp + poa / 29.0;
    double p = 1.15 * (poa / 1000.0) * (1.0 - 0.0043 * (tcell - 25.0)) * 0.989;
    return std::min(1.0, std::max(0.0, p));
}

void InputData_poi(TEPES& M, const std::string& DirName, const std::string& CaseName, int log) {
    std::cout << "Input data                             ****\n";
    auto t0 = std::chrono::high_resolution_clock::now();
    M.dir = DirName;
    M.case_name = CaseName;
    M.path = DirName + "/" + CaseName;
    const std::string P = M.path + "/";
    const std::string C = CaseName;

    auto dfOpt = read_csv(P + "oT_Data_Option_" + C + ".csv");
    auto dfPar = read_csv(P + "oT_Data_Parameter_" + C + ".csv");
    auto dfDem = read_csv(P + "oT_Data_Demand_" + C + ".csv");
    auto dfPri = read_csv(P + "oT_Data_ElectricityPrice_" + C + ".csv");
    auto dfGen = read_csv(P + "oT_Data_Generation_" + C + ".csv");
    auto dfLoc = read_csv(P + "oT_Data_NodeLocation_" + C + ".csv");
    auto dfNet = read_csv(P + "oT_Data_Network_" + C + ".csv");
    auto dfLL = read_csv(P + "oT_Dict_LoadLevel_" + C + ".csv");

    // Option row 0
    auto optv = [&](const std::string& k) { return to_d(dfOpt.at(0, k)); };
    M.pIndBinGenInvest = (int)optv("IndBinGenInvest");
    M.pIndBinNetInvest = (int)optv("IndBinNetInvest");
    M.pIndBinNetLosses = (int)optv("IndBinNetLosses");
    M.pIndBinGenRamps = (int)optv("IndBinGenRamps");
    M.pIndBinGenMinTime = (int)optv("IndBinGenMinTime");
    M.enable_ev = (int)optv("EVPlanning");
    M.enable_an = (int)optv("ANPlanning");
    M.enable_thermal = (int)optv("ThermalPlanning");
    M.enable_dc = (int)optv("DCPlanning");
    for (auto& h : dfOpt.header) M.pOption[h] = to_d(dfOpt.at(0, h));
    M.pIndBinGenRetire = 2;
    M.pIndBinGenOperat = 0;
    M.pIndBinSingleNode = 0;
    M.pIndBinLineCommit = 0;

    M.pENSCost = to_d(dfPar.at(0, "ENSCost")) * 1e3;
    M.pCO2Cost = to_d(dfPar.at(0, "CO2Cost"));
    M.pAnnualDiscRate = to_d(dfPar.at(0, "AnnualDiscountRate"));
    M.pSBase = to_d(dfPar.at(0, "SBase"), 1.0) * 1e-3;
    M.pReferenceNode = dfPar.at(0, "ReferenceNode");
    if (M.pReferenceNode.empty()) M.pReferenceNode = "Node1";
    M.pTimeStep = (int)to_d(dfPar.at(0, "TimeStep"), 1);
    M.pOffGridState = to_d(dfPar.at(0, "OffGridState"));
    M.pOffGridHour = to_d(dfPar.at(0, "OffGridHour"));

    // nodes
    int name_col = dfLoc.ncol("") >= 0 ? 0 : 0;  // first column is node name (often empty header)
    for (int r = 0; r < (int)dfLoc.rows.size(); ++r) {
        std::string nm = dfLoc.at(r, 0);
        if (nm.empty()) continue;
        M.nd_id[nm] = (int)M.nd_name.size();
        M.nd_name.push_back(nm);
    }
    M.ND = (int)M.nd_name.size();
    std::vector<double> lat(M.ND), lon(M.ND);
    int clat = dfLoc.ncol("Latitude"), clon = dfLoc.ncol("Longitude");
    for (int r = 0; r < (int)dfLoc.rows.size(); ++r) {
        int nd = M.find_nd(dfLoc.at(r, 0));
        if (nd < 0) continue;
        lat[nd] = to_d(dfLoc.at(r, clat));
        lon[nd] = to_d(dfLoc.at(r, clon));
    }

    // load levels
    for (int r = 0; r < (int)dfLL.rows.size(); ++r) {
        std::string nm = dfLL.at(r, 0);
        M.n_id[nm] = (int)M.n_name.size();
        M.n_name.push_back(nm);
    }
    M.T = (int)M.n_name.size();
    if (M.T == 0) {
        for (int r = 0; r < (int)dfDem.rows.size(); ++r) {
            std::string nm = dfDem.at(r, "LoadLevel");
            if (M.n_id.count(nm)) continue;
            M.n_id[nm] = (int)M.n_name.size();
            M.n_name.push_back(nm);
        }
        M.T = (int)M.n_name.size();
    }
    if (!dfDem.rows.empty()) {
        M.period = dfDem.at(0, "Period");
        M.scenario = dfDem.at(0, "Scenario");
        try {
            M.period_year = std::stoi(M.period);
        } catch (...) {
            M.period_year = 2025;
        }
    }

    M.pDuration.assign(M.T, (double)M.pTimeStep);
    M.pLoadLevelWeight.assign(M.T, 1.0);
    M.pLoadLevelDuration.assign(M.T, (double)M.pTimeStep);
    M.pDiscountFactor = 1.0;
    M.pScenProb = 1.0;

    // generators
    int gname_c = 0;
    for (int r = 0; r < (int)dfGen.rows.size(); ++r) {
        std::string nm = dfGen.at(r, 0);
        M.g_id[nm] = (int)M.g_name.size();
        M.g_name.push_back(nm);
    }
    M.G = (int)M.g_name.size();
    auto gcol = [&](const std::string& k) { return dfGen.ncol(k); };
    M.pGenToNode.assign(M.G, 0);
    M.pGenToTechnology.assign(M.G, "");
    M.pMustRun.assign(M.G, 0);
    M.pIndBinUnitInvest.assign(M.G, 0);
    M.pIndBinUnitCommit.assign(M.G, 1);
    M.pIndOperReserve.assign(M.G, 0);
    M.pRatedMinPower.assign(M.G, 0);
    M.pRatedMaxPower.assign(M.G, 0);
    M.pLinearVarCost.assign(M.G, 0);
    M.pLinearOMCost.assign(M.G, 0);
    M.pLinearOperCost.assign(M.G, 0);
    M.pConstantVarCost.assign(M.G, 0);
    M.pOperReserveCost.assign(M.G, 0);
    M.pStartUpCost.assign(M.G, 0);
    M.pShutDownCost.assign(M.G, 0);
    M.pCO2EmissionCost.assign(M.G, 0);
    M.pCO2EmissionRate.assign(M.G, 0);
    M.pGenInvestCost.assign(M.G, 0);
    M.pGenRetireCost.assign(M.G, 0);
    M.pRatedMinCharge.assign(M.G, 0);
    M.pRatedMaxCharge.assign(M.G, 0);
    M.pRatedMinStorage.assign(M.G, 0);
    M.pRatedMaxStorage.assign(M.G, 0);
    M.pInitialInventory.assign(M.G, 0);
    M.pEfficiency.assign(M.G, 1);
    M.pAvailability.assign(M.G, 1);
    M.pCycleTimeStep.assign(M.G, 1);
    M.pPeriodIniGen.assign(M.G, 2020);
    M.pPeriodFinGen.assign(M.G, 2100);

    for (int r = 0; r < (int)dfGen.rows.size(); ++r) {
        int g = M.find_g(dfGen.at(r, 0));
        if (g < 0) continue;
        std::string node = dfGen.at(r, "Node");
        int nd = M.find_nd(node);
        M.pGenToNode[g] = nd < 0 ? 0 : nd;
        M.pGenToTechnology[g] = dfGen.at(r, "Technology");
        double efor = to_d(dfGen.at(r, "EFOR"));
        M.pRatedMinPower[g] = to_d(dfGen.at(r, "MinimumPower")) * 1e-3 * (1.0 - efor);
        M.pRatedMaxPower[g] = to_d(dfGen.at(r, "MaximumPower")) * 1e-3 * (1.0 - efor);
        double fuel = to_d(dfGen.at(r, "FuelCost"));
        double lin = to_d(dfGen.at(r, "LinearTerm"));
        double om = to_d(dfGen.at(r, "OMVariableCost"));
        double cst = to_d(dfGen.at(r, "ConstantTerm"));
        M.pLinearOMCost[g] = om * 1e3;
        double fuelc = lin * 1e3 * fuel;
        M.pCO2EmissionRate[g] = to_d(dfGen.at(r, "CO2EmissionRate"));
        M.pCO2EmissionCost[g] = M.pCO2EmissionRate[g] * 1e-3 * M.pCO2Cost;
        M.pLinearOperCost[g] = fuelc + M.pCO2EmissionCost[g];
        M.pLinearVarCost[g] = fuelc + M.pLinearOMCost[g];
        M.pConstantVarCost[g] = cst * 1e3 * fuel;
        M.pOperReserveCost[g] = to_d(dfGen.at(r, "OperReserveCost")) * 1e3;
        M.pStartUpCost[g] = to_d(dfGen.at(r, "StartUpCost"));
        M.pShutDownCost[g] = to_d(dfGen.at(r, "ShutDownCost"));
        double life = to_d(dfGen.at(r, "Lifetime"));
        double fcr = to_d(dfGen.at(r, "FixedChargeRate"));
        if (life > 0) {
            double dr = 0.04;
            fcr = (dr * std::pow(1 + dr, life)) / (std::pow(1 + dr, life) - 1.0);
        }
        M.pGenInvestCost[g] = to_d(dfGen.at(r, "FixedInvestmentCost")) * 1e3 * fcr;
        M.pGenRetireCost[g] = to_d(dfGen.at(r, "FixedRetirementCost")) * fcr;
        M.pRatedMinCharge[g] = to_d(dfGen.at(r, "MinimumCharge")) * 1e-3;
        M.pRatedMaxCharge[g] = to_d(dfGen.at(r, "MaximumCharge")) * 1e-3;
        M.pRatedMinStorage[g] = to_d(dfGen.at(r, "MinimumStorage")) * 1e-3;
        M.pRatedMaxStorage[g] = to_d(dfGen.at(r, "MaximumStorage")) * 1e-3;
        M.pInitialInventory[g] = to_d(dfGen.at(r, "InitialStorage")) * 1e-3;
        M.pEfficiency[g] = to_d(dfGen.at(r, "Efficiency"), 1.0);
        if (M.pEfficiency[g] <= 0) M.pEfficiency[g] = 1.0;
        M.pAvailability[g] = to_d(dfGen.at(r, "Availability"), 1.0);
        if (M.pAvailability[g] == 0) M.pAvailability[g] = 1.0;
        M.pMustRun[g] = yesno(dfGen.at(r, "MustRun"));
        M.pIndBinUnitInvest[g] = yesno(dfGen.at(r, "BinaryInvestment"));
        std::string bc = dfGen.at(r, "BinaryCommitment");
        M.pIndBinUnitCommit[g] = bc.empty() ? 1 : yesno(bc);
        M.pIndOperReserve[g] = yesno(dfGen.at(r, "NoOperatingReserve"));
        M.pPeriodIniGen[g] = (int)to_d(dfGen.at(r, "InitialPeriod"), 2020);
        M.pPeriodFinGen[g] = (int)to_d(dfGen.at(r, "FinalPeriod"), 2100);
    }

    // demand [t][nd] GW
    M.pDemand.assign(M.T, std::vector<double>(M.ND, 0.0));
    for (int r = 0; r < (int)dfDem.rows.size(); ++r) {
        int t = 0;
        auto it = M.n_id.find(dfDem.at(r, "LoadLevel"));
        if (it == M.n_id.end()) continue;
        t = it->second;
        for (int nd = 0; nd < M.ND; ++nd) {
            int c = dfDem.ncol(M.nd_name[nd]);
            if (c >= 0) M.pDemand[t][nd] = to_d(dfDem.at(r, c)) * 1e-3;
        }
    }
    M.pPrice.assign(M.T, 0.0);
    for (int r = 0; r < (int)dfPri.rows.size(); ++r) {
        auto it = M.n_id.find(dfPri.at(r, "LoadLevel"));
        if (it == M.n_id.end()) continue;
        M.pPrice[it->second] = to_d(dfPri.at(r, "Price")) * 1e6;
    }

    // variable max power MW then GW
    std::vector<std::vector<double>> vmax(M.T, std::vector<double>(M.G, std::numeric_limits<double>::quiet_NaN()));
    std::string wfile = P + "oT_Data_WeatherData_" + C + ".csv";
    if (file_exists(wfile)) {
        auto dfW = read_csv(wfile);
        int cw = dfW.ncol("wind_speed_10m (m/s)");
        int cdni = dfW.ncol("direct_radiation (W/m2)");
        int cdhi = dfW.ncol("diffuse_radiation (W/m2)");
        int ct = dfW.ncol("temperature_2m");
        for (int g = 0; g < M.G; ++g) {
            double cap = M.pRatedMaxPower[g] * 1e3;  // MW
            auto tech = M.pGenToTechnology[g];
            for (int r = 0; r < (int)dfW.rows.size() && r < M.T; ++r) {
                if (tech == "Wind")
                    vmax[r][g] = std::max(1e-5, wind_pu(to_d(dfW.at(r, cw))) * cap);
                else if (tech == "PV")
                    vmax[r][g] = std::max(1e-5, pv_pu(to_d(dfW.at(r, cdni)), to_d(dfW.at(r, cdhi)), to_d(dfW.at(r, ct))) * cap);
            }
        }
        if (log) std::cout << "Weather: physical power models         ****\n";
    } else {
        auto dfV = read_csv(P + "oT_Data_VariableMaxGeneration_" + C + ".csv");
        bool tech_cols = dfV.ncol("PV") >= 0 || dfV.ncol("Wind") >= 0;
        for (int r = 0; r < (int)dfV.rows.size(); ++r) {
            auto it = M.n_id.find(dfV.at(r, "LoadLevel"));
            if (it == M.n_id.end()) continue;
            int t = it->second;
            for (int g = 0; g < M.G; ++g) {
                double cap_mw = M.pRatedMaxPower[g] * 1e3;
                if (tech_cols) {
                    auto tech = M.pGenToTechnology[g];
                    int c = dfV.ncol(tech);
                    if (c >= 0 && (tech == "PV" || tech == "Wind" || tech == "Hydro"))
                        vmax[t][g] = to_d(dfV.at(r, c)) * cap_mw;
                } else {
                    int c = dfV.ncol(M.g_name[g]);
                    if (c >= 0) vmax[t][g] = to_d(dfV.at(r, c)) * cap_mw;
                }
            }
        }
        if (log) std::cout << "Weather: VariableMaxGeneration CSV     ****\n";
    }

    M.pMinPower.assign(M.T, std::vector<double>(M.G, 0));
    M.pMaxPower.assign(M.T, std::vector<double>(M.G, 0));
    M.pMinCharge.assign(M.T, std::vector<double>(M.G, 0));
    M.pMaxCharge.assign(M.T, std::vector<double>(M.G, 0));
    M.pMinStorage.assign(M.T, std::vector<double>(M.G, 0));
    M.pMaxStorage.assign(M.T, std::vector<double>(M.G, 0));
    M.pIniInventory_t.assign(M.T, std::vector<double>(M.G, 0));
    M.pEnergyInflows.assign(M.T, std::vector<double>(M.G, 0));
    M.pEnergyOutflows.assign(M.T, std::vector<double>(M.G, 0));
    M.pMaxPower2ndBlock.assign(M.T, std::vector<double>(M.G, 0));
    M.pMaxCharge2ndBlock.assign(M.T, std::vector<double>(M.G, 0));

    for (int t = 0; t < M.T; ++t) {
        for (int g = 0; g < M.G; ++g) {
            double mn = M.pRatedMinPower[g];
            double mx = M.pRatedMaxPower[g];
            double vm = vmax[t][g];
            if (!std::isnan(vm) && vm > 0) {
                double vgw = vm * 1e-3;
                if (vgw < mx) mx = vgw;
            }
            if (mx < 0) mx = 0;
            M.pMinPower[t][g] = mn;
            M.pMaxPower[t][g] = mx;
            M.pMaxPower2ndBlock[t][g] = std::max(0.0, mx - mn);
            M.pMinCharge[t][g] = M.pRatedMinCharge[g];
            M.pMaxCharge[t][g] = M.pRatedMaxCharge[g];
            M.pMaxCharge2ndBlock[t][g] = std::max(0.0, M.pMaxCharge[t][g] - M.pMinCharge[t][g]);
            M.pMinStorage[t][g] = M.pRatedMinStorage[g];
            M.pMaxStorage[t][g] = M.pRatedMaxStorage[g];
            M.pIniInventory_t[t][g] = M.pInitialInventory[g];
        }
    }

    // subsets
    int p0 = 2025;
    try {
        p0 = std::stoi(M.period);
    } catch (...) {
    }
    for (int g = 0; g < M.G; ++g) {
        if ((M.pRatedMaxPower[g] > 0 || M.pRatedMaxCharge[g] > 0) && M.pPeriodIniGen[g] <= p0 &&
            M.pPeriodFinGen[g] >= p0) {
            M.g.push_back(g);
        }
    }
    for (int g : M.g) {
        if (M.pLinearOperCost[g] > 0) M.t_th.push_back(g);
        if (M.pLinearOperCost[g] == 0 && M.pRatedMaxStorage[g] == 0) M.r.push_back(g);
        if (M.pRatedMaxStorage[g] > 0 && M.pRatedMaxCharge[g] > 0) M.es.push_back(g);
        if (M.pGenInvestCost[g] > 0) M.gc.push_back(g);
        if (M.pGenRetireCost[g] != 0) M.gd.push_back(g);
    }
    for (int g : M.es)
        if (M.pGenInvestCost[g] > 0) M.ec.push_back(g);
    for (int g : M.g)
        if (!M.is_r(g)) M.nr.push_back(g);

    for (int g : M.g) {
        M.n2g.push_back({M.pGenToNode[g], g});
        M.n2g_set.insert(((long long)M.pGenToNode[g] << 32) | (unsigned)g);
    }

    // network
    auto net_first = [&](int r) { return dfNet.at(r, 0); };
    for (int r = 0; r < (int)dfNet.rows.size(); ++r) {
        int ni = M.find_nd(dfNet.at(r, 0));
        int nf = M.find_nd(dfNet.at(r, 1));
        if (ni < 0 || nf < 0) continue;
        LineKey lk{ni, nf, 0};
        double X = to_d(dfNet.at(r, "Reactance"));
        double ttc = to_d(dfNet.at(r, "TTC"));
        double sf = to_d(dfNet.at(r, "SecurityFactor"), 1.0);
        double ttcb = dfNet.ncol("TTCBck") >= 0 ? to_d(dfNet.at(r, "TTCBck")) : -ttc;
        double frw = ttc * 1e-3 * sf;
        double bck = ttcb * 1e-3 * sf;
        if (bck <= 0) bck = frw;
        if (frw <= 0) frw = bck;
        if (X == 0 || frw <= 0 || bck <= 0) continue;
        M.la.push_back(lk);
        M.pLineX.push_back(X);
        M.pLineLossFactor.push_back(to_d(dfNet.at(r, "LossFactor")));
        M.pLineNTCFrw.push_back(frw);
        M.pLineNTCBck.push_back(std::abs(bck));
        M.pNetFixedCost.push_back(to_d(dfNet.at(r, "FixedInvestmentCost")) * to_d(dfNet.at(r, "FixedChargeRate")));
        double L = to_d(dfNet.at(r, "Length"));
        if (L <= 0) {
            double dlat = (lat[nf] - lat[ni]) * kPi / 180.0;
            double dlon = (lon[nf] - lon[ni]) * kPi / 180.0;
            double a = std::sin(dlat / 2) * std::sin(dlat / 2) +
                       std::cos(lat[ni] * kPi / 180) * std::cos(lat[nf] * kPi / 180) * std::sin(dlon / 2) *
                           std::sin(dlon / 2);
            L = 1.1 * 6371.0 * 2 * std::asin(std::sqrt(a));
        }
        M.pLineLength.push_back(L);
        M.pLineType.push_back(dfNet.at(r, "LineType"));
        M.pIndBinLineSwitch.push_back(yesno(dfNet.at(r, "Switching")));
        M.pIndBinLineInvest.push_back(dfNet.at(r, "BinaryInvestment").empty() ? 1 : yesno(dfNet.at(r, "BinaryInvestment")));
        M.pPeriodIniNet.push_back((int)to_d(dfNet.at(r, "InitialPeriod"), 2020));
        M.pPeriodFinNet.push_back((int)to_d(dfNet.at(r, "FinalPeriod"), 2050));
        M.pBigMFlowFrw.push_back(frw > 0 ? frw : 1.0);
        M.pBigMFlowBck.push_back(std::abs(bck) > 0 ? std::abs(bck) : 1.0);
    }
    M.LA = (int)M.la.size();
    for (int l = 0; l < M.LA; ++l) {
        if (M.pNetFixedCost[l] > 0) M.lc.push_back(M.la[l]);
        else M.le.push_back(M.la[l]);
        if (M.pLineLossFactor[l] > 0 && M.pIndBinNetLosses > 0) M.ll.push_back(M.la[l]);
        if (M.pIndBinLineSwitch[l] == 0 && M.pLineType[l] != "DC" && M.pNetFixedCost[l] == 0) M.lea.push_back(M.la[l]);
        if ((M.pIndBinLineSwitch[l] == 1 || M.pNetFixedCost[l] > 0) && M.pLineType[l] != "DC") M.lca.push_back(M.la[l]);
    }
    M.laa = M.lea;
    for (auto& x : M.lca) {
        bool dup = false;
        for (auto& y : M.laa)
            if (y.ni == x.ni && y.nf == x.nf && y.cc == x.cc) dup = true;
        if (!dup) M.laa.push_back(x);
    }
    M.lout.assign(M.ND, {});
    M.lin.assign(M.ND, {});
    for (int l = 0; l < M.LA; ++l) {
        M.lout[M.la[l].ni].push_back(l);
        M.lin[M.la[l].nf].push_back(l);
    }
    for (int nd = 0; nd < M.ND; ++nd)
        if (M.nd_name[nd] == M.pReferenceNode) M.rf.push_back(nd);
    if (M.rf.empty() && M.ND) M.rf.push_back(0);
    M.pMaxTheta.assign(M.ND, kPi / 2);

    M.gt_name = {"Grid", "Wind", "Hydro", "PV", "Battery", "Diesel"};

    auto t1 = std::chrono::high_resolution_clock::now();
    std::cout << "Reading    input data                  ... "
              << (int)std::chrono::duration<double>(t1 - t0).count() << " s\n";
}

void SettingUpVariables_poi(TEPES& M) {
    auto& m = *M.model;
    int T = M.T, G = M.G, ND = M.ND, LA = M.LA;
    M.vTotalFCost = add_var(m, 0, kInf, VariableDomain::Continuous, "vTotalFCost");
    M.vTotalGCost.resize(T);
    M.vTotalCCost.resize(T);
    M.vTotalECost.resize(T);
    M.vTotalRCost.resize(T);
    M.vTotalAbandonCost.resize(T);
    for (int t = 0; t < T; ++t) {
        M.vTotalGCost[t] = add_var(m, -kInf, kInf, VariableDomain::Continuous, "vGCost_" + std::to_string(t));
        M.vTotalCCost[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "vCCost_" + std::to_string(t));
        M.vTotalECost[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "vECost_" + std::to_string(t));
        M.vTotalRCost[t] = add_var(m, -1e-8, 1e7, VariableDomain::Continuous, "vRCost_" + std::to_string(t));
        M.vTotalAbandonCost[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "vACost_" + std::to_string(t));
    }
    M.vTotalOutput.resize(T * G);
    M.vTotalOutputAbs.resize(T * G);
    M.vOutput2ndBlock.resize(T * G);
    M.vReserveUp.resize(T * G);
    M.vReserveDown.resize(T * G);
    M.vCommitment.resize(T * G);
    M.vStartUp.resize(T * G);
    M.vShutDown.resize(T * G);
    M.vEnergyOutflows.resize(T * G);
    M.vESSInventory.resize(T * G);
    M.vESSSpillage.resize(T * G);
    M.vESSTotalCharge.resize(T * G);
    M.vESSChargeState.resize(T * G);
    M.vESSDischargeState.resize(T * G);
    M.vCharge2ndBlock.resize(T * G);
    M.vESSReserveUp.resize(T * G);
    M.vESSReserveDown.resize(T * G);
    M.vENS.resize(T * ND);
    M.vPloss.resize(T * ND);
    M.vTheta.resize(T * ND);
    M.vFlow.resize(T * std::max(LA, 1));
    M.vLineCommit.resize(T * std::max(LA, 1));

    auto cont = VariableDomain::Continuous;
    auto bin = VariableDomain::Binary;
    for (int t = 0; t < T; ++t) {
        for (int g = 0; g < G; ++g) {
            int k = M.idx_tg(t, g);
            M.vTotalOutput[k] = add_var(m, M.pMinPower[t][g], M.pMaxPower[t][g], cont, "P_" + std::to_string(t) + "_" + std::to_string(g));
            M.vTotalOutputAbs[k] = add_var(m, 0, M.pMaxPower[t][g], cont, "Pabs_" + std::to_string(k));
            M.vOutput2ndBlock[k] = add_var(m, 0, M.pMaxPower2ndBlock[t][g], cont, "P2_" + std::to_string(k));
            M.vReserveUp[k] = add_var(m, 0, M.pMaxPower2ndBlock[t][g], cont, "Ru_" + std::to_string(k));
            M.vReserveDown[k] = add_var(m, 0, M.pMaxPower2ndBlock[t][g], cont, "Rd_" + std::to_string(k));
            M.vCommitment[k] = add_var(m, 0, 1, cont, "u_" + std::to_string(k));
            M.vStartUp[k] = add_var(m, 0, 1, cont, "su_" + std::to_string(k));
            M.vShutDown[k] = add_var(m, 0, 1, cont, "sd_" + std::to_string(k));
            M.vEnergyOutflows[k] = add_var(m, 0, std::max(M.pMaxPower[t][g], M.pMaxCharge[t][g]), cont, "out_" + std::to_string(k));
            M.vESSInventory[k] = add_var(m, 0, M.pMaxStorage[t][g], cont, "soc_" + std::to_string(k));
            M.vESSSpillage[k] = add_var(m, 0, 0, cont, "spil_" + std::to_string(k));
            M.vESSTotalCharge[k] = add_var(m, 0, M.pMaxCharge[t][g], cont, "ch_" + std::to_string(k));
            M.vESSChargeState[k] = add_var(m, 0, 1, bin, "uch_" + std::to_string(k));
            M.vESSDischargeState[k] = add_var(m, 0, 1, bin, "udis_" + std::to_string(k));
            M.vCharge2ndBlock[k] = add_var(m, 0, M.pMaxCharge2ndBlock[t][g], cont, "ch2_" + std::to_string(k));
            M.vESSReserveUp[k] = add_var(m, 0, M.pMaxCharge2ndBlock[t][g], cont, "esru_" + std::to_string(k));
            M.vESSReserveDown[k] = add_var(m, 0, M.pMaxCharge2ndBlock[t][g], cont, "esrd_" + std::to_string(k));
            if (M.pMaxPower[t][g] == 0) m.set_variable_bounds(M.vTotalOutput[k], 0, 0);
            if (M.is_nr(g) && (M.pMustRun[g] == 1 || (M.pMinPower[t][g] == 0 && M.pConstantVarCost[g] == 0) || M.is_es(g))) {
                m.set_variable_bounds(M.vCommitment[k], 1, 1);
                m.set_variable_bounds(M.vStartUp[k], 0, 0);
                m.set_variable_bounds(M.vShutDown[k], 0, 0);
            }
            if (M.pMaxPower2ndBlock[t][g] == 0) {
                m.set_variable_bounds(M.vOutput2ndBlock[k], 0, 0);
                m.set_variable_bounds(M.vReserveUp[k], 0, 0);
                m.set_variable_bounds(M.vReserveDown[k], 0, 0);
            }
            if (M.pIndOperReserve[g] != 0) {
                m.set_variable_bounds(M.vReserveUp[k], 0, 0);
                m.set_variable_bounds(M.vReserveDown[k], 0, 0);
                m.set_variable_bounds(M.vESSReserveUp[k], 0, 0);
                m.set_variable_bounds(M.vESSReserveDown[k], 0, 0);
            }
            if (M.pMaxCharge[t][g] == 0) m.set_variable_bounds(M.vESSTotalCharge[k], 0, 0);
            if (M.pMaxStorage[t][g] == 0) m.set_variable_bounds(M.vESSInventory[k], 0, 0);
        }
        for (int nd = 0; nd < ND; ++nd) {
            int k = M.idx_tnd(t, nd);
            M.vENS[k] = add_var(m, 0, std::max(0.0, M.pDemand[t][nd]), cont, "ens_" + std::to_string(k));
            M.vPloss[k] = add_var(m, 0, std::max(0.0, -M.pDemand[t][nd]), cont, "ploss_" + std::to_string(k));
            M.vTheta[k] = add_var(m, -M.pMaxTheta[nd], M.pMaxTheta[nd], cont, "th_" + std::to_string(k));
            if (M.pDemand[t][nd] <= 0) m.set_variable_bounds(M.vENS[k], 0, 0);
        }
        for (int nd : M.rf) m.set_variable_bounds(M.vTheta[M.idx_tnd(t, nd)], 0, 0);
        for (int l = 0; l < LA; ++l) {
            int k = M.idx_tla(t, l);
            M.vFlow[k] = add_var(m, -M.pLineNTCBck[l], M.pLineNTCFrw[l], cont, "f_" + std::to_string(k));
            M.vLineCommit[k] = add_var(m, 1, 1, cont, "lc_" + std::to_string(k));  // existing non-switchable
        }
    }
    M.vGenerationInvest.resize(M.G);
    for (int g = 0; g < G; ++g) {
        if (M.is_gc(g) && M.pIndBinGenInvest != 2)
            M.vGenerationInvest[g] = add_var(m, 0, 1, cont, "inv_" + M.g_name[g]);
        else
            M.vGenerationInvest[g] = add_var(m, 0, 0, cont, "inv0_" + std::to_string(g));
    }
    M.vGenerationRetire.resize(M.G);
    for (int g = 0; g < G; ++g) M.vGenerationRetire[g] = add_var(m, 0, 0, cont, "ret_" + std::to_string(g));
    M.vNetworkInvest.resize(std::max(LA, 1));
    for (int l = 0; l < std::max(LA, 1); ++l) M.vNetworkInvest[l] = add_var(m, 0, 0, bin, "ninv_" + std::to_string(l));

    // last ESS inventory = initial
    for (int g : M.es) {
        int k = M.idx_tg(T - 1, g);
        m.set_variable_bounds(M.vESSInventory[k], M.pInitialInventory[g], M.pInitialInventory[g]);
    }
}

void EVplan_inputdata(TEPES& M, const std::string& DirName, const std::string& CaseName, int) {
    std::cout << "Input EV data                          ****\n";
    auto df = read_csv(M.path + "/oT_Data_EV_" + CaseName + ".csv");
    int T = M.T;
    M.ev_arrivals.assign(T, 0);
    M.ev_visit.assign(T, 0);
    M.ev_init_soc.assign(T, 0);
    M.ev_tgt_soc.assign(T, 0);
    M.ev_node_col.assign(T, "Node3");
    std::unordered_set<std::string> nodes;
    for (int r = 0; r < (int)df.rows.size(); ++r) {
        auto it = M.n_id.find(df.at(r, "LoadLevel"));
        if (it == M.n_id.end()) continue;
        int t = it->second;
        M.ev_arrivals[t] = to_i(df.at(r, "arrivals"));
        M.ev_visit[t] = to_i(df.at(r, "visit_time"));
        M.ev_init_soc[t] = to_d(df.at(r, "initial_soc")) / 100.0;
        M.ev_tgt_soc[t] = to_d(df.at(r, "target_soc")) / 100.0;
        M.ev_node_col[t] = df.at(r, "node");
        if (!M.ev_node_col[t].empty()) nodes.insert(M.ev_node_col[t]);
    }
    M.ev_nodes.assign(nodes.begin(), nodes.end());
    M.P_ELEC_CHR.resize(T);
    M.P_ELEC_DIS.resize(T);
    for (int t = 0; t < T; ++t) {
        int h = t % 24;
        double p = (h < 8) ? 0.3 : ((h < 14 || (h >= 17 && h < 20)) ? 0.6 : 1.2);
        M.P_ELEC_CHR[t] = p;
        M.P_ELEC_DIS[t] = (p >= 1.0) ? 1.5 : 0.4;
    }
    M.demand_energy_per_ev.resize(T);
    M.target_energy_per_cohort.resize(T);
    M.initial_energy_per_cohort.resize(T);
    M.naive_demand_curve.resize(T);
    for (int t = 0; t < T; ++t) {
        M.demand_energy_per_ev[t] = std::max(0.0, (M.ev_tgt_soc[t] - M.ev_init_soc[t]) * M.E_BATT_MAX);
        M.target_energy_per_cohort[t] = M.ev_arrivals[t] * M.ev_tgt_soc[t] * M.E_BATT_MAX;
        M.initial_energy_per_cohort[t] = M.ev_arrivals[t] * M.ev_init_soc[t] * M.E_BATT_MAX;
        M.naive_demand_curve[t] = (M.target_energy_per_cohort[t] - M.initial_energy_per_cohort[t]) / M.EFF_CHR;
    }
    auto& m = *M.model;
    M.N_pile = add_var(m, 0, 1e6, VariableDomain::Integer, "N_pile");
    M.grid_p_chr.assign(T, {});
    M.grid_p_dis.assign(T, {});
    for (int t = 0; t < T; ++t) {
        int V = M.ev_visit[t];
        if (V == 0 || M.ev_arrivals[t] == 0) continue;
        TEPES::EVCohortVars c;
        c.t = t;
        c.V = V;
        int endk = std::min(T, t + V);
        for (int k = t; k < endk; ++k) {
            auto pc = add_var(m, 0, kInf, VariableDomain::Continuous, "Pchr_" + std::to_string(t) + "_" + std::to_string(k));
            auto pd = add_var(m, 0, kInf, VariableDomain::Continuous, "Pdis_" + std::to_string(t) + "_" + std::to_string(k));
            c.P_chr.push_back(pc);
            c.P_dis.push_back(pd);
            M.grid_p_chr[k].push_back(pc);
            M.grid_p_dis[k].push_back(pd);
            ExprBuilder e1;
            e1 += pc;
            add_le(m, e1, M.ev_arrivals[t] * M.P_CHR_MAX);
            ExprBuilder e2;
            e2 += pd;
            add_le(m, e2, M.ev_arrivals[t] * M.P_CHR_MAX * M.ENABLE_V2G);
        }
        for (int k = t; k <= endk; ++k) {
            auto e = add_var(m, 0, M.ev_arrivals[t] * M.E_BATT_MAX, VariableDomain::Continuous,
                             "Eev_" + std::to_string(t) + "_" + std::to_string(k));
            c.E.push_back(e);
        }
        M.ev_cohorts.push_back(std::move(c));
    }
}

void inputdata_ammonia(TEPES& M, const std::string& DirName, const std::string& CaseName) {
    M.params_ammonia = {{"price_grid", 0.3},
                        {"cost_elec", 400.0},
                        {"cost_nh3", 500.0},
                        {"price_h2", 20.0},
                        {"price_nh3", 4.0},
                        {"rate_h2_prod", 0.0188},
                        {"min_elec_load", 0.057},
                        {"rate_nh3_h2_in", 0.33},
                        {"rate_nh3_prod", 1.84},
                        {"min_nh3_load", 0.30},
                        {"constant_load", 0.0},
                        {"max_annual_cost", 1e7}};
    M.eh_node = "Node2";
    std::ofstream f(M.path + "/oT_Data_H2AnParameter_" + CaseName + ".csv");
    f << "Parameter,Value\n";
    for (auto& par : M.params_ammonia) f << par.first << "," << par.second << "\n";
    f << "eh_node," << M.eh_node << "\n";
    banner("Ammonia input");
    kv("Saved", "oT_Data_H2AnParameter_" + CaseName + ".csv");
}

void ThermalInputData_poi(TEPES& M, const std::string& DirName, const std::string& CaseName, int log) {
    std::cout << "Thermal input data                     ****\n";
    M.ht_node = "Node2";
    auto dfT = read_csv(M.path + "/oT_Data_ThermalDemand_" + CaseName + ".csv");
    M.pThermalDemand.assign(M.T, 0.0);
    int cN = dfT.ncol("Node1");
    if (cN < 0) cN = 3;
    for (int r = 0; r < (int)dfT.rows.size(); ++r) {
        auto it = M.n_id.find(dfT.at(r, "LoadLevel"));
        if (it == M.n_id.end()) continue;
        M.pThermalDemand[it->second] = to_d(dfT.at(r, cN));
    }
    auto dfP = read_csv(M.path + "/oT_Data_ThermalParameter_" + CaseName + ".csv");
    for (int r = 0; r < (int)dfP.rows.size(); ++r)
        M.pThermalParams[dfP.at(r, "Parameter")] = to_d(dfP.at(r, "Value"));
    M.pThermalCapacityUnit = 0.01;
    M.pChillerDemand.assign(M.T, 0.0);
    std::string cf = M.path + "/oT_Data_ChillerDemand_" + CaseName + ".csv";
    if (file_exists(cf)) {
        auto dfC = read_csv(cf);
        int c = dfC.ncol("Node1");
        if (c < 0) c = 3;
        for (int r = 0; r < (int)dfC.rows.size(); ++r) {
            auto it = M.n_id.find(dfC.at(r, "LoadLevel"));
            if (it == M.n_id.end()) continue;
            M.pChillerDemand[it->second] = to_d(dfC.at(r, c));
        }
    }
    if (log) {
        double mn = 1e99, mx = -1e99;
        for (double x : M.pThermalDemand) {
            mn = std::min(mn, x);
            mx = std::max(mx, x);
        }
        kv("Time steps", std::to_string(M.T));
        kv("Heat demand min", std::to_string(mn) + " MW");
        kv("Heat demand max", std::to_string(mx) + " MW");
    }
}

void DC_inputdata(TEPES& M, const std::string& DirName, const std::string& CaseName, int log) {
    M.pDCParams = {{"srv_exist_q", 0},
                   {"srv_max_q", 10000},
                   {"idle_p_kw", 0.35},
                   {"peak_p_kw", 0.7},
                   {"srv_lambda_max", 10000},
                   {"cool_exist_q_kw", 0},
                   {"beta_1", 1.05},
                   {"beta_2_kw", 4.0},
                   {"cool_max_q_kw", 3000},
                   {"delay_max_h", 7},
                   {"srv_inv_cny_per_unit", 8000},
                   {"cool_inv_cny_per_kw", 1500},
                   {"srv_opex_cny_per_kwh", 0.08},
                   {"cool_opex_cny_per_kwh", 0.10},
                   {"cpu_temp_enable", 1},
                   {"cpu_R_K_per_W", 0.35},
                   {"cpu_C_J_per_K", 340},
                   {"cpu_T_ini_K", 318},
                   {"cpu_T_max_K", 343.15},
                   {"cpu_T_in_K", 298.15},
                   {"indoor_temp_enable", 1},
                   {"dc_R_C_per_kW", 1.9},
                   {"dc_C_kWh_per_C", 16.19},
                   {"dc_T_in_ini_C", 20},
                   {"dc_T_in_min_C", 15},
                   {"dc_T_in_max_C", 25},
                   {"dc_r_in_min_C_per_h", -5},
                   {"dc_r_in_max_C_per_h", 5},
                   {"kappa_IT_kwth_per_kw", 1.0}};
    M.lambda_inter.assign(M.T, 0);
    M.lambda_batch.assign(M.T, 0);
    M.p_other_kw.assign(M.T, 0);
    M.t_out_C.assign(M.T, 20);
    auto df = read_csv(M.path + "/oT_Data_DCWorkload_" + CaseName + ".csv");
    for (int r = 0; r < (int)df.rows.size(); ++r) {
        auto it = M.n_id.find(df.at(r, "LoadLevel"));
        if (it == M.n_id.end()) continue;
        M.lambda_inter[it->second] = to_d(df.at(r, "inter_load"));
        M.lambda_batch[it->second] = to_d(df.at(r, "batch_load"));
    }
    M.dc_D = (int)dcp(M, "delay_max_h", 7);
    if (log) {
        banner("Data-center input");
        kv("Time steps", std::to_string(M.T));
        kv("Source", "oT_Data_DCWorkload_" + CaseName + ".csv");
    }
}
