#pragma once
// Shared data + model container for the ESOPT port of ses_iesp/openTEPES.

#include "csv_io.hpp"
#include "model_gurobi.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

inline constexpr double kInf = 1.0e20;
inline constexpr double kPi = 3.14159265358979323846;

inline void add_eq(ModelBase& m, ExprBuilder& e, double rhs = 0.0) {
    m.add_linear_constraint(static_cast<ScalarAffineFunction>(e), ConstraintSense::Equal, rhs);
}
inline void add_le(ModelBase& m, ExprBuilder& e, double rhs = 0.0) {
    m.add_linear_constraint(static_cast<ScalarAffineFunction>(e), ConstraintSense::LessEqual, rhs);
}
inline void add_ge(ModelBase& m, ExprBuilder& e, double rhs = 0.0) {
    m.add_linear_constraint(static_cast<ScalarAffineFunction>(e), ConstraintSense::GreaterEqual, rhs);
}
inline double getv(ModelBase& m, const VariableIndex& x) { return m.get_variable_value(x); }

inline VariableIndex add_var(ModelBase& m, double lb, double ub, VariableDomain d, const std::string& name) {
    return m.add_variable(lb, ub, d, name.c_str());
}
inline void term(ExprBuilder& e, const VariableIndex& v, double c) { e.add_affine_term(v, c); }

struct LineKey {
    int ni = 0, nf = 0, cc = 0;
};

struct TEPES {
    GurobiModel* model = nullptr;
    std::string dir, case_name, path;

    // ---- sets (string names + integer ids) ----
    std::string period = "2025", scenario = "sc1", stage = "st1";
    int period_year = 2025;
    std::vector<std::string> n_name;   // LoadLevel
    std::vector<std::string> g_name, nd_name, gt_name;
    std::unordered_map<std::string, int> n_id, g_id, nd_id;
    int T = 0, G = 0, ND = 0, LA = 0;

    std::vector<int> g, t_th, r, es, gc, gd, ec, nr;  // generator subsets (ids)
    std::vector<LineKey> la, lc, le, ll, lea, lca, laa;
    std::vector<int> rf;  // reference nodes
    std::vector<std::pair<int, int>> n2g;  // (nd, g)
    std::unordered_set<long long> n2g_set;
    std::vector<std::string> ev_nodes;
    std::string ht_node = "Node2";
    std::string eh_node = "Node2";

    // options / flags
    std::unordered_map<std::string, double> pOption;
    int pIndBinGenInvest = 0, pIndBinNetInvest = 0, pIndBinNetLosses = 0;
    int pIndBinGenRamps = 1, pIndBinGenMinTime = 1;
    int pIndBinGenRetire = 2, pIndBinGenOperat = 0, pIndBinSingleNode = 0, pIndBinLineCommit = 0;
    int pIndLogConsole = 1;
    int enable_ev = 0, enable_an = 0, enable_thermal = 0, enable_dc = 0;

    // scalars
    double pENSCost = 0, pCO2Cost = 0, pAnnualDiscRate = 0, pSBase = 0.001;
    std::string pReferenceNode = "Node1";
    int pTimeStep = 1;
    double pOffGridState = 0, pOffGridHour = 0, pOffgridDemand = 0, pOffgridMinDemand = 0;
    double pUpReserveActivation = 0, pDwReserveActivation = 0;
    double pDiscountFactor = 1.0, pScenProb = 1.0, pStageWeight = 1.0;

    // time series
    std::vector<double> pDuration, pLoadLevelDuration, pLoadLevelWeight, pPrice;
    std::vector<std::vector<double>> pDemand;          // [t][nd] GW
    std::vector<std::vector<double>> pMinPower, pMaxPower, pMaxPower2ndBlock;
    std::vector<std::vector<double>> pMinCharge, pMaxCharge, pMaxCharge2ndBlock;
    std::vector<std::vector<double>> pMinStorage, pMaxStorage, pIniInventory_t;
    std::vector<std::vector<double>> pEnergyInflows, pEnergyOutflows;

    // generator params
    std::vector<int> pGenToNode, pMustRun, pIndBinUnitInvest, pIndBinUnitCommit, pIndOperReserve;
    std::vector<std::string> pGenToTechnology;
    std::vector<double> pRatedMinPower, pRatedMaxPower, pLinearVarCost, pLinearOMCost, pLinearOperCost;
    std::vector<double> pConstantVarCost, pOperReserveCost, pStartUpCost, pShutDownCost;
    std::vector<double> pCO2EmissionCost, pCO2EmissionRate, pGenInvestCost, pGenRetireCost;
    std::vector<double> pRatedMinCharge, pRatedMaxCharge, pRatedMinStorage, pRatedMaxStorage;
    std::vector<double> pInitialInventory, pEfficiency, pAvailability;
    std::vector<int> pCycleTimeStep, pPeriodIniGen, pPeriodFinGen;

