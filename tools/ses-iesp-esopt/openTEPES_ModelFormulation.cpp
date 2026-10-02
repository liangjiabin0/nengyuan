#include "openTEPES.hpp"

#include <chrono>
#include <iostream>

void TotalObjectiveFunction_poi(TEPES& M, int log) {
    std::cout << "Total cost o.f.      model formulation ****\n";
    auto t0 = std::chrono::high_resolution_clock::now();
    M.eTotalTCost = ExprBuilder();
    term(M.eTotalTCost, M.vTotalFCost, M.pDiscountFactor);
    for (int t = 0; t < M.T; ++t) {
        term(M.eTotalTCost, M.vTotalGCost[t], M.pDiscountFactor * M.pScenProb);
        term(M.eTotalTCost, M.vTotalCCost[t], M.pDiscountFactor * M.pScenProb);
        term(M.eTotalTCost, M.vTotalRCost[t], M.pDiscountFactor * M.pScenProb);
        term(M.eTotalTCost, M.vTotalAbandonCost[t], M.pDiscountFactor * M.pScenProb);
    }
    M.model->set_objective(M.eTotalTCost, ObjectiveSense::Minimize);
    if (log) {
        auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
        std::cout << "Total fixed and variable costs         ... " << (int)dt << " s\n";
    }
}

void InvestmentModelFormulation_poi(TEPES& M, int log) {
    std::cout << "Investment           model formulation ****\n";
    auto t0 = std::chrono::high_resolution_clock::now();
    auto& m = *M.model;
    ExprBuilder e;
    e += M.vTotalFCost;
    for (int g : M.gc) term(e, M.vGenerationInvest[g], -M.pGenInvestCost[g] * M.pRatedMaxPower[g]);
    for (int g : M.gd) term(e, M.vGenerationRetire[g], -M.pGenRetireCost[g]);
    for (int l = 0; l < M.LA; ++l) {
        bool cand = false;
        for (auto& x : M.lc)
            if (x.ni == M.la[l].ni && x.nf == M.la[l].nf) cand = true;
        if (cand) term(e, M.vNetworkInvest[l], -M.pNetFixedCost[l] * M.pLineLength[l]);
    }
    add_eq(m, e, 0.0);
    if (log) {
        auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
        std::cout << "Gen&transm investment o.f./constraints ... " << (int)dt << " s\n";
    }
}

void GenerationOperationModelFormulationObjFunct_poi(TEPES& M, int log) {
    std::cout << "Generation oper model formulation o.f. ****\n";
    auto t0 = std::chrono::high_resolution_clock::now();
    auto& m = *M.model;
    for (int t = 0; t < M.T; ++t) {
        double dur = M.pLoadLevelDuration[t];
        double w = M.pLoadLevelWeight[t];
        {
            ExprBuilder e;
            e += M.vTotalGCost[t];
            for (int g : M.nr) {
                term(e, M.vTotalOutputAbs[M.idx_tg(t, g)], -0.5 * dur * M.pLinearVarCost[g]);
                term(e, M.vTotalOutput[M.idx_tg(t, g)], -0.5 * dur * M.pLinearVarCost[g]);
                term(e, M.vCommitment[M.idx_tg(t, g)], -dur * M.pConstantVarCost[g]);
                term(e, M.vStartUp[M.idx_tg(t, g)], -w * M.pStartUpCost[g]);
                term(e, M.vShutDown[M.idx_tg(t, g)], -w * M.pShutDownCost[g]);
                if (M.pIndOperReserve[g] == 0) {
                    term(e, M.vReserveUp[M.idx_tg(t, g)], -w * M.pOperReserveCost[g]);
                    term(e, M.vReserveDown[M.idx_tg(t, g)], -w * M.pOperReserveCost[g]);
                }
            }
            for (int g : M.es) {
                if (M.pIndOperReserve[g] == 0) {
                    term(e, M.vESSReserveUp[M.idx_tg(t, g)], -w * M.pOperReserveCost[g]);
                    term(e, M.vESSReserveDown[M.idx_tg(t, g)], -w * M.pOperReserveCost[g]);
                }
            }
            for (int g : M.r) term(e, M.vTotalOutput[M.idx_tg(t, g)], -dur * M.pLinearOMCost[g]);
            add_eq(m, e, 0.0);
        }
        {
            ExprBuilder e;
            e += M.vTotalCCost[t];
            for (int g : M.es) term(e, M.vESSTotalCharge[M.idx_tg(t, g)], -dur * M.pLinearVarCost[g]);
            add_eq(m, e, 0.0);
        }
        double sum_co2 = 0;
        for (int g : M.nr) sum_co2 += M.pCO2EmissionCost[g];
        if (sum_co2 != 0) {
            ExprBuilder e;
            e += M.vTotalECost[t];
            for (int g : M.nr) term(e, M.vTotalOutput[M.idx_tg(t, g)], -dur * M.pCO2EmissionCost[g]);
            add_eq(m, e, 0.0);
        }
        {
            ExprBuilder e;
            e += M.vTotalRCost[t];
            for (int nd = 0; nd < M.ND; ++nd) term(e, M.vENS[M.idx_tnd(t, nd)], -dur * M.pENSCost);
            add_eq(m, e, 0.0);
        }
        {
            ExprBuilder e;
            e += M.vTotalAbandonCost[t];
            for (int g : M.r) {
                if (M.is_gc(g)) {
                    term(e, M.vGenerationInvest[g], -dur * 1e6 * M.pMaxPower[t][g]);
                    term(e, M.vTotalOutput[M.idx_tg(t, g)], dur * 1e6);
                } else {
                    e += -dur * 1e6 * M.pMaxPower[t][g];
                    term(e, M.vTotalOutput[M.idx_tg(t, g)], dur * 1e6);
                }
            }
            for (int nd = 0; nd < M.ND; ++nd) term(e, M.vPloss[M.idx_tnd(t, nd)], -dur * 0.2 * 1e6);
            add_eq(m, e, 0.0);
        }
    }
    if (log) {
        auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
        std::cout << "Generating operation  o.f.             ... " << (int)dt << " s\n";
    }
}

void GenerationOperationModelFormulationInvestment_poi(TEPES& M, int log) {
    std::cout << "Investment & operation var constraints ****\n";
    auto t0 = std::chrono::high_resolution_clock::now();
    auto& m = *M.model;
    int n1 = 0, n2 = 0;
    for (int t = 0; t < M.T; ++t) {
        for (int g : M.gc) {
            ExprBuilder e;
            if (M.pMaxPower[t][g] != 0) {
                term(e, M.vTotalOutput[M.idx_tg(t, g)], 1.0 / M.pMaxPower[t][g]);
                term(e, M.vGenerationInvest[g], -1.0);
                add_le(m, e, 0.0);
            } else {
                e += M.vTotalOutput[M.idx_tg(t, g)];
                add_le(m, e, 0.0);
            }
            ++n1;
        }
        for (int g : M.ec) {
            ExprBuilder e;
            term(e, M.vESSTotalCharge[M.idx_tg(t, g)], 1.0 / M.pMaxCharge[t][g]);
            term(e, M.vGenerationInvest[g], -1.0);
            add_le(m, e, 0.0);
            ++n2;
        }
    }
    std::cout << "Added " << n1 << " eInstalGenCap constraints.\n";
    std::cout << "Added " << n2 << " eInstalConESS constraints.\n";
    if (log) {
        auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
        std::cout << "Generating operation & investment      ... " << (int)dt << " s\n";
    }
}

