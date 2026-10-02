"""
Open Generation, Storage, and Transmission Operation and Expansion Planning Model with RES and ESS (openTEPES) - June 07, 2022
"""

import time
import os
import psutil
# from   pyomo.opt     import SolverFactory
# from   pyomo.environ import Suffix, Set
from   opt.gurobi import *
import pyoptinterface as poi

# def ProblemSolving(DirName, CaseName, SolverName, OptModel, mTEPES, pIndLogConsole):
#     print('Problem solving                        ****')
#     _path = os.path.join(DirName, CaseName)
#     StartTime = time.time()

#     #%% activating all periods, scenarios, and load levels
#     mTEPES.del_component(mTEPES.st)
#     mTEPES.del_component(mTEPES.n )
#     mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and mTEPES.pStageWeight[stt] and sum(1 for (stt,nn) in mTEPES.s2n))
#     mTEPES.n  = Set(initialize=mTEPES.nn,  ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn  in                mTEPES.pDuration                                              )

#     #%% solving the problem
#     # Solver = SolverFactory(SolverName)  
#     Solver = pyomo_gurobi_solver()
#     if SolverName == 'gurobi':
#         # Solver.options['LogFile'       ] = _path+'/openTEPES_'+CaseName+'.log'
#         # Solver.options['IISFile'     ] = _path+'/openTEPES_'+CaseName+'.ilp'               # should be uncommented to show results of IIS
#         Solver.options['Method'        ] = 2                                                 # barrier method
#         Solver.options['MIPFocus'      ] = 1
#         Solver.options['Presolve'      ] = 2
#         Solver.options['RINS'          ] = 100
#         Solver.options['Crossover'     ] = -1
#         # Solver.options['BarConvTol'    ] = 1e-9
#         # Solver.options['BarQCPConvTol' ] = 0.025
#         Solver.options['MIPGap'        ] = 0.01
#         Solver.options['Threads'       ] = int((psutil.cpu_count(logical=True) + psutil.cpu_count(logical=False))/2)
#         Solver.options['TimeLimit'     ] =    36000
#         Solver.options['IterationLimit'] = 36000000
#     if mTEPES.pIndBinGenInvest()*len(mTEPES.gc) + mTEPES.pIndBinGenRetire()*len(mTEPES.gd) + mTEPES.pIndBinNetInvest()*len(mTEPES.lc) + mTEPES.pIndBinGenOperat()*len(mTEPES.nr) + mTEPES.pIndBinLineCommit()*len(mTEPES.la) + len(mTEPES.g2g) == 0:
#         OptModel.dual = Suffix(direction=Suffix.IMPORT)
#         OptModel.rc   = Suffix(direction=Suffix.IMPORT)
    
#     # 打印模型
#     # filename="opentepes_Model_Info.txt"
#     # with open(filename, 'w') as output_file:
#     #     OptModel.pprint(output_file)
    
    
#     SolverResults = Solver.solve(OptModel, tee=True , report_timing=True)              # tee=True displays the log of the solver
#     print('Termination Condition: ', SolverResults.solver.termination_condition)
#     assert (str(SolverResults.solver.termination_condition) == 'optimal' or str(SolverResults.solver.termination_condition) == 'maxTimeLimit' or str(SolverResults.solver.termination_condition) == 'maxIterations')
#     SolverResults.write()                                                              # summary of the solver results

