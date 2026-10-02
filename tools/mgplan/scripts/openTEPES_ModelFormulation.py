import time
from   collections   import defaultdict
import pyoptinterface as poi
import numpy as np

def add_to_tuple(tup, *elements):
    if not isinstance(tup, tuple): # 如果tup不是元组，先将其转换为元组
        tup = (tup,)
    if not elements:
        return tup
    if len(elements) == 1 and isinstance(elements[0], tuple): # 如果只有一个参数且是元组，直接连接
        return tup + elements[0]
    else:  # 处理混合情况：将非元组元素转换为元组
        result = tup
        for element in elements:
            if isinstance(element, tuple):
                result += element
            else:
                result += (element,)
    return result 

def TotalObjectiveFunction_poi(OptModel, mTEPES, pIndLogConsole):
    print('Total cost o.f.      model formulation ****')
    StartTime = time.time()
    
    def eTotalTCost(OptModel):
        # return sum(mTEPES.pDiscountFactor[p] * OptModel.vTotalFCost[p] for p in mTEPES.p) + sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * (OptModel.vTotalGCost[p,sc,n] + OptModel.vTotalCCost[p,sc,n] + OptModel.vTotalECost[p,sc,n] + OptModel.vTotalRCost[p,sc,n] + OptModel.vTotalAbandonCost[p,sc,n]) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n)
        return sum(mTEPES.pDiscountFactor[p] * OptModel.vTotalFCost[p] for p in mTEPES.p) + sum(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * (OptModel.vTotalGCost[p,sc,n] + OptModel.vTotalCCost[p,sc,n]                                  + OptModel.vTotalRCost[p,sc,n] + OptModel.vTotalAbandonCost[p,sc,n]) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n)
    OptModel.eTotalTCost = eTotalTCost(OptModel)
    OptModel.set_objective(OptModel.eTotalTCost, poi.ObjectiveSense.Minimize)
    
    GeneratingTime = time.time() - StartTime
    if pIndLogConsole == 1:
        print('Total fixed and variable costs         ... ', round(GeneratingTime), 's')

def InvestmentModelFormulation_poi(OptModel, mTEPES, pIndLogConsole):
    print('Investment           model formulation ****')
    StartTime = time.time()
    for p in mTEPES.p:
        OptModel.add_linear_constraint(
            OptModel.vTotalFCost[p]
            == sum(mTEPES.pGenInvestCost[gc] * mTEPES.pRatedMaxPower[gc] * OptModel.vGenerationInvest[p, gc] for gc in mTEPES.gc)
            + sum(mTEPES.pGenRetireCost[gd] * OptModel.vGenerationRetire[p, gd] for gd in mTEPES.gd)
            + sum(mTEPES.pNetFixedCost[ni, nf, cc] * mTEPES.pLineLength[ni, nf, cc] * OptModel.vNetworkInvest[p, ni, nf, cc] for ni, nf, cc in mTEPES.lc) 
        ) # pNetFixedCost 改为“单位公里线路投资成本”，因此总投资需乘以线路长度 pLineLength

    for p in mTEPES.p:
        for gc in mTEPES.gc:
            if p != mTEPES.p[0]:
                OptModel.add_linear_constraint(OptModel.vGenerationInvest[mTEPES.p.prev(p,1),gc      ] <= OptModel.vGenerationInvest[p,gc      ])

    for p in mTEPES.p:
        for gd in mTEPES.gd:
            if p != mTEPES.p[0]:
                OptModel.add_linear_constraint(OptModel.vGenerationRetire[mTEPES.p.prev(p,1),gd      ] <= OptModel.vGenerationRetire[p,gd      ])
   
    for p in mTEPES.p:
        for ni,nf,cc in mTEPES.lc:
            if p != mTEPES.p[0]:
                OptModel.add_linear_constraint(OptModel.vNetworkInvest   [mTEPES.p.prev(p,1),ni,nf,cc] <= OptModel.vNetworkInvest   [p,ni,nf,cc])
    
    GeneratingTime = time.time() - StartTime
    if pIndLogConsole == 1:
        print('Gen&transm investment o.f./constraints ... ', round(GeneratingTime), 's')

def GenerationOperationModelFormulationObjFunct_poi(OptModel, mTEPES, pIndLogConsole, p, sc, st):
    print('Generation oper model formulation o.f. ****')
    StartTime = time.time()
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                OptModel.add_linear_constraint(OptModel.vTotalGCost[p,sc,n] == 
                                                # (sum(mTEPES.pLoadLevelDuration[n] * mTEPES.pLinearVarCost  [nr]   * OptModel.vTotalOutputAbs[p,sc,n,nr]     for nr in mTEPES.nr) +
                                                (sum(mTEPES.pLoadLevelDuration[n] * mTEPES.pLinearVarCost  [nr]   * (OptModel.vTotalOutputAbs[p,sc,n,nr] + OptModel.vTotalOutput[p,sc,n,nr]) for nr in mTEPES.nr)/2 + 
                                                # sum(mTEPES.pLoadLevelDuration[n] * mTEPES.pLinearVarCost  [nr] * (OptModel.vTotalOutputAbs[p,sc,n,nr] - OptModel.vTotalOutput[p,sc,n,nr]) for nr in mTEPES.nr)/2 +
                                                sum(mTEPES.pLoadLevelDuration[n] * mTEPES.pConstantVarCost[nr]   * OptModel.vCommitment    [p,sc,n,nr]                          +
                                                    mTEPES.pLoadLevelWeight  [n] * mTEPES.pStartUpCost    [nr]   * OptModel.vStartUp       [p,sc,n,nr]                          +
                                                    mTEPES.pLoadLevelWeight  [n] * mTEPES.pShutDownCost   [nr]   * OptModel.vShutDown      [p,sc,n,nr]     for nr in mTEPES.nr) +
                                                sum(mTEPES.pLoadLevelWeight  [n] * mTEPES.pOperReserveCost[nr]   * OptModel.vReserveUp     [p,sc,n,nr]                          +
                                                    mTEPES.pLoadLevelWeight  [n] * mTEPES.pOperReserveCost[nr]   * OptModel.vReserveDown   [p,sc,n,nr]     for nr in mTEPES.nr if mTEPES.pIndOperReserve[nr] == 0) +
                                                sum(mTEPES.pLoadLevelWeight  [n] * mTEPES.pOperReserveCost[es]   * OptModel.vESSReserveUp  [p,sc,n,es]                          +
                                                    mTEPES.pLoadLevelWeight  [n] * mTEPES.pOperReserveCost[es]   * OptModel.vESSReserveDown[p,sc,n,es]     for es in mTEPES.es if mTEPES.pIndOperReserve[es] == 0) +
                                                sum(mTEPES.pLoadLevelDuration[n] * mTEPES.pLinearOMCost   [r ]   * OptModel.vTotalOutput   [p,sc,n,r ]     for r  in mTEPES.r ) ))
    # 储能充电成本
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                OptModel.add_linear_constraint(OptModel.vTotalCCost[p,sc,n] == sum(mTEPES.pLoadLevelDuration[n] * mTEPES.pLinearVarCost  [es] * OptModel.vESSTotalCharge[p,sc,n,es] for es in mTEPES.es))

    # 目标函数里没体现
    # 碳排放成本
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                if sum(mTEPES.pCO2EmissionCost[nr] for nr in mTEPES.nr):
                    OptModel.add_linear_constraint(OptModel.vTotalECost[p,sc,n] == sum(mTEPES.pLoadLevelDuration[n] * mTEPES.pCO2EmissionCost[nr] * OptModel.vTotalOutput   [p,sc,n,nr] for nr in mTEPES.nr))

    # 缺电成本
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                OptModel.add_linear_constraint(OptModel.vTotalRCost[p,sc,n] == sum(mTEPES.pLoadLevelDuration[n] * mTEPES.pENSCost             * OptModel.vENS           [p,sc,n,nd] for nd in mTEPES.nd))

    # 新能源机组弃光成本（弃光成本设为 1000000 GWh）
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                expr = 0
                for r in mTEPES.r:
                    if r in mTEPES.gc: # 待规划机组，有投资决策
                        expr += mTEPES.pLoadLevelDuration[n] * 1000000 * (mTEPES.pMaxPower[p,sc,n,r] * OptModel.vGenerationInvest[p,r] - OptModel.vTotalOutput[p,sc,n,r])
                    else: # 已有机组，没有投资决策
                        expr += mTEPES.pLoadLevelDuration[n] * 1000000 * (mTEPES.pMaxPower[p,sc,n,r]                                   - OptModel.vTotalOutput[p,sc,n,r])
                # 电网的弃光
                expr += sum(mTEPES.pLoadLevelDuration[n] * 0.2 * 1000000 * OptModel.vPloss[p,sc,n,nd] for nd in mTEPES.nd)
                OptModel.add_linear_constraint(OptModel.vTotalAbandonCost[p,sc,n] == expr, name='vTotalAbandonCost_'+str(p)+'_'+str(sc)+'_'+str(n))

    GeneratingTime = time.time() - StartTime
    if pIndLogConsole == 1:
        print('Generating operation  o.f.             ... ', round(GeneratingTime), 's')

def GenerationOperationModelFormulationInvestment_poi(OptModel, mTEPES, pIndLogConsole, p, sc, st):
    print('Investment & operation var constraints ****')
    StartTime = time.time()
    '''
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for gc in mTEPES.gc:
                    if gc in mTEPES.nr and gc not in mTEPES.es and mTEPES.pMustRun[gc] == 0 and (mTEPES.pMinPower[p,sc,n,gc] > 0.0 or mTEPES.pConstantVarCost[gc] > 0.0):
                        OptModel.add_linear_constraint(OptModel.vCommitment[p,sc,n,gc] <=  OptModel.vGenerationInvest[p,gc])
    '''

    cons_count = 0
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for gc in mTEPES.gc:
                    if mTEPES.pMaxPower[p,sc,n,gc]:
                        OptModel.add_linear_constraint(OptModel.vTotalOutput[p,sc,n,gc] / mTEPES.pMaxPower [p,sc,n,gc] <= OptModel.vGenerationInvest[p,gc])
                        cons_count += 1
                    else:
                        OptModel.add_linear_constraint(OptModel.vTotalOutput[p,sc,n,gc]                               <= 0.0)
                        cons_count += 1
    print(f'Added {cons_count} eInstalGenCap constraints.')
    
    cons_count = 0
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for ec in mTEPES.ec:
                    OptModel.add_linear_constraint(OptModel.vESSTotalCharge [p,sc,n,ec] / mTEPES.pMaxCharge[p,sc,n,ec] <= OptModel.vGenerationInvest[p,ec])
                    cons_count += 1
    print(f'Added {cons_count} eInstalConESS constraints.')

    GeneratingTime = time.time() - StartTime
    if pIndLogConsole == 1:
        print('Generating operation & investment      ... ', round(GeneratingTime), 's')