void GenerationOperationModelFormulationDemand_poi(TEPES& M, int log) {
    std::cout << "Inertia, oper resr, demand constraints ****\n";
    auto t0 = std::chrono::high_resolution_clock::now();
    auto& m = *M.model;
    int nb = 0;
    for (int t = 0; t < M.T; ++t) {
        for (int nd = 0; nd < M.ND; ++nd) {
            ExprBuilder e;
            for (int g : M.g)
                if (M.in_n2g(nd, g)) e += M.vTotalOutput[M.idx_tg(t, g)];
            term(e, M.vPloss[M.idx_tnd(t, nd)], -1.0);
            for (int g : M.es)
                if (M.in_n2g(nd, g)) term(e, M.vESSTotalCharge[M.idx_tg(t, g)], -1.0);
            e += M.vENS[M.idx_tnd(t, nd)];
            e += -M.pDemand[t][nd];
            for (int l : M.lout[nd]) term(e, M.vFlow[M.idx_tla(t, l)], -1.0);
            for (int l : M.lin[nd]) e += M.vFlow[M.idx_tla(t, l)];
            if (M.enable_ev && M.nd_is_ev(nd)) {
                for (auto& v : M.grid_p_chr[t]) term(e, v, -1.0 / 1e6);
                for (auto& v : M.grid_p_dis[t]) term(e, v, 1.0 / 1e6);
            }
            if (M.enable_thermal && M.nd_is_ht(nd)) {
                if (M.has_chp) term(e, M.vP_chp_elec[t], 1.0 / 1000.0);
                if (M.has_gt) term(e, M.vP_gt_elec[t], 1.0 / 1000.0);
                if (M.has_st) term(e, M.vP_st_elec[t], 1.0 / 1000.0);
                term(e, M.vP_hp_elec[t], -1.0 / 1000.0);
                term(e, M.vP_boiler_elec[t], -1.0 / 1000.0);
            }
            if (M.enable_an && M.nd_is_eh(nd)) term(e, M.p_grid[t], -1.0 / 1e6);
            add_eq(m, e, 0.0);
            ++nb;
        }
    }
    std::cout << "Added " << nb << " eBalance constraints.\n";
    int nabs = 0;
    for (int t = 0; t < M.T; ++t) {
        for (int g : M.g) {
            ExprBuilder e1;
            e1 += M.vTotalOutputAbs[M.idx_tg(t, g)];
            term(e1, M.vTotalOutput[M.idx_tg(t, g)], -1.0);
            add_ge(m, e1, 0.0);
            ExprBuilder e2;
            e2 += M.vTotalOutputAbs[M.idx_tg(t, g)];
            e2 += M.vTotalOutput[M.idx_tg(t, g)];
            add_ge(m, e2, 0.0);
            nabs += 2;
        }
    }
    std::cout << "Added " << nabs / 2 << " vTotalOutput1 constraints.\n";
    std::cout << "Added " << nabs / 2 << " vTotalOutput2 constraints.\n";
    if (log) {
        auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
        std::cout << "Generating inertia/reserves/balance    ... " << (int)dt << " s\n";
    }
}

void GenerationOperationModelFormulationStorage_poi(TEPES& M, int log) {
    std::cout << "Storage scheduling         constraints ****\n";
    auto t0 = std::chrono::high_resolution_clock::now();
    auto& m = *M.model;
    int period_length = (int)(24 / std::max(1, M.pTimeStep));
    int n = 0;
    for (int idx = 0; idx < M.T; ++idx) {
        if ((idx + 1) % period_length != 0) continue;
        for (int g : M.es) {
            ExprBuilder e;
            for (int i = 1; i < 24; ++i) {
                int prev = idx - i;
                if (prev >= 0) e += M.vTotalOutput[M.idx_tg(prev, g)];
            }
            add_le(m, e, 350.0 / 365.0 * M.pMaxStorage[idx][g]);
            ++n;
        }
    }
    std::cout << "Added " << n << " eDischarge constraints.\n";
    n = 0;
    for (int t = 0; t < M.T; ++t)
        for (int g : M.es) {
            ExprBuilder e;
            e += M.vESSTotalCharge[M.idx_tg(t, g)];
            term(e, M.vESSChargeState[M.idx_tg(t, g)], -M.pMaxCharge[t][g]);
            add_le(m, e, 0.0);
            ++n;
        }
    std::cout << "Added " << n << " ePowerChargeLimit constraints.\n";
    n = 0;
    for (int t = 0; t < M.T; ++t)
        for (int g : M.es) {
            ExprBuilder e;
            e += M.vTotalOutput[M.idx_tg(t, g)];
            term(e, M.vESSDischargeState[M.idx_tg(t, g)], -M.pMaxPower[t][g]);
            add_le(m, e, 0.0);
            ++n;
        }
    std::cout << "Added " << n << " ePowerDischargeLimit constraints.\n";
    n = 0;
    for (int t = 0; t < M.T; ++t)
        for (int g : M.es) {
            ExprBuilder e;
            e += M.vESSChargeState[M.idx_tg(t, g)];
            e += M.vESSDischargeState[M.idx_tg(t, g)];
            add_le(m, e, 1.0);
            ++n;
        }
    std::cout << "Added " << n << " eChargeAndDischarge constraints.\n";
    n = 0;
    for (int t = 0; t < M.T; ++t) {
        int n_ord = t + 1;
        for (int g : M.es) {
            int cyc = std::max(1, M.pCycleTimeStep[g]);
            if (n_ord == cyc || (n_ord > cyc && n_ord % cyc == 0)) {
                ExprBuilder e;
                if (n_ord == cyc) {
                    if (M.is_gc(g))
                        term(e, M.vGenerationInvest[g], M.pIniInventory_t[t][g]);
                    else
                        e += M.pIniInventory_t[t][g];
                } else {
                    e += M.vESSInventory[M.idx_tg(t - cyc, g)];
                }
                for (int n2 = n_ord - cyc; n2 < n_ord; ++n2) {
                    double d = M.pDuration[n2];
                    e += d * M.pEnergyInflows[n2][g];
                    term(e, M.vEnergyOutflows[M.idx_tg(n2, g)], -d);
                    term(e, M.vTotalOutput[M.idx_tg(n2, g)], -d);
                    term(e, M.vESSTotalCharge[M.idx_tg(n2, g)], d * M.pEfficiency[g]);
                }
                term(e, M.vESSInventory[M.idx_tg(t, g)], -1.0);
                term(e, M.vESSSpillage[M.idx_tg(t, g)], -1.0);
                add_eq(m, e, 0.0);
                ++n;
            }
        }
    }
    std::cout << "Added " << n << " eESSInventory constraints.\n";
    n = 0;
    if (M.T > 0) {
        for (int g : M.es) {
            ExprBuilder e;
            e += M.vESSInventory[M.idx_tg(M.T - 1, g)];
            if (M.is_gc(g))
                term(e, M.vGenerationInvest[g], -M.pIniInventory_t[0][g]);
            else
                e += -M.pIniInventory_t[0][g];
            add_le(m, e, 0.0);
            ++n;
        }
    }
    std::cout << "Added " << n << " eESSFinalCapacity constraints.\n";
    n = 0;
    for (int t = 0; t < M.T; ++t)
        for (int g : M.es) {
            ExprBuilder e;
            e += M.vESSInventory[M.idx_tg(t, g)];
            if (M.is_ec(g) || M.is_gc(g))
                term(e, M.vGenerationInvest[g], -0.9 * M.pMaxStorage[t][g]);
            else
                e += -0.9 * M.pMaxStorage[t][g];
            add_le(m, e, 0.0);
            ++n;
        }
    std::cout << "Added " << n << " eESSMaxStorage constraints.\n";
    std::cout << "Added 0 eESS off-grid constraints. \nOff-grid demand: " << M.pOffgridDemand * 1000 << " MWh.\n";
    n = 0;
    for (int t = 0; t < M.T; ++t)
        for (int g : M.es) {
            if (M.pMaxPower2ndBlock[t][g] && M.pMaxCharge2ndBlock[t][g]) {
                ExprBuilder e;
                term(e, M.vOutput2ndBlock[M.idx_tg(t, g)], 1.0 / M.pMaxPower2ndBlock[t][g]);
                term(e, M.vCharge2ndBlock[M.idx_tg(t, g)], 1.0 / M.pMaxCharge2ndBlock[t][g]);
                add_le(m, e, 1.0);
                ++n;
            }
        }
    std::cout << "Added " << n << " eChargeDischarge constraints.\n";
    n = 0;
    for (int t = 0; t < M.T; ++t)
        for (int g : M.es) {
            if (M.pMaxCharge[t][g] && M.pMaxCharge2ndBlock[t][g] && M.pMinCharge[t][g] == 0.0) {
                ExprBuilder e;
                e += M.vESSTotalCharge[M.idx_tg(t, g)];
                term(e, M.vCharge2ndBlock[M.idx_tg(t, g)], -1.0);
                add_eq(m, e, 0.0);
                ++n;
            } else if (M.pMaxCharge[t][g] && M.pMaxCharge2ndBlock[t][g]) {
                ExprBuilder e;
                term(e, M.vESSTotalCharge[M.idx_tg(t, g)], 1.0 / M.pMinCharge[t][g]);
                term(e, M.vCharge2ndBlock[M.idx_tg(t, g)], -1.0 / M.pMinCharge[t][g]);
                add_eq(m, e, 1.0);
                ++n;
            }
        }
    std::cout << "Added " << n << " eESSTotalCharge constraints.\n";
    if (log) {
        auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
        std::cout << "Generating storage operation           ... " << (int)dt << " s\n";
    }
}