#     #%% fix values of some variables to get duals and solve it again
#     # binary/continuous investment decisions are fixed to their optimal values
#     # binary            operation  decisions are fixed to their optimal values
#     if mTEPES.pIndBinGenInvest()*len(mTEPES.gc) + mTEPES.pIndBinGenRetire()*len(mTEPES.gd) + mTEPES.pIndBinNetInvest()*len(mTEPES.lc) + mTEPES.pIndBinGenOperat()*len(mTEPES.nr) + mTEPES.pIndBinLineCommit()*len(mTEPES.la) + len(mTEPES.g2g):
#         if mTEPES.pIndBinGenInvest()*len(mTEPES.gc):
#             for p,gc in mTEPES.p*mTEPES.gc:
#                 if mTEPES.pIndBinUnitInvest[gc] != 0:
#                     OptModel.vGenerationInvest[p,gc].fix(round(OptModel.vGenerationInvest[p,gc]()))
#                 else:
#                     OptModel.vGenerationInvest[p,gc].fix(      OptModel.vGenerationInvest[p,gc]())
#         if mTEPES.pIndBinGenRetire()*len(mTEPES.gd):
#             for p,gd in mTEPES.p*mTEPES.gd:
#                 if mTEPES.pIndBinUnitRetire[gd] != 0:
#                     OptModel.vGenerationRetire[p,gd].fix(round(OptModel.vGenerationRetire[p,gd]()))
#                 else:
#                     OptModel.vGenerationRetire[p,gd].fix(      OptModel.vGenerationRetire[p,gd]())
#         if mTEPES.pIndBinNetInvest()*len(mTEPES.lc):
#             for p,ni,nf,cc in mTEPES.p*mTEPES.lc:
#                 if mTEPES.pIndBinLineInvest[ni,nf,cc] != 0:
#                     OptModel.vNetworkInvest   [p,ni,nf,cc].fix(round(OptModel.vNetworkInvest[p,ni,nf,cc]()))
#                 else:
#                     OptModel.vNetworkInvest   [p,ni,nf,cc].fix(      OptModel.vNetworkInvest[p,ni,nf,cc]())
#         if mTEPES.pIndBinGenOperat()*len(mTEPES.nr):
#             for p,sc,n,nr in mTEPES.ps*mTEPES.n*mTEPES.nr:
#                 if mTEPES.pIndBinUnitCommit[nr] != 0:
#                     OptModel.vCommitment[p,sc,n,nr].fix(round(OptModel.vCommitment[p,sc,n,nr]()))
#                     OptModel.vStartUp   [p,sc,n,nr].fix(round(OptModel.vStartUp   [p,sc,n,nr]()))
#                     OptModel.vShutDown  [p,sc,n,nr].fix(round(OptModel.vShutDown  [p,sc,n,nr]()))
#         if mTEPES.pIndBinLineCommit()*len(mTEPES.la):
#             for p,sc,n,ni,nf,cc in mTEPES.ps*mTEPES.n*mTEPES.la:
#                 if mTEPES.pIndBinLineSwitch[ni,nf,cc] != 0:
#                     OptModel.vLineCommit  [p,sc,n,ni,nf,cc].fix(round(OptModel.vLineCommit   [p,sc,n,ni,nf,cc]()))
#                     OptModel.vLineOnState [p,sc,n,ni,nf,cc].fix(round(OptModel.vLineOnState  [p,sc,n,ni,nf,cc]()))
#                     OptModel.vLineOffState[p,sc,n,ni,nf,cc].fix(round(OptModel.vLineOffState [p,sc,n,ni,nf,cc]()))
#                 elif (ni,nf,cc) in mTEPES.lc:
#                     OptModel.vLineCommit  [p,sc,n,ni,nf,cc].fix(round(OptModel.vNetworkInvest[p,     ni,nf,cc]()))
#         if len(mTEPES.g2g):
#             for nr in mTEPES.nr:
#                 if sum(1 for g in mTEPES.nr if (nr,g) in mTEPES.g2g or (g,nr) in mTEPES.g2g):
#                     OptModel.vMaxCommitment[nr].fix(round(OptModel.vMaxCommitment[nr]()))
#         OptModel.dual = Suffix(direction=Suffix.IMPORT)
#         OptModel.rc   = Suffix(direction=Suffix.IMPORT)
#         SolverResults = Solver.solve(OptModel, tee=True, report_timing=True, warmstart=False)   # tee=True displays the log of the solver
#         SolverResults.write()                                                                  # summary of the solver results