    // network
    std::vector<double> pLineX, pLineLossFactor, pLineNTCFrw, pLineNTCBck, pNetFixedCost, pLineLength;
    std::vector<double> pBigMFlowFrw, pBigMFlowBck, pMaxTheta;
    std::vector<int> pIndBinLineSwitch, pIndBinLineInvest, pPeriodIniNet, pPeriodFinNet;
    std::vector<std::string> pLineType;
    std::vector<int> lout_ni, lout_nf, lout_cc;  // flattened later via adjacency
    std::vector<std::vector<int>> lout, lin;     // line indices incident to node

    // ---- variables (flat t-major) ----
    VariableIndex vTotalFCost;
    std::vector<VariableIndex> vTotalGCost, vTotalCCost, vTotalECost, vTotalRCost, vTotalAbandonCost;
    std::vector<VariableIndex> vTotalOutput, vTotalOutputAbs, vOutput2ndBlock;
    std::vector<VariableIndex> vReserveUp, vReserveDown, vCommitment, vStartUp, vShutDown;
    std::vector<VariableIndex> vEnergyOutflows, vESSInventory, vESSSpillage, vESSTotalCharge;
    std::vector<VariableIndex> vESSChargeState, vESSDischargeState, vCharge2ndBlock;
    std::vector<VariableIndex> vESSReserveUp, vESSReserveDown;
    std::vector<VariableIndex> vENS, vPloss, vFlow, vTheta, vLineCommit;
    std::vector<VariableIndex> vGenerationInvest, vGenerationRetire, vNetworkInvest;

    ExprBuilder eTotalTCost;
    int pSolveStatus = 0;
    double obj_value = 0;

    // ---- EV ----
    std::vector<int> ev_period, ev_arrivals, ev_visit;
    std::vector<double> ev_init_soc, ev_tgt_soc, naive_demand_curve, P_ELEC_CHR, P_ELEC_DIS;
    std::vector<std::string> ev_node_col;
    double E_BATT_MAX = 50, P_CHR_MAX = 60, MAX_STATION_DISCHARGE = 120;
    int ENABLE_V2G = 1;
    double EFF_CHR = 0.95, EFF_DIS = 0.95, C_INV_PILE = 2000, C_PENALTY = 10000;
    VariableIndex N_pile;
    std::vector<std::vector<VariableIndex>> grid_p_chr, grid_p_dis;  // per t
    struct EVCohortVars {
        int t = 0, V = 0;
        std::vector<VariableIndex> P_chr, P_dis, E;  // E size V+1
    };
    std::vector<EVCohortVars> ev_cohorts;
    std::vector<double> demand_energy_per_ev, target_energy_per_cohort, initial_energy_per_cohort;

    // ---- Ammonia ----
    std::unordered_map<std::string, double> params_ammonia;
    VariableIndex cap_elec, cap_nh3;
    std::vector<VariableIndex> p_grid, p_elec, p_nh3, h2_prod, h2_cons, h2_sold, nh3_prod, u_elec, u_nh3;

    // ---- Thermal ----
    std::unordered_map<std::string, double> pThermalParams;
    double pThermalCapacityUnit = 0.01;
    std::vector<double> pThermalDemand, pChillerDemand;
    VariableIndex vCAP_boiler, vCAP_hp, vCAP_storage, vCAP_chp, vCAP_chiller, vCAP_comp, vCAP_gt, vCAP_st;
    VariableIndex vInstall_boiler, vInstall_hp, vInstall_storage, vInstall_chp, vInstall_chiller, vInstall_comp, vInstall_gt, vInstall_st;
    bool has_chp = false, has_chiller = false, has_comp = false, has_gt = false, has_st = false;
    std::vector<VariableIndex> vP_boiler_elec, vP_hp_elec, vQ_boiler_out, vQ_hp_out, vQ_district;
    std::vector<VariableIndex> vE_thermal_storage, vQ_storage_charge, vQ_storage_discharge;
    std::vector<VariableIndex> vP_chp_elec, vQ_chp_heat, vF_chp_gas;
    std::vector<VariableIndex> vP_gt_elec, vQ_gt_heat, vF_gt_gas;
    std::vector<VariableIndex> vP_st_elec, vQ_st_steam;
    std::vector<VariableIndex> vQ_chiller_cool, vQ_chiller_heat_in, vQ_comp_cool, vP_comp_elec;

    // ---- DC ----
    std::unordered_map<std::string, double> pDCParams;
    std::vector<double> lambda_inter, lambda_batch, p_other_kw, t_out_C;
    VariableIndex vDC_SrvAdd, vDC_CoolAdd;  // CoolAdd in kW (Python vDC_CoolAdd_kW)
    std::vector<VariableIndex> vDC_NSrv, vDC_L_tasks, vDC_P_IT, vDC_P_cool, vDC_H_cool, vDC_P_DC, vDC_T_in, vDC_T_cpu;
    std::vector<std::vector<VariableIndex>> vDC_BatchExec;  // [tau][k]
    int dc_D = 7;