void NetworkOperationModelFormulation_poi(TEPES& M, int log) {
    std::cout << "Network    operation model constraints ****\n";
    auto t0 = std::chrono::high_resolution_clock::now();
    auto& m = *M.model;
    int n1 = 0, n2 = 0;
    auto is_lca = [&](int l) {
        for (auto& x : M.lca)
            if (x.ni == M.la[l].ni && x.nf == M.la[l].nf) return true;
        return false;
    };
    auto is_laa = [&](int l) {
        for (auto& x : M.laa)
            if (x.ni == M.la[l].ni && x.nf == M.la[l].nf) return true;
        return false;
    };
    for (int t = 0; t < M.T; ++t) {
        for (int l = 0; l < M.LA; ++l) {
            if (!is_laa(l)) continue;
            if (M.pIndBinSingleNode != 0) continue;
            if (M.pPeriodIniNet[l] > M.period_year || M.pPeriodFinNet[l] < M.period_year) continue;
            if (M.pLineX[l] <= 0) continue;
            double Mb = M.pBigMFlowBck[l];
            ExprBuilder e;
            term(e, M.vFlow[M.idx_tla(t, l)], 1.0 / Mb);
            term(e, M.vTheta[M.idx_tnd(t, M.la[l].ni)], -M.pSBase / M.pLineX[l] / Mb);
            term(e, M.vTheta[M.idx_tnd(t, M.la[l].nf)], M.pSBase / M.pLineX[l] / Mb);
            if (is_lca(l)) {
                term(e, M.vLineCommit[M.idx_tla(t, l)], -1.0);
                add_ge(m, e, -1.0);
            } else {
                add_eq(m, e, 0.0);
            }
            ++n1;
        }
    }
    std::cout << "Added eKirchhoff2ndLaw1     ... " << n1 << " rows\n";
    for (int t = 0; t < M.T; ++t) {
        for (int l = 0; l < M.LA; ++l) {
            if (!is_laa(l) || !is_lca(l)) continue;
            if (M.pIndBinSingleNode != 0) continue;
            if (M.pPeriodIniNet[l] > M.period_year || M.pPeriodFinNet[l] < M.period_year) continue;
            if (M.pLineX[l] <= 0) continue;
            double Mf = M.pBigMFlowFrw[l];
            ExprBuilder e;
            term(e, M.vFlow[M.idx_tla(t, l)], 1.0 / Mf);
            term(e, M.vTheta[M.idx_tnd(t, M.la[l].ni)], -M.pSBase / M.pLineX[l] / Mf);
            term(e, M.vTheta[M.idx_tnd(t, M.la[l].nf)], M.pSBase / M.pLineX[l] / Mf);
            term(e, M.vLineCommit[M.idx_tla(t, l)], 1.0);
            add_le(m, e, 1.0);
            ++n2;
        }
    }
    std::cout << "Added eKirchhoff2ndLaw2     ... " << n2 << " rows\n";
    std::cout << "Added eNetCapacityInvest (vNetworkInvest-NTC) ... 0 rows\n";
    if (log) {
        auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
        std::cout << "Generating network    constraints      ... " << (int)dt << " s\n";
    }
}

void EVplan_modelformulation(TEPES& M) {
    auto& m = *M.model;
    for (int k = 0; k < M.T; ++k) {
        if (!M.grid_p_chr[k].empty() || !M.grid_p_dis[k].empty()) {
            ExprBuilder e;
            for (auto& v : M.grid_p_chr[k]) e += v;
            for (auto& v : M.grid_p_dis[k]) e += v;
            term(e, M.N_pile, -M.P_CHR_MAX);
            add_le(m, e, 0.0);
        }
        if (!M.grid_p_dis[k].empty()) {
            ExprBuilder e;
            for (auto& v : M.grid_p_dis[k]) e += v;
            add_le(m, e, M.MAX_STATION_DISCHARGE);
        }
    }
    for (auto& c : M.ev_cohorts) {
        int t = c.t, V = c.V;
        int endk = std::min(M.T, t + V);
        {
            ExprBuilder e;
            e += c.E[0];
            add_eq(m, e, M.initial_energy_per_cohort[t]);
        }
        for (int i = 0; i < (int)c.P_chr.size(); ++i) {
            ExprBuilder e;
            e += c.E[i + 1];
            term(e, c.E[i], -1.0);
            term(e, c.P_chr[i], -M.EFF_CHR);
            term(e, c.P_dis[i], 1.0 / M.EFF_DIS);
            add_eq(m, e, 0.0);
        }
        double max_ach = M.initial_energy_per_cohort[t] + V * M.ev_arrivals[t] * M.P_CHR_MAX * M.EFF_CHR;
        double feas = std::min(M.target_energy_per_cohort[t], max_ach);
        ExprBuilder e;
        e += c.E[(int)c.E.size() - 1];
        add_ge(m, e, feas);
        (void)endk;
    }
    term(M.eTotalTCost, M.N_pile, M.C_INV_PILE);
    for (auto& c : M.ev_cohorts) {
        for (int i = 0; i < (int)c.P_chr.size(); ++i) {
            int k = c.t + i;
            term(M.eTotalTCost, c.P_chr[i], M.P_ELEC_CHR[k]);
            term(M.eTotalTCost, c.P_dis[i], -M.P_ELEC_DIS[k]);
        }
    }
    m.set_objective(M.eTotalTCost, ObjectiveSense::Minimize);
}