#     SolvingTime = time.time() - StartTime
#     print('Solution time                                ... ', round(SolvingTime), 's')
#     print('Total system            cost [元]              ', OptModel.eTotalTCost.expr())
#     for p,sc in mTEPES.ps:
#         print('***** Period: '+str(p)+', Scenario: '+str(sc)+' ******')
#         print('      Total genr invest cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pGenInvestCost[gc      ] * OptModel.vGenerationInvest[p,gc      ]() for gc       in mTEPES.gc))
#         print('      Total genr retire cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pGenRetireCost[gd      ] * OptModel.vGenerationRetire[p,gd      ]() for gd       in mTEPES.gd))
#         print('      Total line invest cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pNetFixedCost [ni,nf,cc] * OptModel.vNetworkInvest   [p,ni,nf,cc]() for ni,nf,cc in mTEPES.lc))
#         print('      Total generation  cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb     [p,sc    ] * OptModel.vTotalGCost      [p,sc,n    ]() for n        in mTEPES.n ))
#         print('            grid exchan cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb     [p,sc    ] * sum(mTEPES.pLoadLevelDuration[n]() * mTEPES.pLinearVarCost  [nr] * OptModel.vTotalOutputAbs[p,sc,n,nr]() for nr in mTEPES.nr                                        ) for n in mTEPES.n ))        
#         print('            grid down   cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb     [p,sc    ] * sum(mTEPES.pLoadLevelDuration[n]() * mTEPES.pLinearVarCost  [nr] * OptModel.vTotalOutput   [p,sc,n,nr]() for nr in mTEPES.nr if OptModel.vTotalOutput[p,sc,n,nr]()>0) for n in mTEPES.n ))
#         print('            res oper    cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb     [p,sc    ] * sum(mTEPES.pLoadLevelDuration[n]() * mTEPES.pLinearOMCost   [r ] * OptModel.vTotalOutput   [p,sc,n,r ]() for r  in mTEPES.r                                         ) for n in mTEPES.n ))        
#         print('      Total ess oper    cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb     [p,sc    ] * OptModel.vTotalCCost      [p,sc,n    ]() for n        in mTEPES.n ))
#         print('      Total emission    cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb     [p,sc    ] * OptModel.vTotalECost      [p,sc,n    ]() for n        in mTEPES.n ))
#         print('      Total reliability cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb     [p,sc    ] * OptModel.vTotalRCost      [p,sc,n    ]() for n        in mTEPES.n ))
#         print('      Total abandon     cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb     [p,sc    ] * OptModel.vTotalAbandonCost[p,sc,n    ]() for n        in mTEPES.n ))

