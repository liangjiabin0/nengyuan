import time
import os
import setuptools
from openTEPES_InputData        import InputData_poi, SettingUpVariables_poi, EVplan_inputdata, inputdata_ammonia, ThermalInputData_poi, DC_inputdata
from openTEPES_ModelFormulation import TotalObjectiveFunction_poi, InvestmentModelFormulation_poi, GenerationOperationModelFormulationObjFunct_poi, GenerationOperationModelFormulationInvestment_poi, GenerationOperationModelFormulationDemand_poi, GenerationOperationModelFormulationStorage_poi, NetworkOperationModelFormulation_poi, EVplan_modelformulation, modelformulation_ammonia #, GenerationOperationModelFormulationCommitment_poi, GenerationOperationModelFormulationRampMinTime_poi, NetworkSwitchingModelFormulation_poi
from openTEPES_ModelFormulation import ThermalSettingUpVariables_poi, ThermalInvestmentModelFormulation_poi, ThermalGenerationOperationModelFormulation_poi, ThermalStorageOperationModelFormulation_poi, ThermalBalanceModelFormulation_poi, ThermalObjectiveFunction_poi, DC_modelformulation
from openTEPES_ProblemSolving   import ProblemSolving_poi
from openTEPES_OutputResults    import InvestmentResults_poi, EconomicResults_poi, GenerationOperationResults_poi, ESSOperationResults_poi, NetworkOperationResults_poi, NetworkMapResults_poi, PlanEvaluation_poi, EVplan_outputresult, outputresult_ammonia, ThermalInvestmentResults_poi, ThermalEconomicResults_poi, ThermalOperationResults_poi, ThermalPlotResults_poi, DC_outputresult # PlanEvaluation_poi, FlexibilityResults_poi, 
from pyoptinterface import gurobi
import pyoptinterface as poi
from opt.gurobi import *