void modelformulation_ammonia(TEPES& M) {
    auto& m = *M.model;
    auto& P = M.params_ammonia;
    M.cap_elec = add_var(m, 0, 1e6, VariableDomain::Continuous, "ammonia_cap_elec");
    M.cap_nh3 = add_var(m, 0, 1e6, VariableDomain::Continuous, "ammonia_cap_nh3");
    M.p_grid.resize(M.T);
    M.p_elec.resize(M.T);
    M.p_nh3.resize(M.T);
    M.h2_prod.resize(M.T);
    M.h2_cons.resize(M.T);
    M.h2_sold.resize(M.T);
    M.nh3_prod.resize(M.T);
    M.u_elec.resize(M.T);
    M.u_nh3.resize(M.T);
    double big_m = 2e6;
    for (int t = 0; t < M.T; ++t) {
        M.p_grid[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "ag_" + std::to_string(t));
        M.p_elec[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "ae_" + std::to_string(t));
        M.p_nh3[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "an_" + std::to_string(t));
        M.h2_prod[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "h2p_" + std::to_string(t));
        M.h2_cons[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "h2c_" + std::to_string(t));
        M.h2_sold[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "h2s_" + std::to_string(t));
        M.nh3_prod[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "nh3_" + std::to_string(t));
        M.u_elec[t] = add_var(m, 0, 1, VariableDomain::Continuous, "ue_" + std::to_string(t));
        M.u_nh3[t] = add_var(m, 0, 1, VariableDomain::Continuous, "un_" + std::to_string(t));
        {
            ExprBuilder e;
            e += M.p_elec[t];
            term(e, M.cap_elec, -1);
            add_le(m, e, 0);
        }
        {
            ExprBuilder e;
            e += M.p_elec[t];
            term(e, M.u_elec[t], -big_m);
            add_le(m, e, 0);
        }
        {
            ExprBuilder e;
            e += M.p_elec[t];
            term(e, M.cap_elec, -P["min_elec_load"]);
            term(e, M.u_elec[t], -big_m);
            add_ge(m, e, -big_m);
        }
        {
            ExprBuilder e;
            e += M.p_nh3[t];
            term(e, M.cap_nh3, -1);
            add_le(m, e, 0);
        }
        {
            ExprBuilder e;
            e += M.p_nh3[t];
            term(e, M.u_nh3[t], -big_m);
            add_le(m, e, 0);
        }
        {
            ExprBuilder e;
            e += M.p_nh3[t];
            term(e, M.cap_nh3, -P["min_nh3_load"]);
            term(e, M.u_nh3[t], -big_m);
            add_ge(m, e, -big_m);
        }
        {
            ExprBuilder e;
            e += M.p_grid[t];
            term(e, M.p_elec[t], -1);
            term(e, M.p_nh3[t], -1);
            add_eq(m, e, 0);
        }
        {
            ExprBuilder e;
            e += M.h2_prod[t];
            term(e, M.p_elec[t], -P["rate_h2_prod"]);
            add_eq(m, e, 0);
        }
        {
            ExprBuilder e;
            e += M.nh3_prod[t];
            term(e, M.p_nh3[t], -P["rate_nh3_prod"]);
            add_eq(m, e, 0);
        }
        {
            ExprBuilder e;
            e += M.h2_cons[t];
            term(e, M.p_nh3[t], -P["rate_nh3_h2_in"]);
            add_eq(m, e, 0);
        }
        {
            ExprBuilder e;
            e += M.h2_prod[t];
            term(e, M.h2_cons[t], -1);
            term(e, M.h2_sold[t], -1);
            add_eq(m, e, 0);
        }
        term(M.eTotalTCost, M.p_grid[t], P["price_grid"]);
        term(M.eTotalTCost, M.h2_sold[t], -P["price_h2"]);
        term(M.eTotalTCost, M.nh3_prod[t], -P["price_nh3"]);
    }
    term(M.eTotalTCost, M.cap_elec, P["cost_elec"]);
    term(M.eTotalTCost, M.cap_nh3, P["cost_nh3"]);
    {
        ExprBuilder e;
        for (int t = 0; t < M.T; ++t) term(e, M.p_grid[t], P["price_grid"]);
        term(e, M.cap_elec, P["cost_elec"]);
        term(e, M.cap_nh3, P["cost_nh3"]);
        add_le(m, e, P["max_annual_cost"]);
    }
    m.set_objective(M.eTotalTCost, ObjectiveSense::Minimize);
    std::cout << "氨模型构建完成\n";
}

static VariableIndex add_int(ModelBase& m, int lo, int hi, const std::string& n) {
    return add_var(m, (double)lo, (double)hi, VariableDomain::Integer, n);
}
static VariableIndex add_bin(ModelBase& m, const std::string& n) {
    return add_var(m, 0, 1, VariableDomain::Binary, n);
}