    bool in_n2g(int nd, int g) const {
        return n2g_set.count(((long long)nd << 32) | (unsigned)g) != 0;
    }
    int idx_tg(int t, int g) const { return t * G + g; }
    int idx_tnd(int t, int nd) const { return t * ND + nd; }
    int idx_tla(int t, int l) const { return t * LA + l; }
    int find_g(const std::string& s) const {
        auto it = g_id.find(s);
        return it == g_id.end() ? -1 : it->second;
    }
    int find_nd(const std::string& s) const {
        auto it = nd_id.find(s);
        return it == nd_id.end() ? -1 : it->second;
    }
    bool is_es(int g) const { return std::find(es.begin(), es.end(), g) != es.end(); }
    bool is_gc(int g) const { return std::find(gc.begin(), gc.end(), g) != gc.end(); }
    bool is_ec(int g) const { return std::find(ec.begin(), ec.end(), g) != ec.end(); }
    bool is_r(int g) const { return std::find(r.begin(), r.end(), g) != r.end(); }
    bool is_nr(int g) const { return std::find(nr.begin(), nr.end(), g) != nr.end(); }
    bool nd_is_ev(int nd) const {
        for (auto& s : ev_nodes)
            if (s == nd_name[nd]) return true;
        return false;
    }
    bool nd_is_ht(int nd) const { return nd_name[nd] == ht_node; }
    bool nd_is_eh(int nd) const { return nd_name[nd] == eh_node; }
};

double tp(const TEPES& m, const std::string& k, double def = 0.0);
double dcp(const TEPES& m, const std::string& k, double def = 0.0);

void InputData_poi(TEPES& m, const std::string& DirName, const std::string& CaseName, int pIndLogConsole);
void SettingUpVariables_poi(TEPES& m);
void EVplan_inputdata(TEPES& m, const std::string& DirName, const std::string& CaseName, int log);
void inputdata_ammonia(TEPES& m, const std::string& DirName, const std::string& CaseName);
void ThermalInputData_poi(TEPES& m, const std::string& DirName, const std::string& CaseName, int log);
void DC_inputdata(TEPES& m, const std::string& DirName, const std::string& CaseName, int log);

void TotalObjectiveFunction_poi(TEPES& m, int log);
void InvestmentModelFormulation_poi(TEPES& m, int log);
void GenerationOperationModelFormulationObjFunct_poi(TEPES& m, int log);
void GenerationOperationModelFormulationInvestment_poi(TEPES& m, int log);
void GenerationOperationModelFormulationDemand_poi(TEPES& m, int log);
void GenerationOperationModelFormulationStorage_poi(TEPES& m, int log);
void NetworkOperationModelFormulation_poi(TEPES& m, int log);
void EVplan_modelformulation(TEPES& m);
void modelformulation_ammonia(TEPES& m);
void ThermalSettingUpVariables_poi(TEPES& m);
void ThermalInvestmentModelFormulation_poi(TEPES& m, int log);
void ThermalGenerationOperationModelFormulation_poi(TEPES& m, int log);
void ThermalStorageOperationModelFormulation_poi(TEPES& m, int log);
void ThermalBalanceModelFormulation_poi(TEPES& m, int log);
void ThermalObjectiveFunction_poi(TEPES& m, int log);
void DC_modelformulation(TEPES& m, int log);

void ProblemSolving_poi(TEPES& m, const std::string& DirName, const std::string& CaseName,
                        const std::string& SolverName, int log);

void EconomicResults_poi(TEPES& m);
void InvestmentResults_poi(TEPES& m);
void GenerationOperationResults_poi(TEPES& m);
void ESSOperationResults_poi(TEPES& m);
void NetworkOperationResults_poi(TEPES& m);
void PlanEvaluation_poi(TEPES& m);
void EVplan_outputresult(TEPES& m);
void outputresult_ammonia(TEPES& m);
void ThermalInvestmentResults_poi(TEPES& m, int log);
void ThermalEconomicResults_poi(TEPES& m, int log);
void ThermalOperationResults_poi(TEPES& m, int log);
void DC_outputresult(TEPES& m, int log);

void EVSystemIntegration(TEPES& m, const std::string& Dir, const std::string& Case, int log, const std::string& stage);
void ThermalSystemIntegration(TEPES& m, const std::string& Dir, const std::string& Case, int log, const std::string& stage);
void AmmoniaSystemIntegration(TEPES& m, const std::string& Dir, const std::string& Case, int log, const std::string& stage);
void DataCenterIntegration(TEPES& m, const std::string& Dir, const std::string& Case, int log, const std::string& stage);

void openTEPES_run(const std::string& DirName, const std::string& CaseName, const std::string& SolverName,
                   const std::string& pIndLogConsole, const std::string& lib_gurobi);