def openTEPES_run(DirName, CaseName, SolverName, pIndLogConsole):
    InitialTime = time.time()
    _path = os.path.join(DirName, CaseName)
    #%% replacing string values by numerical values
    idxDict = dict()
    idxDict[0    ] = 0
    idxDict[0.0  ] = 0
    idxDict['No' ] = 0
    idxDict['NO' ] = 0
    idxDict['no' ] = 0
    idxDict['N'  ] = 0
    idxDict['n'  ] = 0
    idxDict['Yes'] = 1
    idxDict['YES'] = 1
    idxDict['yes'] = 1
    idxDict['Y'  ] = 1
    idxDict['y'  ] = 1
    #%% model declaration
    # mTEPES = gurobi.Model()
    mTEPES = poi_gurobi_model()
    # mTEPES.set_init_check()

    pIndLogConsole = [j for i, j in idxDict.items() if i == pIndLogConsole][0]

    # Define sets and parameters
    InputData_poi(DirName, CaseName, mTEPES, pIndLogConsole)
    # Define variables
    SettingUpVariables_poi(mTEPES, mTEPES)
    # objective function and investment constraints
    TotalObjectiveFunction_poi    (mTEPES, mTEPES, pIndLogConsole)
    InvestmentModelFormulation_poi(mTEPES, mTEPES, pIndLogConsole)
    
    # -----------------------------------------------------------------------------
    # 执行EV规划数据输入
    EVSystemIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='input')
    # 执行EV规划模型构建与约束
    EVSystemIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='modelformulation')
    # -----------------------------------------------------------------------------

    # -----------------------------------------------------------------------------
    # 热系统数据输入
    ThermalSystemIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='input')
    # 热系统变量定义
    ThermalSystemIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='variables')
    # 热系统投资约束
    ThermalSystemIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='investment')
    # 热系统运行约束
    ThermalSystemIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='operation')
    # 热系统目标函数
    ThermalSystemIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='objective')
    # -----------------------------------------------------------------------------

    # -----------------------------------------------------------------------------
    # 合成氨数据输入
    AmmoniaSystemIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='input')
    # 合成氨模型建模
    AmmoniaSystemIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='modelformulation')
    # -----------------------------------------------------------------------------

    # -----------------------------------------------------------------------------
    # 数据中心(EHCCS)数据输入
    DataCenterIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='input')
    # 数据中心(EHCCS)模型建模
    DataCenterIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='modelformulation')
    # -----------------------------------------------------------------------------
    
    # iterative model formulation for each stage of a year
    # for p,sc,st in mTEPES.ps*mTEPES.stt:
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for st in mTEPES.stt:
                # activate only scenario, period and load levels to formulate
                mTEPES.st = [stt for stt in mTEPES.stt if stt in mTEPES.stt and stt == stt and mTEPES.pStageWeight[stt] and sum(1 for (stt,nn) in mTEPES.s2n)]
                mTEPES.n  = [nn  for nn  in mTEPES.nn  if nn  in                             mTEPES.pDuration         and           (st,nn) in mTEPES.s2n]
                mTEPES.n2 = [nn  for nn  in mTEPES.nn  if nn  in                             mTEPES.pDuration         and           (st,nn) in mTEPES.s2n]
                print('Period '+str(p)+', Scenario '+str(sc)+', Stage '+str(st))

                # operation model objective function and constraints by stage
                GenerationOperationModelFormulationObjFunct_poi   (mTEPES, mTEPES, pIndLogConsole, p, sc, st)
                GenerationOperationModelFormulationInvestment_poi (mTEPES, mTEPES, pIndLogConsole, p, sc, st)
                GenerationOperationModelFormulationDemand_poi     (mTEPES, mTEPES, pIndLogConsole, p, sc, st)
                GenerationOperationModelFormulationStorage_poi    (mTEPES, mTEPES, pIndLogConsole, p, sc, st)
                # GenerationOperationModelFormulationCommitment_poi (mTEPES, mTEPES, pIndLogConsole, p, sc, st)
                # GenerationOperationModelFormulationRampMinTime_poi(mTEPES, mTEPES, pIndLogConsole, p, sc, st)
                # NetworkSwitchingModelFormulation_poi              (mTEPES, mTEPES, pIndLogConsole, p, sc, st)
                NetworkOperationModelFormulation_poi              (mTEPES, mTEPES, pIndLogConsole, p, sc, st)
        
    if pIndLogConsole == 1:
        StartTime         = time.time()
        # mTEPES.write(_path+'/openTEPES_'+CaseName+'.lp', io_options={'symbolic_solver_labels': True})  # create lp-format file
        WritingLPFileTime = time.time() - StartTime
        StartTime         = time.time()
        print('Writing LP file                        ... ', round(WritingLPFileTime), 's')

    # ProblemSolving    (DirName, CaseName, SolverName, mTEPES, mTEPES, pIndLogConsole)
    ProblemSolving_poi(DirName, CaseName, SolverName, mTEPES, mTEPES, pIndLogConsole)
    mTEPES.st = [stt for stt in mTEPES.stt if stt in mTEPES.stt and stt == stt and mTEPES.pStageWeight[stt] and sum(1 for (stt,nn) in mTEPES.s2n)]
    mTEPES.n  = [nn  for nn  in mTEPES.nn  if nn  in                               mTEPES.pDuration                                              ]

    EconomicResults_poi            (DirName, CaseName, mTEPES, mTEPES)
    InvestmentResults_poi          (DirName, CaseName, mTEPES, mTEPES)
    GenerationOperationResults_poi (DirName, CaseName, mTEPES, mTEPES)
    PlanEvaluation_poi             (DirName, CaseName, mTEPES, mTEPES)
    ESSOperationResults_poi        (DirName, CaseName, mTEPES, mTEPES)
    # FlexibilityResults_poi         (DirName, CaseName, mTEPES, mTEPES)
    NetworkOperationResults_poi    (DirName, CaseName, mTEPES, mTEPES)
    NetworkMapResults_poi          (DirName, CaseName, mTEPES, mTEPES)
    
    # 输出EV规划结果
    EVSystemIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='output')
    # 合成氨结果输出
    AmmoniaSystemIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='output')
    # 热系统结果输出
    ThermalSystemIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='output')
    # 数据中心(EHCCS)结果输出
    DataCenterIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='output')

    TotalTime = time.time() - InitialTime
    print('Total time                             ... ', round(TotalTime), 's')

    return mTEPES

def EVSystemIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='input'):
    """
    EV系统集成函数 - 统一管理所有充电桩(EV)系统相关的调用
    
    Args:
        mTEPES: 模型对象
        DirName: 数据目录
        CaseName: 算例名称
        pIndLogConsole: 日志输出标志
        stage: 集成阶段
            - 'input': 数据输入阶段
            - 'modelformulation': 模型构建（包括变量、约束、目标函数）
            - 'output': 结果输出阶段
    """
    # 检查是否启用EV规划
    enable_ev = 0
    if hasattr(mTEPES, 'pOption'):
        enable_ev = mTEPES.pOption.get('EVPlanning', 0)
    
    if not enable_ev:
        return None
        
    _path = os.path.join(DirName, CaseName)
        
    # ========== 数据输入阶段 ==========
    if stage == 'input':
        print('\n' + '='*60)
        print('电动汽车(EV)规划已启用')
        print('='*60)
        EVplan_inputdata(DirName, CaseName, mTEPES, pIndLogConsole)
        
    # ========== 模型构建阶段 ==========
    elif stage == 'modelformulation':
        print('\n整合电动汽车(EV)规划变量与约束           ****')
        EVplan_modelformulation(mTEPES)
        
    # ========== 结果输出阶段 ==========
    elif stage == 'output':
        print('\n' + '='*60)
        print('输出电动汽车(EV)规划结果')
        print('='*60)
        EVplan_outputresult(mTEPES, _path)

def ThermalSystemIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='input'):
    """
    热系统集成函数 - 统一管理所有热系统相关的调用
    
    Args:
        mTEPES: 模型对象
        DirName: 数据目录
        CaseName: 算例名称
        pIndLogConsole: 日志输出标志
        stage: 集成阶段
            - 'input': 数据输入阶段
            - 'variables': 变量定义阶段
            - 'investment': 投资约束阶段
            - 'operation': 运行约束阶段
            - 'objective': 目标函数阶段
            - 'output': 结果输出阶段
    """
    # 检查是否启用热系统规划
    enable_thermal = 0
    if hasattr(mTEPES, 'pOption'):
        enable_thermal = mTEPES.pOption.get('ThermalPlanning', 0)
    
    if not enable_thermal:
        return None
    
    # ========== 数据输入阶段 ==========
    if stage == 'input':
        print('\n' + '='*60)
        print('热系统规划已启用')
        print('='*60)
        ThermalInputData_poi(DirName, CaseName, mTEPES, pIndLogConsole)
    
    # ========== 变量定义阶段 ==========
    elif stage == 'variables':
        ThermalSettingUpVariables_poi(mTEPES, mTEPES)
    
    # ========== 投资约束阶段 ==========
    elif stage == 'investment':
        ThermalInvestmentModelFormulation_poi(mTEPES, mTEPES, pIndLogConsole)
    
    # ========== 运行约束阶段 ==========
    elif stage == 'operation':
        ThermalGenerationOperationModelFormulation_poi(mTEPES, mTEPES, pIndLogConsole)
        ThermalStorageOperationModelFormulation_poi(mTEPES, mTEPES, pIndLogConsole)
        ThermalBalanceModelFormulation_poi(mTEPES, mTEPES, pIndLogConsole)
    
    # ========== 目标函数阶段 ==========
    elif stage == 'objective':
        print('\n添加热系统成本到目标函数                ****')
        thermal_cost = ThermalObjectiveFunction_poi(mTEPES, mTEPES, pIndLogConsole)
        
        # 电-热联合规划：在原有电力系统目标函数基础上加上热系统成本
        print('  电-热联合规划模式，将热系统成本添加到目标函数')
        
        # 获取原有的电力系统目标函数值
        original_objective = mTEPES.eTotalTCost
        
        # 新目标函数 = 原电力系统目标函数 + 热系统成本
        mTEPES.eTotalTCost = original_objective + thermal_cost
        
        # 重新设置目标函数
        mTEPES.set_objective(mTEPES.eTotalTCost, poi.ObjectiveSense.Minimize)
        print('热系统成本已添加到总目标函数')
    
    # ========== 结果输出阶段 ==========
    elif stage == 'output':
        print('\n' + '='*60)
        print('输出热系统规划结果')
        print('='*60)
        ThermalInvestmentResults_poi(mTEPES, mTEPES, DirName, CaseName, pIndLogConsole)
        ThermalEconomicResults_poi(mTEPES, mTEPES, DirName, CaseName, pIndLogConsole)
        ThermalOperationResults_poi(mTEPES, mTEPES, DirName, CaseName, pIndLogConsole)
        ThermalPlotResults_poi(mTEPES, mTEPES, DirName, CaseName, pIndLogConsole)

def AmmoniaSystemIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='input'):
    """
    合成氨(Ammonia)系统集成函数 - 统一管理所有合成氨系统相关的调用
    
    Args:
        mTEPES: 模型对象
        DirName: 数据目录
        CaseName: 算例名称
        pIndLogConsole: 日志输出标志
        stage: 集成阶段
            - 'input': 数据输入阶段
            - 'modelformulation': 模型构建（包括变量、约束、目标函数）
            - 'output': 结果输出阶段
    """
    # 检查是否启用合成氨规划
    enable_ammonia = 0
    if hasattr(mTEPES, 'pOption'):
        enable_ammonia = mTEPES.pOption.get('ANPlanning', 0)
    
    if not enable_ammonia:
        return None
        
    # ========== 数据输入阶段 ==========
    if stage == 'input':
        print('\n' + '='*60)
        print('合成氨(Ammonia)规划已启用')
        print('='*60)
        inputdata_ammonia(mTEPES, DirName, CaseName)
        
    # ========== 模型构建阶段 ==========
    elif stage == 'modelformulation':
        print('\n整合合成氨(Ammonia)规划变量与约束        ****')
        modelformulation_ammonia(mTEPES)
        
    # ========== 结果输出阶段 ==========
    elif stage == 'output':
        print('\n' + '='*60)
        print('输出合成氨(Ammonia)规划结果')
        print('='*60)
        outputresult_ammonia(mTEPES, DirName, CaseName)

def DataCenterIntegration(mTEPES, DirName, CaseName, pIndLogConsole, stage='input'):
    """
    数据中心(EHCCS)系统集成函数 - 统一管理所有数据中心规划相关的调用

    通过 option 文件中的 DCPlanning 开关控制是否启用。

    Args:
        mTEPES: 模型对象
        DirName: 数据目录
        CaseName: 算例名称
        pIndLogConsole: 日志输出标志
        stage: 集成阶段
            - 'input': 数据输入阶段
            - 'modelformulation': 模型构建（包括变量、约束、目标函数）
            - 'output': 结果输出阶段
    """
    enable_dc = 0
    if hasattr(mTEPES, 'pOption'):
        enable_dc = mTEPES.pOption.get('DCPlanning', 0)

    if not enable_dc:
        return None

    _path = os.path.join(DirName, CaseName)

    # ========== 数据输入阶段 ==========
    if stage == 'input':
        print('\n' + '='*60)
        print('数据中心(EHCCS)规划已启用')
        print('='*60)
        DC_inputdata(DirName, CaseName, mTEPES, pIndLogConsole)

    # ========== 模型构建阶段 ==========
    elif stage == 'modelformulation':
        print('\n整合数据中心(EHCCS)规划变量与约束        ****')
        DC_modelformulation(DirName, CaseName, mTEPES, pIndLogConsole)

    # ========== 结果输出阶段 ==========
    elif stage == 'output':
        print('\n' + '='*60)
        print('输出数据中心(EHCCS)规划结果')
        print('='*60)
        DC_outputresult(DirName, CaseName, mTEPES, pIndLogConsole)