def ProblemSolving_poi(DirName, CaseName, SolverName, OptModel, mTEPES, pIndLogConsole):
    print('Problem solving                        ****')
    _path = os.path.join(DirName, CaseName)
    StartTime = time.time()

    # mTEPES.del_component(mTEPES.st)
    # mTEPES.del_component(mTEPES.n )
    # mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and mTEPES.pStageWeight[stt] and sum(1 for (stt,nn) in mTEPES.s2n))
    # mTEPES.n  = Set(initialize=mTEPES.nn,  ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn  in                mTEPES.pDuration                                              )

    mTEPES.st = [stt for stt in mTEPES.stt if stt in mTEPES.stt and stt == stt and mTEPES.pStageWeight[stt] and sum(1 for (stt,nn) in mTEPES.s2n)]
    mTEPES.n  = [nn  for nn  in mTEPES.nn  if nn  in                               mTEPES.pDuration                                              ]
    
    # Solver = pyomo_gurobi_solver()
    if SolverName == 'gurobi':
        OptModel.set_raw_parameter_int('Method',    2)
        OptModel.set_raw_parameter_int('MIPFocus',  1)
        OptModel.set_raw_parameter_int('RINS',    100)
        OptModel.set_raw_parameter_int('Crossover', -1)
        OptModel.set_raw_parameter_double('MIPGap',  0.001)
        OptModel.set_raw_parameter_int('Threads', int((psutil.cpu_count(logical=True) + psutil.cpu_count(logical=False))/2))
        OptModel.set_raw_parameter_double('TimeLimit', 36000)
        OptModel.set_raw_parameter_double('IterationLimit', 36000000)
    # if mTEPES.pIndBinGenInvest*len(mTEPES.gc) + mTEPES.pIndBinGenRetire*len(mTEPES.gd) + mTEPES.pIndBinNetInvest*len(mTEPES.lc) + mTEPES.pIndBinGenOperat*len(mTEPES.nr) + mTEPES.pIndBinLineCommit*len(mTEPES.la) + len(mTEPES.g2g) == 0:
    #     OptModel.dual = Suffix(direction=Suffix.IMPORT)
    #     OptModel.rc   = Suffix(direction=Suffix.IMPORT)
    
    OptModel.set_raw_parameter_int
    OptModel.optimize()
    # OptModel.get_model_attribute(poi.ModelAttribute.PrimalStatus)


    
    try:
        objval = OptModel.get_model_attribute(poi.ModelAttribute.ObjectiveValue)
        print('Objective Value: ', objval)
        status = OptModel.get_model_attribute(poi.ModelAttribute.TerminationStatus)
        mTEPES.pSolveStatus = status
        
    except Exception as e:
        print(f"Failed to get Objective Value. Model might be infeasible. Error: {e}")
        print("Computing IIS to diagnose infeasibility...")
        OptModel.computeIIS()
        ilp_path = os.path.join(DirName, CaseName, "infeasible_EV_model.ilp")
        OptModel.write(ilp_path)
        print(f"IIS written to {ilp_path}. Exiting.")
        import sys
        sys.exit(1)

    # 打印模型
    # filename= os.path.join(_path, "opentepes_Model_Info.lp")
    # OptModel.write(filename)
    
    
    # SolverResults = Solver.solve(OptModel, tee=True , report_timing=True)              # tee=True displays the log of the solver
    # print('Termination Condition: ', SolverResults.solver.termination_condition)
    # assert (str(SolverResults.solver.termination_condition) == 'optimal' or str(SolverResults.solver.termination_condition) == 'maxTimeLimit' or str(SolverResults.solver.termination_condition) == 'maxIterations')
    # SolverResults.write()                                                              # summary of the solver results

    #%% fix values of some variables to get duals and solve it again
    # binary/continuous investment decisions are fixed to their optimal values
    # binary            operation  decisions are fixed to their optimal values
    # if mTEPES.pIndBinGenInvest()*len(mTEPES.gc) + mTEPES.pIndBinGenRetire()*len(mTEPES.gd) + mTEPES.pIndBinNetInvest()*len(mTEPES.lc) + mTEPES.pIndBinGenOperat()*len(mTEPES.nr) + mTEPES.pIndBinLineCommit()*len(mTEPES.la) + len(mTEPES.g2g):
    #     if mTEPES.pIndBinGenInvest()*len(mTEPES.gc):
    #         for p,gc in mTEPES.p*mTEPES.gc:
    #             if mTEPES.pIndBinUnitInvest[gc] != 0:
    #                 OptModel.vGenerationInvest[p,gc].fix(round(OptModel.vGenerationInvest[p,gc]()))
    #             else:
    #                 OptModel.vGenerationInvest[p,gc].fix(      OptModel.vGenerationInvest[p,gc]())
    #     if mTEPES.pIndBinGenRetire()*len(mTEPES.gd):
    #         for p,gd in mTEPES.p*mTEPES.gd:
    #             if mTEPES.pIndBinUnitRetire[gd] != 0:
    #                 OptModel.vGenerationRetire[p,gd].fix(round(OptModel.vGenerationRetire[p,gd]()))
    #             else:
    #                 OptModel.vGenerationRetire[p,gd].fix(      OptModel.vGenerationRetire[p,gd]())
    #     if mTEPES.pIndBinNetInvest()*len(mTEPES.lc):
    #         for p,ni,nf,cc in mTEPES.p*mTEPES.lc:
    #             if mTEPES.pIndBinLineInvest[ni,nf,cc] != 0:
    #                 OptModel.vNetworkInvest   [p,ni,nf,cc].fix(round(OptModel.vNetworkInvest[p,ni,nf,cc]()))
    #             else:
    #                 OptModel.vNetworkInvest   [p,ni,nf,cc].fix(      OptModel.vNetworkInvest[p,ni,nf,cc]())
    #     if mTEPES.pIndBinGenOperat()*len(mTEPES.nr):
    #         for p,sc,n,nr in mTEPES.ps*mTEPES.n*mTEPES.nr:
    #             if mTEPES.pIndBinUnitCommit[nr] != 0:
    #                 OptModel.vCommitment[p,sc,n,nr].fix(round(OptModel.vCommitment[p,sc,n,nr]()))
    #                 OptModel.vStartUp   [p,sc,n,nr].fix(round(OptModel.vStartUp   [p,sc,n,nr]()))
    #                 OptModel.vShutDown  [p,sc,n,nr].fix(round(OptModel.vShutDown  [p,sc,n,nr]()))
    #     if mTEPES.pIndBinLineCommit()*len(mTEPES.la):
    #         for p,sc,n,ni,nf,cc in mTEPES.ps*mTEPES.n*mTEPES.la:
    #             if mTEPES.pIndBinLineSwitch[ni,nf,cc] != 0:
    #                 OptModel.vLineCommit  [p,sc,n,ni,nf,cc].fix(round(OptModel.vLineCommit   [p,sc,n,ni,nf,cc]()))
    #                 OptModel.vLineOnState [p,sc,n,ni,nf,cc].fix(round(OptModel.vLineOnState  [p,sc,n,ni,nf,cc]()))
    #                 OptModel.vLineOffState[p,sc,n,ni,nf,cc].fix(round(OptModel.vLineOffState [p,sc,n,ni,nf,cc]()))
    #             elif (ni,nf,cc) in mTEPES.lc:
    #                 OptModel.vLineCommit  [p,sc,n,ni,nf,cc].fix(round(OptModel.vNetworkInvest[p,     ni,nf,cc]()))
    #     if len(mTEPES.g2g):
    #         for nr in mTEPES.nr:
    #             if sum(1 for g in mTEPES.nr if (nr,g) in mTEPES.g2g or (g,nr) in mTEPES.g2g):
    #                 OptModel.vMaxCommitment[nr].fix(round(OptModel.vMaxCommitment[nr]()))
    #     OptModel.dual = Suffix(direction=Suffix.IMPORT)
    #     OptModel.rc   = Suffix(direction=Suffix.IMPORT)
    #     SolverResults = Solver.solve(OptModel, tee=True, report_timing=True, warmstart=False)   # tee=True displays the log of the solver
    #     SolverResults.write()                                                                  # summary of the solver results

    SolvingTime = time.time() - StartTime
    print('Solution time                                ... ', round(SolvingTime), 's')
    print('Total system            cost [元]              ', OptModel.get_value(OptModel.eTotalTCost))
    for p,sc in mTEPES.ps:
        print('***** Period: '+str(p)+', Scenario: '+str(sc)+' ******')
        print('      Total genr invest cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pGenInvestCost[gc] * mTEPES.pRatedMaxPower[gc] * OptModel.get_value(OptModel.vGenerationInvest[p,gc])      for gc       in mTEPES.gc))
        print('      Total genr retire cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pGenRetireCost[gd      ] * OptModel.get_value(OptModel.vGenerationRetire[p,gd      ])                      for gd       in mTEPES.gd))
        print('      Total line invest cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pNetFixedCost[ni,nf,cc] * mTEPES.pLineLength[ni,nf,cc] * OptModel.get_value(OptModel.vNetworkInvest[p,ni,nf,cc]) for ni,nf,cc in mTEPES.lc))         # pNetFixedCost 为“单位公里线路投资成本”，因此总投资需乘以线路长度 pLineLength
        print('      Total generation  cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb     [p,sc    ] * OptModel.get_value(OptModel.vTotalGCost      [p,sc,n    ])                      for n        in mTEPES.n ))        
        # print('          grid exchan cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb     [p,sc    ] * sum(mTEPES.pLoadLevelDuration[n] * mTEPES.pLinearVarCost  [nr]   * OptModel.get_value(OptModel.vTotalOutputAbs[p,sc,n,nr]) for nr in mTEPES.nr                                                          ) for n in mTEPES.n ))        
        print('            grid down   cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb     [p,sc    ] * sum(mTEPES.pLoadLevelDuration[n] * mTEPES.pLinearVarCost  [nr]   * OptModel.get_value(OptModel.vTotalOutput   [p,sc,n,nr]) for nr in mTEPES.nr if OptModel.get_value(OptModel.vTotalOutput[p,sc,n,nr])>0) for n in mTEPES.n )) 
        print('            grid up   income [元]              ',-sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb     [p,sc    ] * sum(mTEPES.pLoadLevelDuration[n] * mTEPES.pLinearVarCost  [nr]/2 * OptModel.get_value(OptModel.vTotalOutput   [p,sc,n,nr]) for nr in mTEPES.nr if OptModel.get_value(OptModel.vTotalOutput[p,sc,n,nr])<0) for n in mTEPES.n )) 
        print('            res oper    cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb     [p,sc    ] * sum(mTEPES.pLoadLevelDuration[n] * mTEPES.pLinearOMCost   [r ]   * OptModel.get_value(OptModel.vTotalOutput   [p,sc,n,r ]) for r  in mTEPES.r                                                           ) for n in mTEPES.n ))        
        print('      Total ess oper    cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb     [p,sc    ] * OptModel.get_value(OptModel.vTotalCCost      [p,sc,n    ]) for n        in mTEPES.n ))
        print('      Total emission    cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb     [p,sc    ] * OptModel.get_value(OptModel.vTotalECost      [p,sc,n    ]) for n        in mTEPES.n ))
        print('      Total reliability cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb     [p,sc    ] * OptModel.get_value(OptModel.vTotalRCost      [p,sc,n    ]) for n        in mTEPES.n ))
        print('      Total abandon     cost [元]              ', sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb     [p,sc    ] * OptModel.get_value(OptModel.vTotalAbandonCost[p,sc,n    ]) for n        in mTEPES.n ))