void ThermalSettingUpVariables_poi(TEPES& M) {
    std::cout << "\n创建热系统决策变量                   ****\n";
    auto t0 = std::chrono::high_resolution_clock::now();
    auto& m = *M.model;
    double cu = M.pThermalCapacityUnit;
    double kw_to_unit = 0.001 / cu;
    int T = M.T;
    auto imin = [&](const char* k, double d) { return (int)(tp(M, k, d) * kw_to_unit); };
    auto imax = [&](const char* k, double d) { return (int)(tp(M, k, d) * kw_to_unit); };
    M.vCAP_boiler = add_int(m, imin("boiler_capacity_min", 0), imax("boiler_capacity_max", 150000), "vCAP_boiler_units");
    M.vCAP_hp = add_int(m, imin("hp_capacity_min", 0), imax("hp_capacity_max", 150000), "vCAP_hp_units");
    M.vInstall_boiler = add_bin(m, "vInstall_boiler");
    M.vInstall_hp = add_bin(m, "vInstall_hp");
    M.has_chp = tp(M, "enable_chp_planning", 1) > 0;
    if (M.has_chp) {
        M.vCAP_chp = add_int(m, imin("chp_capacity_min", 0), imax("chp_capacity_max", 200000), "vCAP_chp_units");
        M.vInstall_chp = add_bin(m, "vInstall_chp");
    }
    M.vP_boiler_elec.resize(T);
    M.vP_hp_elec.resize(T);
    M.vQ_boiler_out.resize(T);
    M.vQ_hp_out.resize(T);
    M.vQ_district.resize(T);
    for (int t = 0; t < T; ++t) {
        M.vP_boiler_elec[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Pboil_" + std::to_string(t));
        M.vP_hp_elec[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Php_" + std::to_string(t));
        M.vQ_boiler_out[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Qboil_" + std::to_string(t));
        M.vQ_hp_out[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Qhp_" + std::to_string(t));
        M.vQ_district[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Qdist_" + std::to_string(t));
    }
    M.vCAP_storage = add_int(m, imin("storage_capacity_min", 0), imax("storage_capacity_max", 300000), "vCAP_storage_units");
    M.vInstall_storage = add_bin(m, "vInstall_storage");
    M.vE_thermal_storage.resize(T);
    M.vQ_storage_charge.resize(T);
    M.vQ_storage_discharge.resize(T);
    for (int t = 0; t < T; ++t) {
        M.vE_thermal_storage[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Ets_" + std::to_string(t));
        M.vQ_storage_charge[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Qtsc_" + std::to_string(t));
        M.vQ_storage_discharge[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Qtsd_" + std::to_string(t));
    }
    if (M.has_chp) {
        M.vP_chp_elec.resize(T);
        M.vQ_chp_heat.resize(T);
        M.vF_chp_gas.resize(T);
        for (int t = 0; t < T; ++t) {
            M.vP_chp_elec[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Pchp_" + std::to_string(t));
            M.vQ_chp_heat[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Qchp_" + std::to_string(t));
            M.vF_chp_gas[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Fchp_" + std::to_string(t));
        }
    }
    M.has_chiller = tp(M, "enable_chiller_planning", 0) > 0;
    if (M.has_chiller) {
        M.vCAP_chiller = add_int(m, imin("chiller_capacity_min", 0), imax("chiller_capacity_max", 200000), "vCAP_chiller_units");
        M.vInstall_chiller = add_bin(m, "vInstall_chiller");
        M.vQ_chiller_cool.resize(T);
        M.vQ_chiller_heat_in.resize(T);
        for (int t = 0; t < T; ++t) {
            M.vQ_chiller_cool[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Qcc_" + std::to_string(t));
            M.vQ_chiller_heat_in[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Qchi_" + std::to_string(t));
        }
        std::cout << "  吸收式制冷机变量已创建: vCAP, vInstall, " << T << "个vQ_cool, " << T << "个vQ_heat_in\n";
    }
    M.has_comp = tp(M, "enable_comp_chiller_planning", 0) > 0;
    if (M.has_comp) {
        M.vCAP_comp = add_int(m, imin("comp_chiller_capacity_min", 0), imax("comp_chiller_capacity_max", 200000), "vCAP_comp_units");
        M.vInstall_comp = add_bin(m, "vInstall_comp");
        M.vQ_comp_cool.resize(T);
        M.vP_comp_elec.resize(T);
        for (int t = 0; t < T; ++t) {
            M.vQ_comp_cool[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Qcomp_" + std::to_string(t));
            M.vP_comp_elec[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Pcomp_" + std::to_string(t));
        }
        std::cout << "  压缩式制冷机变量已创建: vCAP, vInstall, " << T << "个vQ_cool, " << T << "个vP_elec\n";
    }
    M.has_gt = tp(M, "enable_gt_planning", 1) > 0;
    if (M.has_gt) {
        M.vCAP_gt = add_int(m, imin("gt_capacity_min", 0), imax("gt_capacity_max", 326000), "vCAP_gt_units");
        M.vInstall_gt = add_bin(m, "vInstall_gt");
        M.vP_gt_elec.resize(T);
        M.vQ_gt_heat.resize(T);
        M.vF_gt_gas.resize(T);
        for (int t = 0; t < T; ++t) {
            M.vP_gt_elec[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Pgt_" + std::to_string(t));
            M.vQ_gt_heat[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Qgt_" + std::to_string(t));
            M.vF_gt_gas[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Fgt_" + std::to_string(t));
        }
        std::cout << "  GT变量已创建: vCAP, vInstall, " << T << "个vP_elec, " << T << "个vQ_heat, " << T << "个vF_gas\n";
    }
    M.has_st = tp(M, "enable_st_planning", 1) > 0 && M.has_gt;
    if (M.has_st) {
        M.vCAP_st = add_int(m, imin("st_capacity_min", 0), imax("st_capacity_max", 5000), "vCAP_st_units");
        M.vInstall_st = add_bin(m, "vInstall_st");
        M.vP_st_elec.resize(T);
        M.vQ_st_steam.resize(T);
        for (int t = 0; t < T; ++t) {
            M.vP_st_elec[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Pst_" + std::to_string(t));
            M.vQ_st_steam[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Qst_" + std::to_string(t));
        }
        std::cout << "  ST变量已创建: vCAP, vInstall, " << T << "个vP_elec, " << T << "个vQ_steam\n";
    }
    std::cout << "  时间步映射已创建: " << T << " 个时间点\n";
    auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
    std::cout << "热系统决策变量创建完成               ... " << dt << " s\n";
}

static void cap_install(ModelBase& m, VariableIndex cap, VariableIndex inst, int lo, int hi) {
    if (lo > 0) {
        ExprBuilder e;
        e += cap;
        term(e, inst, -(double)lo);
        add_ge(m, e, 0);
    }
    ExprBuilder e;
    e += cap;
    term(e, inst, -(double)hi);
    add_le(m, e, 0);
}

void ThermalInvestmentModelFormulation_poi(TEPES& M, int log) {
    std::cout << "\n热系统投资规划约束                   ****\n";
    auto t0 = std::chrono::high_resolution_clock::now();
    auto& m = *M.model;
    double kw_to_unit = 0.001 / M.pThermalCapacityUnit;
    auto iu = [&](const char* k, double d) { return (int)(tp(M, k, d) * kw_to_unit); };
    cap_install(m, M.vCAP_boiler, M.vInstall_boiler, iu("boiler_capacity_min", 0), iu("boiler_capacity_max", 150000));
    cap_install(m, M.vCAP_hp, M.vInstall_hp, iu("hp_capacity_min", 0), iu("hp_capacity_max", 150000));
    if (M.has_chp) cap_install(m, M.vCAP_chp, M.vInstall_chp, iu("chp_capacity_min", 0), iu("chp_capacity_max", 200000));
    cap_install(m, M.vCAP_storage, M.vInstall_storage, iu("storage_capacity_min", 0), iu("storage_capacity_max", 300000));
    if (M.has_chiller)
        cap_install(m, M.vCAP_chiller, M.vInstall_chiller, iu("chiller_capacity_min", 0), iu("chiller_capacity_max", 200000));
    if (M.has_comp)
        cap_install(m, M.vCAP_comp, M.vInstall_comp, iu("comp_chiller_capacity_min", 0), iu("comp_chiller_capacity_max", 200000));
    if (M.has_gt) cap_install(m, M.vCAP_gt, M.vInstall_gt, iu("gt_capacity_min", 0), iu("gt_capacity_max", 326000));
    if (M.has_st) cap_install(m, M.vCAP_st, M.vInstall_st, iu("st_capacity_min", 0), iu("st_capacity_max", 5000));
    if (log) {
        auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
        std::cout << "热系统投资规划约束添加完成           ... " << dt << " s\n";
    }
}

void ThermalGenerationOperationModelFormulation_poi(TEPES& M, int log) {
    std::cout << "\n热源运行约束                           ****\n";
    auto t0 = std::chrono::high_resolution_clock::now();
    auto& m = *M.model;
    double cu = M.pThermalCapacityUnit;
    double boiler_eff = tp(M, "boiler_efficiency", 0.99);
    double hp_cop = tp(M, "hp_cop", 2.43);
    double district_q_max = tp(M, "district_q_max", 200000);
    for (int t = 0; t < M.T; ++t) {
        {
            ExprBuilder e;
            e += M.vQ_boiler_out[t];
            term(e, M.vP_boiler_elec[t], -boiler_eff);
            add_eq(m, e, 0);
        }
        {
            ExprBuilder e;
            e += M.vQ_boiler_out[t];
            term(e, M.vCAP_boiler, -cu);
            add_le(m, e, 0);
        }
        {
            ExprBuilder e;
            e += M.vQ_hp_out[t];
            term(e, M.vP_hp_elec[t], -hp_cop);
            add_eq(m, e, 0);
        }
        {
            ExprBuilder e;
            e += M.vQ_hp_out[t];
            term(e, M.vCAP_hp, -cu);
            add_le(m, e, 0);
        }
        {
            ExprBuilder e;
            e += M.vQ_district[t];
            add_le(m, e, district_q_max);
        }
    }
    if (M.has_chp) {
        double ee = tp(M, "chp_elec_efficiency", 0.45);
        double he = tp(M, "chp_heat_efficiency", 0.41);
        for (int t = 0; t < M.T; ++t) {
            ExprBuilder e1;
            e1 += M.vP_chp_elec[t];
            term(e1, M.vCAP_chp, -cu);
            add_le(m, e1, 0);
            ExprBuilder e2;
            e2 += M.vP_chp_elec[t];
            term(e2, M.vF_chp_gas[t], -ee);
            add_eq(m, e2, 0);
            ExprBuilder e3;
            e3 += M.vQ_chp_heat[t];
            term(e3, M.vF_chp_gas[t], -he);
            add_eq(m, e3, 0);
        }
    }
    if (M.has_gt) {
        double ee = tp(M, "gt_elec_efficiency", 0.404);
        double he = tp(M, "gt_heat_efficiency", 0.534);
        for (int t = 0; t < M.T; ++t) {
            ExprBuilder e1;
            e1 += M.vP_gt_elec[t];
            term(e1, M.vCAP_gt, -cu);
            add_le(m, e1, 0);
            ExprBuilder e2;
            e2 += M.vP_gt_elec[t];
            term(e2, M.vF_gt_gas[t], -ee);
            add_eq(m, e2, 0);
            ExprBuilder e3;
            e3 += M.vQ_gt_heat[t];
            term(e3, M.vF_gt_gas[t], -he);
            add_eq(m, e3, 0);
        }
    }
    if (M.has_st) {
        double ee = tp(M, "st_elec_efficiency", 0.30);
        for (int t = 0; t < M.T; ++t) {
            ExprBuilder e1;
            e1 += M.vP_st_elec[t];
            term(e1, M.vCAP_st, -cu);
            add_le(m, e1, 0);
            ExprBuilder e2;
            e2 += M.vP_st_elec[t];
            term(e2, M.vQ_st_steam[t], -ee);
            add_eq(m, e2, 0);
            ExprBuilder e3;
            e3 += M.vQ_st_steam[t];
            term(e3, M.vQ_gt_heat[t], -1);
            add_le(m, e3, 0);
        }
    }
    if (M.has_chiller) {
        double eta_min = tp(M, "chiller_eta_min", 0.65);
        double eta_max = tp(M, "chiller_eta_max", 0.80);
        double T_min = tp(M, "chiller_T_min", 10);
        double T_max = tp(M, "chiller_T_max", 40);
        double T_design = tp(M, "chiller_T_design", 30);
        double c1 = (1.0 / eta_max - 1.0 / eta_min) / (T_max - T_min);
        double c2 = 1.0 / eta_max - T_max * c1;
        double alpha = c1 * T_design + c2;
        for (int t = 0; t < M.T; ++t) {
            ExprBuilder eA;
            eA += M.vQ_chiller_cool[t];
            term(eA, M.vCAP_chiller, -cu);
            add_le(m, eA, 0);
            ExprBuilder eB;
            eB += M.vQ_chiller_heat_in[t];
            term(eB, M.vQ_chiller_cool[t], -alpha);
            add_eq(m, eB, 0);
        }
        std::cout << "  吸收式制冷机运行约束建立: alpha=" << alpha << " (设计温度" << T_design << "°C)\n";
    }
    if (M.has_comp) {
        double cop = tp(M, "comp_chiller_cop", 2.7);
        double load_max = tp(M, "comp_chiller_load_max", 1.0);
        for (int t = 0; t < M.T; ++t) {
            ExprBuilder eE;
            eE += M.vQ_comp_cool[t];
            term(eE, M.vP_comp_elec[t], -cop);
            add_eq(m, eE, 0);
            ExprBuilder eF;
            eF += M.vQ_comp_cool[t];
            term(eF, M.vCAP_comp, -load_max * cu);
            add_le(m, eF, 0);
        }
        std::cout << "  压缩式制冷机运行约束建立: COP=" << cop << ", 负荷范围["
                  << tp(M, "comp_chiller_load_min", 0.2) * 100 << "%~" << load_max * 100 << "%]\n";
    }
    if (M.has_chiller || M.has_comp) {
        for (int t = 0; t < M.T; ++t) {
            ExprBuilder e;
            if (M.has_chiller) e += M.vQ_chiller_cool[t];
            if (M.has_comp) e += M.vQ_comp_cool[t];
            add_eq(m, e, M.pChillerDemand[t]);
        }
        std::cout << "  制冷负荷平衡约束(实时等号): 全年" << M.T << "个时段，供冷=需求\n";
    }
    if (log) {
        auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
        std::cout << "热源运行约束添加完成                   ... " << dt << " s\n";
    }
}

void ThermalStorageOperationModelFormulation_poi(TEPES& M, int log) {
    std::cout << "\n储热罐运行约束                       ****\n";
    auto t0 = std::chrono::high_resolution_clock::now();
    auto& m = *M.model;
    double cu = M.pThermalCapacityUnit;
    double init_r = tp(M, "storage_init_ratio", 0.3);
    double cr = tp(M, "storage_charge_rate", 0.5);
    double dr = tp(M, "storage_discharge_rate", 0.5);
    double eta_c = tp(M, "storage_eta_charge", 0.98);
    double eta_d = tp(M, "storage_eta_discharge", 0.98);
    double loss = tp(M, "storage_loss_rate", 0.02) / 100.0;
    for (int t = 0; t < M.T; ++t) {
        {
            ExprBuilder e;
            e += M.vE_thermal_storage[t];
            term(e, M.vCAP_storage, -cu);
            add_le(m, e, 0);
        }
        {
            ExprBuilder e;
            e += M.vQ_storage_charge[t];
            term(e, M.vCAP_storage, -cr * cu);
            add_le(m, e, 0);
        }
        {
            ExprBuilder e;
            e += M.vQ_storage_discharge[t];
            term(e, M.vCAP_storage, -dr * cu);
            add_le(m, e, 0);
        }
        ExprBuilder e;
        e += M.vE_thermal_storage[t];
        if (t == 0)
            term(e, M.vCAP_storage, -(1 - loss) * init_r * cu);
        else
            term(e, M.vE_thermal_storage[t - 1], -(1 - loss));
        term(e, M.vQ_storage_charge[t], -eta_c);
        term(e, M.vQ_storage_discharge[t], 1.0 / eta_d);
        add_eq(m, e, 0);
    }
    if (log) {
        auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
        std::cout << "储热罐运行约束添加完成               ... " << dt << " s\n";
    }
}

void ThermalBalanceModelFormulation_poi(TEPES& M, int log) {
    std::cout << "\n热平衡约束                            ****\n";
    auto t0 = std::chrono::high_resolution_clock::now();
    auto& m = *M.model;
    for (int t = 0; t < M.T; ++t) {
        ExprBuilder e;
        e += M.vQ_boiler_out[t];
        e += M.vQ_hp_out[t];
        e += M.vQ_district[t];
        if (M.has_chp) e += M.vQ_chp_heat[t];
        if (M.has_gt) e += M.vQ_gt_heat[t];
        if (M.has_st) term(e, M.vQ_st_steam[t], -1);
        e += M.vQ_storage_discharge[t];
        term(e, M.vQ_storage_charge[t], -1);
        if (M.has_chiller) term(e, M.vQ_chiller_heat_in[t], -1);
        add_eq(m, e, M.pThermalDemand[t]);
    }
    if (log) {
        auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
        std::cout << "热平衡约束添加完成                    ... " << dt << " s\n";
    }
}

void ThermalObjectiveFunction_poi(TEPES& M, int log) {
    std::cout << "\n热系统目标函数                        ****\n";
    auto t0 = std::chrono::high_resolution_clock::now();
    double N = tp(M, "investment_years", 10);
    double r = tp(M, "discount_rate", 0.08);
    double crf = r * std::pow(1 + r, N) / (std::pow(1 + r, N) - 1);
    double cu = M.pThermalCapacityUnit;
    term(M.eTotalTCost, M.vInstall_boiler, crf * tp(M, "boiler_fixed_cost", 0));
    term(M.eTotalTCost, M.vCAP_boiler, crf * tp(M, "boiler_unit_cost", 0) * cu);
    term(M.eTotalTCost, M.vInstall_hp, crf * tp(M, "hp_fixed_cost", 0));
    term(M.eTotalTCost, M.vCAP_hp, crf * tp(M, "hp_unit_cost", 1000) * cu);
    if (M.has_chp) {
        term(M.eTotalTCost, M.vInstall_chp, crf * tp(M, "chp_fixed_cost", 0));
        term(M.eTotalTCost, M.vCAP_chp, crf * tp(M, "chp_unit_cost", 3750) * cu);
    }
    if (M.has_gt) {
        term(M.eTotalTCost, M.vInstall_gt, crf * tp(M, "gt_fixed_cost", 0));
        term(M.eTotalTCost, M.vCAP_gt, crf * tp(M, "gt_unit_cost", 2905) * cu);
    }
    if (M.has_st) {
        term(M.eTotalTCost, M.vInstall_st, crf * tp(M, "st_fixed_cost", 0));
        term(M.eTotalTCost, M.vCAP_st, crf * tp(M, "st_unit_cost", 7000) * cu);
    }
    term(M.eTotalTCost, M.vInstall_storage, crf * tp(M, "storage_fixed_cost", 0));
    term(M.eTotalTCost, M.vCAP_storage, crf * tp(M, "storage_unit_cost", 204.2) * cu);
    if (M.has_chiller) {
        term(M.eTotalTCost, M.vInstall_chiller, crf * tp(M, "chiller_fixed_cost", 0));
        term(M.eTotalTCost, M.vCAP_chiller, crf * tp(M, "chiller_unit_cost", 800) * cu);
    }
    if (M.has_comp) {
        term(M.eTotalTCost, M.vInstall_comp, crf * tp(M, "comp_chiller_fixed_cost", 0));
        term(M.eTotalTCost, M.vCAP_comp, crf * tp(M, "comp_chiller_unit_cost", 600) * cu);
    }
    double dh = tp(M, "district_heat_price", 0.3);
    double gas = tp(M, "gas_price", 0.12);
    double gt_opex = tp(M, "gt_opex", 0.014);
    double st_opex = tp(M, "st_opex", 0.007);
    double pen = tp(M, "storage_penalty", 0.001);
    for (int t = 0; t < M.T; ++t) {
        term(M.eTotalTCost, M.vQ_district[t], dh);
        if (M.has_chp) term(M.eTotalTCost, M.vF_chp_gas[t], gas);
        if (M.has_gt) {
            term(M.eTotalTCost, M.vF_gt_gas[t], gas);
            term(M.eTotalTCost, M.vP_gt_elec[t], gt_opex);
        }
        if (M.has_st) term(M.eTotalTCost, M.vP_st_elec[t], st_opex);
        if (pen > 0) {
            term(M.eTotalTCost, M.vQ_storage_charge[t], pen);
            term(M.eTotalTCost, M.vQ_storage_discharge[t], pen);
        }
    }
    M.model->set_objective(M.eTotalTCost, ObjectiveSense::Minimize);
    if (log) {
        auto dt = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t0).count();
        std::cout << "热系统目标函数计算完成               ... " << dt << " s\n";
    }
}

void DC_modelformulation(TEPES& M, int log) {
    auto& m = *M.model;
    int T = M.T;
    int srv_exist = (int)dcp(M, "srv_exist_q", 0);
    int srv_max = (int)dcp(M, "srv_max_q", 10000);
    int srv_add_max = std::max(0, srv_max - srv_exist);
    M.vDC_SrvAdd = add_var(m, 0, (double)srv_add_max, VariableDomain::Integer, "vDC_SrvAdd");
    double cool_exist = dcp(M, "cool_exist_q_kw", 0);
    double cool_max = dcp(M, "cool_max_q_kw", 3000);
    M.vDC_CoolAdd = add_var(m, 0, std::max(0.0, cool_max - cool_exist), VariableDomain::Continuous, "vDC_CoolAdd_kW");
    double idle_p = dcp(M, "idle_p_kw", 0.35);
    double peak_p = dcp(M, "peak_p_kw", 0.7);
    double beta_1 = dcp(M, "beta_1", 1.05);
    double beta_2 = dcp(M, "beta_2_kw", 4.0);
    double srv_lambda_max = dcp(M, "srv_lambda_max", 10000);
    int D = M.dc_D;
    M.vDC_BatchExec.assign(T, std::vector<VariableIndex>(D + 1));
    for (int tau = 0; tau < T; ++tau) {
        ExprBuilder done;
        for (int k = 0; k <= D; ++k) {
            int tt = tau + k;
            if (tt >= T) {
                M.vDC_BatchExec[tau][k] = VariableIndex(-1);
                continue;
            }
            M.vDC_BatchExec[tau][k] = add_var(m, 0, kInf, VariableDomain::Continuous,
                                              "Bex_" + std::to_string(tau) + "_" + std::to_string(tt));
            done += M.vDC_BatchExec[tau][k];
        }
        add_eq(m, done, M.lambda_batch[tau]);
    }
    M.vDC_NSrv.resize(T);
    M.vDC_L_tasks.resize(T);
    M.vDC_P_IT.resize(T);
    M.vDC_P_cool.resize(T);
    M.vDC_H_cool.resize(T);
    M.vDC_P_DC.resize(T);
    for (int t = 0; t < T; ++t) {
        M.vDC_NSrv[t] = add_var(m, 0, (double)srv_max, VariableDomain::Continuous, "Nsrv_" + std::to_string(t));
        M.vDC_L_tasks[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Ltsk_" + std::to_string(t));
        M.vDC_P_IT[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "PIT_" + std::to_string(t));
        M.vDC_P_cool[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Pcl_" + std::to_string(t));
        M.vDC_H_cool[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "Hcl_" + std::to_string(t));
        M.vDC_P_DC[t] = add_var(m, 0, kInf, VariableDomain::Continuous, "PDC_" + std::to_string(t));
        {
            ExprBuilder e;
            e += M.vDC_NSrv[t];
            term(e, M.vDC_SrvAdd, -1);
            add_le(m, e, (double)srv_exist);
        }
        ExprBuilder demand;
        demand += M.lambda_inter[t];
        int tau0 = std::max(0, t - D);
        for (int tau = tau0; tau <= t; ++tau) {
            int k = t - tau;
            if (k <= D && M.vDC_BatchExec[tau][k].index >= 0) demand += M.vDC_BatchExec[tau][k];
        }
        {
            ExprBuilder e;
            e += M.vDC_L_tasks[t];
            e -= demand;
            add_ge(m, e, 0);
        }
        if (srv_lambda_max > 0) {
            ExprBuilder e;
            e += M.vDC_L_tasks[t];
            term(e, M.vDC_NSrv[t], -srv_lambda_max);
            add_le(m, e, 0);
            ExprBuilder e2;
            e2 += M.vDC_P_IT[t];
            term(e2, M.vDC_NSrv[t], -idle_p);
            term(e2, M.vDC_L_tasks[t], -(peak_p - idle_p) / srv_lambda_max);
            add_eq(m, e2, 0);
        }
        {
            ExprBuilder e;
            e += M.vDC_P_cool[t];
            term(e, M.vDC_H_cool[t], -beta_1);
            add_eq(m, e, beta_2);
        }
        {
            ExprBuilder e;
            e += M.vDC_P_cool[t];
            term(e, M.vDC_CoolAdd, -1);
            add_le(m, e, cool_exist);
        }
        {
            ExprBuilder e;
            e += M.vDC_P_DC[t];
            term(e, M.vDC_P_IT[t], -1);
            term(e, M.vDC_P_cool[t], -1);
            add_eq(m, e, M.p_other_kw[t]);
        }
    }
    bool indoor_on = (int)dcp(M, "indoor_temp_enable", 0) == 1;
    if (indoor_on) {
        double R_dc = dcp(M, "dc_R_C_per_kW", 1.9);
        double C_dc = dcp(M, "dc_C_kWh_per_C", 16.19);
        double Tini = dcp(M, "dc_T_in_ini_C", 20);
        double Tmin = dcp(M, "dc_T_in_min_C", 15);
        double Tmax = dcp(M, "dc_T_in_max_C", 25);
        double rmin = dcp(M, "dc_r_in_min_C_per_h", -5);
        double rmax = dcp(M, "dc_r_in_max_C_per_h", 5);
        double kappa = dcp(M, "kappa_IT_kwth_per_kw", 1);
        M.vDC_T_in.resize(T);
        for (int t = 0; t < T; ++t)
            M.vDC_T_in[t] = add_var(m, Tmin, Tmax, VariableDomain::Continuous, "Tin_" + std::to_string(t));
        {
            ExprBuilder e;
            e += M.vDC_T_in[0];
            add_eq(m, e, Tini);
        }
        for (int t = 0; t < T - 1; ++t) {
            double dt_h = M.pLoadLevelDuration[t];
            double a = dt_h / std::max(C_dc, 1e-9);
            double b = dt_h / std::max(C_dc * R_dc, 1e-9);
            ExprBuilder e;
            e += M.vDC_T_in[t + 1];
            term(e, M.vDC_T_in[t], -(1.0 - b));
            term(e, M.vDC_P_IT[t], -a * kappa);
            term(e, M.vDC_H_cool[t], a);
            add_eq(m, e, b * M.t_out_C[t]);
            if (dt_h > 0) {
                ExprBuilder e1;
                e1 += M.vDC_T_in[t + 1];
                term(e1, M.vDC_T_in[t], -1);
                add_ge(m, e1, rmin * dt_h);
                ExprBuilder e2;
                e2 += M.vDC_T_in[t + 1];
                term(e2, M.vDC_T_in[t], -1);
                add_le(m, e2, rmax * dt_h);
            }
        }
    }
    bool cpu_on = (int)dcp(M, "cpu_temp_enable", 0) == 1 && srv_lambda_max > 0;
    if (cpu_on) {
        double R_cpu = dcp(M, "cpu_R_K_per_W", 0.35);
        double C_cpu = dcp(M, "cpu_C_J_per_K", 340);
        double Tini = dcp(M, "cpu_T_ini_K", 318);
        double Tmax = dcp(M, "cpu_T_max_K", 343.15);
        double TinK = dcp(M, "cpu_T_in_K", 298.15);
        double n_ref = srv_exist > 0 ? (double)srv_exist : std::min(500.0, std::max(50.0, 0.05 * srv_max));
        double coeff = R_cpu * 1000.0 / n_ref;
        double tau_rc = std::max(R_cpu * C_cpu, 1e-9);
        M.vDC_T_cpu.resize(T);
        for (int t = 0; t < T; ++t) {
            M.vDC_T_cpu[t] = add_var(m, 200, 400, VariableDomain::Continuous, "Tcpu_" + std::to_string(t));
            ExprBuilder e;
            e += M.vDC_T_cpu[t];
            add_le(m, e, Tmax);
        }
        {
            ExprBuilder e;
            e += M.vDC_T_cpu[0];
            add_eq(m, e, Tini);
        }
        for (int t = 0; t < T - 1; ++t) {
            double dt_s = M.pLoadLevelDuration[t] * 3600.0;
            double alpha = std::min(1.0, dt_s / tau_rc);
            ExprBuilder e;
            e += M.vDC_T_cpu[t + 1];
            term(e, M.vDC_T_cpu[t], -(1.0 - alpha));
            term(e, M.vDC_P_IT[t], -alpha * coeff);
            if (indoor_on) {
                term(e, M.vDC_T_in[t], -alpha);
                add_eq(m, e, alpha * 273.15);
            } else {
                add_eq(m, e, alpha * TinK);
            }
        }
    }
    term(M.eTotalTCost, M.vDC_SrvAdd, dcp(M, "srv_inv_cny_per_unit", 8000));
    term(M.eTotalTCost, M.vDC_CoolAdd, dcp(M, "cool_inv_cny_per_kw", 1500));
    double srv_opex = dcp(M, "srv_opex_cny_per_kwh", 0.08);
    double cool_opex = dcp(M, "cool_opex_cny_per_kwh", 0.10);
    for (int t = 0; t < T; ++t) {
        double h = M.pLoadLevelDuration[t];
        term(M.eTotalTCost, M.vDC_P_IT[t], h * srv_opex);
        term(M.eTotalTCost, M.vDC_P_cool[t], h * cool_opex);
    }
    m.set_objective(M.eTotalTCost, ObjectiveSense::Minimize);
    if (log) {
        std::cout << "\n添加数据中心(EHCCS)变量与约束完成        ****\n";
        std::cout << "  DC 时间点数 T = " << T << "\n";
        std::cout << "  服务器新增上界 = " << srv_add_max << " 台\n";
        std::cout << "  冷却新增上界 = " << (cool_max - cool_exist) << " kW\n";
        if (cpu_on) std::cout << "  CPU 温度约束(离散线性): 启用\n";
    }
}
