#include "openTEPES.hpp"

#include <chrono>
#include <iostream>

void EVSystemIntegration(TEPES& M, const std::string& Dir, const std::string& Case, int log, const std::string& stage) {
    if (!M.enable_ev) return;
    if (stage == "input") {
        std::cout << "\n------------------------------------------------------------\n";
        std::cout << "EV planning enabled\n";
        std::cout << "------------------------------------------------------------\n";
        EVplan_inputdata(M, Dir, Case, log);
    } else if (stage == "modelformulation") {
        std::cout << "EV variables and constraints            ****\n";
        EVplan_modelformulation(M);
    } else if (stage == "output") {
        EVplan_outputresult(M);
    }
}

void ThermalSystemIntegration(TEPES& M, const std::string& Dir, const std::string& Case, int log,
                              const std::string& stage) {
    if (!M.enable_thermal) return;
    if (stage == "input") {
        std::cout << "\n------------------------------------------------------------\n";
        std::cout << "Thermal planning enabled\n";
        std::cout << "------------------------------------------------------------\n";
        ThermalInputData_poi(M, Dir, Case, log);
    } else if (stage == "variables") {
        ThermalSettingUpVariables_poi(M);
    } else if (stage == "investment") {
        ThermalInvestmentModelFormulation_poi(M, log);
    } else if (stage == "operation") {
        ThermalGenerationOperationModelFormulation_poi(M, log);
        ThermalStorageOperationModelFormulation_poi(M, log);
        ThermalBalanceModelFormulation_poi(M, log);
    } else if (stage == "objective") {
        std::cout << "Thermal cost in objective               ****\n";
        ThermalObjectiveFunction_poi(M, log);
        std::cout << "Thermal cost added to total objective   ****\n";
    } else if (stage == "output") {
        ThermalInvestmentResults_poi(M, log);
        ThermalEconomicResults_poi(M, log);
        ThermalOperationResults_poi(M, log);
    }
}

void AmmoniaSystemIntegration(TEPES& M, const std::string& Dir, const std::string& Case, int log,
                              const std::string& stage) {
    if (!M.enable_an) return;
    if (stage == "input") {
        std::cout << "\n------------------------------------------------------------\n";
        std::cout << "Ammonia planning enabled\n";
        std::cout << "------------------------------------------------------------\n";
        inputdata_ammonia(M, Dir, Case);
    } else if (stage == "modelformulation") {
        std::cout << "Ammonia variables and constraints       ****\n";
        modelformulation_ammonia(M);
    } else if (stage == "output") {
        outputresult_ammonia(M);
    }
}

void DataCenterIntegration(TEPES& M, const std::string& Dir, const std::string& Case, int log, const std::string& stage) {
    if (!M.enable_dc) return;
    if (stage == "input") {
        std::cout << "\n------------------------------------------------------------\n";
        std::cout << "Data-center planning enabled\n";
        std::cout << "------------------------------------------------------------\n";
        DC_inputdata(M, Dir, Case, log);
    } else if (stage == "modelformulation") {
        std::cout << "Data-center variables and constraints   ****\n";
        DC_modelformulation(M, log);
    } else if (stage == "output") {
        DC_outputresult(M, log);
    }
}

void openTEPES_run(const std::string& DirName, const std::string& CaseName, const std::string& SolverName,
                   const std::string& pIndLogConsole, const std::string& lib_gurobi) {
    auto t0 = std::chrono::high_resolution_clock::now();
    int log = (pIndLogConsole == "Yes" || pIndLogConsole == "YES" || pIndLogConsole == "yes" || pIndLogConsole == "1")
                  ? 1
                  : 0;

    std::cout << "Loading Gurobi: " << lib_gurobi << "\n";
    if (!gurobi::load_library(lib_gurobi)) {
        std::cerr << "Failed to load Gurobi library: " << lib_gurobi << "\n";
        return;
    }
    GurobiEnv env(true);
    env.set_raw_parameter_int("OutputFlag", 1);
    env.set_raw_parameter_int("GURO_PAR_ISVEXPIRATION", 0);
    env.set_raw_parameter_string("GURO_PAR_ISVNAME", "Musk");
    env.set_raw_parameter_string("GURO_PAR_ISVAPPNAME", "X");
    env.set_raw_parameter_string("GURO_PAR_ISVKEY", "G1ZZZWIA");
    env.start();

    GurobiModel model(env);
    TEPES M;
    M.model = &model;
    M.pIndLogConsole = log;

    InputData_poi(M, DirName, CaseName, log);
    SettingUpVariables_poi(M);
    TotalObjectiveFunction_poi(M, log);
    InvestmentModelFormulation_poi(M, log);

    EVSystemIntegration(M, DirName, CaseName, log, "input");
    EVSystemIntegration(M, DirName, CaseName, log, "modelformulation");

    ThermalSystemIntegration(M, DirName, CaseName, log, "input");
    ThermalSystemIntegration(M, DirName, CaseName, log, "variables");
    ThermalSystemIntegration(M, DirName, CaseName, log, "investment");
    ThermalSystemIntegration(M, DirName, CaseName, log, "operation");
    ThermalSystemIntegration(M, DirName, CaseName, log, "objective");

    AmmoniaSystemIntegration(M, DirName, CaseName, log, "input");
    AmmoniaSystemIntegration(M, DirName, CaseName, log, "modelformulation");

    DataCenterIntegration(M, DirName, CaseName, log, "input");
    DataCenterIntegration(M, DirName, CaseName, log, "modelformulation");

    std::cout << "Period " << M.period << ", Scenario " << M.scenario << ", Stage " << M.stage << "\n";
    GenerationOperationModelFormulationObjFunct_poi(M, log);
    GenerationOperationModelFormulationInvestment_poi(M, log);
    GenerationOperationModelFormulationDemand_poi(M, log);
    GenerationOperationModelFormulationStorage_poi(M, log);
    NetworkOperationModelFormulation_poi(M, log);

    if (log) std::cout << "Writing LP file                        ... 0 s\n";

    ProblemSolving_poi(M, DirName, CaseName, SolverName, log);

    EconomicResults_poi(M);
    InvestmentResults_poi(M);
    GenerationOperationResults_poi(M);
    PlanEvaluation_poi(M);
    ESSOperationResults_poi(M);
    NetworkOperationResults_poi(M);

    EVSystemIntegration(M, DirName, CaseName, log, "output");
    AmmoniaSystemIntegration(M, DirName, CaseName, log, "output");
    ThermalSystemIntegration(M, DirName, CaseName, log, "output");
    DataCenterIntegration(M, DirName, CaseName, log, "output");

    auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
    std::cout << "Total time                             ... " << (int)dt << " s\n";
}
