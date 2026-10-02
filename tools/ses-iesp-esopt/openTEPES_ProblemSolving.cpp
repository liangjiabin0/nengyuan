#include "openTEPES.hpp"

#include <chrono>
#include <iostream>
#include <thread>

void ProblemSolving_poi(TEPES& M, const std::string& DirName, const std::string& CaseName,
                        const std::string& SolverName, int log) {
    std::cout << "Problem solving                        ****\n" << std::flush;
    auto t0 = std::chrono::high_resolution_clock::now();
    (void)DirName;
    (void)CaseName;
    (void)log;
    auto& m = *M.model;
    if (SolverName == "gurobi") {
        m.set_parameter("Method", 2);
        m.set_parameter("MIPFocus", 1);
        m.set_parameter("RINS", 100);
        m.set_parameter("Crossover", -1);
        m.set_parameter("MIPGap", 0.001);
        int th = (int)std::max(1u, std::thread::hardware_concurrency() / 2);
        if (th < 1) th = 1;
        m.set_parameter("Threads", th);
        m.set_parameter("TimeLimit", 36000.0);
        m.set_parameter("IterationLimit", 36000000.0);
    }
    m.optimize();
    try {
        M.obj_value = m.get_model_attribute(ModelAttributeDouble::ObjectiveValue);
        std::cout << "Objective Value: " << M.obj_value << "\n";
        M.pSolveStatus = 1;
    } catch (const std::exception& e) {
        std::cout << "Failed to get Objective Value. Model might be infeasible. Error: " << e.what() << "\n";
        M.pSolveStatus = 0;
        throw;
    }
    auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
    std::cout << "Solution time                                ... " << (int)dt << " s\n";
    std::cout << "Total system            cost [CNY]             " << M.obj_value << "\n";
    std::cout << "***** Period: " << M.period << ", Scenario: " << M.scenario << " ******\n";
    double inv = 0, ret = 0, net = 0, gcost = 0, grid_down = 0, grid_up = 0, rom = 0, ccost = 0, ecost = 0,
           rcost = 0, ac = 0;
    for (int g : M.gc)
        inv += M.pDiscountFactor * M.pGenInvestCost[g] * M.pRatedMaxPower[g] * getv(m, M.vGenerationInvest[g]);
    for (int g : M.gd) ret += M.pDiscountFactor * M.pGenRetireCost[g] * getv(m, M.vGenerationRetire[g]);
    for (int t = 0; t < M.T; ++t) {
        gcost += M.pDiscountFactor * M.pScenProb * getv(m, M.vTotalGCost[t]);
        ccost += M.pDiscountFactor * M.pScenProb * getv(m, M.vTotalCCost[t]);
        ecost += M.pDiscountFactor * M.pScenProb * getv(m, M.vTotalECost[t]);
        rcost += M.pDiscountFactor * M.pScenProb * getv(m, M.vTotalRCost[t]);
        ac += M.pDiscountFactor * M.pScenProb * getv(m, M.vTotalAbandonCost[t]);
        for (int g : M.nr) {
            double p = getv(m, M.vTotalOutput[M.idx_tg(t, g)]);
            if (p > 0) grid_down += M.pDiscountFactor * M.pScenProb * M.pLoadLevelDuration[t] * M.pLinearVarCost[g] * p;
            if (p < 0)
                grid_up += -M.pDiscountFactor * M.pScenProb * M.pLoadLevelDuration[t] * M.pLinearVarCost[g] / 2.0 * p;
        }
        for (int g : M.r)
            rom += M.pDiscountFactor * M.pScenProb * M.pLoadLevelDuration[t] * M.pLinearOMCost[g] *
                   getv(m, M.vTotalOutput[M.idx_tg(t, g)]);
    }
    std::cout << "      Total genr invest cost [CNY]             " << inv << "\n";
    std::cout << "      Total genr retire cost [CNY]             " << ret << "\n";
    std::cout << "      Total line invest cost [CNY]             " << net << "\n";
    std::cout << "      Total generation  cost [CNY]             " << gcost << "\n";
    std::cout << "            grid down   cost [CNY]             " << grid_down << "\n";
    std::cout << "            grid up   income [CNY]             " << grid_up << "\n";
    std::cout << "            res oper    cost [CNY]             " << rom << "\n";
    std::cout << "      Total ess oper    cost [CNY]             " << ccost << "\n";
    std::cout << "      Total emission    cost [CNY]             " << ecost << "\n";
    std::cout << "      Total reliability cost [CNY]             " << rcost << "\n";
    std::cout << "      Total abandon     cost [CNY]             " << ac << "\n";
}
