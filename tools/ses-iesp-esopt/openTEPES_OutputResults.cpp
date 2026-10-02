#include "openTEPES.hpp"

#include <chrono>
#include <cmath>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <map>
#include <tuple>

static std::string join_path(const TEPES& M, const std::string& name) {
    return M.path + "/" + name + "_" + M.case_name + ".csv";
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

static std::string yn(double v) { return v > 0.5 ? "yes" : "no"; }

static void write_wide_time_units(const TEPES& M, const std::string& fname,
                                  const std::vector<std::string>& units,
                                  const std::vector<int>& uids,
                                  const std::function<double(int t, int u)>& val, int prec = 6) {
    std::ofstream f(join_path(M, fname));
    f << "Period,Scenario,LoadLevel";
    for (auto& u : units) f << "," << u;
    f << "\n";
    f << std::fixed << std::setprecision(prec);
    for (int t = 0; t < M.T; ++t) {
        f << M.period << "," << M.scenario << "," << M.n_name[t];
        for (int i = 0; i < (int)uids.size(); ++i) f << "," << val(t, uids[i]);
        f << "\n";
    }
}

void EconomicResults_poi(TEPES& M) {
    auto t0 = std::chrono::high_resolution_clock::now();
    auto& m = *M.model;
    double inv = 0, net = 0, gcost = 0, ecost = 0, ac = 0;
    for (int g : M.gc)
        inv += M.pDiscountFactor * M.pGenInvestCost[g] * M.pRatedMaxPower[g] * getv(m, M.vGenerationInvest[g]);
    for (int t = 0; t < M.T; ++t) {
        gcost += M.pDiscountFactor * M.pScenProb * getv(m, M.vTotalGCost[t]);
        ecost += M.pDiscountFactor * M.pScenProb * getv(m, M.vTotalECost[t]);
        ac += M.pDiscountFactor * M.pScenProb * getv(m, M.vTotalAbandonCost[t]);
    }
    std::ofstream f(join_path(M, "oT_Result_CostSummary"));
    f << "Period,Cost/Payment,CNY\n";
    f << std::fixed << std::setprecision(2);
    f << M.period << ",Generation investment," << inv << "\n";
    f << M.period << ",Network investment," << net << "\n";
    f << M.period << ",O&M cost," << gcost << "\n";
    f << M.period << ",Emission cost," << ecost << "\n";
    f << M.period << ",Curtailment cost," << ac << "\n";

    // BalanceEnergy
    std::ofstream b(join_path(M, "oT_Result_BalanceEnergy"));
    b << "Period,Scenario,LoadLevel,Technology";
    for (auto& nd : M.nd_name) b << "," << nd;
    b << "\n";
    b << std::fixed << std::setprecision(4);
    auto row = [&](int t, const std::string& tech, const std::vector<double>& v) {
        b << M.period << "," << M.scenario << "," << M.n_name[t] << "," << tech;
        for (double x : v) b << "," << x;
        b << "\n";
    };
    for (int t = 0; t < M.T; ++t) {
        std::map<std::string, std::vector<double>> cols;
        auto z = std::vector<double>(M.ND, 0.0);
        for (auto& gt : M.gt_name) cols[gt] = z;
        cols["PNS"] = z;
        cols["PowerDemand"] = z;
        cols["PowerFlowOut"] = z;
        cols["PowerFlowIn"] = z;
        cols["LineLossesOut"] = z;
        cols["LineLossesIn"] = z;
        cols["EVload"] = z;
        cols["ANload"] = z;
        cols["heatload"] = z;
        for (int nd = 0; nd < M.ND; ++nd) {
            for (int g : M.g) {
                if (!M.in_n2g(nd, g)) continue;
                double p = getv(m, M.vTotalOutput[M.idx_tg(t, g)]) * M.pLoadLevelDuration[t] * 1000.0;
                cols[M.pGenToTechnology[g]][nd] += p;
            }
            for (int g : M.es) {
                if (!M.in_n2g(nd, g)) continue;
                cols[M.pGenToTechnology[g]][nd] +=
                    -getv(m, M.vESSTotalCharge[M.idx_tg(t, g)]) * M.pLoadLevelDuration[t] * 1000.0;
            }
            cols["PNS"][nd] = getv(m, M.vENS[M.idx_tnd(t, nd)]) * M.pLoadLevelDuration[t] * 1000.0;
            cols["PowerDemand"][nd] = -M.pDemand[t][nd] * M.pLoadLevelDuration[t] * 1000.0;
            double fout = 0, fin = 0;
            for (int l : M.lout[nd]) fout += getv(m, M.vFlow[M.idx_tla(t, l)]);
            for (int l : M.lin[nd]) fin += getv(m, M.vFlow[M.idx_tla(t, l)]);
            cols["PowerFlowOut"][nd] = -fout * M.pLoadLevelDuration[t] * 1000.0;
            cols["PowerFlowIn"][nd] = fin * M.pLoadLevelDuration[t] * 1000.0;
            if (M.enable_ev && M.nd_is_ev(nd)) {
                double chr = 0, dis = 0;
                for (auto& v : M.grid_p_chr[t]) chr += getv(m, v);
                for (auto& v : M.grid_p_dis[t]) dis += getv(m, v);
                cols["EVload"][nd] = -((chr - dis) / 1e6) * M.pLoadLevelDuration[t] * 1000.0;
            }
            if (M.enable_an && M.nd_is_eh(nd))
                cols["ANload"][nd] = -(getv(m, M.p_grid[t]) / 1e6) * M.pLoadLevelDuration[t] * 1000.0;
            if (M.enable_thermal && M.nd_is_ht(nd)) {
                double hp = getv(m, M.vP_hp_elec[t]) / 1000.0;
                double bl = getv(m, M.vP_boiler_elec[t]) / 1000.0;
                double chp = M.has_chp ? getv(m, M.vP_chp_elec[t]) / 1000.0 : 0;
                cols["heatload"][nd] = -(hp + bl - chp) * M.pLoadLevelDuration[t] * 1000.0;
            }
        }
        std::vector<std::string> order = M.gt_name;
        order.insert(order.end(),
                     {"PNS", "PowerDemand", "PowerFlowOut", "PowerFlowIn", "LineLossesOut", "LineLossesIn", "EVload",
                      "ANload", "heatload"});
        for (auto& k : order) row(t, k, cols[k]);
    }
    auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
    std::cout << "Writing economic results               ... " << (int)dt << " s\n";
}

void InvestmentResults_poi(TEPES& M) {
    auto& m = *M.model;
    std::ofstream f(join_path(M, "oT_Result_GenerationInvestment"));
    f << "Period,GeneratingUnit,MW,CNY\n";
    f << std::fixed << std::setprecision(3);
    for (int g : M.gc) {
        double v = getv(m, M.vGenerationInvest[g]);
        double mw = M.pRatedMaxPower[g] * v * 1e3;
        double cny = M.pDiscountFactor * M.pGenInvestCost[g] * M.pRatedMaxPower[g] * v;
        f << M.period << "," << M.g_name[g] << "," << mw << "," << cny << "\n";
    }
    if (M.enable_thermal) {
        double cu = M.pThermalCapacityUnit;
        auto extra = [&](const char* name, VariableIndex cap, double unit_cost) {
            double c = getv(m, cap) * cu;
            f << M.period << "," << name << "," << c / 1000.0 << "," << c * unit_cost << "\n";
        };
        extra("Boiler", M.vCAP_boiler, tp(M, "boiler_unit_cost", 0));
        extra("HeatPump", M.vCAP_hp, tp(M, "hp_unit_cost", 0));
        extra("StorageTank_MWh", M.vCAP_storage, tp(M, "storage_unit_cost", 0));
        if (M.has_chp) extra("CHP", M.vCAP_chp, tp(M, "chp_unit_cost", 0));
        if (M.has_chiller) extra("AbsorptionChiller", M.vCAP_chiller, tp(M, "chiller_unit_cost", 0));
        if (M.has_comp) extra("CompressionChiller", M.vCAP_comp, tp(M, "comp_chiller_unit_cost", 0));
    }
    if (M.enable_an) {
        double ce = getv(m, M.cap_elec), cn = getv(m, M.cap_nh3);
        f << M.period << ",H2_Electrolyzer," << ce / 1000.0 << "," << ce * M.params_ammonia["cost_elec"] << "\n";
        f << M.period << ",NH3_Synthesis," << cn / 1000.0 << "," << cn * M.params_ammonia["cost_nh3"] << "\n";
    }
    if (M.enable_ev) {
        double np = getv(m, M.N_pile);
        f << M.period << ",EV_ChargingStation," << (np * M.P_CHR_MAX) / 1000.0 << "," << np * M.C_INV_PILE << "\n";
    }
}

void GenerationOperationResults_poi(TEPES& M) {
    auto t0 = std::chrono::high_resolution_clock::now();
    auto& m = *M.model;
    write_wide_time_units(
        M, "oT_Result_GenerationCommitment",
        [&] {
            std::vector<std::string> n;
            for (int g : M.nr) n.push_back(M.g_name[g]);
            return n;
        }(),
        M.nr, [&](int t, int g) { return getv(m, M.vCommitment[M.idx_tg(t, g)]); }, 1);
    write_wide_time_units(
        M, "oT_Result_GenerationStartUp",
        [&] {
            std::vector<std::string> n;
            for (int g : M.nr) n.push_back(M.g_name[g]);
            return n;
        }(),
        M.nr, [&](int t, int g) { return getv(m, M.vStartUp[M.idx_tg(t, g)]); }, 1);
    write_wide_time_units(
        M, "oT_Result_GenerationShutDown",
        [&] {
            std::vector<std::string> n;
            for (int g : M.nr) n.push_back(M.g_name[g]);
            return n;
        }(),
        M.nr, [&](int t, int g) { return getv(m, M.vShutDown[M.idx_tg(t, g)]); }, 1);
    if (!M.es.empty()) {
        write_wide_time_units(
            M, "oT_Result_ESSDischargeState",
            [&] {
                std::vector<std::string> n;
                for (int g : M.es) n.push_back(M.g_name[g]);
                return n;
            }(),
            M.es, [&](int t, int g) { return getv(m, M.vESSDischargeState[M.idx_tg(t, g)]); }, 1);
        write_wide_time_units(
            M, "oT_Result_ESSChargeState",
            [&] {
                std::vector<std::string> n;
                for (int g : M.es) n.push_back(M.g_name[g]);
                return n;
            }(),
            M.es, [&](int t, int g) { return getv(m, M.vESSChargeState[M.idx_tg(t, g)]); }, 1);
    }
    write_wide_time_units(
        M, "oT_Result_GenerationOutput", M.g_name, M.g,
        [&](int t, int g) {
            double p = getv(m, M.vTotalOutput[M.idx_tg(t, g)]) * 1e3;
            if (M.is_es(g)) p += -getv(m, M.vESSTotalCharge[M.idx_tg(t, g)]) * 1e3;
            return p;
        },
        6);
    write_wide_time_units(
        M, "oT_Result_GenerationEmission",
        [&] {
            std::vector<std::string> n;
            for (int g : M.nr) n.push_back(M.g_name[g]);
            return n;
        }(),
        M.nr,
        [&](int t, int g) {
            return getv(m, M.vTotalOutput[M.idx_tg(t, g)]) * 1e3 * M.pLoadLevelDuration[t] * M.pCO2EmissionRate[g];
        },
        6);
    write_wide_time_units(
        M, "oT_Result_TechnologyOutput", M.gt_name,
        [&] {
            std::vector<int> id(M.gt_name.size());
            for (int i = 0; i < (int)id.size(); ++i) id[i] = i;
            return id;
        }(),
        [&](int t, int gi) {
            double s = 0;
            for (int g : M.g)
                if (M.pGenToTechnology[g] == M.gt_name[gi]) {
                    double p = getv(m, M.vTotalOutput[M.idx_tg(t, g)]);
                    if (p > 0) s += p;
                    if (M.g_name[g] == "Grid" && p < 0) s += p;
                    if (M.is_es(g)) s += -getv(m, M.vESSTotalCharge[M.idx_tg(t, g)]);
                }
            return s * 1e3;
        },
        10);
    write_wide_time_units(
        M, "oT_Result_TechnologyEnergy", M.gt_name,
        [&] {
            std::vector<int> id(M.gt_name.size());
            for (int i = 0; i < (int)id.size(); ++i) id[i] = i;
            return id;
        }(),
        [&](int t, int gi) {
            double s = 0;
            for (int g : M.g)
                if (M.pGenToTechnology[g] == M.gt_name[gi])
                    s += getv(m, M.vTotalOutput[M.idx_tg(t, g)]) * M.pLoadLevelDuration[t] * 1000.0;
            return s;
        },
        10);
    auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
    std::cout << "Writing generation operation results   ... " << (int)dt << " s\n";
}

void ESSOperationResults_poi(TEPES& M) {
    auto& m = *M.model;
    if (M.es.empty()) return;
    write_wide_time_units(
        M, "oT_Result_GenerationInventory",
        [&] {
            std::vector<std::string> n;
            for (int g : M.es) n.push_back(M.g_name[g]);
            return n;
        }(),
        M.es, [&](int t, int g) { return getv(m, M.vESSInventory[M.idx_tg(t, g)]) * 1e3; }, 10);
    write_wide_time_units(
        M, "oT_Result_GenerationInventoryUtilization",
        [&] {
            std::vector<std::string> n;
            for (int g : M.es) n.push_back(M.g_name[g]);
            return n;
        }(),
        M.es,
        [&](int t, int g) {
            double inv = getv(m, M.vESSInventory[M.idx_tg(t, g)]);
            double mx = M.pMaxStorage[t][g];
            if (mx <= 0) return 0.0;
            if (M.is_gc(g)) {
                double v = getv(m, M.vGenerationInvest[g]);
                return v > 0 ? inv / (v * mx) : 0.0;
            }
            return inv / mx;
        },
        10);
    write_wide_time_units(
        M, "oT_Result_GenerationSpillage",
        [&] {
            std::vector<std::string> n;
            for (int g : M.es) n.push_back(M.g_name[g]);
            return n;
        }(),
        M.es, [&](int t, int g) { return getv(m, M.vESSSpillage[M.idx_tg(t, g)]); }, 10);
    write_wide_time_units(
        M, "oT_Result_ESSChargeDischarge",
        [&] {
            std::vector<std::string> n;
            for (int g : M.es) n.push_back(M.g_name[g]);
            return n;
        }(),
        M.es,
        [&](int t, int g) {
            return (getv(m, M.vTotalOutput[M.idx_tg(t, g)]) - getv(m, M.vESSTotalCharge[M.idx_tg(t, g)])) * 1e3;
        },
        10);
    std::ofstream f(join_path(M, "oT_Result_ESSInitialInventoryUtilization"));
    f << "Period,Scenario,LoadLevel";
    for (int g : M.es) f << "," << M.g_name[g];
    f << "\n" << M.period << "," << M.scenario << "," << M.n_name[0];
    f << std::setprecision(16);
    for (int g : M.es) {
        double mx = M.pMaxStorage[0][g];
        double inv = getv(m, M.vESSInventory[M.idx_tg(0, g)]);
        double v = M.is_gc(g) ? getv(m, M.vGenerationInvest[g]) : 1.0;
        f << "," << ((mx > 0 && v > 0) ? inv / (v * mx) : 0.0);
    }
    f << "\n";
}

void NetworkOperationResults_poi(TEPES& M) {
    auto t0 = std::chrono::high_resolution_clock::now();
    auto& m = *M.model;
    write_wide_time_units(M, "oT_Result_NetworkPloss", M.nd_name,
                          [&] {
                              std::vector<int> id(M.ND);
                              for (int i = 0; i < M.ND; ++i) id[i] = i;
                              return id;
                          }(),
                          [&](int t, int nd) { return getv(m, M.vPloss[M.idx_tnd(t, nd)]) * 1e3; }, 1);
    write_wide_time_units(
        M, "oT_Result_NetworkENS", M.nd_name,
        [&] {
            std::vector<int> id(M.ND);
            for (int i = 0; i < M.ND; ++i) id[i] = i;
            return id;
        }(),
        [&](int t, int nd) { return getv(m, M.vENS[M.idx_tnd(t, nd)]) * M.pLoadLevelDuration[t] * 1e3; }, 1);
    auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
    std::cout << "Writing    network operation results   ... " << (int)dt << " s\n";
}

void PlanEvaluation_poi(TEPES& M) {
    auto& m = *M.model;
    double generation_sum = 0, demand_sum = 0, demand_max = 0;
    std::vector<double> demand_curve(M.T, 0), grid_curve(M.T, 0);
    for (int t = 0; t < M.T; ++t) {
        for (int g : M.r)
            generation_sum += getv(m, M.vTotalOutput[M.idx_tg(t, g)]) * 1e3 * M.pLoadLevelDuration[t];
        double d = 0;
        for (int nd = 0; nd < M.ND; ++nd) d += M.pDemand[t][nd] * 1e3;
        demand_sum += d;
        demand_curve[t] = d;
        demand_max = std::max(demand_max, d);
        int grid = M.find_g("Grid");
        if (grid >= 0) grid_curve[t] = getv(m, M.vTotalOutput[M.idx_tg(t, grid)]) * 1e3;
    }
    double demand_ave = M.T ? demand_sum / M.T : 0;
    double res_cap = 0;
    for (int g : M.r) res_cap += M.pRatedMaxPower[g] * 1e3;
    double grid_up_max = 0, grid_down_max = 0, grid_up_sum = 0, grid_down_sum = 0;
    for (double p : grid_curve) {
        if (p < 0) {
            grid_up_max = std::max(grid_up_max, -p);
            grid_up_sum += -p;
        }
        if (p > 0) {
            grid_down_max = std::max(grid_down_max, p);
            grid_down_sum += p;
        }
    }
    auto util = [&](const std::string& tech) {
        double gen = 0, cap = 0;
        for (int g : M.g)
            if (M.pGenToTechnology[g] == tech) {
                cap += M.pRatedMaxPower[g] * 1e3;
                for (int t = 0; t < M.T; ++t) gen += std::abs(getv(m, M.vTotalOutput[M.idx_tg(t, g)])) * 1e3;
            }
        return cap > 0 ? gen / cap : 0;
    };
    double ess_charge = 0, ess_dis = 0, batt_e = 0, batt_p = 0;
    for (int g : M.es) {
        if (M.pGenToTechnology[g] == "Battery") {
            batt_e += M.pRatedMaxStorage[g] * 1e3;
            batt_p += M.pRatedMaxPower[g] * 1e3;
        }
        for (int t = 0; t < M.T; ++t) {
            ess_charge += getv(m, M.vESSTotalCharge[M.idx_tg(t, g)]) * 1e3;
            ess_dis += getv(m, M.vTotalOutput[M.idx_tg(t, g)]) * 1e3;
        }
    }
    double generation_fore = 0;
    for (int t = 0; t < M.T; ++t)
        for (int g : M.r) generation_fore += M.pMaxPower[t][g] * 1e3 * M.pLoadLevelDuration[t];
    double co2_e = 0;
    for (int t = 0; t < M.T; ++t)
        for (int g : M.nr)
            co2_e += getv(m, M.vTotalOutput[M.idx_tg(t, g)]) * 1e3 * M.pLoadLevelDuration[t] * M.pCO2EmissionRate[g];
    double co2_h = 0;
    if (M.enable_thermal) {
        for (int t = 0; t < M.T; ++t) {
            if (M.has_chp) co2_h += getv(m, M.vF_chp_gas[t]) * 0.202;
            if (M.has_gt) co2_h += getv(m, M.vF_gt_gas[t]) * 0.202;
        }
    }
    double CO2_sum = co2_e + co2_h;
    double pv24 = 0;
    for (int t = 23; t < M.T; ++t) {
        double mx = grid_curve[t], mn = grid_curve[t];
        for (int k = 0; k < 24; ++k) {
            mx = std::max(mx, grid_curve[t - k]);
            mn = std::min(mn, grid_curve[t - k]);
        }
        pv24 = std::max(pv24, mx - mn);
    }
    auto rec = [&](const char* metric, const char* name, double v, const char* unit) {
        return std::tuple<std::string, std::string, double, std::string>{metric, name, v, unit};
    };
    std::vector<std::tuple<std::string, std::string, double, std::string>> rows = {
        rec("generation_sum", "Total generation", generation_sum, "MWh"),
        rec("demand_sum", "Total demand", demand_sum, "MWh"),
        rec("demand_ave", "Average demand", demand_ave, "MW"),
        rec("demand_max", "Peak demand", demand_max, "MW"),
        rec("diff_generation_demand", "Generation minus demand", generation_sum - demand_sum, "MWh"),
        rec("sum_demand_with_storage_loss", "Demand with storage loss", demand_sum, "MWh"),
        rec("CO2_emission_sum", "CO2 emission", CO2_sum, "tCO2"),
        rec("CO2_emission_unit", "CO2 per tce", demand_sum > 0 ? CO2_sum / (demand_sum * 0.1229) : 0, "tCO2/tce"),
        rec("ratio_generation_demand", "Generation/demand", demand_sum > 0 ? generation_sum / demand_sum : 0, "/"),
        rec("ratio_gen_demand", "Source/load", demand_max > 0 ? res_cap / demand_max : 0, "/"),
        rec("ratio_ess_demand", "Storage/load", demand_max > 0 ? 8.0 / demand_max : 0, "/"),
        rec("grid_up_max", "Max export", grid_up_max, "MW"),
        rec("grid_down_max", "Max import", grid_down_max, "MW"),
        rec("grid_up_sum", "Total export", grid_up_sum, "MWh"),
        rec("grid_down_sum", "Total import", grid_down_sum, "MWh"),
        rec("grid_up_minus_down", "Export minus import", grid_up_sum - grid_down_sum, "MWh"),
        rec("grid_exchange_sum", "Total exchange", grid_up_sum + grid_down_sum, "MWh"),
        rec("utilization_h_demand", "Demand utilization hours", demand_max > 0 ? demand_sum / demand_max : 0, "h"),
        rec("utilization_h_hydro", "Hydro utilization hours", util("Hydro"), "h"),
        rec("utilization_h_solar", "PV utilization hours", util("PV"), "h"),
        rec("utilization_h_wind", "Wind utilization hours", util("Wind"), "h"),
        rec("ratio_exchange_peakvalley", "Exchange peak-valley ratio", demand_max > 0 ? pv24 / demand_max : 0, "/"),
        rec("ratio_exchange_power", "Net exchange share",
            demand_sum > 0 ? ((grid_up_sum + grid_down_sum) / demand_sum - (generation_sum / demand_sum - 1)) * 100.0 : 0,
            "%"),
        rec("ritio_self_sufficiency", "Self-sufficiency",
            demand_sum > 0 ? (demand_sum - grid_down_sum) / demand_sum * 100.0 : 0, "%"),
        rec("ratio_res_consume", "RES local consumption",
            (demand_sum + ess_charge - ess_dis) > 0
                ? (generation_sum - grid_up_sum) / (demand_sum + ess_charge - ess_dis) * 100.0
                : 0,
            "%"),
        rec("ratio_res_use", "RES utilization",
            generation_fore > 0 ? (1 - (generation_fore - generation_sum) / generation_fore) * 100.0 : 0, "%"),
        rec("ess_full_time", "ESS full cycles", batt_e > 0 ? ess_dis / batt_e : 0, "time"),
        rec("ration_ess_utilization", "ESS utilization",
            batt_p > 0 ? (ess_charge + ess_dis) / batt_p / 8760.0 * 100.0 : 0, "%"),
        rec("ess_total_charge", "ESS charge", ess_charge, "MWh"),
        rec("ess_total_discharge", "ESS discharge", ess_dis, "MWh"),
        rec("ess_total_charge_loss", "ESS charge loss", ess_charge - ess_dis, "MWh"),
        rec("ratio_ess_charge_discharge", "ESS discharge/charge",
            ess_charge > 0 ? ess_dis / ess_charge * 100.0 : 0, "%"),
    };
    std::ofstream f(join_path(M, "oT_Result_Evaluations"));
    f << "metric,name,value,unit\n";
    f << std::fixed << std::setprecision(3);
    for (auto& r : rows) {
        f << std::get<0>(r) << "," << std::get<1>(r) << "," << std::get<2>(r) << "," << std::get<3>(r) << "\n";
    }
    double inv = 0;
    for (int g : M.gc)
        inv += M.pDiscountFactor * M.pGenInvestCost[g] * M.pRatedMaxPower[g] * getv(m, M.vGenerationInvest[g]);
    double rom = 0;
    for (int t = 0; t < M.T; ++t)
        for (int g : M.r)
            rom += M.pLoadLevelDuration[t] * M.pLinearOMCost[g] * getv(m, M.vTotalOutput[M.idx_tg(t, g)]);
    double initial_investment = inv / 10000.0;
    double cost_res_oper = rom / 10000.0;
    double cost_grid_purchase = grid_down_sum * 1e3 * 0.5 * 1e-4;
    double revenue_generation = generation_sum * 1e3 * 0.2 * 1e-4;
    double cost_per_yr = cost_res_oper + cost_grid_purchase;
    std::vector<double> income(8, revenue_generation), outcome(8, cost_per_yr);
    income[0] = 0;
    outcome[0] = initial_investment + cost_per_yr;

    auto static_cycle = [&]() {
        std::vector<double> net(8), cum(8);
        int pos = 0;
        for (int n = 0; n < 8; ++n) net[n] = income[n] - outcome[n];
        cum[0] = net[0];
        for (int j = 1; j < 8; ++j) {
            cum[j] = net[j] + cum[j - 1];
            if (cum[j] > 0) {
                pos = j;
                break;
            }
        }
        double count_out = 0, count_in = 0;
        for (int k = 0; k < pos; ++k) {
            count_out += outcome[k];
            count_in += income[k];
        }
        double den = income[pos] - outcome[pos];
        double cycle = pos - 1 + (den != 0 ? std::abs((count_out - count_in) / den) : 0);
        return std::round(cycle * 100.0) / 100.0;
    };
    auto dynamic_cycle_fn = [&](double rate) {
        std::vector<double> net(8), cum(8);
        for (int n = 0; n < 8; ++n) net[n] = income[n] - outcome[n];
        for (int l = 1; l < 8; ++l) net[l] = std::round(net[l] / std::pow(1.0 + rate, l) * 100.0) / 100.0;
        cum[0] = net[0];
        int pos = 0;
        for (int j = 1; j < 8; ++j) {
            cum[j] = std::round((net[j] + cum[j - 1]) * 100.0) / 100.0;
            if (cum[j] >= 0) {
                pos = j;
                break;
            }
        }
        if (pos == 0 || net[pos] == 0) return 0.0;
        double cycle = pos - 1 + std::abs(cum[pos - 1] / net[pos]);
        return std::round(cycle * 100.0) / 100.0;
    };
    auto irr_of = [&]() {
        std::vector<double> cf(8);
        for (int n = 0; n < 8; ++n) cf[n] = income[n] - outcome[n];
        auto npv = [&](double r) {
            double v = 0, d = 1;
            for (double c : cf) {
                v += c / d;
                d *= (1.0 + r);
            }
            return v;
        };
        double lo = -0.99, hi = 100.0;
        for (int it = 0; it < 80; ++it) {
            double mid = 0.5 * (lo + hi);
            if (npv(mid) > 0)
                lo = mid;
            else
                hi = mid;
        }
        double irr = 0.5 * (lo + hi);
        return irr < 0 ? 0.0 : irr;
    };

    double i_disc = 0.1;
    double irr = irr_of();
    double st_c = static_cycle();
    if (st_c < 0) st_c = 0;
    double dy_c = dynamic_cycle_fn(i_disc);
    if (dy_c < 0) dy_c = 0;

    std::ofstream e(join_path(M, "oT_Result_EvaluationsEco"));
    e << "metric,name,value,unit\n";
    e << std::fixed << std::setprecision(3);
    e << "initial_investment,Initial investment," << initial_investment << ",10k CNY\n";
    e << "cost_grid_purchase,Grid purchase cost," << cost_grid_purchase << ",10k CNY\n";
    e << "cost_res_oper,RES O&M cost," << cost_res_oper << ",10k CNY\n";
    e << "revenue_generation,RES subsidy revenue," << revenue_generation << ",10k CNY\n";
    e << std::setprecision(2);
    e << "irr,IRR," << (std::round(irr * 10000.0) / 10000.0) * 100.0 << ",%\n";
    e << std::setprecision(1);
    e << "i,Discount rate," << i_disc * 100.0 << ",%\n";
    e << std::setprecision(2);
    e << "static_cycle,Static payback," << st_c << ",year\n";
    e << "dynamic_cycle,Dynamic payback," << dy_c << ",year\n";
}

void EVplan_outputresult(TEPES& M) {
    auto& m = *M.model;
    std::vector<double> pchr(M.T, 0), pdis(M.T, 0);
    for (int t = 0; t < M.T; ++t) {
        for (auto& v : M.grid_p_chr[t]) pchr[t] += getv(m, v);
        for (auto& v : M.grid_p_dis[t]) pdis[t] += getv(m, v);
    }
    double np = getv(m, M.N_pile);
    double schr = 0, sdis = 0;
    for (int t = 0; t < M.T; ++t) {
        schr += pchr[t];
        sdis += pdis[t];
    }
    banner("EV results");
    kv("Total cost", std::to_string(M.obj_value) + " CNY");
    kv("Charging piles", std::to_string((int)std::lround(np)));
    kv("Total charged", std::to_string(schr) + " kWh");
    kv("Total discharged (V2G)", std::to_string(sdis) + " kWh");
    std::ofstream f(M.path + "/oT_Result_EV_planning_results.csv");
    f << "Period,Scenario,LoadLevel,arrivals,visit_time,initial_soc,target_soc,node,Arriving_Demand_kW,"
         "Optimized_Charge_Power_kW,Optimized_Discharge_Power_kW,Optimized_Net_Grid_Power_kW,Grid_Buy_Price_CNY,"
         "Grid_Sell_Price_CNY\n";
    f << std::setprecision(16);
    for (int t = 0; t < M.T; ++t) {
        f << M.period << "," << M.scenario << "," << M.n_name[t] << "," << M.ev_arrivals[t] << "," << M.ev_visit[t]
          << "," << M.ev_init_soc[t] * 100 << "," << M.ev_tgt_soc[t] * 100 << "," << M.ev_node_col[t] << ","
          << M.naive_demand_curve[t] << "," << pchr[t] << "," << pdis[t] << "," << (pchr[t] - pdis[t]) << ","
          << M.P_ELEC_CHR[t] << "," << M.P_ELEC_DIS[t] << "\n";
    }
    kv("Saved", M.path + "/oT_Result_EV_planning_results.csv");
}

void outputresult_ammonia(TEPES& M) {
    auto& m = *M.model;
    double ce = getv(m, M.cap_elec), cn = getv(m, M.cap_nh3);
    banner("Ammonia results");
    kv("Electrolyzer capacity", std::to_string(ce) + " kW");
    kv("NH3 synthesis capacity", std::to_string(cn) + " kg/h");
    std::ofstream f(join_path(M, "oT_Result_H2AnOutput"));
    f << "Period,Scenario,LoadLevel,H2_Power,NH3_Power,H2_Production,NH3_Production,H2_Consumption,H2_Sold\n";
    f << std::setprecision(16);
    for (int t = 0; t < M.T; ++t) {
        f << M.period << "," << M.scenario << "," << M.n_name[t] << "," << getv(m, M.p_elec[t]) << ","
          << getv(m, M.p_nh3[t]) << "," << getv(m, M.h2_prod[t]) << "," << getv(m, M.nh3_prod[t]) << ","
          << getv(m, M.h2_cons[t]) << "," << getv(m, M.h2_sold[t]) << "\n";
    }
    kv("Saved", "oT_Result_H2AnOutput_" + M.case_name + ".csv");
}

void ThermalInvestmentResults_poi(TEPES& M, int log) {
    (void)log;
    auto& m = *M.model;
    banner("Thermal investment results");
    double cu = M.pThermalCapacityUnit;
    auto cap = [&](VariableIndex x) { return getv(m, x) * cu; };
    auto cap_line = [&](const char* name, VariableIndex c, VariableIndex inst, const char* unit) {
        kv(name, std::to_string(cap(c)) + " " + unit + "   install: " + yn(getv(m, inst)));
    };
    cap_line("Boiler", M.vCAP_boiler, M.vInstall_boiler, "MW");
    cap_line("Heat pump", M.vCAP_hp, M.vInstall_hp, "MW");
    kv("Storage tank", std::to_string(cap(M.vCAP_storage)) + " MWh   install: " + yn(getv(m, M.vInstall_storage)));
    if (M.has_chp) cap_line("CHP", M.vCAP_chp, M.vInstall_chp, "MW");
    if (M.has_gt) cap_line("GT", M.vCAP_gt, M.vInstall_gt, "MW");
    if (M.has_st) cap_line("ST", M.vCAP_st, M.vInstall_st, "MW");
    if (M.has_chiller) cap_line("Absorption chiller", M.vCAP_chiller, M.vInstall_chiller, "MW");
    if (M.has_comp) {
        cap_line("Compression chiller", M.vCAP_comp, M.vInstall_comp, "MW");
        kv("Rated COP", std::to_string(tp(M, "comp_chiller_cop", 2.7)));
    }
}

void ThermalEconomicResults_poi(TEPES& M, int log) {
    (void)M;
    (void)log;
    banner("Thermal economic results");
    kv("Note", "Thermal cost is included in the total objective");
}

void ThermalOperationResults_poi(TEPES& M, int log) {
    (void)log;
    auto& m = *M.model;
    banner("Thermal operation results");
    std::ofstream c(join_path(M, "oT_Result_BalanceCooling"));
    c << "Period,Scenario,LoadLevel,ChillerDemand,AbsorptionChiller,CompressionChiller\n";
    c << std::setprecision(16);
    for (int t = 0; t < M.T; ++t) {
        c << M.period << "," << M.scenario << "," << M.n_name[t] << "," << M.pChillerDemand[t] << ","
          << (M.has_chiller ? getv(m, M.vQ_chiller_cool[t]) : 0) << ","
          << (M.has_comp ? getv(m, M.vQ_comp_cool[t]) : 0) << "\n";
    }
    kv("Cooling balance", "oT_Result_BalanceCooling_" + M.case_name + ".csv");
    std::ofstream h(join_path(M, "oT_Result_BalanceHeating"));
    h << "Period,Scenario,LoadLevel,ThermalDemand,Boiler,HeatPump,CHP,GTHeat,STSteamConsumption,StorageDischarge,"
         "StorageCharge,DistrictHeat\n";
    h << std::setprecision(16);
    for (int t = 0; t < M.T; ++t) {
        h << M.period << "," << M.scenario << "," << M.n_name[t] << "," << M.pThermalDemand[t] << ","
          << getv(m, M.vQ_boiler_out[t]) << "," << getv(m, M.vQ_hp_out[t]) << ","
          << (M.has_chp ? getv(m, M.vQ_chp_heat[t]) : 0) << "," << (M.has_gt ? getv(m, M.vQ_gt_heat[t]) : 0) << ","
          << (M.has_st ? -getv(m, M.vQ_st_steam[t]) : 0) << "," << getv(m, M.vQ_storage_discharge[t]) << ","
          << -getv(m, M.vQ_storage_charge[t]) << "," << getv(m, M.vQ_district[t]) << "\n";
    }
    kv("Heating balance", "oT_Result_BalanceHeating_" + M.case_name + ".csv");
}

void DC_outputresult(TEPES& M, int log) {
    (void)log;
    auto& m = *M.model;
    banner("Data-center results");
    double srv = getv(m, M.vDC_SrvAdd);
    double cool = getv(m, M.vDC_CoolAdd);
    kv("Servers added", std::to_string(srv));
    kv("Servers total", std::to_string(srv));
    kv("Cooling added", std::to_string(cool) + " kW");
    std::ofstream f(join_path(M, "oT_Result_DCWorkload"));
    f << "Period,Scenario,LoadLevel,inter_load,batch_load,total_load,batch_exec_load,scheduled_total_load\n";
    for (int t = 0; t < M.T; ++t) {
        double be = 0;
        int tau0 = std::max(0, t - M.dc_D);
        for (int tau = tau0; tau <= t; ++tau) {
            int k = t - tau;
            if (k <= M.dc_D && M.vDC_BatchExec[tau][k].index >= 0) be += getv(m, M.vDC_BatchExec[tau][k]);
        }
        int li = (int)std::lround(M.lambda_inter[t]);
        int lb = (int)std::lround(M.lambda_batch[t]);
        int be_i = (int)std::lround(be);
        f << M.period << "," << M.scenario << "," << M.n_name[t] << "," << li << "," << lb << "," << (li + lb) << ","
          << be_i << "," << (li + be_i) << "\n";
    }
    kv("Saved", join_path(M, "oT_Result_DCWorkload"));
}