def GenerationOperationModelFormulationDemand_poi(OptModel, mTEPES, pIndLogConsole, p, sc, st):
    print('Inertia, oper resr, demand constraints ****')
    StartTime = time.time()
    # def eSystemInertia(OptModel,p,sc,n,ar):
    #     if mTEPES.pSystemInertia[p,sc,n,ar] and sum(1 for nr in mTEPES.nr if (ar,nr) in mTEPES.a2g) + sum(1 for es in mTEPES.es if (ar,es) in mTEPES.a2g):
    #         return sum(OptModel.vTotalOutput[p,sc,n,nr] * mTEPES.pInertia[nr] / mTEPES.pMaxPower[p,sc,n,nr] for nr in mTEPES.nr if mTEPES.pMaxPower[p,sc,n,nr] and (ar,nr) in mTEPES.a2g) >= mTEPES.pSystemInertia[p,sc,n,ar]
    #     else:
    #         return Constraint.Skip
    # setattr(OptModel, 'eSystemInertia_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.ar, rule=eSystemInertia, doc='system inertia [s]'))
    '''
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for ar in mTEPES.ar:
                for n in mTEPES.n:
                    if mTEPES.pSystemInertia[p,sc,n,ar] and sum(1 for nr in mTEPES.nr if (ar,nr) in mTEPES.a2g) + sum(1 for es in mTEPES.es if (ar,es) in mTEPES.a2g):
                        OptModel.add_linear_constraint(sum(OptModel.vTotalOutput[p,sc,n,nr] * mTEPES.pInertia[nr] / mTEPES.pMaxPower[p,sc,n,nr] for nr in mTEPES.nr if mTEPES.pMaxPower[p,sc,n,nr] and (ar,nr) in mTEPES.a2g) >= mTEPES.pSystemInertia[p,sc,n,ar], name='eSystemInertia_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(ar))
    '''
    # if pIndLogConsole == 1:
    #     print('eSystemInertia        ... ', len(getattr(OptModel, 'eSystemInertia_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    # def eOperReserveUp(OptModel,p,sc,n,ar):
    #     if   mTEPES.pOperReserveUp[p,sc,n,ar] and sum(1 for nr in mTEPES.nr if (ar,nr) in mTEPES.a2g and mTEPES.pIndOperReserve[nr] == 0) + sum(1                                   for es in mTEPES.es if (ar,es) in mTEPES.a2g and mTEPES.pIndOperReserve[es] == 0):
    #         return sum(OptModel.vReserveUp  [p,sc,n,nr] for nr in mTEPES.nr if (ar,nr) in mTEPES.a2g and mTEPES.pIndOperReserve[nr] == 0) + sum(OptModel.vESSReserveUp  [p,sc,n,es] for es in mTEPES.es if (ar,es) in mTEPES.a2g and mTEPES.pIndOperReserve[es] == 0) == mTEPES.pOperReserveUp[p,sc,n,ar]
    #     else:
    #         return Constraint.Skip
    # setattr(OptModel, 'eOperReserveUp_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.ar, rule=eOperReserveUp, doc='up   operating reserve [GW]'))
    '''
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for ar in mTEPES.ar:
                for n in mTEPES.n:
                    if mTEPES.pOperReserveUp[p,sc,n,ar] and sum(1 for nr in mTEPES.nr if (ar,nr) in mTEPES.a2g and mTEPES.pIndOperReserve[nr] == 0) + sum(1                                   for es in mTEPES.es if (ar,es) in mTEPES.a2g and mTEPES.pIndOperReserve[es] == 0):
                        OptModel.add_linear_constraint(sum(OptModel.vReserveUp  [p,sc,n,nr] for nr in mTEPES.nr if (ar,nr) in mTEPES.a2g and mTEPES.pIndOperReserve[nr] == 0) + sum(OptModel.vESSReserveUp  [p,sc,n,es] for es in mTEPES.es if (ar,es) in mTEPES.a2g and mTEPES.pIndOperReserve[es] == 0) == mTEPES.pOperReserveUp[p,sc,n,ar], name='eOperReserveUp_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(ar))
    '''
    # if pIndLogConsole == 1:
    #     print('eOperReserveUp        ... ', len(getattr(OptModel, 'eOperReserveUp_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    # def eOperReserveDw(OptModel,p,sc,n,ar):
    #     if   mTEPES.pOperReserveDw[p,sc,n,ar] and sum(1 for nr in mTEPES.nr if (ar,nr) in mTEPES.a2g and mTEPES.pIndOperReserve[nr] == 0) + sum(1                                   for es in mTEPES.es if (ar,es) in mTEPES.a2g and mTEPES.pIndOperReserve[es] == 0):
    #         return sum(OptModel.vReserveDown[p,sc,n,nr] for nr in mTEPES.nr if (ar,nr) in mTEPES.a2g and mTEPES.pIndOperReserve[nr] == 0) + sum(OptModel.vESSReserveDown[p,sc,n,es] for es in mTEPES.es if (ar,es) in mTEPES.a2g and mTEPES.pIndOperReserve[es] == 0) == mTEPES.pOperReserveDw[p,sc,n,ar]
    #     else:
    #         return Constraint.Skip
    # setattr(OptModel, 'eOperReserveDw_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.ar, rule=eOperReserveDw, doc='down operating reserve [GW]'))
    '''
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for ar in mTEPES.ar:
                for n in mTEPES.n:
                    if mTEPES.pOperReserveDw[p,sc,n,ar] and sum(1 for nr in mTEPES.nr if (ar,nr) in mTEPES.a2g and mTEPES.pIndOperReserve[nr] == 0) + sum(1                                   for es in mTEPES.es if (ar,es) in mTEPES.a2g and mTEPES.pIndOperReserve[es] == 0):
                        OptModel.add_linear_constraint(sum(OptModel.vReserveDown[p,sc,n,nr] for nr in mTEPES.nr if (ar,nr) in mTEPES.a2g and mTEPES.pIndOperReserve[nr] == 0) + sum(OptModel.vESSReserveDown[p,sc,n,es] for es in mTEPES.es if (ar,es) in mTEPES.a2g and mTEPES.pIndOperReserve[es] == 0) == mTEPES.pOperReserveDw[p,sc,n,ar], name='eOperReserveDw_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(ar))
    '''
    # if pIndLogConsole == 1:
    #     print('eOperReserveDw        ... ', len(getattr(OptModel, 'eOperReserveDw_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    # def eReserveMinRatioDwUp(OptModel,p,sc,n,nr):
    #     if mTEPES.pMinRatioDwUp       and sum(mTEPES.pOperReserveUp[p,sc,n,ar] for ar in mTEPES.ar if (ar,nr) in mTEPES.a2g) and sum(mTEPES.pOperReserveDw[p,sc,n,ar] for ar in mTEPES.ar if (ar,nr) in mTEPES.a2g) and mTEPES.pMaxPower2ndBlock[p,sc,n,nr] and mTEPES.pIndOperReserve[nr] == 0:
    #         return OptModel.vReserveDown[p,sc,n,nr] >= OptModel.vReserveUp[p,sc,n,nr] * mTEPES.pMinRatioDwUp
    #     else:
    #         return Constraint.Skip
    # setattr(OptModel, 'eReserveMinRatioDwUp_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.nr, rule=eReserveMinRatioDwUp, doc='minimum ratio down to up operating reserve [GW]'))
    '''
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for nr in mTEPES.nr:
                for n in mTEPES.n:
                    if mTEPES.pMinRatioDwUp       and sum(mTEPES.pOperReserveUp[p,sc,n,ar] for ar in mTEPES.ar if (ar,nr) in mTEPES.a2g) and sum(mTEPES.pOperReserveDw[p,sc,n,ar] for ar in mTEPES.ar if (ar,nr) in mTEPES.a2g) and mTEPES.pMaxPower2ndBlock[p,sc,n,nr] and mTEPES.pIndOperReserve[nr] == 0:
                        OptModel.add_linear_constraint(OptModel.vReserveDown[p,sc,n,nr]  >=  OptModel.vReserveUp[p,sc,n,nr] * mTEPES.pMinRatioDwUp, name='eReserveMinRatioDwUp_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(nr))
    '''
    # if pIndLogConsole == 1:
    #     print('eReserveMinRatioDwUp  ... ', len(getattr(OptModel, 'eReserveMinRatioDwUp_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    # def eReserveMaxRatioDwUp(OptModel,p,sc,n,nr):
    #     if mTEPES.pMaxRatioDwUp < 1.0 and sum(mTEPES.pOperReserveUp[p,sc,n,ar] for ar in mTEPES.ar if (ar,nr) in mTEPES.a2g) and sum(mTEPES.pOperReserveDw[p,sc,n,ar] for ar in mTEPES.ar if (ar,nr) in mTEPES.a2g) and mTEPES.pMaxPower2ndBlock[p,sc,n,nr] and mTEPES.pIndOperReserve[nr] == 0:
    #         return OptModel.vReserveDown[p,sc,n,nr] <= OptModel.vReserveUp[p,sc,n,nr] * mTEPES.pMaxRatioDwUp
    #     else:
    #         return Constraint.Skip
    # setattr(OptModel, 'eReserveMaxRatioDwUp_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.nr, rule=eReserveMaxRatioDwUp, doc='maximum ratio down to up operating reserve [GW]'))
    '''
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for nr in mTEPES.nr:
                for n in mTEPES.n:
                    if mTEPES.pMaxRatioDwUp < 1.0 and sum(mTEPES.pOperReserveUp[p,sc,n,ar] for ar in mTEPES.ar if (ar,nr) in mTEPES.a2g) and sum(mTEPES.pOperReserveDw[p,sc,n,ar] for ar in mTEPES.ar if (ar,nr) in mTEPES.a2g) and mTEPES.pMaxPower2ndBlock[p,sc,n,nr] and mTEPES.pIndOperReserve[nr] == 0:
                        OptModel.add_linear_constraint(OptModel.vReserveDown[p,sc,n,nr] <=  OptModel.vReserveUp[p,sc,n,nr] * mTEPES.pMaxRatioDwUp, name='eReserveMaxRatioDwUp_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(nr))
    '''
    # if pIndLogConsole == 1:
    #     print('eReserveMaxRatioDwUp  ... ', len(getattr(OptModel, 'eReserveMaxRatioDwUp_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    # def eRsrvMinRatioDwUpESS(OptModel,p,sc,n,es):
    #     if mTEPES.pMinRatioDwUp       and sum(mTEPES.pOperReserveUp[p,sc,n,ar] for ar in mTEPES.ar if (ar,es) in mTEPES.a2g) and sum(mTEPES.pOperReserveDw[p,sc,n,ar] for ar in mTEPES.ar if (ar,es) in mTEPES.a2g) and mTEPES.pMaxPower2ndBlock[p,sc,n,es] and mTEPES.pIndOperReserve[es] == 0:
    #         return OptModel.vESSReserveDown[p,sc,n,es] >= OptModel.vESSReserveUp[p,sc,n,es] * mTEPES.pMinRatioDwUp
    #     else:
    #         return Constraint.Skip
    # setattr(OptModel, 'eRsrvMinRatioDwUpESS_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.es, rule=eRsrvMinRatioDwUpESS, doc='minimum ratio down to up operating reserve [GW]'))
    '''
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for es in mTEPES.es:
                for n in mTEPES.n:
                    if mTEPES.pMinRatioDwUp       and sum(mTEPES.pOperReserveUp[p,sc,n,ar] for ar in mTEPES.ar if (ar,es) in mTEPES.a2g) and sum(mTEPES.pOperReserveDw[p,sc,n,ar] for ar in mTEPES.ar if (ar,es) in mTEPES.a2g) and mTEPES.pMaxPower2ndBlock[p,sc,n,es] and mTEPES.pIndOperReserve[es] == 0:
                        OptModel.add_linear_constraint(OptModel.vESSReserveDown[p,sc,n,es]  >=  OptModel.vESSReserveUp[p,sc,n,es] * mTEPES.pMinRatioDwUp, name='eRsrvMinRatioDwUpESS_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(es))
    '''
    # if pIndLogConsole == 1:
    #     print('eRsrvMinRatioDwUpESS  ... ', len(getattr(OptModel, 'eRsrvMinRatioDwUpESS_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    # def eRsrvMaxRatioDwUpESS(OptModel,p,sc,n,es):
    #     if mTEPES.pMaxRatioDwUp < 1.0 and sum(mTEPES.pOperReserveUp[p,sc,n,ar] for ar in mTEPES.ar if (ar,es) in mTEPES.a2g) and sum(mTEPES.pOperReserveDw[p,sc,n,ar] for ar in mTEPES.ar if (ar,es) in mTEPES.a2g) and mTEPES.pMaxPower2ndBlock[p,sc,n,es] and mTEPES.pIndOperReserve[es] == 0:
    #         return OptModel.vESSReserveDown[p,sc,n,es] <= OptModel.vESSReserveUp[p,sc,n,es] * mTEPES.pMaxRatioDwUp
    #     else:
    #         return Constraint.Skip
    # setattr(OptModel, 'eRsrvMaxRatioDwUpESS_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.es, rule=eRsrvMaxRatioDwUpESS, doc='maximum ratio down to up operating reserve [GW]'))
    '''
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for es in mTEPES.es:
                for n in mTEPES.n:
                    if mTEPES.pMaxRatioDwUp < 1.0 and sum(mTEPES.pOperReserveUp[p,sc,n,ar] for ar in mTEPES.ar if (ar,es) in mTEPES.a2g) and sum(mTEPES.pOperReserveDw[p,sc,n,ar] for ar in mTEPES.ar if (ar,es) in mTEPES.a2g) and mTEPES.pMaxPower2ndBlock[p,sc,n,es] and mTEPES.pIndOperReserve[es] == 0:
                        OptModel.add_linear_constraint(OptModel.vESSReserveDown[p,sc,n,es] <=  OptModel.vESSReserveUp[p,sc,n,es] * mTEPES.pMaxRatioDwUp, name='eRsrvMaxRatioDwUpESS_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(es))
    '''
    # if pIndLogConsole == 1:
    #     print('eRsrvMaxRatioDwUpESS  ... ', len(getattr(OptModel, 'eRsrvMaxRatioDwUpESS_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    # def eReserveUpIfEnergy(OptModel,p,sc,n,es):
    #     if sum(mTEPES.pOperReserveUp[p,sc,n,ar] for ar in mTEPES.ar if (ar,es) in mTEPES.a2g) and mTEPES.pMaxPower2ndBlock[p,sc,n,es] and mTEPES.pIndOperReserve[es] == 0 and mTEPES.n.ord(n) % mTEPES.pCycleTimeStep[es] == 0:
    #         return OptModel.vReserveUp  [p,sc,n,es] <=                                  OptModel.vESSInventory[p,sc,n,es]  / mTEPES.pDuration[n]
    #     else:
    #         return Constraint.Skip
    # setattr(OptModel, 'eReserveUpIfEnergy_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.es, rule=eReserveUpIfEnergy, doc='up   operating reserve if energy available [GW]'))
    '''
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for es in mTEPES.es:
                for n in mTEPES.n:
                    if sum(mTEPES.pOperReserveUp[p,sc,n,ar] for ar in mTEPES.ar if (ar,es) in mTEPES.a2g) and mTEPES.pMaxPower2ndBlock[p,sc,n,es] and mTEPES.pIndOperReserve[es] == 0 and (mTEPES.n.index(n) + 1) % mTEPES.pCycleTimeStep[es] == 0:
                        OptModel.add_linear_constraint(OptModel.vReserveUp  [p,sc,n,es] <=  OptModel.vESSInventory[p,sc,n,es]  / mTEPES.pDuration[n], name='eReserveUpIfEnergy_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(es))
    '''
    # if pIndLogConsole == 1:
    #     print('eReserveUpIfEnergy    ... ', len(getattr(OptModel, 'eReserveUpIfEnergy_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    # def eReserveDwIfEnergy(OptModel,p,sc,n,es):
    #     if sum(mTEPES.pOperReserveDw[p,sc,n,ar] for ar in mTEPES.ar if (ar,es) in mTEPES.a2g) and mTEPES.pMaxPower2ndBlock[p,sc,n,es] and mTEPES.pIndOperReserve[es] == 0 and mTEPES.n.ord(n) % mTEPES.pCycleTimeStep[es] == 0:
    #         return OptModel.vReserveDown[p,sc,n,es] <= (mTEPES.pMaxStorage[p,sc,n,es] - OptModel.vESSInventory[p,sc,n,es]) / mTEPES.pDuration[n]
    #     else:
    #         return Constraint.Skip
    # setattr(OptModel, 'eReserveDwIfEnergy_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.es, rule=eReserveDwIfEnergy, doc='down operating reserve if energy available [GW]'))
    '''
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for es in mTEPES.es:
                for n in mTEPES.n:
                    if sum(mTEPES.pOperReserveDw[p,sc,n,ar] for ar in mTEPES.ar if (ar,es) in mTEPES.a2g) and mTEPES.pMaxPower2ndBlock[p,sc,n,es] and mTEPES.pIndOperReserve[es] == 0 and (mTEPES.n.index(n) + 1) % mTEPES.pCycleTimeStep[es] == 0:
                        OptModel.add_linear_constraint(OptModel.vReserveDown[p,sc,n,es] <=  (mTEPES.pMaxStorage[p,sc,n,es] - OptModel.vESSInventory[p,sc,n,es]) / mTEPES.pDuration[n], name='eReserveDwIfEnergy_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(es))
    '''
    # if pIndLogConsole == 1:
    #     print('eReserveDwIfEnergy    ... ', len(getattr(OptModel, 'eReserveDwIfEnergy_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    # def eESSReserveUpIfEnergy(OptModel,p,sc,n,es):
    #     if sum(mTEPES.pOperReserveUp[p,sc,n,ar] for ar in mTEPES.ar if (ar,es) in mTEPES.a2g) and mTEPES.pMaxCharge2ndBlock[p,sc,n,es] and mTEPES.pIndOperReserve[es] == 0 and mTEPES.n.ord(n) % mTEPES.pCycleTimeStep[es] == 0:
    #         return OptModel.vESSReserveUp  [p,sc,n,es] <= (mTEPES.pMaxStorage[p,sc,n,es] - OptModel.vESSInventory[p,sc,n,es]) / mTEPES.pDuration[n]
    #     else:
    #         return Constraint.Skip
    # setattr(OptModel, 'eESSReserveUpIfEnergy_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.es, rule=eESSReserveUpIfEnergy, doc='up   operating reserve if energy available [GW]'))
    '''
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for es in mTEPES.es:
                for n in mTEPES.n:
                    if sum(mTEPES.pOperReserveUp[p,sc,n,ar] for ar in mTEPES.ar if (ar,es) in mTEPES.a2g) and mTEPES.pMaxCharge2ndBlock[p,sc,n,es] and mTEPES.pIndOperReserve[es] == 0 and (mTEPES.n.index(n) + 1) % mTEPES.pCycleTimeStep[es] == 0:
                        OptModel.add_linear_constraint(OptModel.vESSReserveUp  [p,sc,n,es] <=  (mTEPES.pMaxStorage[p,sc,n,es] - OptModel.vESSInventory[p,sc,n,es]) / mTEPES.pDuration[n], name='eESSReserveUpIfEnergy_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(es))
    '''
    # if pIndLogConsole == 1:
    #     print('eESSReserveUpIfEnergy ... ', len(getattr(OptModel, 'eESSReserveUpIfEnergy_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    # def eESSReserveDwIfEnergy(OptModel,p,sc,n,es):
    #     if sum(mTEPES.pOperReserveDw[p,sc,n,ar] for ar in mTEPES.ar if (ar,es) in mTEPES.a2g) and mTEPES.pMaxCharge2ndBlock[p,sc,n,es] and mTEPES.pIndOperReserve[es] == 0 and mTEPES.n.ord(n) % mTEPES.pCycleTimeStep[es] == 0:
    #         return OptModel.vESSReserveDown[p,sc,n,es] <=                                  OptModel.vESSInventory[p,sc,n,es]  / mTEPES.pDuration[n]
    #     else:
    #         return Constraint.Skip
    # setattr(OptModel, 'eESSReserveDwIfEnergy_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.es, rule=eESSReserveDwIfEnergy, doc='down operating reserve if energy available [GW]'))
    '''
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for es in mTEPES.es:
                for n in mTEPES.n:
                    if sum(mTEPES.pOperReserveDw[p,sc,n,ar] for ar in mTEPES.ar if (ar,es) in mTEPES.a2g) and mTEPES.pMaxCharge2ndBlock[p,sc,n,es] and mTEPES.pIndOperReserve[es] == 0 and (mTEPES.n.index(n) + 1) % mTEPES.pCycleTimeStep[es] == 0:
                        OptModel.add_linear_constraint(OptModel.vESSReserveDown[p,sc,n,es] <=  OptModel.vESSInventory[p,sc,n,es]  / mTEPES.pDuration[n], name='eESSReserveDwIfEnergy_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(es))
    '''
    # if pIndLogConsole == 1:
    #     print('eESSReserveDwIfEnergy ... ', len(getattr(OptModel, 'eESSReserveDwIfEnergy_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    # incoming and outgoing lines (lin) (lout)
    lin   = defaultdict(list)
    linl  = defaultdict(list)
    lout  = defaultdict(list)
    loutl = defaultdict(list)
    for ni,nf,cc in mTEPES.la:
        lin  [nf].append((ni,cc))
        lout [ni].append((nf,cc))
    for ni,nf,cc in mTEPES.ll:
        linl [nf].append((ni,cc))
        loutl[ni].append((nf,cc))
    
    # 功率平衡
    cons_count = 0
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for nd in mTEPES.nd:
                    expr = 0
                    if sum(1 for g in mTEPES.g if (nd,g) in mTEPES.n2g) + sum(1 for lout in lout[nd]) + sum(1 for ni,cc in lin[nd]):
                        expr += sum(OptModel.vTotalOutput[p,sc,n,g] for g in mTEPES.g if (nd,g) in mTEPES.n2g) - OptModel.vPloss[p,sc,n,nd] - sum(OptModel.vESSTotalCharge[p,sc,n,es] for es in mTEPES.es if (nd,es) in mTEPES.n2g) + \
                                OptModel.vENS[p,sc,n,nd] - mTEPES.pDemand[p,sc,n,nd] -\
                                sum(OptModel.vLineLosses[add_to_tuple(p,sc,n,nd,lout )] for lout  in loutl[nd]) - sum(OptModel.vFlow[add_to_tuple(p,sc,n,nd,lout )] for lout  in lout[nd]) - \
                                sum(OptModel.vLineLosses[add_to_tuple(p,sc,n,ni,nd,cc)] for ni,cc in linl [nd]) + sum(OptModel.vFlow[add_to_tuple(p,sc,n,ni,nd,cc)] for ni,cc in lin [nd])
                    
                    # 对于电动汽车节点，需要添加电动汽车充放电平衡项
                    if hasattr(mTEPES, 'ev_node') and nd in mTEPES.ev_node: 
                        expr -= sum(var / 1000000.0 for var in OptModel.grid_p_chr_vars.get((p,sc,n), []))
                        expr += sum(var / 1000000.0 for var in OptModel.grid_p_dis_vars.get((p,sc,n), []))

                    # 对于电热耦合节点，需要添加电力侧平衡约束
                    if hasattr(mTEPES, 'ht_node') and nd in mTEPES.ht_node: 
                        # 如果启用热系统，添加CHP/GT/ST发电及热泵/锅炉用电
                        if hasattr(mTEPES, 'n_to_t_map'):  # 检查是否有热系统时间映射
                            t = mTEPES.n_to_t_map[n] # 获取时间步索引
                            # CHP发电（增加供电侧）
                            if hasattr(mTEPES, 'vP_chp_elec'):
                                expr += OptModel.vP_chp_elec[t]/1000
                            # GT发电（增加供电侧）
                            if hasattr(mTEPES, 'vP_gt_elec'):
                                expr += OptModel.vP_gt_elec[t]/1000
                            # ST发电（增加供电侧）
                            if hasattr(mTEPES, 'vP_st_elec'):
                                expr += OptModel.vP_st_elec[t]/1000
                            # 热泵用电（增加用电侧）
                            if hasattr(mTEPES, 'vP_hp_elec'):
                                expr -= OptModel.vP_hp_elec[t]/1000
                            # 锅炉用电（增加用电侧）
                            if hasattr(mTEPES, 'vP_boiler_elec'):
                                expr -= OptModel.vP_boiler_elec[t]/1000

                    # 对于电氢耦合节点，需要添加电力侧平衡约束
                    if hasattr(mTEPES, 'params_ammonia') and nd in mTEPES.params_ammonia['eh_node']: 
                        expr -= mTEPES.var_dict_ammonia['p_grid'][n] / 1000000.0
                            
                    OptModel.add_linear_constraint(expr == 0, name='eBalance_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(nd))
                    cons_count += 1
                    if n in mTEPES.pMinLoadPeriod and mTEPES.pOffgridMinDemand > 0: # 对离网时段并网点添加0约束 
                        for g in mTEPES.g:
                            if g == 'Grid' and (nd,g) in mTEPES.n2g:
                                OptModel.add_linear_constraint(OptModel.vTotalOutput[p,sc,n,g] == 0, name='vTotalOutputNonNeg_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(g))
                    elif n in mTEPES.pMaxLoadPeriod and mTEPES.pOffgridDemand > 0: # 对最大负荷时段并网点添加0约束
                        for g in mTEPES.g:
                            if g == 'Grid' and (nd,g) in mTEPES.n2g:
                                OptModel.add_linear_constraint(OptModel.vTotalOutput[p,sc,n,g] == 0, name='vTotalOutputMax_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(g))
    print(f'Added {cons_count} eBalance constraints.')

    # 出力绝对 
    cons_count = 0
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for g in mTEPES.g:
                    OptModel.add_linear_constraint(OptModel.vTotalOutputAbs[p,sc,n,g]  >=  OptModel.vTotalOutput[p,sc,n,g], name='vTotalOutput1_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(g))
                    cons_count += 1
    print(f'Added {cons_count} vTotalOutput1 constraints.')
    
    cons_count = 0
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for g in mTEPES.g:
                    OptModel.add_linear_constraint(OptModel.vTotalOutputAbs[p,sc,n,g]  >= - OptModel.vTotalOutput[p,sc,n,g], name='vTotalOutput2_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(g))
                    cons_count += 1
    print(f'Added {cons_count} vTotalOutput2 constraints.')


    # 需求响 固定边界
    # def eDRUp1(OptModel,p,sc,n,nd):
    #     return     OptModel.vDRUp[p,sc,n,nd] >= 0
    # setattr(OptModel, 'eDRUp1_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.nd, rule=eDRUp1, doc='Up demand response lower bound'))
    # if pIndLogConsole == 1:
    #     print('eDRUp1                ... ', len(getattr(OptModel, 'eDRUp1_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')
    # def eDRUp2(OptModel,p,sc,n,nd):
    #     return     OptModel.vDRUp[p,sc,n,nd] <= 0.00001
    # setattr(OptModel, 'eDRUp2_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.nd, rule=eDRUp2, doc='Up demand response upper bound'))
    # if pIndLogConsole == 1:
    #     print('eDRUp2                ... ', len(getattr(OptModel, 'eDRUp2_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    # def eDRDown1(OptModel,p,sc,n,nd):
    #     return     OptModel.vDRDown[p,sc,n,nd] >= 0
    # setattr(OptModel, 'eDRDown1_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.nd, rule=eDRDown1, doc='Down demand response lower bound'))
    # if pIndLogConsole == 1:
    #     print('eDRDown1                ... ', len(getattr(OptModel, 'eDRDown1_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')
    # def eDRDown2(OptModel,p,sc,n,nd):
    #     return     OptModel.vDRDown[p,sc,n,nd] <= 0.00001
    # setattr(OptModel, 'eDRDown2_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.nd, rule=eDRDown2, doc='Down demand response upper bound'))
    # if pIndLogConsole == 1:
    #     print('eDRDown2                ... ', len(getattr(OptModel, 'eDRDown2_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    # 需求响应可变边界（备用约束，当前关闭）
    # def eDRUp1(OptModel,p,sc,n,nd):
    #     # return OptModel.vDRUp[p,sc,n,nd] >= 0.02 * mTEPES.pDemand[p,sc,n,nd] * 0
    #     return OptModel.vDRUp[p,sc,n,nd] >= 0.02 * mTEPES.pDemand[p,sc,n,nd] * (1 - mTEPES.pPrice[n] / mTEPES.pPrice_avg)
    # setattr(OptModel, 'eDRUp1_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.nd, rule=eDRUp1, doc='Up demand response lower bound'))
    # if pIndLogConsole == 1:
    #     print('eDRUp1                ... ', len(getattr(OptModel, 'eDRUp1_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')
    #
    # def eDRUp2(OptModel,p,sc,n,nd):
    #     return OptModel.vDRUp[p,sc,n,nd] <= 0.12 * OptModel.vDRUpIndex[p,sc,n,nd] * mTEPES.pDemand[p,sc,n,nd]
    # setattr(OptModel, 'eDRUp2_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.nd, rule=eDRUp2, doc='Up demand response upper bound'))
    # if pIndLogConsole == 1:
    #     print('eDRUp2                ... ', len(getattr(OptModel, 'eDRUp2_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')
    #
    # # 负荷减少上下界
    # def eDRDown1(OptModel,p,sc,n,nd):
    #     # return OptModel.vDRUp[p,sc,n,nd] >= 0.02 * mTEPES.pDemand[p,sc,n,nd] * 0
    #     return OptModel.vDRDown[p,sc,n,nd] >= 0.02 * mTEPES.pDemand[p,sc,n,nd] * (mTEPES.pPrice[n] / mTEPES.pPrice_avg - 1)
    # setattr(OptModel, 'eDRDown1_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.nd, rule=eDRDown1, doc='Down demand response lower bound'))
    # if pIndLogConsole == 1:
    #     print('eDRDown1                ... ', len(getattr(OptModel, 'eDRDown1_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')
    #
    # def eDRDown2(OptModel,p,sc,n,nd):
    #     return OptModel.vDRDown[p,sc,n,nd] <= 0.12 * OptModel.vDRDownIndex[p,sc,n,nd] * mTEPES.pDemand[p,sc,n,nd]
    # setattr(OptModel, 'eDRDown2_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.nd, rule=eDRDown2, doc='Down demand response upper bound'))
    # if pIndLogConsole == 1:
    #     print('eDRDown2                ... ', len(getattr(OptModel, 'eDRDown2_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')
    #
    # # 限制在考虑电价的需求响应过程中不能同时增加和减少负荷
    # def eDRIncompatible(OptModel,p,sc,n,nd):
    #     return OptModel.vDRDownIndex[p,sc,n,nd] + OptModel.vDRUpIndex[p,sc,n,nd] <= 1
    # setattr(OptModel, 'eDRIncompatible_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.nd, rule=eDRIncompatible, doc='Demand response Incompatible'))
    # if pIndLogConsole == 1:
    #     print('eDRIncompatible                ... ', len(getattr(OptModel, 'eDRIncompatible_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')
    #
    # # 规划期内参与需求响应的总负荷变化量必须相等
    # def eDRsum(OptModel,p,sc,nd):
    #     return sum(OptModel.vDRUp[p,sc,n2,nd] - OptModel.vDRDown[p,sc,n2,nd] for n2 in list(mTEPES.n2)) == 0
    # setattr(OptModel, 'eDRsum_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.nd, rule=eDRsum, doc='Demand response summation'))
    # if pIndLogConsole == 1:
    #     print('eDRsum                ... ', len(getattr(OptModel, 'eDRsum_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')
    
    # 整个约束模块的计算时间
    GeneratingTime = time.time() - StartTime
    if pIndLogConsole == 1:
        print('Generating inertia/reserves/balance    ... ', round(GeneratingTime), 's')



def GenerationOperationModelFormulationStorage_poi(OptModel, mTEPES, pIndLogConsole, p, sc, st):
    print('Storage scheduling         constraints ****')
    StartTime = time.time()
    
    # 提前计算周期长度
    period_length = int(24 / mTEPES.pTimeStep)
    cons_count = 0
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            # 遍历时间点并获取索引
            for idx, n in enumerate(mTEPES.n):
                # 判断是否为周期末尾（等价于 .ord(n) % period_length == 0 的逻辑）
                if (idx + 1) % period_length != 0:
                    continue  # 跳过非周期末尾的时间点
                # 遍历储能设备
                for es in mTEPES.es:
                    # 收集前 23 个时间步的输出
                    previous_values = []
                    for i in range(1, 24):
                        prev_idx = idx - i  # 计算前驱索引
                        prev_n = mTEPES.n[prev_idx]  # 获取前驱时间点
                        previous_values.append(OptModel.vTotalOutput[p, sc, prev_n, es])
                    # 计算总和并添加约束
                    sum_first_23 = sum(previous_values)
                    OptModel.add_linear_constraint(sum_first_23 <= 350 / 365 * mTEPES.pMaxStorage[p, sc, n, es], name=f'eDischarge_{p}_{sc}_{n}_{es}') # 
                    cons_count += 1
    print(f'Added {cons_count} eDischarge constraints.')
    
    # 储能的充放电功率上下限
    cons_count = 0
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for es in mTEPES.es:
                    OptModel.add_linear_constraint(OptModel.vESSTotalCharge[p, sc, n, es] <= OptModel.vESSChargeState[p, sc, n, es] * mTEPES.pMaxCharge[p,sc,n,es], name='ePowerChargeLimit_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(es))
                    cons_count += 1
    print(f'Added {cons_count} ePowerChargeLimit constraints.')
    
    # 储能的充放电功率上下限
    cons_count = 0
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for es in mTEPES.es:
                    OptModel.add_linear_constraint(OptModel.vTotalOutput[p, sc, n, es] <= OptModel.vESSDischargeState[p, sc, n, es] * mTEPES.pMaxPower[p,sc,n,es], 'ePowerDischargeLimit_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(es))
                    cons_count += 1
    print(f'Added {cons_count} ePowerDischargeLimit constraints.')
    
    # 储能不能同时充电和放电
    cons_count = 0    
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for es in mTEPES.es:
                    OptModel.add_linear_constraint(OptModel.vESSChargeState[p, sc, n, es] + OptModel.vESSDischargeState[p, sc, n, es] <= 1, 'eChargeAndDischarge_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(es))
                    cons_count += 1
    print(f'Added {cons_count} eChargeAndDischarge constraints.')

    # 容量和功率关系 
    cons_count = 0
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for es in mTEPES.es:
                    n_ord = mTEPES.n.index(n) + 1  # 转换后的序号
                    # 区分已有储能和待规划储能的初始容量
                    if es in mTEPES.gc:
                        ini_inventory = mTEPES.pIniInventory[p,sc,n,es] * OptModel.vGenerationInvest[p,es]
                    else:
                        ini_inventory = mTEPES.pIniInventory[p,sc,n,es]

                    if n_ord == mTEPES.pCycleTimeStep[es]:
                        OptModel.add_linear_constraint(ini_inventory + sum(mTEPES.pDuration[n2]*(mTEPES.pEnergyInflows[p,sc,n2,es] - OptModel.vEnergyOutflows[p,sc,n2,es] - OptModel.vTotalOutput[p,sc,n2,es] + mTEPES.pEfficiency[es]*OptModel.vESSTotalCharge[p,sc,n2,es]) for n2 in list(mTEPES.n2)[n_ord-mTEPES.pCycleTimeStep[es]:n_ord]) == OptModel.vESSInventory[p,sc,n,es] + OptModel.vESSSpillage[p,sc,n,es], 'eESSInventory_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(es))
                        cons_count += 1
                    elif n_ord > mTEPES.pCycleTimeStep[es] and n_ord % mTEPES.pCycleTimeStep[es] == 0:
                        OptModel.add_linear_constraint(OptModel.vESSInventory[p,sc,mTEPES.n[mTEPES.n.index(n) - mTEPES.pCycleTimeStep[es]],es] + sum(mTEPES.pDuration[n2]*(mTEPES.pEnergyInflows[p,sc,n2,es] - OptModel.vEnergyOutflows[p,sc,n2,es] - OptModel.vTotalOutput[p,sc,n2,es] + mTEPES.pEfficiency[es]*OptModel.vESSTotalCharge[p,sc,n2,es]) for n2 in list(mTEPES.n2)[n_ord-mTEPES.pCycleTimeStep[es]:n_ord]) == OptModel.vESSInventory[p,sc,n,es] + OptModel.vESSSpillage[p,sc,n,es], 'eESSInventory_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(es))
                        cons_count += 1
    print(f'Added {cons_count} eESSInventory constraints.')

    # 电池的最终时刻的容量要小于等于初始容量
    cons_count = 0
    if list(mTEPES.n):
        n_first = list(mTEPES.n)[0]
        n_last = list(mTEPES.n)[-1]
        for p in mTEPES.p:
            for sc in mTEPES.sc:
                for es in mTEPES.es:
                    # 区分已有储能和待规划储能的初始容量
                    if es in mTEPES.gc:
                        ini_inventory_first = mTEPES.pIniInventory[p,sc,n_first,es] * OptModel.vGenerationInvest[p,es]
                    else:
                        ini_inventory_first = mTEPES.pIniInventory[p,sc,n_first,es]
                        
                    # 最后一个时刻的储能状态小于等于定义的初始时刻的设定状 
                    OptModel.add_linear_constraint(OptModel.vESSInventory[p,sc,n_last,es] <= ini_inventory_first, 'eESSFinalCapacity_'+str(p)+'_'+str(sc)+'_'+str(n_last)+'_'+str(es))
                    cons_count += 1
    print(f'Added {cons_count} eESSFinalCapacity constraints.')
    
    # 待规划储能最大容量是投资决策系数决定
    cons_count = 0
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for es in mTEPES.es:
                    if es in  mTEPES.ec:
                        OptModel.add_linear_constraint(OptModel.vESSInventory[p,sc,n,es] <= 0.9 * mTEPES.pMaxStorage[p,sc,n,es] * OptModel.vGenerationInvest[p,es], 'eMaxStorage_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(es))
                        # OptModel.add_linear_constraint(OptModel.vESSInventory[p,sc,n,ec] >= 0.05 * mTEPES.pMaxStorage[p,sc,n,ec] * OptModel.vGenerationInvest[p,ec], 'eMinStorage_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(ec))
                    else:
                        OptModel.add_linear_constraint(OptModel.vESSInventory[p,sc,n,es] <= 0.9 * mTEPES.pMaxStorage[p,sc,n,es]                                   , 'eMaxStorage_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(es))
                    cons_count += 1
    print(f'Added {cons_count} eESSMaxStorage constraints.')

    # 待规划储能最大容量要大于设定离网小时数内的关键负荷用电量
    cons_count = 0
    if mTEPES.pOffgridDemand > 0.0:
        for p in mTEPES.p:
            for sc in mTEPES.sc:
                for ec in mTEPES.ec:
                    ratio = mTEPES.pOffgridDemand / mTEPES.pMaxStorage[p,sc,n,ec] if mTEPES.pOffgridDemand / mTEPES.pMaxStorage[p,sc,n,ec] < 1 else 1.0
                    print(f'The propotion is set to {ratio:.3f}')
                    OptModel.add_linear_constraint(OptModel.vGenerationInvest[p,ec] >= ratio)
                    cons_count += 1
    print(f'Added {cons_count} eESS off-grid constraints. \nOff-grid demand: {mTEPES.pOffgridDemand*1000:.3f} MWh.')

    cons_count = 0
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for es in mTEPES.es:
                    if mTEPES.pMaxPower2ndBlock [p,sc,n,es] and mTEPES.pMaxCharge2ndBlock[p,sc,n,es]:
                        if sum(mTEPES.pOperReserveUp[p,sc,n,ar] + mTEPES.pOperReserveDw[p,sc,n,ar] for ar in mTEPES.ar if (ar,es) in mTEPES.a2g):
                            OptModel.add_linear_constraint(((OptModel.vOutput2ndBlock[p,sc,n,es] + mTEPES.pUpReserveActivation * OptModel.vReserveUp     [p,sc,n,es]) / mTEPES.pMaxPower2ndBlock [p,sc,n,es] +
                                                            (OptModel.vCharge2ndBlock[p,sc,n,es] + mTEPES.pUpReserveActivation * OptModel.vESSReserveDown[p,sc,n,es]) / mTEPES.pMaxCharge2ndBlock[p,sc,n,es] <= 1.0), name='eChargeDischarge_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(es))
                            cons_count += 1
                        else:
                            OptModel.add_linear_constraint(((OptModel.vOutput2ndBlock[p,sc,n,es]                                                                    ) / mTEPES.pMaxPower2ndBlock [p,sc,n,es] +
                                                            (OptModel.vCharge2ndBlock[p,sc,n,es]                                                                    ) / mTEPES.pMaxCharge2ndBlock[p,sc,n,es] <= 1.0), name='eChargeDischarge_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(es))
                            cons_count += 1
    print(f'Added {cons_count} eChargeDischarge constraints.')
    
    cons_count = 0
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for es in mTEPES.es:
                    if mTEPES.pMaxCharge[p,sc,n,es] and mTEPES.pMaxCharge2ndBlock[p,sc,n,es] and mTEPES.pMinCharge[p,sc,n,es] == 0.0:
                        OptModel.add_linear_constraint(OptModel.vESSTotalCharge[p,sc,n,es]                                ==      OptModel.vCharge2ndBlock[p,sc,n,es] + mTEPES.pUpReserveActivation * OptModel.vESSReserveDown[p,sc,n,es] - mTEPES.pDwReserveActivation * OptModel.vESSReserveUp[p,sc,n,es], name='eESSTotalCharge_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(es))
                        cons_count += 1
                    elif mTEPES.pMaxCharge[p,sc,n,es] and mTEPES.pMaxCharge2ndBlock[p,sc,n,es]:
                        OptModel.add_linear_constraint(OptModel.vESSTotalCharge[p,sc,n,es] / mTEPES.pMinCharge[p,sc,n,es] == 1 + (OptModel.vCharge2ndBlock[p,sc,n,es] + mTEPES.pUpReserveActivation * OptModel.vESSReserveDown[p,sc,n,es] - mTEPES.pDwReserveActivation * OptModel.vESSReserveUp[p,sc,n,es]) / mTEPES.pMinCharge[p,sc,n,es], name='eESSTotalCharge_'+str(p)+'_'+str(sc)+'_'+str(n)+'_'+str(es))
                        cons_count += 1
    print(f'Added {cons_count} eESSTotalCharge constraints.')

    GeneratingTime = time.time() - StartTime
    if pIndLogConsole == 1:
        print('Generating storage operation           ... ', round(GeneratingTime), 's')


def NetworkOperationModelFormulation_poi(OptModel, mTEPES, pIndLogConsole, p, sc, st):
    print('Network    operation model constraints ****')

    StartTime = time.time()

    # def eNetCapacity1(OptModel,p,sc,n,ni,nf,cc):
    #     if mTEPES.pIndBinSingleNode() == 0 and ((ni,nf,cc) in mTEPES.lc or mTEPES.pIndBinLineSwitch[ni,nf,cc] == 1):
    #         return OptModel.vFlow[p,sc,n,ni,nf,cc] / max(mTEPES.pLineNTCBck[ni,nf,cc],mTEPES.pLineNTCFrw[ni,nf,cc]) >= - OptModel.vLineCommit[p,sc,n,ni,nf,cc]
    #     else:
    #         return Constraint.Skip
    # setattr(OptModel, 'eNetCapacity1_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.la, rule=eNetCapacity1, doc='maximum flow by existing network capacity [p.u.]'))

    # if pIndLogConsole == 1:
    #     print('eNetCapacity1         ... ', len(getattr(OptModel, 'eNetCapacity1_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    # def eNetCapacity2(OptModel,p,sc,n,ni,nf,cc):
    #     if mTEPES.pIndBinSingleNode() == 0 and ((ni,nf,cc) in mTEPES.lc or mTEPES.pIndBinLineSwitch[ni,nf,cc] == 1):
    #         return OptModel.vFlow[p,sc,n,ni,nf,cc] / max(mTEPES.pLineNTCBck[ni,nf,cc],mTEPES.pLineNTCFrw[ni,nf,cc]) <=   OptModel.vLineCommit[p,sc,n,ni,nf,cc]
    #     else:
    #         return Constraint.Skip
    # setattr(OptModel, 'eNetCapacity2_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.la, rule=eNetCapacity2, doc='maximum flow by existing network capacity [p.u.]'))

    # if pIndLogConsole == 1:
    #     print('eNetCapacity2         ... ', len(getattr(OptModel, 'eNetCapacity2_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    # def eKirchhoff2ndLaw1(OptModel,p,sc,n,ni,nf,cc):
    #     if mTEPES.pIndBinSingleNode() == 0 and mTEPES.pPeriodIniNet[ni,nf,cc] <= p and mTEPES.pPeriodFinNet[ni,nf,cc] >= p and mTEPES.pLineX[ni,nf,cc] > 0.0:
    #         if (ni,nf,cc) in mTEPES.lca:
    #             return OptModel.vFlow[p,sc,n,ni,nf,cc] / mTEPES.pBigMFlowBck[ni,nf,cc] - (OptModel.vTheta[p,sc,n,ni] - OptModel.vTheta[p,sc,n,nf]) / mTEPES.pLineX[ni,nf,cc] / mTEPES.pBigMFlowBck[ni,nf,cc] * mTEPES.pSBase >= - 1 + OptModel.vLineCommit[p,sc,n,ni,nf,cc]
    #         else:
    #             return OptModel.vFlow[p,sc,n,ni,nf,cc] / mTEPES.pBigMFlowBck[ni,nf,cc] - (OptModel.vTheta[p,sc,n,ni] - OptModel.vTheta[p,sc,n,nf]) / mTEPES.pLineX[ni,nf,cc] / mTEPES.pBigMFlowBck[ni,nf,cc] * mTEPES.pSBase ==   0
    #     else:
    #         return Constraint.Skip
    # setattr(OptModel, 'eKirchhoff2ndLaw1_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.laa, rule=eKirchhoff2ndLaw1, doc='flow for each AC candidate line [rad]'))

    # if pIndLogConsole == 1:
    #     print('eKirchhoff2ndLaw1     ... ', len(getattr(OptModel, 'eKirchhoff2ndLaw1_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')
    
    cons_count = 0
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for ni,nf,cc in mTEPES.laa:
                    if mTEPES.pIndBinSingleNode == 0 and mTEPES.pPeriodIniNet[ni,nf,cc] <= p and mTEPES.pPeriodFinNet[ni,nf,cc] >= p and mTEPES.pLineX[ni,nf,cc] > 0.0:
                        if (ni,nf,cc) in mTEPES.lca:
                            OptModel.add_linear_constraint(OptModel.vFlow[p,sc,n,ni,nf,cc] / mTEPES.pBigMFlowBck[ni,nf,cc] - (OptModel.vTheta[p,sc,n,ni] - OptModel.vTheta[p,sc,n,nf]) / mTEPES.pLineX[ni,nf,cc] / mTEPES.pBigMFlowBck[ni,nf,cc] * mTEPES.pSBase >= - 1 + OptModel.vLineCommit[p,sc,n,ni,nf,cc])
                            cons_count += 1
                        else:
                            OptModel.add_linear_constraint(OptModel.vFlow[p,sc,n,ni,nf,cc] / mTEPES.pBigMFlowBck[ni,nf,cc] - (OptModel.vTheta[p,sc,n,ni] - OptModel.vTheta[p,sc,n,nf]) / mTEPES.pLineX[ni,nf,cc] / mTEPES.pBigMFlowBck[ni,nf,cc] * mTEPES.pSBase ==   0)
                            cons_count += 1
    print('Added eKirchhoff2ndLaw1     ... ', cons_count, ' rows')


    # def eKirchhoff2ndLaw2(OptModel,p,sc,n,ni,nf,cc):
    #     if mTEPES.pIndBinSingleNode() == 0 and mTEPES.pPeriodIniNet[ni,nf,cc] <= p and mTEPES.pPeriodFinNet[ni,nf,cc] >= p and mTEPES.pLineX[ni,nf,cc] > 0.0 and (ni,nf,cc) in mTEPES.lca:
    #         return OptModel.vFlow[p,sc,n,ni,nf,cc] / mTEPES.pBigMFlowFrw[ni,nf,cc] - (OptModel.vTheta[p,sc,n,ni] - OptModel.vTheta[p,sc,n,nf]) / mTEPES.pLineX[ni,nf,cc] / mTEPES.pBigMFlowFrw[ni,nf,cc] * mTEPES.pSBase <=   1 - OptModel.vLineCommit[p,sc,n,ni,nf,cc]
    #     else:
    #         return Constraint.Skip
    # setattr(OptModel, 'eKirchhoff2ndLaw2_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.laa, rule=eKirchhoff2ndLaw2, doc='flow for each AC candidate line [rad]'))

    cons_count = 0
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for ni,nf,cc in mTEPES.laa:
                    if mTEPES.pIndBinSingleNode == 0 and mTEPES.pPeriodIniNet[ni,nf,cc] <= p and mTEPES.pPeriodFinNet[ni,nf,cc] >= p and mTEPES.pLineX[ni,nf,cc] > 0.0 and (ni,nf,cc) in mTEPES.lca:
                        OptModel.add_linear_constraint(OptModel.vFlow[p,sc,n,ni,nf,cc] / mTEPES.pBigMFlowFrw[ni,nf,cc] - (OptModel.vTheta[p,sc,n,ni] - OptModel.vTheta[p,sc,n,nf]) / mTEPES.pLineX[ni,nf,cc] / mTEPES.pBigMFlowFrw[ni,nf,cc] * mTEPES.pSBase <=   1 - OptModel.vLineCommit[p,sc,n,ni,nf,cc])
                        cons_count += 1
    print('Added eKirchhoff2ndLaw2     ... ', cons_count, ' rows')
    # if pIndLogConsole == 1:
    #     print('eKirchhoff2ndLaw2     ... ', len(getattr(OptModel, 'eKirchhoff2ndLaw2_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    # 候选线路投资-潮流耦合（未投资则该线路潮流必须为 0）
    # 约束形式：
    #   vFlow <= NTCFrw * vNetworkInvest
    #   vFlow >= -NTCBck * vNetworkInvest
    # 这样当 vNetworkInvest=0 时，强制 vFlow=0；当 vNetworkInvest=1 时，恢复原 NTC 上下界。
    cons_count = 0
    if hasattr(OptModel, 'vNetworkInvest') and len(mTEPES.lc):
        for p in mTEPES.p:
            for sc in mTEPES.sc:
                for n in mTEPES.n:
                    for ni, nf, cc in mTEPES.lc:
                        if mTEPES.pIndBinSingleNode == 0 and mTEPES.pPeriodIniNet[ni, nf, cc] <= p and mTEPES.pPeriodFinNet[ni, nf, cc] >= p:
                            # 前向上界
                            OptModel.add_linear_constraint(
                                OptModel.vFlow[p, sc, n, ni, nf, cc] <= mTEPES.pLineNTCFrw[ni, nf, cc] * OptModel.vNetworkInvest[p, ni, nf, cc]
                            )
                            # 反向下界
                            OptModel.add_linear_constraint(
                                OptModel.vFlow[p, sc, n, ni, nf, cc] >= -mTEPES.pLineNTCBck[ni, nf, cc] * OptModel.vNetworkInvest[p, ni, nf, cc]
                            )
                            cons_count += 2
    print('Added eNetCapacityInvest (vNetworkInvest-NTC) ... ', cons_count, ' rows')

    # def eLineLosses1(OptModel,p,sc,n,ni,nf,cc):
    #     if mTEPES.pIndBinSingleNode() == 0 and mTEPES.pIndBinNetLosses() and len(mTEPES.ll):
    #         return OptModel.vLineLosses[p,sc,n,ni,nf,cc] >= - 0.5 * mTEPES.pLineLossFactor[ni,nf,cc] * OptModel.vFlow[p,sc,n,ni,nf,cc]
    #     else:
    #         return Constraint.Skip
    # setattr(OptModel, 'eLineLosses1_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.ll, rule=eLineLosses1, doc='ohmic losses for all the lines [GW]'))

    # if pIndLogConsole == 1:
    #     print('eLineLosses1          ... ', len(getattr(OptModel, 'eLineLosses1_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    # def eLineLosses2(OptModel,p,sc,n,ni,nf,cc):
    #     if mTEPES.pIndBinSingleNode() == 0 and mTEPES.pIndBinNetLosses() and len(mTEPES.ll):
    #         return OptModel.vLineLosses[p,sc,n,ni,nf,cc] >=   0.5 * mTEPES.pLineLossFactor[ni,nf,cc] * OptModel.vFlow[p,sc,n,ni,nf,cc]
    #     else:
    #         return Constraint.Skip
    # setattr(OptModel, 'eLineLosses2_'+str(p)+'_'+str(sc)+'_'+str(st), Constraint(mTEPES.ps, mTEPES.n, mTEPES.ll, rule=eLineLosses2, doc='ohmic losses for all the lines [GW]'))

    # if pIndLogConsole == 1:
    #     print('eLineLosses2          ... ', len(getattr(OptModel, 'eLineLosses2_'+str(p)+'_'+str(sc)+'_'+str(st))), ' rows')

    GeneratingTime = time.time() - StartTime
    if pIndLogConsole == 1:
        print('Generating network    constraints      ... ', round(GeneratingTime), 's')

def EVplan_modelformulation(model):
    import numpy as np
    import pandas as pd
    import pyoptinterface as poi
    # ==========================================
    # 建立规划优化模型 (Optimization Model Formulation)
    # 约束条件 (Constraints)
    # ==========================================
    # 1. 站级功率容量约束：全站充放电受限
    for k in range(model.T_len):                              # 遍历系统每一时刻 k
        k_tuple = model.idx_tuples[k]                     # 获取时刻对应的元组
        var_list = model.grid_p_chr_vars[k_tuple] + model.grid_p_dis_vars[k_tuple] # 收集该时刻所有批次EV的充电和放电功率变量
        if len(var_list) > 0:                             # 若此时刻内存在活动的充放电变量
            total_abs_p_k = poi.quicksum(var_list)        # 使用POI加速函数，求出该时刻全站所有充放电功率的绝对总和
            model.add_linear_constraint(total_abs_p_k - model.P_CHR_MAX * model.N_pile <= 0, name=f"Capacity_Constraint_{k_tuple[2]}") # 添加线性约束：要求任何时刻总充放功率不超过充电站硬件总容量（单桩满功率 × 桩数）
            
        if len(model.grid_p_dis_vars[k_tuple]) > 0:             # 若此时刻存在放电操作变量（V2G 激活时）
            total_dis_k = poi.quicksum(model.grid_p_dis_vars[k_tuple]) # 对所有批次车辆在此时刻的放电功率求和
            model.add_linear_constraint(total_dis_k <= model.MAX_STATION_DISCHARGE, name=f"Grid_Max_Discharge_Constraint_{k_tuple[2]}") # 添加安全约束：限制整个充电站向电网侧释放的 V2G 最大总功率不突破预设安全上限

    # 2. 能量状态跨时段演进 (SoE Evolution)
    for t in range(model.T_len):                              # 再次遍历每一批次到达的 EV 组（按到达时刻 t 标记）
        V_t = model.visit_time[t]                         # 提取该群体的驻留时长
        if V_t == 0 or model.arrivals[t] == 0:            # 没有车或者不停留，直接跳过计 
            continue
        end_k = min(model.T_len, t + V_t)                     # 计算该批次EV离去的时间节 end_k（并做边界保护，防止越过仿真最后时刻）
        
        t_lvl = model.idx_tuples[t][2]
        model.add_linear_constraint(model.E_cohort[t, t] == model.initial_energy_per_cohort[t], name=f"E_init_{t}_{t_lvl}") # 初始条件约束：该批次到达时刻 t 的储能状态，必须精准等于其携带入站的初始储能 
        
        for k in range(t, end_k):                         # 在驻留时间窗内逐步推演能量传递方 
            k_lvl = model.idx_tuples[k][2]
            # 能量守恒转移方程：k+1时刻的电 = k时刻的电 +  小时 k)冲入的电 乘充电效  -  小时 k)放出的电 除以放电效率损失)
            model.add_linear_constraint(model.E_cohort[t, k+1] == model.E_cohort[t, k] + model.P_chr[t, k] * model.EFF_CHR - model.P_dis[t, k] / model.EFF_DIS, name=f"E_transfer_{t}_{k_lvl}")
            
        # 目标约束放宽机制，防止不合理的目标不可解
        max_achievable = model.initial_energy_per_cohort[t] + V_t * model.arrivals[t] * model.P_CHR_MAX * model.EFF_CHR # 如果这段驻留在每一个小时全速满功率充电，计算这批车能够达到的最大极限物理携带电 
        feasible_target = min(model.target_energy_per_cohort[t], max_achievable) # 最终考核目标：如果时间不够充不到车主预期，就以极限物理容量为考核刚性底线；反之则以车主设定SOC要求为底 
        
        end_k_lvl = model.idx_tuples[end_k][2] if end_k < model.T_len else "end"
        model.add_linear_constraint(model.E_cohort[t, end_k] >= feasible_target, name=f"E_target_{t}_{end_k_lvl}") # 终端条件约束：离场时刻的携带电量必须大于等于上述可行目标电量

    # ==========================================
    # 目标函数 (Objective Function)
    # ==========================================
    total_inv_cost = model.C_INV_PILE * model.N_pile      # 计算固定建设投资成本 = 单桩综合造价 * 寻优得出的规划桩 
    total_opr_cost = 0.0                                  # 初始化运行阶段的净开销 
    
    if len(model.P_chr) > 0:                              # 如果系统中建立了任何充放电变量（即有过真实EV接入 
        expense = poi.quicksum(model.P_ELEC_CHR[k] * model.P_chr[t, k] for t, k in model.P_chr.keys()) # 从电网购电的高昂支出 = Σ (每小时峰谷买入电 * 对应的群组充电功 
        revenue = poi.quicksum(model.P_ELEC_DIS[k] * model.P_dis[t, k] for t, k in model.P_dis.keys()) # 向电网V2G卖电的辅助收 = Σ (每小时峰谷卖出电 * 对应的群组放电功 
        total_opr_cost = expense - revenue                # 最终本年度该站的运行总成 如果是负数代表站方赚钱了) = 买电电费 - 卖电电费
        
    obj = total_inv_cost + total_opr_cost                 # EV独立模块的综合全寿命/全年度总成本目 = 初期建设折算投入 + 周期运行净消 
    model.eTotalTCost = model.eTotalTCost + obj           # (核心整合耦合 ：将这个独立的EV建设与运营成本，代数叠加进入 openTEPES 主系统的全局总年化成本目标函数变 eTotalTCost  
    model.set_objective(model.eTotalTCost, sense=poi.ObjectiveSense.Minimize) # 最后一步：命令底层数学求解器去【最小化】这个融合了主网系统总成本和充电站微系统总成本的新综合目 

def modelformulation_ammonia(model):
    import pyoptinterface as poi
    params = model.params_ammonia
    T = params['T']

    DOMAIN_BIN_RELAXED = poi.VariableDomain.Continuous

    # 容量变量
    cap_elec = model.add_variable(lb=0.0, ub=1e6, name='ammonia_cap_elec')
    cap_nh3 = model.add_variable(lb=0.0, ub=1e6, name='ammonia_cap_nh3')

    # 时序变量
    p_grid = {t: model.add_variable(lb=0.0, name=f'ammonia_p_grid_{t}') for t in T}
    p_elec = {t: model.add_variable(lb=0.0, name=f'ammonia_p_elec_{t}') for t in T}
    p_nh3 = {t: model.add_variable(lb=0.0, name=f'ammonia_p_nh3_{t}') for t in T}
    h2_prod = {t: model.add_variable(lb=0.0, name=f'ammonia_h2_prod_{t}') for t in T}
    h2_cons = {t: model.add_variable(lb=0.0, name=f'ammonia_h2_cons_{t}') for t in T}
    h2_sold = {t: model.add_variable(lb=0.0, name=f'ammonia_h2_sold_{t}') for t in T}
    nh3_prod = {t: model.add_variable(lb=0.0, name=f'ammonia_nh3_prod_{t}') for t in T}
    u_elec = {t: model.add_variable(lb=0.0, ub=1.0, domain=DOMAIN_BIN_RELAXED, name=f'ammonia_u_elec_{t}') for t in T}
    u_nh3 = {t: model.add_variable(lb=0.0, ub=1.0, domain=DOMAIN_BIN_RELAXED, name=f'ammonia_u_nh3_{t}') for t in T}

    big_m = 2e6

    # 约束
    for t in T:
        model.add_linear_constraint(p_elec[t] <= cap_elec)
        model.add_linear_constraint(p_elec[t] <= big_m * u_elec[t])
        model.add_linear_constraint(p_elec[t] >= params['min_elec_load'] * cap_elec - big_m * (1 - u_elec[t]))

        model.add_linear_constraint(p_nh3[t] <= cap_nh3)
        model.add_linear_constraint(p_nh3[t] <= big_m * u_nh3[t])
        model.add_linear_constraint(p_nh3[t] >= params['min_nh3_load'] * cap_nh3 - big_m * (1 - u_nh3[t]))

        model.add_linear_constraint(p_grid[t] == p_elec[t] + p_nh3[t])

        model.add_linear_constraint(h2_prod[t] == p_elec[t] * params['rate_h2_prod'])
        model.add_linear_constraint(nh3_prod[t] == p_nh3[t] * params['rate_nh3_prod'])
        model.add_linear_constraint(h2_cons[t] == p_nh3[t] * params['rate_nh3_h2_in'])
        model.add_linear_constraint(h2_prod[t] == h2_cons[t] + h2_sold[t])

    # 目标与全局约束
    cost_total = (
        sum(p_grid[t] * params['price_grid'] for t in T) +
        params['cost_elec'] * cap_elec + params['cost_nh3'] * cap_nh3
    )
    model.add_linear_constraint(cost_total <= params['max_annual_cost'])

    revenue_total = sum(h2_sold[t] * params['price_h2'] + nh3_prod[t] * params['price_nh3'] for t in T)

    if hasattr(model, 'eTotalTCost'):
        obj_expr = model.eTotalTCost + cost_total - revenue_total
        model.set_objective(obj_expr, sense=poi.ObjectiveSense.Minimize)
        model.eTotalTCost = obj_expr # Update reference
    else:
        model.set_objective(cost_total - revenue_total, sense=poi.ObjectiveSense.Minimize)

    var_dict = {
        'cap_elec': cap_elec,
        'cap_nh3': cap_nh3,
        'p_grid': p_grid,
        'p_elec': p_elec,
        'p_nh3': p_nh3,
        'h2_prod': h2_prod,
        'h2_sold': h2_sold,
        'nh3_prod': nh3_prod,
        'h2_cons': h2_cons,
    }

    print('氨模型构建完成')
    model.var_dict_ammonia = var_dict
    return var_dict

# ==================== 热系统建模函数 ====================

def ThermalSettingUpVariables_poi(OptModel, mTEPES):
    """
    创建热系统决策变量
    
    Args:
        OptModel: 优化模型
        mTEPES: 模型对象
    """
    print('\n创建热系统决策变量                   ****')
    StartTime = time.time()
    
    params = mTEPES.pThermalParams
    capacity_unit = mTEPES.pThermalCapacityUnit
    T = len(mTEPES.pThermalDemand)
    
    # 创建时间步映射： n (时间标签)  t (整数索引)
    n_list = list(mTEPES.n)
    mTEPES.n_to_t_map = {n_val: idx for idx, n_val in enumerate(n_list)}
    print(f'  时间步映射已创建: {len(mTEPES.n_to_t_map)} 个时间点')
    
    # 容量规划变量
    # 注意：参数文件中的容量单位是 kW，需要转换为 MW
    # capacity_unit = 0.01 MW = 10 kW
    boiler_cap_min_kw = params.get('boiler_capacity_min', 0)
    boiler_cap_max_kw = params.get('boiler_capacity_max', 150000)
    hp_cap_min_kw = params.get('hp_capacity_min', 0)
    hp_cap_max_kw = params.get('hp_capacity_max', 150000)
    
    # 转换为模型单位（ capacity_unit 为基准）
    # 1 kW = 0.001 MW，capacity_unit = 0.01 MW，因此 1 kW = 0.001/0.01 = 0.1 个单位
    kw_to_unit = 0.001 / capacity_unit  # kW 转换为模型单位的系数
    
    boiler_cap_min = int(boiler_cap_min_kw * kw_to_unit)
    boiler_cap_max = int(boiler_cap_max_kw * kw_to_unit)
    hp_cap_min = int(hp_cap_min_kw * kw_to_unit)
    hp_cap_max = int(hp_cap_max_kw * kw_to_unit)
    
    mTEPES.vCAP_boiler_units = OptModel.add_variable(
        lb=boiler_cap_min, ub=boiler_cap_max,
        domain=poi.VariableDomain.Integer,
        name='vCAP_boiler_units'
    )
    mTEPES.vCAP_hp_units = OptModel.add_variable(
        lb=hp_cap_min, ub=hp_cap_max,
        domain=poi.VariableDomain.Integer,
        name='vCAP_hp_units'
    )
    mTEPES.vInstall_boiler = OptModel.add_variable(
        domain=poi.VariableDomain.Binary,
        name='vInstall_boiler'
    )
    mTEPES.vInstall_hp = OptModel.add_variable(
        domain=poi.VariableDomain.Binary,
        name='vInstall_hp'
    )
    
    # CHP容量规划
    enable_chp = params.get('enable_chp_planning', 1)
    if enable_chp > 0:
        chp_cap_min_kw = params.get('chp_capacity_min', 0)
        chp_cap_max_kw = params.get('chp_capacity_max', 200000)
        
        chp_cap_min = int(chp_cap_min_kw * kw_to_unit)
        chp_cap_max = int(chp_cap_max_kw * kw_to_unit)
        
        mTEPES.vCAP_chp_units = OptModel.add_variable(
            lb=chp_cap_min, ub=chp_cap_max,
            domain=poi.VariableDomain.Integer,
            name='vCAP_chp_units'
        )
        mTEPES.vInstall_chp = OptModel.add_variable(
            domain=poi.VariableDomain.Binary,
            name='vInstall_chp'
        )
    
    # 运行变量
    mTEPES.vP_boiler_elec = np.empty(T, dtype=object)
    mTEPES.vP_hp_elec = np.empty(T, dtype=object)
    mTEPES.vQ_boiler_out = np.empty(T, dtype=object)
    mTEPES.vQ_hp_out = np.empty(T, dtype=object)
    mTEPES.vQ_district = np.empty(T, dtype=object)
    
    for t in range(T):
        mTEPES.vP_boiler_elec[t] = OptModel.add_variable(lb=0, name=f'vP_boiler_elec_{t}')
        mTEPES.vP_hp_elec[t] = OptModel.add_variable(lb=0, name=f'vP_hp_elec_{t}')
        mTEPES.vQ_boiler_out[t] = OptModel.add_variable(lb=0, name=f'vQ_boiler_out_{t}')
        mTEPES.vQ_hp_out[t] = OptModel.add_variable(lb=0, name=f'vQ_hp_out_{t}')
        mTEPES.vQ_district[t] = OptModel.add_variable(lb=0, name=f'vQ_district_{t}')
    
    # 储热罐变量
    storage_cap_min_kw = params.get('storage_capacity_min', 0)
    storage_cap_max_kw = params.get('storage_capacity_max', 300000)
    
    storage_cap_min = int(storage_cap_min_kw * kw_to_unit)
    storage_cap_max = int(storage_cap_max_kw * kw_to_unit)
    
    mTEPES.vCAP_storage_units = OptModel.add_variable(
        lb=storage_cap_min, ub=storage_cap_max,
        domain=poi.VariableDomain.Integer,
        name='vCAP_storage_units'
    )
    mTEPES.vInstall_storage = OptModel.add_variable(
        domain=poi.VariableDomain.Binary,
        name='vInstall_storage'
    )
    
    mTEPES.vE_thermal_storage = np.empty(T, dtype=object)
    mTEPES.vQ_storage_charge = np.empty(T, dtype=object)
    mTEPES.vQ_storage_discharge = np.empty(T, dtype=object)
    
    for t in range(T):
        mTEPES.vE_thermal_storage[t] = OptModel.add_variable(lb=0, name=f'vE_thermal_storage_{t}')
        mTEPES.vQ_storage_charge[t] = OptModel.add_variable(lb=0, name=f'vQ_storage_charge_{t}')
        mTEPES.vQ_storage_discharge[t] = OptModel.add_variable(lb=0, name=f'vQ_storage_discharge_{t}')
    
    # CHP运行变量
    if enable_chp > 0:
        mTEPES.vP_chp_elec = np.empty(T, dtype=object)
        mTEPES.vQ_chp_heat = np.empty(T, dtype=object)
        mTEPES.vF_chp_gas = np.empty(T, dtype=object)
        
        for t in range(T):
            mTEPES.vP_chp_elec[t] = OptModel.add_variable(lb=0, name=f'vP_chp_elec_{t}')
            mTEPES.vQ_chp_heat[t] = OptModel.add_variable(lb=0, name=f'vQ_chp_heat_{t}')
            mTEPES.vF_chp_gas[t] = OptModel.add_variable(lb=0, name=f'vF_chp_gas_{t}')
    
    # 吸收式制冷机变量
    enable_chiller = params.get('enable_chiller_planning', 0)
    if enable_chiller > 0:
        chiller_cap_min_kw = params.get('chiller_capacity_min', 0)
        chiller_cap_max_kw = params.get('chiller_capacity_max', 200000)
        chiller_cap_min = int(chiller_cap_min_kw * kw_to_unit)
        chiller_cap_max = int(chiller_cap_max_kw * kw_to_unit)
        
        mTEPES.vCAP_chiller_units = OptModel.add_variable(
            lb=chiller_cap_min, ub=chiller_cap_max,
            domain=poi.VariableDomain.Integer,
            name='vCAP_chiller_units'
        )
        mTEPES.vInstall_chiller = OptModel.add_variable(
            domain=poi.VariableDomain.Binary,
            name='vInstall_chiller'
        )
        # 制冷输出和热能输入（每时刻）
        mTEPES.vQ_chiller_cool = np.empty(T, dtype=object)
        mTEPES.vQ_chiller_heat_in = np.empty(T, dtype=object)
        for t in range(T):
            mTEPES.vQ_chiller_cool[t]    = OptModel.add_variable(lb=0, name=f'vQ_chiller_cool_{t}')
            mTEPES.vQ_chiller_heat_in[t] = OptModel.add_variable(lb=0, name=f'vQ_chiller_heat_in_{t}')
        print(f'  吸收式制冷机变量已创建: vCAP, vInstall, {T}个vQ_cool, {T}个vQ_heat_in')
    
    # 压缩式制冷机变量
    enable_comp = params.get('enable_comp_chiller_planning', 0)
    if enable_comp > 0:
        comp_cap_min_kw = params.get('comp_chiller_capacity_min', 0)
        comp_cap_max_kw = params.get('comp_chiller_capacity_max', 200000)
        comp_cap_min = int(comp_cap_min_kw * kw_to_unit)
        comp_cap_max = int(comp_cap_max_kw * kw_to_unit)
        
        mTEPES.vCAP_comp_units = OptModel.add_variable(
            lb=comp_cap_min, ub=comp_cap_max,
            domain=poi.VariableDomain.Integer,
            name='vCAP_comp_units'
        )
        mTEPES.vInstall_comp = OptModel.add_variable(
            domain=poi.VariableDomain.Binary,
            name='vInstall_comp'
        )
        # 制冷输出和电能输入（每时刻）
        mTEPES.vQ_comp_cool  = np.empty(T, dtype=object)
        mTEPES.vP_comp_elec  = np.empty(T, dtype=object)
        for t in range(T):
            mTEPES.vQ_comp_cool[t] = OptModel.add_variable(lb=0, name=f'vQ_comp_cool_{t}')
            mTEPES.vP_comp_elec[t] = OptModel.add_variable(lb=0, name=f'vP_comp_elec_{t}')
        print(f'  压缩式制冷机变量已创建: vCAP, vInstall, {T}个vQ_cool, {T}个vP_elec')
    
    # GT（燃气轮机）容量规划变量
    enable_gt = params.get('enable_gt_planning', 1)
    if enable_gt > 0:
        gt_cap_min_kw = params.get('gt_capacity_min', 0)
        gt_cap_max_kw = params.get('gt_capacity_max', 326000)
        gt_cap_min = int(gt_cap_min_kw * kw_to_unit)
        gt_cap_max = int(gt_cap_max_kw * kw_to_unit)
        
        mTEPES.vCAP_gt_units = OptModel.add_variable(
            lb=gt_cap_min, ub=gt_cap_max,
            domain=poi.VariableDomain.Integer,
            name='vCAP_gt_units'
        )
        mTEPES.vInstall_gt = OptModel.add_variable(
            domain=poi.VariableDomain.Binary,
            name='vInstall_gt'
        )
        mTEPES.vP_gt_elec  = np.empty(T, dtype=object)  # GT 发电功率 [MW]
        mTEPES.vQ_gt_heat  = np.empty(T, dtype=object)  # GT 余热产热 [MW]
        mTEPES.vF_gt_gas   = np.empty(T, dtype=object)  # GT 燃气消耗 [MW_gas]
        for t in range(T):
            mTEPES.vP_gt_elec[t] = OptModel.add_variable(lb=0, name=f'vP_gt_elec_{t}')
            mTEPES.vQ_gt_heat[t] = OptModel.add_variable(lb=0, name=f'vQ_gt_heat_{t}')
            mTEPES.vF_gt_gas[t]  = OptModel.add_variable(lb=0, name=f'vF_gt_gas_{t}')
        print(f'  GT变量已创建: vCAP, vInstall, {T}个vP_elec, {T}个vQ_heat, {T}个vF_gas')
    
    # ST（蒸汽轮机）容量规划变量，消耗GT余热蒸汽发电
    enable_st = params.get('enable_st_planning', 1)
    if enable_st > 0 and enable_gt > 0:
        st_cap_min_kw = params.get('st_capacity_min', 0)
        st_cap_max_kw = params.get('st_capacity_max', 5000)
        st_cap_min = int(st_cap_min_kw * kw_to_unit)
        st_cap_max = int(st_cap_max_kw * kw_to_unit)
        
        mTEPES.vCAP_st_units = OptModel.add_variable(
            lb=st_cap_min, ub=st_cap_max,
            domain=poi.VariableDomain.Integer,
            name='vCAP_st_units'
        )
        mTEPES.vInstall_st = OptModel.add_variable(
            domain=poi.VariableDomain.Binary,
            name='vInstall_st'
        )
        mTEPES.vP_st_elec  = np.empty(T, dtype=object)  # ST 发电功率 [MW]
        mTEPES.vQ_st_steam = np.empty(T, dtype=object)  # ST 消耗蒸汽（来自GT余热）[MW]
        for t in range(T):
            mTEPES.vP_st_elec[t]  = OptModel.add_variable(lb=0, name=f'vP_st_elec_{t}')
            mTEPES.vQ_st_steam[t] = OptModel.add_variable(lb=0, name=f'vQ_st_steam_{t}')
        print(f'  ST变量已创建: vCAP, vInstall, {T}个vP_elec, {T}个vQ_steam')
    
    CreatingTime = time.time() - StartTime
    print(f'热系统决策变量创建完成               ... {CreatingTime:.2f} s')


def ThermalInvestmentModelFormulation_poi(OptModel, mTEPES, pIndLogConsole):
    """添加投资规划约束"""
    print('\n热系统投资规划约束                   ****')
    StartTime = time.time()
    
    params = mTEPES.pThermalParams
    capacity_unit = mTEPES.pThermalCapacityUnit
    
    # kW 转换为模型单位的系数
    kw_to_unit = 0.001 / capacity_unit
    
    # 锅炉容量约束
    boiler_cap_min = params.get('boiler_capacity_min', 0)
    boiler_cap_max = params.get('boiler_capacity_max', 150000)
    
    if boiler_cap_min > 0:
        expr1 = poi.ExprBuilder()
        expr1 += mTEPES.vCAP_boiler_units - int(boiler_cap_min * kw_to_unit) * mTEPES.vInstall_boiler
        OptModel.add_linear_constraint(expr1, poi.Geq, 0)
    
    expr2 = poi.ExprBuilder()
    expr2 += mTEPES.vCAP_boiler_units - int(boiler_cap_max * kw_to_unit) * mTEPES.vInstall_boiler
    OptModel.add_linear_constraint(expr2, poi.Leq, 0)
    
    # 热泵容量约束
    hp_cap_min = params.get('hp_capacity_min', 0)
    hp_cap_max = params.get('hp_capacity_max', 150000)
    
    if hp_cap_min > 0:
        expr3 = poi.ExprBuilder()
        expr3 += mTEPES.vCAP_hp_units - int(hp_cap_min * kw_to_unit) * mTEPES.vInstall_hp
        OptModel.add_linear_constraint(expr3, poi.Geq, 0)
    
    expr4 = poi.ExprBuilder()
    expr4 += mTEPES.vCAP_hp_units - int(hp_cap_max * kw_to_unit) * mTEPES.vInstall_hp
    OptModel.add_linear_constraint(expr4, poi.Leq, 0)
    
    # CHP容量约束
    enable_chp = params.get('enable_chp_planning', 1)
    if enable_chp > 0:
        chp_cap_min = params.get('chp_capacity_min', 0)
        chp_cap_max = params.get('chp_capacity_max', 200000)
        
        if chp_cap_min > 0:
            expr5 = poi.ExprBuilder()
            expr5 += mTEPES.vCAP_chp_units - int(chp_cap_min * kw_to_unit) * mTEPES.vInstall_chp
            OptModel.add_linear_constraint(expr5, poi.Geq, 0)
        
        expr6 = poi.ExprBuilder()
        expr6 += mTEPES.vCAP_chp_units - int(chp_cap_max * kw_to_unit) * mTEPES.vInstall_chp
        OptModel.add_linear_constraint(expr6, poi.Leq, 0)
    
    # 储热罐容量约束
    storage_cap_min = params.get('storage_capacity_min', 0)
    storage_cap_max = params.get('storage_capacity_max', 300000)
    
    if storage_cap_min > 0:
        expr7 = poi.ExprBuilder()
        expr7 += mTEPES.vCAP_storage_units - int(storage_cap_min * kw_to_unit) * mTEPES.vInstall_storage
        OptModel.add_linear_constraint(expr7, poi.Geq, 0)
    
    expr8 = poi.ExprBuilder()
    expr8 += mTEPES.vCAP_storage_units - int(storage_cap_max * kw_to_unit) * mTEPES.vInstall_storage
    OptModel.add_linear_constraint(expr8, poi.Leq, 0)
    
    # 吸收式制冷机容量约束
    enable_chiller = params.get('enable_chiller_planning', 0)
    if enable_chiller > 0 and hasattr(mTEPES, 'vCAP_chiller_units'):
        chiller_cap_min = params.get('chiller_capacity_min', 0)
        chiller_cap_max = params.get('chiller_capacity_max', 200000)
        if chiller_cap_min > 0:
            exprC1 = poi.ExprBuilder()
            exprC1 += mTEPES.vCAP_chiller_units - int(chiller_cap_min * kw_to_unit) * mTEPES.vInstall_chiller
            OptModel.add_linear_constraint(exprC1, poi.Geq, 0)
        exprC2 = poi.ExprBuilder()
        exprC2 += mTEPES.vCAP_chiller_units - int(chiller_cap_max * kw_to_unit) * mTEPES.vInstall_chiller
        OptModel.add_linear_constraint(exprC2, poi.Leq, 0)
    
    # 压缩式制冷机容量约束
    enable_comp = params.get('enable_comp_chiller_planning', 0)
    if enable_comp > 0 and hasattr(mTEPES, 'vCAP_comp_units'):
        comp_cap_min = params.get('comp_chiller_capacity_min', 0)
        comp_cap_max = params.get('comp_chiller_capacity_max', 200000)
        if comp_cap_min > 0:
            exprD1 = poi.ExprBuilder()
            exprD1 += mTEPES.vCAP_comp_units - int(comp_cap_min * kw_to_unit) * mTEPES.vInstall_comp
            OptModel.add_linear_constraint(exprD1, poi.Geq, 0)
        exprD2 = poi.ExprBuilder()
        exprD2 += mTEPES.vCAP_comp_units - int(comp_cap_max * kw_to_unit) * mTEPES.vInstall_comp
        OptModel.add_linear_constraint(exprD2, poi.Leq, 0)
    
    # GT（燃气轮机）容量约束
    enable_gt = params.get('enable_gt_planning', 1)
    if enable_gt > 0 and hasattr(mTEPES, 'vCAP_gt_units'):
        gt_cap_min = params.get('gt_capacity_min', 0)
        gt_cap_max = params.get('gt_capacity_max', 326000)
        if gt_cap_min > 0:
            exprGT1 = poi.ExprBuilder()
            exprGT1 += mTEPES.vCAP_gt_units - int(gt_cap_min * kw_to_unit) * mTEPES.vInstall_gt
            OptModel.add_linear_constraint(exprGT1, poi.Geq, 0)
        exprGT2 = poi.ExprBuilder()
        exprGT2 += mTEPES.vCAP_gt_units - int(gt_cap_max * kw_to_unit) * mTEPES.vInstall_gt
        OptModel.add_linear_constraint(exprGT2, poi.Leq, 0)
    
    # ST（蒸汽轮机）容量约束
    enable_st = params.get('enable_st_planning', 1)
    if enable_st > 0 and enable_gt > 0 and hasattr(mTEPES, 'vCAP_st_units'):
        st_cap_min = params.get('st_capacity_min', 0)
        st_cap_max = params.get('st_capacity_max', 5000)
        if st_cap_min > 0:
            exprST1 = poi.ExprBuilder()
            exprST1 += mTEPES.vCAP_st_units - int(st_cap_min * kw_to_unit) * mTEPES.vInstall_st
            OptModel.add_linear_constraint(exprST1, poi.Geq, 0)
        exprST2 = poi.ExprBuilder()
        exprST2 += mTEPES.vCAP_st_units - int(st_cap_max * kw_to_unit) * mTEPES.vInstall_st
        OptModel.add_linear_constraint(exprST2, poi.Leq, 0)
    
    GeneratingTime = time.time() - StartTime
    if pIndLogConsole == 1:
        print(f'热系统投资规划约束添加完成           ... {GeneratingTime:.2f} s')


def ThermalGenerationOperationModelFormulation_poi(OptModel, mTEPES, pIndLogConsole):
    """添加热源运行约束"""
    print('\n热源运行约束                           ****')
    StartTime = time.time()
    
    params = mTEPES.pThermalParams
    capacity_unit = mTEPES.pThermalCapacityUnit
    T = len(mTEPES.pThermalDemand)
    
    boiler_efficiency = params.get('boiler_efficiency', 0.99)
    hp_cop = params.get('hp_cop', 2.43)
    district_q_max = params.get('district_q_max', 200000)
    enable_chp = params.get('enable_chp_planning', 0)
    enable_gt = params.get('enable_gt_planning', 1)
    enable_st = params.get('enable_st_planning', 1)
    
    for t in range(T):
        # 锅炉约束
        expr2 = poi.ExprBuilder()
        expr2 += mTEPES.vQ_boiler_out[t] - boiler_efficiency * mTEPES.vP_boiler_elec[t]
        OptModel.add_linear_constraint(expr2, poi.Eq, 0)
        
        expr3 = poi.ExprBuilder()
        expr3 += mTEPES.vQ_boiler_out[t] - capacity_unit * mTEPES.vCAP_boiler_units
        OptModel.add_linear_constraint(expr3, poi.Leq, 0)
        
        # 热泵约束
        expr4 = poi.ExprBuilder()
        expr4 += mTEPES.vQ_hp_out[t] - hp_cop * mTEPES.vP_hp_elec[t]
        OptModel.add_linear_constraint(expr4, poi.Eq, 0)
        
        expr5 = poi.ExprBuilder()
        expr5 += mTEPES.vQ_hp_out[t] - capacity_unit * mTEPES.vCAP_hp_units
        OptModel.add_linear_constraint(expr5, poi.Leq, 0)
        
        # 区域供热约束
        OptModel.add_linear_constraint(mTEPES.vQ_district[t], poi.Leq, district_q_max)
    
    # CHP运行约束
    if enable_chp > 0:
        elec_efficiency = params.get('chp_elec_efficiency', 0.45)
        heat_efficiency = params.get('chp_heat_efficiency', 0.41)
        
        for t in range(T):
            # 电功率上限
            expr1 = poi.ExprBuilder()
            expr1 += mTEPES.vP_chp_elec[t] - capacity_unit * mTEPES.vCAP_chp_units
            OptModel.add_linear_constraint(expr1, poi.Leq, 0)
            
            # 发电效率
            expr2 = poi.ExprBuilder()
            expr2 += mTEPES.vP_chp_elec[t] - elec_efficiency * mTEPES.vF_chp_gas[t]
            OptModel.add_linear_constraint(expr2, poi.Eq, 0)
            
            # 供热效率
            expr3 = poi.ExprBuilder()
            expr3 += mTEPES.vQ_chp_heat[t] - heat_efficiency * mTEPES.vF_chp_gas[t]
            OptModel.add_linear_constraint(expr3, poi.Eq, 0)

    # GT（燃气轮机）运行约束
    if enable_gt > 0 and hasattr(mTEPES, 'vP_gt_elec') and hasattr(mTEPES, 'vCAP_gt_units'):
        gt_elec_eff = params.get('gt_elec_efficiency', 0.404)
        gt_heat_eff = params.get('gt_heat_efficiency', 0.534)
        for t in range(T):
            # 电功率上限
            expr_gt1 = poi.ExprBuilder()
            expr_gt1 += mTEPES.vP_gt_elec[t] - capacity_unit * mTEPES.vCAP_gt_units
            OptModel.add_linear_constraint(expr_gt1, poi.Leq, 0)

            # 发电效率
            expr_gt2 = poi.ExprBuilder()
            expr_gt2 += mTEPES.vP_gt_elec[t] - gt_elec_eff * mTEPES.vF_gt_gas[t]
            OptModel.add_linear_constraint(expr_gt2, poi.Eq, 0)

            # 余热效率
            expr_gt3 = poi.ExprBuilder()
            expr_gt3 += mTEPES.vQ_gt_heat[t] - gt_heat_eff * mTEPES.vF_gt_gas[t]
            OptModel.add_linear_constraint(expr_gt3, poi.Eq, 0)

    # ST（蒸汽轮机）运行约束
    if enable_st > 0 and enable_gt > 0 and hasattr(mTEPES, 'vP_st_elec') and hasattr(mTEPES, 'vCAP_st_units'):
        st_elec_eff = params.get('st_elec_efficiency', 0.30)
        for t in range(T):
            # 电功率上限
            expr_st1 = poi.ExprBuilder()
            expr_st1 += mTEPES.vP_st_elec[t] - capacity_unit * mTEPES.vCAP_st_units
            OptModel.add_linear_constraint(expr_st1, poi.Leq, 0)

            # 热电转换效率
            expr_st2 = poi.ExprBuilder()
            expr_st2 += mTEPES.vP_st_elec[t] - st_elec_eff * mTEPES.vQ_st_steam[t]
            OptModel.add_linear_constraint(expr_st2, poi.Eq, 0)

            # ST蒸汽消耗不超过GT余热输出
            expr_st3 = poi.ExprBuilder()
            expr_st3 += mTEPES.vQ_st_steam[t] - mTEPES.vQ_gt_heat[t]
            OptModel.add_linear_constraint(expr_st3, poi.Leq, 0)
    
    # 吸收式制冷机运行约束
    enable_chiller = params.get('enable_chiller_planning', 0)
    if enable_chiller > 0 and hasattr(mTEPES, 'vCAP_chiller_units'):
        # 中间系数预计算（基于设计环境温度线性化）
        eta_min = params.get('chiller_eta_min', 0.65)
        eta_max = params.get('chiller_eta_max', 0.80)
        T_min   = params.get('chiller_T_min', 10.0)
        T_max   = params.get('chiller_T_max', 40.0)
        T_design = params.get('chiller_T_design', 30.0)
        # c1, c2：逆效率线性插值系数
        c1 = (1.0/eta_max - 1.0/eta_min) / (T_max - T_min)
        c2 = 1.0/eta_max - T_max * c1
        # 在设计温度下，热输入与制冷量之比（将非线性化为常数）
        alpha = c1 * T_design + c2  # Q_heat_in = alpha * Q_cool
        
        chiller_demand = mTEPES.pChillerDemand  # kW
        for t in range(T):
            # 1. 制冷出力容量上限
            exprA = poi.ExprBuilder()
            exprA += mTEPES.vQ_chiller_cool[t] - capacity_unit * mTEPES.vCAP_chiller_units
            OptModel.add_linear_constraint(exprA, poi.Leq, 0)
            
            # 2. 热输入与制冷量耦合关系（线性化）：Q_heat_in = alpha * Q_cool
            exprB = poi.ExprBuilder()
            exprB += mTEPES.vQ_chiller_heat_in[t] - alpha * mTEPES.vQ_chiller_cool[t]
            OptModel.add_linear_constraint(exprB, poi.Eq, 0)
        
        print(f'  吸收式制冷机运行约束建立: alpha={alpha:.4f} (设计温度{T_design}°C)')
    
    # 压缩式制冷机运行约束
    enable_comp = params.get('enable_comp_chiller_planning', 0)
    if enable_comp > 0 and hasattr(mTEPES, 'vCAP_comp_units'):
        cop = params.get('comp_chiller_cop', 2.7)
        load_min = params.get('comp_chiller_load_min', 0.2)
        load_max = params.get('comp_chiller_load_max', 1.0)
        
        for t in range(T):
            # 1. COP关系: Q_cool = cop * P_elec
            exprE = poi.ExprBuilder()
            exprE += mTEPES.vQ_comp_cool[t] - cop * mTEPES.vP_comp_elec[t]
            OptModel.add_linear_constraint(exprE, poi.Eq, 0)
            
            # 2. 制冷出力上限（额定容量×最大负荷比）
            exprF = poi.ExprBuilder()
            exprF += mTEPES.vQ_comp_cool[t] - load_max * capacity_unit * mTEPES.vCAP_comp_units
            OptModel.add_linear_constraint(exprF, poi.Leq, 0)
        
        print(f'  压缩式制冷机运行约束建立: COP={cop}, 负荷范围[{load_min*100:.0f}%~{load_max*100:.0f}%]')
    
    # 制冷负荷平衡约束：吸收式 + 压缩式，实时严格等于制冷需求
    chiller_demand = mTEPES.pChillerDemand
    has_abs  = enable_chiller > 0 and hasattr(mTEPES, 'vQ_chiller_cool')
    has_comp = enable_comp   > 0 and hasattr(mTEPES, 'vQ_comp_cool')
    if has_abs or has_comp:
        for t in range(T):
            exprG = poi.ExprBuilder()
            if has_abs:
                exprG += mTEPES.vQ_chiller_cool[t]
            if has_comp:
                exprG += mTEPES.vQ_comp_cool[t]
            OptModel.add_linear_constraint(exprG, poi.Eq, chiller_demand[t])  # 实时平衡（等号）
        print(f'  制冷负荷平衡约束(实时等号): 全年{T}个时段，供冷=需求')
    
    GeneratingTime = time.time() - StartTime
    if pIndLogConsole == 1:
        print(f'热源运行约束添加完成                   ... {GeneratingTime:.2f} s')


def ThermalStorageOperationModelFormulation_poi(OptModel, mTEPES, pIndLogConsole):
    """添加储热罐运行约束"""
    print('\n储热罐运行约束                       ****')
    StartTime = time.time()
    
    params = mTEPES.pThermalParams
    capacity_unit = mTEPES.pThermalCapacityUnit
    T = len(mTEPES.pThermalDemand)
    
    storage_init_ratio = params.get('storage_init_ratio', 0.3)
    charge_rate = params.get('storage_charge_rate', 0.5)
    discharge_rate = params.get('storage_discharge_rate', 0.5)
    eta_charge = params.get('storage_eta_charge', 0.98)
    eta_discharge = params.get('storage_eta_discharge', 0.98)
    loss_rate = params.get('storage_loss_rate', 0.02) / 100
    
    for t in range(T):
        # 储热量上限约束
        expr1 = poi.ExprBuilder()
        expr1 += mTEPES.vE_thermal_storage[t] - capacity_unit * mTEPES.vCAP_storage_units
        OptModel.add_linear_constraint(expr1, poi.Leq, 0)
        
        # 充电功率上限
        expr2 = poi.ExprBuilder()
        expr2 += mTEPES.vQ_storage_charge[t] - charge_rate * capacity_unit * mTEPES.vCAP_storage_units
        OptModel.add_linear_constraint(expr2, poi.Leq, 0)
        
        # 放电功率上限
        expr3 = poi.ExprBuilder()
        expr3 += mTEPES.vQ_storage_discharge[t] - discharge_rate * capacity_unit * mTEPES.vCAP_storage_units
        OptModel.add_linear_constraint(expr3, poi.Leq, 0)
        
        # 储能平衡
        if t == 0:
            expr = poi.ExprBuilder()
            expr += mTEPES.vE_thermal_storage[t]
            expr += -(1 - loss_rate) * storage_init_ratio * capacity_unit * mTEPES.vCAP_storage_units
            expr += -eta_charge * mTEPES.vQ_storage_charge[t]
            expr += mTEPES.vQ_storage_discharge[t] / eta_discharge
            OptModel.add_linear_constraint(expr, poi.Eq, 0)
        else:
            expr = poi.ExprBuilder()
            expr += mTEPES.vE_thermal_storage[t] - (1 - loss_rate) * mTEPES.vE_thermal_storage[t-1]
            expr += -eta_charge * mTEPES.vQ_storage_charge[t]
            expr += mTEPES.vQ_storage_discharge[t] / eta_discharge
            OptModel.add_linear_constraint(expr, poi.Eq, 0)
    
    GeneratingTime = time.time() - StartTime
    if pIndLogConsole == 1:
        print(f'储热罐运行约束添加完成               ... {GeneratingTime:.2f} s')


def ThermalBalanceModelFormulation_poi(OptModel, mTEPES, pIndLogConsole):
    """添加热平衡约束（包括制冷消耗热输入）"""
    print('\n热平衡约束                            ****')
    StartTime = time.time()
    
    params = mTEPES.pThermalParams
    T = len(mTEPES.pThermalDemand)
    demand = mTEPES.pThermalDemand
    enable_chp = params.get('enable_chp_planning', 1)
    enable_chiller = params.get('enable_chiller_planning', 0)
    enable_gt = params.get('enable_gt_planning', 1)
    enable_st = params.get('enable_st_planning', 1)
    
    for t in range(T):
        expr = poi.ExprBuilder()
        expr += mTEPES.vQ_boiler_out[t] + mTEPES.vQ_hp_out[t] + mTEPES.vQ_district[t]
        
        if enable_chp > 0:
            expr += mTEPES.vQ_chp_heat[t]

        # GT余热扣除ST蒸汽消耗后进入热网
        if enable_gt > 0 and hasattr(mTEPES, 'vQ_gt_heat'):
            expr += mTEPES.vQ_gt_heat[t]
        if enable_st > 0 and hasattr(mTEPES, 'vQ_st_steam'):
            expr += -mTEPES.vQ_st_steam[t]
        
        expr += mTEPES.vQ_storage_discharge[t]
        expr += -mTEPES.vQ_storage_charge[t]
        
        # 制冷机消耗热输入：从CHP供热侧扣除制冷机热输入需求
        if enable_chiller > 0 and hasattr(mTEPES, 'vQ_chiller_heat_in'):
            expr += -mTEPES.vQ_chiller_heat_in[t]
        
        OptModel.add_linear_constraint(expr, poi.Eq, demand[t])
    
    GeneratingTime = time.time() - StartTime
    if pIndLogConsole == 1:
        print(f'热平衡约束添加完成                    ... {GeneratingTime:.2f} s')


def ThermalObjectiveFunction_poi(OptModel, mTEPES, pIndLogConsole):
    """
    计算热系统目标函数（返回成本表达式，用于添加到总目标函数）
    """
    print('\n热系统目标函数                        ****')
    StartTime = time.time()
    
    params = mTEPES.pThermalParams
    capacity_unit = mTEPES.pThermalCapacityUnit
    T = len(mTEPES.pThermalDemand)
    
    # 经济参数
    investment_years = params.get('investment_years', 10)
    discount_rate = params.get('discount_rate', 0.08)
    crf = discount_rate * (1 + discount_rate)**investment_years / ((1 + discount_rate)**investment_years - 1)
    
    # 投资成本年化
    thermal_cost = poi.ExprBuilder()
    
    # 锅炉投资
    boiler_unit_cost = params.get('boiler_unit_cost', 0)
    boiler_fixed_cost = params.get('boiler_fixed_cost', 0)
    thermal_cost += crf * boiler_fixed_cost * mTEPES.vInstall_boiler
    thermal_cost += crf * boiler_unit_cost * capacity_unit * mTEPES.vCAP_boiler_units
    
    # 热泵投资
    hp_unit_cost = params.get('hp_unit_cost', 1000)
    hp_fixed_cost = params.get('hp_fixed_cost', 0)
    thermal_cost += crf * hp_fixed_cost * mTEPES.vInstall_hp
    thermal_cost += crf * hp_unit_cost * capacity_unit * mTEPES.vCAP_hp_units
    
    # CHP投资
    enable_chp = params.get('enable_chp_planning', 1)
    if enable_chp > 0:
        chp_unit_cost = params.get('chp_unit_cost', 3750)
        chp_fixed_cost = params.get('chp_fixed_cost', 0)
        thermal_cost += crf * chp_fixed_cost * mTEPES.vInstall_chp
        thermal_cost += crf * chp_unit_cost * capacity_unit * mTEPES.vCAP_chp_units

    # GT（燃气轮机）投资
    enable_gt = params.get('enable_gt_planning', 1)
    if enable_gt > 0 and hasattr(mTEPES, 'vCAP_gt_units'):
        gt_unit_cost = params.get('gt_unit_cost', 2905)
        gt_fixed_cost = params.get('gt_fixed_cost', 0)
        thermal_cost += crf * gt_fixed_cost * mTEPES.vInstall_gt
        thermal_cost += crf * gt_unit_cost * capacity_unit * mTEPES.vCAP_gt_units

    # ST（蒸汽轮机）投资
    enable_st = params.get('enable_st_planning', 1)
    if enable_st > 0 and enable_gt > 0 and hasattr(mTEPES, 'vCAP_st_units'):
        st_unit_cost = params.get('st_unit_cost', 7000)
        st_fixed_cost = params.get('st_fixed_cost', 0)
        thermal_cost += crf * st_fixed_cost * mTEPES.vInstall_st
        thermal_cost += crf * st_unit_cost * capacity_unit * mTEPES.vCAP_st_units
    
    # 储热罐投资
    storage_unit_cost = params.get('storage_unit_cost', 204.2)
    storage_fixed_cost = params.get('storage_fixed_cost', 0)
    thermal_cost += crf * storage_fixed_cost * mTEPES.vInstall_storage
    thermal_cost += crf * storage_unit_cost * capacity_unit * mTEPES.vCAP_storage_units
    
    # 吸收式制冷机投资
    enable_chiller = params.get('enable_chiller_planning', 0)
    if enable_chiller > 0 and hasattr(mTEPES, 'vCAP_chiller_units'):
        chiller_unit_cost  = params.get('chiller_unit_cost', 800)
        chiller_fixed_cost = params.get('chiller_fixed_cost', 0)
        thermal_cost += crf * chiller_fixed_cost * mTEPES.vInstall_chiller
        thermal_cost += crf * chiller_unit_cost * capacity_unit * mTEPES.vCAP_chiller_units
    
    # 压缩式制冷机投资
    enable_comp = params.get('enable_comp_chiller_planning', 0)
    if enable_comp > 0 and hasattr(mTEPES, 'vCAP_comp_units'):
        comp_unit_cost  = params.get('comp_chiller_unit_cost', 600)
        comp_fixed_cost = params.get('comp_chiller_fixed_cost', 0)
        thermal_cost += crf * comp_fixed_cost * mTEPES.vInstall_comp
        thermal_cost += crf * comp_unit_cost * capacity_unit * mTEPES.vCAP_comp_units
    
    # 运行成本
    district_heat_price = params.get('district_heat_price', 0.3)
    
    for t in range(T):
        # 区域供热成本
        thermal_cost += district_heat_price * mTEPES.vQ_district[t]
    
    # CHP运行成本
    if enable_chp > 0:
        gas_price = params.get('gas_price', 0.12)
        for t in range(T):
            thermal_cost += gas_price * mTEPES.vF_chp_gas[t]

    # GT运行成本（天然气燃料 + OPEX）
    if enable_gt > 0 and hasattr(mTEPES, 'vF_gt_gas') and hasattr(mTEPES, 'vP_gt_elec'):
        gas_price = params.get('gas_price', 0.12)
        gt_opex = params.get('gt_opex', 0.014)
        for t in range(T):
            thermal_cost += gas_price * mTEPES.vF_gt_gas[t]
            thermal_cost += gt_opex * mTEPES.vP_gt_elec[t]

    # ST运行成本（OPEX，无燃料成本）
    if enable_st > 0 and enable_gt > 0 and hasattr(mTEPES, 'vP_st_elec'):
        st_opex = params.get('st_opex', 0.007)
        for t in range(T):
            thermal_cost += st_opex * mTEPES.vP_st_elec[t]
    
    # 储热罐充放热惩罚项（避免同时充放热）
    storage_penalty = params.get('storage_penalty', 0.001)
    if storage_penalty > 0:
        for t in range(T):
            thermal_cost += storage_penalty * (mTEPES.vQ_storage_charge[t] + mTEPES.vQ_storage_discharge[t])
    
    GeneratingTime = time.time() - StartTime
    if pIndLogConsole == 1:
        print(f'热系统目标函数计算完成               ... {GeneratingTime:.2f} s')
    
    return thermal_cost


def DC_modelformulation(DirName, CaseName, mTEPES, pIndLogConsole):
    """
    数据中心(EHCCS)建模入口。

    按 `数据中心/EHCCS复现参数变量约束梳理.md` 先落地一个“可求解”的最小 DC 模块（不读写CSV）：
    - 容量：新增服务器数量、冷却容量
    - 运行：活跃服务器数、IT功率、冷却功率/制冷量、数据中心总功率
    - 关键约束：式(8)、(9)-(10)、(22)（简化为给定到达量）、(24)（聚合形式）

    说明：
    - CPU 温度 (20)-(21)：单机功率用「总 IT 功率 / 参考台数 n_ref」均分近似，将 exp 改为一阶显式欧拉离散
      τ=R·C，α=min(1, Δt/τ)，T_{t+1}=(1-α)T_t+α·T_ss,t，T_ss=P_srv_w·R^{cpu}+T^{in}，P_srv_w=P_IT[kW]·1000/n_ref；
    - QoS (23) 暂用“处理能力”线性约束替代：到达量 ≤ 活跃服务器数 × 单机处理能力。
    """
    if not hasattr(mTEPES, "pDC") or not getattr(mTEPES, "pDCParams", None):
        raise RuntimeError("DC_modelformulation: 未找到数据中心输入，请先执行 DC_inputdata()")

    OptModel = mTEPES
    params = mTEPES.pDCParams
    T = int(mTEPES.pDC.get("T", 0))
    if T <= 0:
        raise RuntimeError("DC_modelformulation: 时间维度 T 无效")

    # ========= 容量规划变量 =========
    srv_exist = int(params["srv_exist_q"])
    srv_max = int(params["srv_max_q"])
    srv_add_max = max(0, srv_max - srv_exist)

    mTEPES.vDC_SrvAdd = OptModel.add_variable(
        lb=0, ub=srv_add_max, domain=poi.VariableDomain.Integer, name="vDC_SrvAdd"
    )

    cool_exist_kw = float(params["cool_exist_q_kw"])
    cool_max_kw = float(params["cool_max_q_kw"])
    cool_add_max_kw = max(0.0, cool_max_kw - cool_exist_kw)
    mTEPES.vDC_CoolAdd_kW = OptModel.add_variable(
        lb=0.0, ub=cool_add_max_kw, name="vDC_CoolAdd_kW"
    )

    # ========= 运行变量（按 t）=========
    mTEPES.vDC_NSrv = np.empty(T, dtype=object)         # 活跃服务器数（聚合）
    mTEPES.vDC_L_tasks = np.empty(T, dtype=object)      # 处理任务量（聚合，任务/时段）
    mTEPES.vDC_P_IT = np.empty(T, dtype=object)         # IT功率(kW)
    mTEPES.vDC_P_cool = np.empty(T, dtype=object)       # 冷却耗电(kW)
    mTEPES.vDC_H_cool = np.empty(T, dtype=object)       # 制冷量(kW_th)
    mTEPES.vDC_P_DC = np.empty(T, dtype=object)         # 总功率(kW)
    mTEPES.vDC_T_cpu = None                             # CPU 温度 [K]，启用时 shape (T,)
    mTEPES.vDC_T_in = None                              # 室内温度 [℃]，启用时 shape (T,)

    idle_p = float(params["idle_p_kw"])
    peak_p = float(params["peak_p_kw"])
    beta_1 = float(params["beta_1"])
    beta_2 = float(params["beta_2_kw"])

    lambda_inter = mTEPES.pDC["lambda_inter"]  # 交互式到达任务量（任务/时段）
    lambda_batch = mTEPES.pDC["lambda_batch"]  # 批处理到达任务量（任务/时段）
    p_other_kw = mTEPES.pDC["p_other_kw"]
    t_out_C = mTEPES.pDC.get("t_out_C", np.full(T, 20.0, dtype=float))
    srv_lambda_max = float(params["srv_lambda_max"])
    delay_max_h = int(params.get("delay_max_h", 0))

    # ========= 批处理延迟执行（式(22) 的可解简化：仅时间灵活性，不做 τ→t 以外的其他耦合）=========
    # x[τ,t]：在时刻 t 执行、且在 τ 到达的批处理任务量，要求 τ <= t <= τ+delay_max_h
    # 对每个 τ：sum_{t=τ..min(τ+D,T-1)} x[τ,t] = batch_arrival[τ]
    # 对每个 t：batch_exec[t] = sum_{τ=max(0,t-D)..t} x[τ,t]
    D = max(0, delay_max_h)
    mTEPES.vDC_BatchExec = [[None] * (D + 1) for _ in range(T)]
    for tau in range(T):
        for k in range(D + 1):
            tt = tau + k
            if tt >= T:
                break
            mTEPES.vDC_BatchExec[tau][k] = OptModel.add_variable(lb=0.0, name=f"vDC_BatchExec_{tau}_{tt}")
        # 完成约束：在最大延迟内完成
        terms = [v for v in mTEPES.vDC_BatchExec[tau] if v is not None]
        if terms:
            OptModel.add_linear_constraint(
                sum(terms) == float(lambda_batch[tau]),
                name=f"eDC_batch_complete_{tau}",
            )

    for t in range(T):
        mTEp = f"{t}"
        mTEPES.vDC_NSrv[t] = OptModel.add_variable(lb=0.0, ub=float(srv_max), name=f"vDC_NSrv_{mTEp}")
        mTEPES.vDC_L_tasks[t] = OptModel.add_variable(lb=0.0, name=f"vDC_L_tasks_{mTEp}")
        mTEPES.vDC_P_IT[t] = OptModel.add_variable(lb=0.0, name=f"vDC_P_IT_{mTEp}")
        mTEPES.vDC_P_cool[t] = OptModel.add_variable(lb=0.0, name=f"vDC_P_cool_{mTEp}")
        mTEPES.vDC_H_cool[t] = OptModel.add_variable(lb=0.0, name=f"vDC_H_cool_{mTEp}")
        mTEPES.vDC_P_DC[t] = OptModel.add_variable(lb=0.0, name=f"vDC_P_DC_{mTEp}")

        # (24) 活跃服务器数上界（聚合）
        # N_srv(t) ≤ Q_exist + Q_add
        OptModel.add_linear_constraint(
            mTEPES.vDC_NSrv[t] - (srv_exist + mTEPES.vDC_SrvAdd) <= 0,
            name=f"eDC_NSrv_ub_{t}",
        )

        # (14)-(19) 服务器功耗与状态（聚合线性复现）
        # 原文（逐台服务器）：
        #   P_IT = sum_j P_srv_j
        #   P_srv_j = varphi_j [P_idle + (P_peak - P_idle) * mu_j]
        #   mu_j = zeta_req * ell_j
        # 在本程序中不引入 j 维度，采用“总任务量 L(t)”与“活跃服务器数 N(t)”的聚合形式：
        #   L(t) >= inter_load(t) + batch_load(t)
        #   L(t) <= srv_lambda_max * N(t)
        # 并取 zeta_req = 1 / srv_lambda_max，则可得线性功率关系：
        #   P_IT(t) = P_idle * N(t) + (P_peak - P_idle) / srv_lambda_max * L(t)
        # 当期需要处理的总任务量 = 交互式到达 + 当期执行的批处理（批处理可延迟移峰）
        # batch_exec(t) = sum_{τ=max(0,t-D)..t} x[τ,t]
        batch_exec_terms = []
        tau0 = max(0, t - D)
        for tau in range(tau0, t + 1):
            k = t - tau
            v = mTEPES.vDC_BatchExec[tau][k] if k <= D else None
            if v is not None:
                batch_exec_terms.append(v)
        batch_exec_t = sum(batch_exec_terms) if batch_exec_terms else 0.0

        demand_jobs = float(lambda_inter[t]) + batch_exec_t
        OptModel.add_linear_constraint(
            mTEPES.vDC_L_tasks[t] - demand_jobs >= 0,
            name=f"eDC_tasks_ge_demand_{t}",
        )
        if srv_lambda_max > 0:
            OptModel.add_linear_constraint(
                mTEPES.vDC_L_tasks[t] - srv_lambda_max * mTEPES.vDC_NSrv[t] <= 0,
                name=f"eDC_tasks_capacity_{t}",
            )
            OptModel.add_linear_constraint(
                mTEPES.vDC_P_IT[t]
                - idle_p * mTEPES.vDC_NSrv[t]
                - (peak_p - idle_p) / srv_lambda_max * mTEPES.vDC_L_tasks[t]
                == 0,
                name=f"eDC_PIT_from_tasks_{t}",
            )

        # (9) 冷却功率-制冷量线性关系：P_cool = beta1*H_cool + beta2
        OptModel.add_linear_constraint(
            mTEPES.vDC_P_cool[t] - beta_1 * mTEPES.vDC_H_cool[t] == beta_2,
            name=f"eDC_cool_linear_{t}",
        )

        # (10) 冷却功率上界：P_cool ≤ Q_cool_exist + Q_cool_add
        OptModel.add_linear_constraint(
            mTEPES.vDC_P_cool[t] - (cool_exist_kw + mTEPES.vDC_CoolAdd_kW) <= 0,
            name=f"eDC_Pcool_ub_{t}",
        )

        # 处理能力约束已在 eDC_tasks_capacity_{t} 中体现（L_tasks <= srv_lambda_max * N_srv）

        # (8) 数据中心总功率分解：P_DC = P_IT + P_cool + P_other
        OptModel.add_linear_constraint(
            mTEPES.vDC_P_DC[t] - mTEPES.vDC_P_IT[t] - mTEPES.vDC_P_cool[t] == float(p_other_kw[t]),
            name=f"eDC_power_balance_{t}",
        )

    # 时段长度（小时）：用于室内温度/CPU 温度等差分方程
    def _dc_step_hours(ti):
        dur = getattr(mTEPES, "pLoadLevelDuration", None)
        if dur is not None and ti < len(mTEPES.pDC["n_list"]):
            try:
                return float(dur[mTEPES.pDC["n_list"][ti]])
            except Exception:
                pass
        return 1.0

    # ========= 式 (25)-(27)：室内热动力学（前向差分，℃ 口径）=========
    indoor_on = int(params.get("indoor_temp_enable", 0)) == 1
    if indoor_on:
        R_dc = float(params["dc_R_C_per_kW"])            # ℃/kW
        C_dc = float(params["dc_C_kWh_per_C"])           # kWh/℃
        T_in_ini_C = float(params["dc_T_in_ini_C"])
        T_in_min_C = float(params["dc_T_in_min_C"])
        T_in_max_C = float(params["dc_T_in_max_C"])
        r_in_min = float(params["dc_r_in_min_C_per_h"])  # ℃/h
        r_in_max = float(params["dc_r_in_max_C_per_h"])  # ℃/h
        kappa_IT = float(params.get("kappa_IT_kwth_per_kw", 1.0))

        mTEPES.vDC_T_in = np.empty(T, dtype=object)
        for t in range(T):
            mTEPES.vDC_T_in[t] = OptModel.add_variable(
                lb=T_in_min_C, ub=T_in_max_C, name=f"vDC_T_in_{t}"
            )

        # 初值
        OptModel.add_linear_constraint(
            mTEPES.vDC_T_in[0] == T_in_ini_C, name="eDC_Tin_ini"
        )

        # (25) 前向差分 + (27) 变化率约束
        #   T_{t+1} = T_t + (dt/C) * ( kappa*P_IT - H_cool + (T_out - T_t)/R )
        # 等价线性：T_{t+1} - (1 - dt/(C*R)) T_t - (dt/C) kappa P_IT + (dt/C) H_cool = (dt/(C*R)) T_out
        for t in range(T - 1):
            dt_h = _dc_step_hours(t)
            a = dt_h / max(C_dc, 1e-9)                  # dt/C
            b = dt_h / max(C_dc * R_dc, 1e-9)           # dt/(C*R)

            OptModel.add_linear_constraint(
                mTEPES.vDC_T_in[t + 1]
                - (1.0 - b) * mTEPES.vDC_T_in[t]
                - a * kappa_IT * mTEPES.vDC_P_IT[t]
                + a * mTEPES.vDC_H_cool[t]
                == b * float(t_out_C[t]),
                name=f"eDC_Tin_dyn_{t}",
            )

            # (27) 变化率上下限：r_min <= (T_{t+1}-T_t)/dt <= r_max
            if dt_h > 0:
                OptModel.add_linear_constraint(
                    mTEPES.vDC_T_in[t + 1] - mTEPES.vDC_T_in[t] >= r_in_min * dt_h,
                    name=f"eDC_Tin_rate_lb_{t}",
                )
                OptModel.add_linear_constraint(
                    mTEPES.vDC_T_in[t + 1] - mTEPES.vDC_T_in[t] <= r_in_max * dt_h,
                    name=f"eDC_Tin_rate_ub_{t}",
                )

    # ========= 式 (20)-(21)：CPU 热阻-热容，一阶离散 + P_IT 按 n_ref 均分到单机等效功率（线性）=========
    cpu_temp_on = int(params.get("cpu_temp_enable", 0)) == 1 and srv_lambda_max > 0
    if cpu_temp_on:
        R_cpu = float(params["cpu_R_K_per_W"])
        C_cpu = float(params["cpu_C_J_per_K"])
        T_ini = float(params["cpu_T_ini_K"])
        T_max = float(params["cpu_T_max_K"])
        T_in_K_param = float(params["cpu_T_in_K"])
        n_ref_cfg = params.get("cpu_temp_equal_split_n_ref", None)
        if n_ref_cfg is not None:
            n_ref = float(n_ref_cfg)
        elif srv_exist > 0:
            n_ref = float(srv_exist)
        else:
            # 无既有台数时，用装机规模的下限比例作名义均分台数，避免 n_ref=1 导致温升过尖
            n_ref = min(500.0, max(50.0, 0.05 * float(srv_max)))
        # 稳态目标的线性化系数：T_ss = T_in + coeff * P_IT[kW]，coeff = R * (1000 W/kW) / n_ref
        coeff_K_per_kW = R_cpu * 1000.0 / n_ref
        tau_rc_s = max(R_cpu * C_cpu, 1e-9)

        mTEPES.vDC_T_cpu = np.empty(T, dtype=object)
        for t in range(T):
            mTEPES.vDC_T_cpu[t] = OptModel.add_variable(
                lb=200.0, ub=400.0, name=f"vDC_T_cpu_{t}"
            )
            OptModel.add_linear_constraint(
                mTEPES.vDC_T_cpu[t] <= T_max, name=f"eDC_Tcpu_max_{t}"
            )

        OptModel.add_linear_constraint(
            mTEPES.vDC_T_cpu[0] == T_ini, name="eDC_Tcpu_ini"
        )

        for t in range(T - 1):
            h_step = _dc_step_hours(t)
            dt_s = h_step * 3600.0
            alpha = min(1.0, dt_s / tau_rc_s)
            one_m_a = 1.0 - alpha
            # T[t+1] = (1-α)T[t] + α (T_in + coeff P_IT[t])
            # 若启用室内温度 vDC_T_in[t]（℃），则用 T_in[K]=vDC_T_in[t]+273.15；否则用常数参数 cpu_T_in_K
            if getattr(mTEPES, "vDC_T_in", None) is not None:
                rhs_const = alpha * 273.15
                OptModel.add_linear_constraint(
                    mTEPES.vDC_T_cpu[t + 1]
                    - one_m_a * mTEPES.vDC_T_cpu[t]
                    - alpha * coeff_K_per_kW * mTEPES.vDC_P_IT[t]
                    - alpha * mTEPES.vDC_T_in[t]
                    == rhs_const,
                    name=f"eDC_Tcpu_dyn_{t}",
                )
                continue

            rhs_const = alpha * T_in_K_param
            OptModel.add_linear_constraint(
                mTEPES.vDC_T_cpu[t + 1]
                - one_m_a * mTEPES.vDC_T_cpu[t]
                - alpha * coeff_K_per_kW * mTEPES.vDC_P_IT[t]
                == rhs_const,
                name=f"eDC_Tcpu_dyn_{t}",
            )

    # ========= 目标函数：把 DC 成本加到总目标 =========
    # 仅加入简单 CAPEX+OPEX（不读电价曲线，不接入电网购电变量）
    # CAPEX（年化忽略，先用一次性成本占位）
    srv_inv = float(params["srv_inv_cny_per_unit"])
    cool_inv = float(params["cool_inv_cny_per_kw"])
    capex_expr = srv_inv * mTEPES.vDC_SrvAdd + cool_inv * mTEPES.vDC_CoolAdd_kW

    # OPEX：按功率(kW)*时长(h) -> kWh
    srv_opex = float(params["srv_opex_cny_per_kwh"])
    cool_opex = float(params["cool_opex_cny_per_kwh"])
    opex_expr = 0.0
    # 若存在时段长度参数，优先用它；否则默认 1h
    dur = getattr(mTEPES, "pLoadLevelDuration", None)
    for t in range(T):
        h = 1.0
        if dur is not None and t < len(dur):
            try:
                h = float(dur[mTEPES.pDC["n_list"][t]])
            except Exception:
                h = 1.0
        opex_expr += h * (srv_opex * mTEPES.vDC_P_IT[t] + cool_opex * mTEPES.vDC_P_cool[t])

    dc_cost = capex_expr + opex_expr

    # 将 DC 成本叠加到总目标并重设（保持最小化）
    if hasattr(OptModel, "eTotalTCost"):
        OptModel.eTotalTCost = OptModel.eTotalTCost + dc_cost
        OptModel.set_objective(OptModel.eTotalTCost, poi.ObjectiveSense.Minimize)

    if pIndLogConsole == 1:
        print("\n添加数据中心(EHCCS)变量与约束完成        ****")
        print(f"  DC 时间点数 T = {T}")
        print(f"  服务器新增上界 = {srv_add_max} 台")
        print(f"  冷却新增上界 = {cool_add_max_kw} kW")
        if getattr(mTEPES, "vDC_T_cpu", None) is not None:
            ncfg = params.get("cpu_temp_equal_split_n_ref", None)
            if ncfg is not None:
                nref = float(ncfg)
            elif srv_exist > 0:
                nref = float(srv_exist)
            else:
                nref = min(500.0, max(50.0, 0.05 * float(srv_max)))
            print(f"  CPU 温度约束(离散线性): 启用, n_ref={nref:.4g}（P_srv≈P_IT[kW]×1000/n_ref）")

    return None

