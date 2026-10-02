import datetime
import time
import math
import os
from typing import Any
import pandas        as pd
import numpy         as np
from   pyoptinterface import ScalarAffineFunction
import pyoptinterface as poi

def _resolve_config_dir():
    """输入 CSV 统一从项目根目录下的 config/ 读取。"""
    override = os.environ.get('MGPLAN_CONFIG_DIR', '').strip()
    if override:
        return override
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(repo_root, 'config')

def add_to_tuple(tup, *elements):
    if not isinstance(tup, tuple): # 如果tup不是元组，先将其转换为元 
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

def calc_wind_pu_profile(v_ref):
    """
    Calculate per unit (p.u.) generation profile for Wind Turbines based on physical parameters.
    """
    pAlpha, pV_in, pV_rated, pV_out, pK = 0.1893, 2.4243, 10.6489, 25.0, 1.7398
    
    # Hub height conversion
    v_h = v_ref * (30.0 / 10.0) ** pAlpha
    
    # Vectorized conditional calculation
    conditions = [
        (v_h < pV_in) | (v_h > pV_out),
        (v_h >= pV_in) & (v_h < pV_rated),
        (v_h >= pV_rated) & (v_h <= pV_out)
    ]
    choices = [
        0.0,
        ((v_h - pV_in) / (pV_rated - pV_in)) ** pK,
        1.0
    ]
    return np.select(conditions, choices, default=0.0)

def calc_pv_pu_profile(dni, dhi, temp_2m):
    """
    Calculate per unit (p.u.) generation profile for PV Systems considering irradiance and temperature.
    """
    pU0, pDc_ratio, pTemp_coeff = 29.0, 1.15, 0.0043
    
    poa = dni * 0.95 + dhi * 0.8
    poa = np.clip(poa, 0, None)
    
    t_cell = temp_2m + (poa / pU0)
    p_pu = pDc_ratio * (poa / 1000.0) * (1 - pTemp_coeff * (t_cell - 25)) * 0.989
    
    return np.clip(p_pu, 0.0, 1.0)


def _convert_variable_max_power(df_raw: pd.DataFrame, dfGeneration: pd.DataFrame) -> pd.DataFrame:
    """
    根据 CSV 输入构建“按机组展开”的可变最大出力曲线（MW）。
    支持两种格式：
    1) 列名是机组名（近期旧格式）：直接按各机组 MaximumPower 缩放；
    2) 列名是技术名（新格式）：列为 PV/Wind/Hydro，需要映射到机组。
    """
    max_power_mw = pd.to_numeric(dfGeneration['MaximumPower'], errors='coerce')

    # 情况1：列名是机组名 -> 按各机组装机容量缩放
    if set(df_raw.columns).issubset(set(max_power_mw.index)):
        missing_gens = [g for g in df_raw.columns if g not in max_power_mw.index]
        if missing_gens:
            raise KeyError(f"VariableMaxGeneration columns not found in Generation.Generator: {missing_gens}")
        return df_raw.mul(max_power_mw.reindex(df_raw.columns), axis=1)

    # 情况2：列名是技术名 -> 按机组技术类型映射对应曲线
    df_out = pd.DataFrame(index=df_raw.index, columns=dfGeneration.index, dtype='float64')
    tech_curve_set = {'PV', 'Wind', 'Hydro'}
    for gen in dfGeneration.index:
        tech = str(dfGeneration.at[gen, 'Technology'])
        if tech in tech_curve_set and tech in df_raw.columns:
            df_out[gen] = pd.to_numeric(df_raw[tech], errors='coerce') * max_power_mw[gen]
        else:
            # 只有 PV/Wind/Hydro 使用单位曲线，其他技术保持 NaN。
            df_out[gen] = np.nan
    return df_out

def InputData_poi(DirName, CaseName, mTEPES, pIndLogConsole):
    print('Input data                             ****')

    _path = _resolve_config_dir()
    StartTime = time.time()
    #reading data from CSV
    dfOption             = pd.read_csv(_path+'/oT_Data_Option_'                +CaseName+'.csv')
    dfParameter          = pd.read_csv(_path+'/oT_Data_Parameter_'             +CaseName+'.csv')
    dfDemand             = pd.read_csv(_path+'/oT_Data_Demand_'                +CaseName+'.csv', index_col=[0,1,2])
    dfPrice              = pd.read_csv(_path+'/oT_Data_ElectricityPrice_'      +CaseName+'.csv', index_col=[0    ]) # 电价
    dfGeneration         = pd.read_csv(_path+'/oT_Data_Generation_'            +CaseName+'.csv', index_col=[0    ])
    # dfVariableMinPower 改为由 Generation 表中的 MinimumPower 按机组展开生成。
    # 行索引沿用 dfDemand 的 (Period, Scenario, LoadLevel)，列为机组名；
    # 若机组没有 MinimumPower，则该列保持 NaN。
    _min_power_mw = pd.to_numeric(dfGeneration['MinimumPower'], errors='coerce') if 'MinimumPower' in dfGeneration.columns else pd.Series(np.nan, index=dfGeneration.index)
    dfVariableMinPower = pd.DataFrame(data=np.tile(_min_power_mw.reindex(dfGeneration.index).values, (len(dfDemand.index), 1)),index=dfDemand.index,columns=dfGeneration.index)
    dfVariableMaxPower   = pd.read_csv(_path+'/oT_Data_VariableMaxGeneration_' +CaseName+'.csv', index_col=[0,1,2])
    dfVariableMaxPower   = _convert_variable_max_power(dfVariableMaxPower, dfGeneration)
    dfNodeLocation       = pd.read_csv(_path+'/oT_Data_NodeLocation_'          +CaseName+'.csv', index_col=[0    ])
    dfNetwork            = pd.read_csv(_path+'/oT_Data_Network_'               +CaseName+'.csv', index_col=[0,1,2])
    WeatherFile          = _path + '/oT_Data_WeatherData_' + CaseName + '.csv'
        
    dfPeriod             = pd.DataFrame([1], columns=['Weight'],        index=[dfDemand.index[0][0]]) # 用dfDemand初始化，dfDemand是必要输 
    dfPeriod.index.name  = 'Period'
    dfScenario           = pd.DataFrame([1], columns=['Probability'],   index=pd.MultiIndex.from_tuples([(dfDemand.index[0][0], dfDemand.index[0][1])],names=['Period', 'Scenario']))
    dfStage              = pd.DataFrame([1], columns=['Weight'],        index=['st1'])
    dfStage.index.name   = 'Stage'
    LoadLevel_index      = pd.read_csv(_path+'/oT_Data_Demand_'+CaseName+'.csv', )['LoadLevel']
    dfDuration           = pd.DataFrame({'Duration': 1, 'Stage': 'st1'},index = LoadLevel_index)
    dfReserveMargin      = pd.DataFrame([0.0], columns=['ReserveMargin'], index=['Area1'])
    dfReserveMargin.index.name='Area'

    # 补充被省略的 dfGeneration 字段 (只对原来有、现在没有的列进行补充赋 
    missing_gen_cols = {
        'BinaryCommitment': 'Yes',
        'StorageType': np.nan,
        'MutuallyExclusive': np.nan,
        'OutflowsType': np.nan,
        'MustRun': np.nan,
        'NoOperatingReserve': np.nan,
        'InitialPeriod': 2020.0,
        'FinalPeriod': 2100.0,
        'ShiftTime': np.nan,
        'Inertia': np.nan,
        'EFOR': np.nan,
        'Availability': 1.0,
        'RampUp': np.nan,
        'RampDown': np.nan,
        'UpTime': np.nan,
        'DownTime': np.nan,
        'OperReserveCost': np.nan,
        'FixedRetirementCost': np.nan,
        'BinaryInvestment': np.nan,
        'BinaryRetirement': np.nan,
        'MaximumReactivePower': np.nan,
        'MinimumReactivePower': np.nan
    }
    for col, default_val in missing_gen_cols.items():
        if col not in dfGeneration.columns:
            dfGeneration[col] = default_val
            
    # 补充被省略的 dfParameter 字段
    missing_param_cols = {
        'UpReserveActivation': 0.0,
        'DwReserveActivation': 0.0,
        'MinRatioDwUp': 0.0,
        'MaxRatioDwUp': 0.0,
        'AnnualDiscountRate': 0.0
    }
    for col, default_val in missing_param_cols.items():
        if col not in dfParameter.columns:
            dfParameter[col] = default_val

    # 补充被省略的 dfNetwork 字段（只对原来有、现在没有的列进行补充赋值）
    missing_net_cols = {
        'Switching': np.nan,
        'TTCBck': 7, # TTCBck 是 TTC 的相反数（若 TTC 存在）
        'InitialPeriod': 2020,
        'FinalPeriod': 2050,
        'Voltage': 10,              # pLineVoltage 默认 10
        'BinaryInvestment': 1,
        'SwOnTime': np.nan,
        'SwOffTime': np.nan,
        'Length': np.nan,
        'Susceptance': np.nan,
        'Tap': np.nan,
        'AngMin': np.nan,
        'AngMax': np.nan,
        'Converter': np.nan,
    }
    for col, default_val in missing_net_cols.items():
        if col not in dfNetwork.columns:
            if col == 'TTCBck':
                dfNetwork[col] = -dfNetwork['TTC'] if 'TTC' in dfNetwork.columns else np.nan
            else:
                dfNetwork[col] = default_val
            
    # 获取气象数据
    if os.path.exists(WeatherFile):
        if pIndLogConsole == 1:
            print('Detecting Weather Data... Calculating VariableMaxPower from physical models.')
        dfWeather = pd.read_csv(WeatherFile, index_col=[0])
        dfVariableMaxPower = pd.DataFrame(index=dfDemand.index, columns=dfGeneration.index)
        
        v_ref = dfWeather['wind_speed_10m (m/s)'].values
        dni   = dfWeather['direct_radiation (W/m2)'].values
        dhi   = dfWeather['diffuse_radiation (W/m2)'].values
        temp_2m = dfWeather['temperature_2m'].values
        for gen in dfGeneration.index:
            capacity     = dfGeneration.loc[gen, 'MaximumPower']
            tech_type    = dfGeneration.loc[gen, 'Technology']
            if tech_type == 'Wind':
                dfVariableMaxPower[gen] = calc_wind_pu_profile(v_ref) * capacity
                dfVariableMaxPower[gen] = np.maximum(dfVariableMaxPower[gen], 1e-5)
                if pIndLogConsole == 1:
                    print(f"  -> Check [Wind] {gen}: Min Power = {dfVariableMaxPower[gen].min():.1e}, Max Power = {dfVariableMaxPower[gen].max():.2f}")
            elif tech_type == 'PV':
                dfVariableMaxPower[gen] = calc_pv_pu_profile(dni, dhi, temp_2m) * capacity
                dfVariableMaxPower[gen] = np.maximum(dfVariableMaxPower[gen], 1e-5)
                if pIndLogConsole == 1:
                    print(f"  -> Check [PV] {gen}: Min Power = {dfVariableMaxPower[gen].min():.1e}, Max Power = {dfVariableMaxPower[gen].max():.2f}")
            elif tech_type == 'Battery':
                dfVariableMaxPower[gen] = None
                # dfVariableMaxPower[gen] = np.maximum(dfVariableMaxPower[gen], 1e-5)                
            else:
                dfVariableMaxPower[gen] = None
    else:
        if pIndLogConsole == 1:
            print('Weather Data not found. Reading existing VariableMaxGeneration CSV...')
            dfVariableMaxPower   = pd.read_csv(_path+'/oT_Data_VariableMaxGeneration_' +CaseName+'.csv', index_col=[0,1,2])
            dfVariableMaxPower   = _convert_variable_max_power(dfVariableMaxPower, dfGeneration)

    dfVariableMinCharge  = pd.DataFrame(index=dfVariableMinPower.index, columns=dfVariableMinPower.columns).fillna(0.0)
    dfVariableMaxCharge  = pd.DataFrame(index=dfVariableMinPower.index, columns=dfVariableMinPower.columns).fillna(0.0)
    dfVariableMinStorage = pd.DataFrame(index=dfVariableMinPower.index, columns=dfVariableMinPower.columns).fillna(0.0)
    dfVariableMaxStorage = pd.DataFrame(index=dfVariableMinPower.index, columns=dfVariableMinPower.columns).fillna(0.0)
    dfEnergyInflows      = pd.DataFrame(index=dfVariableMinPower.index, columns=dfVariableMinPower.columns).fillna(0.0)
    dfEnergyOutflows     = pd.DataFrame(index=dfVariableMinPower.index, columns=dfVariableMinPower.columns).fillna(0.0)
    dfInertia            = pd.DataFrame(index=dfDemand.index, columns=['Area1']).fillna(0.0)
    dfUpOperatingReserve = pd.DataFrame(index=dfDemand.index, columns=['Area1']).fillna(0.0)
    dfDwOperatingReserve = pd.DataFrame(index=dfDemand.index, columns=['Area1']).fillna(0.0)

    # substitute NaN by 0
    dfOption.fillna            (0  , inplace=True)
    dfParameter.fillna         (0.0, inplace=True)
    dfPeriod.fillna            (0.0, inplace=True)
    dfScenario.fillna          (0.0, inplace=True)
    dfStage.fillna             (0.0, inplace=True)
    dfDuration.fillna          (0  , inplace=True)
    dfReserveMargin.fillna     (0.0, inplace=True)
    dfDemand.fillna            (0.0, inplace=True)
    dfInertia.fillna           (0.0, inplace=True)
    dfUpOperatingReserve.fillna(0.0, inplace=True)
    dfDwOperatingReserve.fillna(0.0, inplace=True)
    dfPrice.fillna             (0.0, inplace=True) # 电价
    dfGeneration.fillna        (0.0, inplace=True)
    dfVariableMinPower.fillna  (0.0, inplace=True)
    dfVariableMaxPower.fillna  (0.0, inplace=True)
    dfVariableMinCharge.fillna (0.0, inplace=True)
    dfVariableMaxCharge.fillna (0.0, inplace=True)
    dfVariableMinStorage.fillna(0.0, inplace=True)
    dfVariableMaxStorage.fillna(0.0, inplace=True)
    dfEnergyInflows.fillna     (0.0, inplace=True)
    dfEnergyOutflows.fillna    (0.0, inplace=True)
    dfNodeLocation.fillna      (0.0, inplace=True)
    dfNetwork.fillna           (0.0, inplace=True)

    dfReserveMargin      = dfReserveMargin.where     (dfReserveMargin      > 0.0, other=0.0)
    dfInertia            = dfInertia.where           (dfInertia            > 0.0, other=0.0)
    dfUpOperatingReserve = dfUpOperatingReserve.where(dfUpOperatingReserve > 0.0, other=0.0)
    dfDwOperatingReserve = dfDwOperatingReserve.where(dfDwOperatingReserve > 0.0, other=0.0)
    dfPrice              = dfPrice.where             (dfPrice              > 0.0, other=0.0) # 电价
    dfVariableMinPower   = dfVariableMinPower.where  (dfVariableMinPower  != 0.0, other=0.0) # 为了使并网点功率小于零修改这
    dfVariableMaxPower   = dfVariableMaxPower.where  (dfVariableMaxPower   > 0.0, other=0.0) 
    dfVariableMinCharge  = dfVariableMinCharge.where (dfVariableMinCharge  > 0.0, other=0.0)
    dfVariableMaxCharge  = dfVariableMaxCharge.where (dfVariableMaxCharge  > 0.0, other=0.0)
    dfVariableMinStorage = dfVariableMinStorage.where(dfVariableMinStorage > 0.0, other=0.0)
    dfVariableMaxStorage = dfVariableMaxStorage.where(dfVariableMaxStorage > 0.0, other=0.0)
    dfEnergyInflows      = dfEnergyInflows.where     (dfEnergyInflows      > 0.0, other=0.0)
    dfEnergyOutflows     = dfEnergyOutflows.where    (dfEnergyOutflows     > 0.0, other=0.0)

    # show some statistics of the data
    if pIndLogConsole == 1:
        print('Reserve margin               \n', dfReserveMargin.describe     ())
        print('Demand                       \n', dfDemand.describe            ())
        print('Inertia                      \n', dfInertia.describe           ())
        print('Upward   operating reserves  \n', dfUpOperatingReserve.describe())
        print('Downward operating reserves  \n', dfDwOperatingReserve.describe())
        print('Electricity Price            \n', dfPrice.describe             ()) # 电价
        print('Generation                   \n', dfGeneration.describe        ())
        print('Variable minimum generation  \n', dfVariableMinPower.describe  ())
        print('Variable maximum generation  \n', dfVariableMaxPower.describe  ())
        print('Variable minimum consumption \n', dfVariableMinCharge.describe ())
        print('Variable maximum consumption \n', dfVariableMaxCharge.describe ())
        print('Variable minimum storage     \n', dfVariableMinStorage.describe())
        print('Variable maximum storage     \n', dfVariableMaxStorage.describe())
        print('Energy inflows               \n', dfEnergyInflows.describe     ())
        print('Energy outflows              \n', dfEnergyOutflows.describe    ())
        print('Network                      \n', dfNetwork.describe           ())

    mTEPES.pp   = [2025]
    mTEPES.scc  = ['sc1']
    mTEPES.stt  = ['st1']
    mTEPES.nn   = pd.read_csv(_path+'/oT_Dict_LoadLevel_'   +CaseName+'.csv').iloc[:, 0].tolist() # dictSets['n']
    mTEPES.gg   = list(dfGeneration.index.values)
    mTEPES.gt   = ['Grid','Wind','Hydro','PV','Battery','Diesel']
    mTEPES.et   = ['Hourly', 'Daily', 'Weekly']
    mTEPES.nd   = list(dfNodeLocation.index.values)
    mTEPES.ni   = list(dfNodeLocation.index.values)
    mTEPES.nf   = list(dfNodeLocation.index.values)
    mTEPES.zn   = ['Zone1']
    mTEPES.ar   = ['Area1']
    mTEPES.rg   = ['CN']
    mTEPES.cc   = ['ac1', 'ac2', 'ac3', 'cac1']
    mTEPES.lt   = ['AC', 'DC']
    mTEPES.ndzn = [(i, 'Zone1') for i in mTEPES.nd]
    mTEPES.znar = [('Zone1', 'Area1')]
    mTEPES.arrg = [('Area1', 'CN')]
    
    #%% Getting the current year
    date                 = datetime.date.today()
    pCurrentYear         = date.year
    #%% parameters
    pIndBinGenInvest     = int(dfOption   ['IndBinGenInvest'    ].iat[0])                                                            # Indicator of binary generation expansion decisions, 0 continuous  - 1 binary - 2 no investment variables
    pIndBinNetInvest     = int(dfOption   ['IndBinNetInvest'    ].iat[0])                                                            # Indicator of binary network    expansion decisions, 0 continuous  - 1 binary - 2 no investment variables
    # pIndBinGenRetire     = int(dfOption   ['IndBinGenRetirement'].iat[0])                                                            # Indicator of binary generation retirement decisions,0 continuous  - 1 binary - 2 no retirement variables
    # pIndBinGenOperat     = int(dfOption   ['IndBinGenOperat'    ].iat[0])                                                            # Indicator of binary generation operation decisions, 0 continuous  - 1 binary
    # pIndBinSingleNode    = int(dfOption   ['IndBinSingleNode'   ].iat[0])                                                            # Indicator of single node although with network,     0 network     - 1 single node
    pIndBinGenRetire     = 2 # 不考虑退役
    pIndBinGenOperat     = 0 # 对于nr，利用连续变量表示运行状态，而不是二进制变量
    pIndBinSingleNode    = 0 # 不考虑单节点
    pIndBinGenRamps      = int(dfOption   ['IndBinGenRamps'     ].iat[0])                                                            # Indicator of ramp constraints,                      0 no ramps    - 1 ramp constraints
    pIndBinGenMinTime    = int(dfOption   ['IndBinGenMinTime'   ].iat[0])                                                            # Indicator of minimum up/down time constraints,      0 no min time - 1 min time constraints
    # pIndBinLineCommit    = int(dfOption   ['IndBinLineCommit'   ].iat[0])                                                            # Indicator of binary network    switching decisions, 0 continuous  - 1 binary
    pIndBinLineCommit    = 0 # 连续变量表示切换状态
    pIndBinNetLosses     = int(dfOption   ['IndBinNetLosses'    ].iat[0])                                                            # Indicator of network losses,                        0 lossless    - 1 ohmic losses
    mTEPES.pOption       = dfOption.iloc[0].to_dict() # 将所有选项存储为字典，供热系统模块使用

    pENSCost             = dfParameter['ENSCost'            ].iat[0]  * 1e3                                                                     # cost of energy not served              [CNY/GWh]
    pCO2Cost             = dfParameter['CO2Cost'            ].iat[0]                                                                          # cost of CO2 emission                     [CNY/t CO2]
    pAnnualDiscRate      = dfParameter['AnnualDiscountRate' ].iat[0]                                                                          # annual discount rate                     [p.u.]
    pUpReserveActivation = dfParameter['UpReserveActivation'].iat[0]                                                                          # upward   reserve activation              [p.u.]
    pDwReserveActivation = dfParameter['DwReserveActivation'].iat[0]                                                                          # downward reserve activation              [p.u.]
    pMinRatioDwUp        = dfParameter['MinRatioDwUp'       ].iat[0]                                                                          # minimum ratio down up operating reserves [p.u.]
    pMaxRatioDwUp        = dfParameter['MaxRatioDwUp'       ].iat[0]                                                                          # maximum ratio down up operating reserves [p.u.]
    pSBase               = dfParameter['SBase'              ].iat[0] * 1e-3                                                                   # base power                               [GW]
    pReferenceNode       = dfParameter['ReferenceNode'      ].iat[0]                                                                          # reference node
    pTimeStep            = int(dfParameter['TimeStep'      ].iat[0])                                                                    # duration of the unit time step           [h]
    # pStageDuration       = dfParameter['StageDuration'      ][0].astype('int')                                                          # duration of each stage                   [h]
    pOffGridState        = dfParameter['OffGridState'       ].iat[0]                                                                          # off-grid state                           [p.u.] 不考虑离网0；常规离网1；极端离网2；
    pOffGridHour         = dfParameter['OffGridHour'        ].iat[0]                                                                          # off-grid hour                            [h]

    pPeriodWeight        = dfPeriod        ['Weight'        ]                                                                             # weights of periods                       [p.u.]
    pScenProb            = dfScenario      ['Probability'   ]                                                                             # probabilities of scenarios               [p.u.]
    pStageWeight         = dfStage         ['Weight'        ]                                                                             # weights of stages                        [p.u.]
    pDuration            = dfDuration      ['Duration'      ]    * pTimeStep                                                              # duration of load levels                  [h]
    pReserveMargin       = dfReserveMargin ['ReserveMargin' ]                                                                             # minimum adequacy reserve margin          [p.u.]
    pLevelToStage        = dfDuration      ['Stage'         ]                                                                             # load levels assignment to stages
    pDemand              = dfDemand               [mTEPES.nd]    * 1e-3                                                                   # demand                                   [GW]
    pSystemInertia       = dfInertia              [mTEPES.ar]                                                                             # inertia                                  [s]
    pOperReserveUp       = dfUpOperatingReserve   [mTEPES.ar]    * 1e-3                                                                   # upward   operating reserve               [GW]
    pOperReserveDw       = dfDwOperatingReserve   [mTEPES.ar]    * 1e-3                                                                   # downward operating reserve               [GW]
    pPrice               = dfPrice                ['Price']      * 1e6                                                                    # 电价                                     [CNY/GWh]
    pVariableMinPower    = dfVariableMinPower     [mTEPES.gg]    * 1e-3                                                                   # dynamic variable minimum power           [GW]
    pVariableMaxPower    = dfVariableMaxPower     [mTEPES.gg]    * 1e-3                                                                   # dynamic variable maximum power           [GW]
    pVariableMinCharge   = dfVariableMinCharge    [mTEPES.gg]    * 1e-3                                                                   # dynamic variable minimum charge          [GW]
    pVariableMaxCharge   = dfVariableMaxCharge    [mTEPES.gg]    * 1e-3                                                                   # dynamic variable maximum charge          [GW]
    pVariableMinStorage  = dfVariableMinStorage   [mTEPES.gg]                                                                             # dynamic variable minimum storage         [GWh]
    pVariableMaxStorage  = dfVariableMaxStorage   [mTEPES.gg]                                                                             # dynamic variable maximum storage         [GWh]
    pEnergyInflows       = dfEnergyInflows        [mTEPES.gg]    * 1e-3                                                                   # dynamic energy inflows                   [GW]
    pEnergyOutflows      = dfEnergyOutflows       [mTEPES.gg]    * 1e-3                                                                   # dynamic energy outflows                  [GW]

    # compute the demand as the mean over the time step load levels and assign it to active load levels. Idem for operating reserve, variable max power, variable min and max storage and inflows
    if pTimeStep > 1:
        pDemand             = pDemand.rolling            (pTimeStep).mean()
        pSystemInertia      = pSystemInertia.rolling     (pTimeStep).mean()
        pOperReserveUp      = pOperReserveUp.rolling     (pTimeStep).mean()
        pOperReserveDw      = pOperReserveDw.rolling     (pTimeStep).mean()
        pPrice              = pPrice.rolling             (pTimeStep).mean() # 电价
        pVariableMinPower   = pVariableMinPower.rolling  (pTimeStep).mean()
        pVariableMaxPower   = pVariableMaxPower.rolling  (pTimeStep).mean()
        pVariableMinCharge  = pVariableMinCharge.rolling (pTimeStep).mean()
        pVariableMaxCharge  = pVariableMaxCharge.rolling (pTimeStep).mean()
        pVariableMinStorage = pVariableMinStorage.rolling(pTimeStep).mean()
        pVariableMaxStorage = pVariableMaxStorage.rolling(pTimeStep).mean()
        pEnergyInflows      = pEnergyInflows.rolling     (pTimeStep).mean()
        pEnergyOutflows     = pEnergyOutflows.rolling    (pTimeStep).mean()

    pDemand.fillna            (0.0, inplace=True)
    pSystemInertia.fillna     (0.0, inplace=True)
    pOperReserveUp.fillna     (0.0, inplace=True)
    pOperReserveDw.fillna     (0.0, inplace=True)
    pPrice.fillna             (0.0, inplace=True) # 电价
    pVariableMinPower.fillna  (0.0, inplace=True)
    pVariableMaxPower.fillna  (0.0, inplace=True)
    pVariableMinCharge.fillna (0.0, inplace=True)
    pVariableMaxCharge.fillna (0.0, inplace=True)
    pVariableMinStorage.fillna(0.0, inplace=True)
    pVariableMaxStorage.fillna(0.0, inplace=True)
    pEnergyInflows.fillna     (0.0, inplace=True)
    pEnergyOutflows.fillna    (0.0, inplace=True)

    if pTimeStep > 1:
        # assign duration 0 to load levels not being considered, active load levels are at the end of every pTimeStep
        for i in range(pTimeStep-2,-1,-1):
            pDuration[range(i,len(mTEPES.nn),pTimeStep)] = 0

    #%% generation parameters
    pGenToNode          = dfGeneration  ['Node'                  ]                                                                            # generator location in node
    pGenToTechnology    = dfGeneration  ['Technology'            ]                                                                            # generator association to technology
    pGenToExclusiveGen  = dfGeneration  ['MutuallyExclusive'     ]                                                                            # mutually exclusive generator
    pIndBinUnitInvest   = dfGeneration  ['BinaryInvestment'      ]                                                                            # binary unit investment decision             [Yes]
    pIndBinUnitRetire   = dfGeneration  ['BinaryRetirement'      ]                                                                            # binary unit retirement decision             [Yes]
    pIndBinUnitCommit   = dfGeneration  ['BinaryCommitment'      ]                                                                            # binary unit commitment decision             [Yes]
    pIndOperReserve     = dfGeneration  ['NoOperatingReserve'    ]                                                                            # no contribution to operating reserve        [Yes]
    pMustRun            = dfGeneration  ['MustRun'               ]                                                                            # must-run unit                               [Yes]
    pInertia            = dfGeneration  ['Inertia'               ]                                                                            # inertia constant                            [s]
    pPeriodIniGen       = dfGeneration  ['InitialPeriod'         ]                                                                            # initial period                              [year]
    pPeriodFinGen       = dfGeneration  ['FinalPeriod'           ]                                                                            # final   period                              [year]
    pAvailability       = dfGeneration  ['Availability'          ]                                                                            # unit availability for adequacy              [p.u.]
    pEFOR               = dfGeneration  ['EFOR'                  ]                                                                            # EFOR                                        [p.u.]
    pRatedMinPower      = dfGeneration  ['MinimumPower'          ] * 1e-3 * (1.0-dfGeneration['EFOR'])                                        # rated minimum power                         [GW]
    pRatedMaxPower      = dfGeneration  ['MaximumPower'          ] * 1e-3 * (1.0-dfGeneration['EFOR'])                                        # rated maximum power                         [GW]
    pLinearFuelCost     = dfGeneration  ['LinearTerm'            ] * 1e3  *      dfGeneration['FuelCost']                                     # fuel     term variable cost                 [CNY/GWh] 输入的是 [CNY/MWh] 所以要乘以 1e3
    pLinearOMCost       = dfGeneration  ['OMVariableCost'        ] * 1e3                                                                     # O&M      term variable cost                  [MEUR/GWh]
    pConstantVarCost    = dfGeneration  ['ConstantTerm'          ] * 1e3 *      dfGeneration['FuelCost']                                     # constant term variable cost                 [MEUR/h]
    pOperReserveCost    = dfGeneration  ['OperReserveCost'       ] * 1e3                                                                     # operating reserve      cost                 [MEUR/GW]
    pStartUpCost        = dfGeneration  ['StartUpCost'           ]                                                                            # startup  cost                               [MEUR]
    pShutDownCost       = dfGeneration  ['ShutDownCost'          ]                                                                            # shutdown cost                               [MEUR]
    pRampUp             = dfGeneration  ['RampUp'                ] * 1e-3                                                                     # ramp up   rate                              [GW/h]
    pRampDw             = dfGeneration  ['RampDown'              ] * 1e-3                                                                     # ramp down rate                              [GW/h]
    pCO2EmissionCost    = dfGeneration  ['CO2EmissionRate'       ] * 1e-3 * pCO2Cost                                                          # emission  cost                              [MEUR/GWh]
    pCO2EmissionRate    = dfGeneration  ['CO2EmissionRate'       ]                                                                            # emission  rate                              [tCO2/MWh]
    pUpTime             = dfGeneration  ['UpTime'                ]                                                                            # minimum up    time                          [h]
    pDwTime             = dfGeneration  ['DownTime'              ]                                                                            # minimum down  time                          [h]
    pShiftTime          = dfGeneration  ['ShiftTime'             ]                                                                            # maximum shift time for DSM                  [h]
    # Calculate FixedChargeRate based on Lifetime if FixedChargeRate is empty/null
    if 'Lifetime' in dfGeneration.columns:
        discount_rate = 0.04 # 默认贴现率 4%，您可以根据需要调整或从全局参数读取
        # 找出 FixedChargeRate 为空，但 Lifetime 有值的行
        mask = dfGeneration['Lifetime'].notna() & (dfGeneration['Lifetime'] > 0)
        if mask.any():
            lifetime = dfGeneration.loc[mask, 'Lifetime']
            dfGeneration.loc[mask, 'FixedChargeRate'] = (discount_rate * (1 + discount_rate)**lifetime) / ((1 + discount_rate)**lifetime - 1)
            
    # 如果仍然有空值，可以填充为 0 或者抛出警告
    dfGeneration['FixedChargeRate'] = dfGeneration['FixedChargeRate'].fillna(0)

    pGenInvestCost      = dfGeneration  ['FixedInvestmentCost'   ] * 1e3  * dfGeneration['FixedChargeRate']                                   # generation fixed cost                       [CNY]
    pGenRetireCost      = dfGeneration  ['FixedRetirementCost'   ] *        dfGeneration['FixedChargeRate']                                   # generation fixed retirement cost            [CNY]
    pRatedMinCharge     = dfGeneration  ['MinimumCharge'         ] * 1e-3                                                                     # rated minimum ESS charge                    [GW]
    pRatedMaxCharge     = dfGeneration  ['MaximumCharge'         ] * 1e-3                                                                     # rated maximum ESS charge                    [GW]
    pRatedMinStorage    = dfGeneration  ['MinimumStorage'        ] * 1e-3                                                                     # rated minimum ESS storage                   [GWh]
    pRatedMaxStorage    = dfGeneration  ['MaximumStorage'        ] * 1e-3                                                                     # rated maximum ESS storage                   [GWh]
    pInitialInventory   = dfGeneration  ['InitialStorage'        ] * 1e-3                                                                     # initial       ESS storage                   [GWh]
    pEfficiency         = dfGeneration  ['Efficiency'            ]                                                                            #         ESS round-trip efficiency           [p.u.]
    pStorageType        = dfGeneration  ['StorageType'           ]                                                                            #         ESS storage  type
    pOutflowsType       = dfGeneration  ['OutflowsType'          ]                                                                            #         ESS outflows type
    pRMaxReactivePower  = dfGeneration  ['MaximumReactivePower'  ] * 1e-3                                                                     # rated maximum reactive power                [Gvar]

    pLinearOperCost     = pLinearFuelCost + pCO2EmissionCost
    pLinearVarCost      = pLinearFuelCost + pLinearOMCost

    pNodeLat            = dfNodeLocation['Latitude'              ]                                                                            # node latitude                               [º]
    pNodeLon            = dfNodeLocation['Longitude'             ]                                                                            # node longitude                              [º]

    pLineType           = dfNetwork     ['LineType'              ]                                                                            # line type
    pLineLength         = dfNetwork     ['Length'                ]                                                                            # line length                                 [km]
    pLineVoltage        = dfNetwork     ['Voltage'               ]                                                                            # line voltage                                [kV]
    pPeriodIniNet       = dfNetwork     ['InitialPeriod'         ]                                                                            # initial period
    pPeriodFinNet       = dfNetwork     ['FinalPeriod'           ]                                                                            # final   period
    pLineLossFactor     = dfNetwork     ['LossFactor'            ]                                                                            # loss factor                                 [p.u.]
    pLineR              = dfNetwork     ['Resistance'            ]                                                                            # resistance                                  [p.u.]
    pLineX              = dfNetwork     ['Reactance'             ].sort_index()                                                               # reactance                                   [p.u.]
    pLineBsh            = dfNetwork     ['Susceptance'           ]                                                                            # susceptance                                 [p.u.]
    pLineTAP            = dfNetwork     ['Tap'                   ]                                                                            # tap changer                                 [p.u.]
    pLineNTCFrw         = dfNetwork     ['TTC'                   ] * 1e-3 * dfNetwork['SecurityFactor' ]                                      # net transfer capacity in forward  direction [GW]
    pLineNTCBck         = dfNetwork     ['TTCBck'                ] * 1e-3 * dfNetwork['SecurityFactor' ]                                      # net transfer capacity in backward direction [GW]
    pNetFixedCost       = dfNetwork     ['FixedInvestmentCost'   ] *        dfNetwork['FixedChargeRate']                                      # network    fixed cost                       [MEUR]
    pIndBinLineSwitch   = dfNetwork     ['Switching'             ]                                                                            # binary line switching  decision             [Yes]
    pIndBinLineInvest   = dfNetwork     ['BinaryInvestment'      ]                                                                            # binary line investment decision             [Yes]
    pSwitchOnTime       = dfNetwork     ['SwOnTime'              ]                                                                            # minimum on  time                            [h]
    pSwitchOffTime      = dfNetwork     ['SwOffTime'             ]                                                                            # minimum off time                            [h]
    pAngMin             = dfNetwork     ['AngMin'                ] * math.pi / 180                                                            # Min phase angle difference                  [rad]
    pAngMax             = dfNetwork     ['AngMax'                ] * math.pi / 180                                                            # Max phase angle difference                  [rad]

    # replace pLineNTCBck = 0.0 by pLineNTCFrw
    pLineNTCBck     = pLineNTCBck.where(pLineNTCBck > 0.0, other=pLineNTCFrw)
    # replace pLineNTCFrw = 0.0 by pLineNTCBck
    pLineNTCFrw     = pLineNTCFrw.where(pLineNTCFrw > 0.0, other=pLineNTCBck)

    # minimum up and down time converted to an integer number of time steps
    pSwitchOnTime  = round(pSwitchOnTime /pTimeStep).astype('int')
    pSwitchOffTime = round(pSwitchOffTime/pTimeStep).astype('int')

    ReadingDataTime = time.time() - StartTime
    StartTime       = time.time()
    print('Reading    input data                  ... ', round(ReadingDataTime), 's')

    #%% Getting the branches from the network data
    pBr = [(ni, nf) for (ni, nf, cc) in dfNetwork.index]
    # Dropping duplicate keys
    pBrList = [(ni,nf) for n, (ni,nf) in enumerate(pBr) if (ni,nf) not in pBr[:n]]

    mTEPES.p    = mTEPES.pp
    mTEPES.sc   = mTEPES.scc
    mTEPES.ps   = [(p, sc) for p in mTEPES.p for sc in mTEPES.sc]
    mTEPES.st   = mTEPES.stt
    mTEPES.n    = [nn for nn in mTEPES.nn if pDuration         [nn] >  0]
    mTEPES.n2   = [nn for nn in mTEPES.nn if pDuration         [nn] >  0]
    # Keep generators only if they (i) have installed capacity / charge potential, (ii) are within
    # the considered planning horizon, and (iii) are connected to an active node.
    mTEPES.g    = [gg for gg in mTEPES.gg if (pRatedMaxPower   [gg] >  0.0 or  pRatedMaxCharge[gg] >  0.0) 
                  and pPeriodIniGen[gg] <= mTEPES.p[-1]
                  and pPeriodFinGen[gg] >= mTEPES.p[0]
                  and (pGenToNode[gg] in mTEPES.nd)]
    mTEPES.t    = [g for g in mTEPES.g if pLinearOperCost   [g ] >  0.0]
    mTEPES.r    = [g for g in mTEPES.g if pLinearOperCost   [g ] == 0.0 and pRatedMaxStorage[g] == 0.0]
    mTEPES.es   = [g for g in mTEPES.g if                                   pRatedMaxStorage[g] >  0.0 and (pEnergyInflows.sum()[g] > 0.0 or pRatedMaxCharge[g] > 0.0)]
    mTEPES.gc   = [g for g in mTEPES.g if pGenInvestCost    [g ] >  0.0]
    mTEPES.gd   = [g for g in mTEPES.g if pGenRetireCost    [g ] != 0.0]
    mTEPES.ec   = [es for es in mTEPES.es if pGenInvestCost    [es] >  0.0]
    mTEPES.br   = list(pBrList)
    mTEPES.ln   = list(dfNetwork.index)
    mTEPES.la   = [ln for ln in mTEPES.ln if pLineX            [ln] != 0.0 and pLineNTCFrw[ln] > 0.0 and pLineNTCBck[ln] > 0.0 and pPeriodIniNet[ln] <= mTEPES.p[-1] and pPeriodFinNet[ln] >= mTEPES.p[0]]
    mTEPES.lc   = [la for la in mTEPES.la if pNetFixedCost     [la] >  0.0]
    mTEPES.cd   = [la for la in mTEPES.la if pNetFixedCost     [la] >  0.0 and pLineType[la] == 'DC']
    mTEPES.ed   = [la for la in mTEPES.la if pNetFixedCost     [la] == 0.0 and pLineType[la] == 'DC']
    mTEPES.ll   = [la for la in mTEPES.la if pLineLossFactor   [la] >  0.0 and pIndBinNetLosses > 0 ]
    mTEPES.rf   = [nd for nd in mTEPES.nd if nd in                pReferenceNode               ]
    mTEPES.gq   = [gg for gg in mTEPES.gg if pRMaxReactivePower[gg] >  0.0]
    mTEPES.sq   = [gg for gg in mTEPES.gg if pRMaxReactivePower[gg] >  0.0 and pGenToTechnology[gg] == 'SynchronousCondenser']
    mTEPES.sqc  = mTEPES.sq
    mTEPES.shc  = mTEPES.sq

    # non-RES units, they can be committed and also contribute to the operating reserves
    mTEPES.nr = [g for g in mTEPES.g if g not in mTEPES.r]

    # machines able to provide reactive power
    mTEPES.tq = [g for g in mTEPES.gq if g not in mTEPES.sq]
    
    # existing lines (le)
    # mTEPES.le = mTEPES.la - mTEPES.lc
    mTEPES.le = [l for l in mTEPES.la if l not in mTEPES.lc]

    # assigning a node to an area
    pNode2Area = pd.DataFrame(0, dtype=int, index=pd.MultiIndex.from_tuples(((nd, ar) for nd in mTEPES.nd for ar in mTEPES.ar), names=('Node', 'Area')), columns=['Y/N'])
    for nd in mTEPES.nd:
        for zn in mTEPES.zn:
            for ar in mTEPES.ar:
                if (zn,ar) in mTEPES.znar:
                    pNode2Area.loc[nd, ar] = 1
    mTEPES.ndar = [(nd, ar) for nd in mTEPES.nd for ar in mTEPES.ar if pNode2Area.loc[nd, ar]['Y/N'] == 1]

    # assigning a line to an area. Both nodes are in the same area. Cross-area lines not included
    # pLine2Area = pd.DataFrame(0, dtype=int, index=pd.MultiIndex.from_tuples(mTEPES.la*mTEPES.ar, names=('InitialNode', 'FinalNode', 'Circuit', 'Area')), columns=['Y/N'])
    # for ni,nf,cc,ar in mTEPES.la*mTEPES.ar:
    #     if (ni,ar) in mTEPES.ndar:
    #         if (nf,ar) in mTEPES.ndar:
    #             pLine2Area.loc[ni,nf,cc,ar] = 1
    # mTEPES.laar = Set(initialize=mTEPES.la*mTEPES.ar, ordered=False, doc='line to area', filter=lambda mTEPES,ni,nf,cc,ar: (ni,nf,cc,ar) in mTEPES.la*mTEPES.ar and pLine2Area.loc[ni,nf,cc,ar]['Y/N'] == 1)

    # replacing string values by numerical values
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

    pIndBinUnitInvest = pIndBinUnitInvest.map(idxDict)
    pIndBinUnitRetire = pIndBinUnitRetire.map(idxDict)
    pIndBinUnitCommit = pIndBinUnitCommit.map(idxDict)
    pIndOperReserve   = pIndOperReserve.map  (idxDict)
    pMustRun          = pMustRun.map         (idxDict)
    pIndBinLineInvest = pIndBinLineInvest.map(idxDict)
    pIndBinLineSwitch = pIndBinLineSwitch.map(idxDict)

    # define AC existing  lines     non-switchable
    mTEPES.lea = [l for l in mTEPES.le if pIndBinLineSwitch[l] == 0                             and not pLineType[l] == 'DC']
   
    # define AC candidate lines and     switchable lines
    mTEPES.lca = [l for l in mTEPES.la if (pIndBinLineSwitch[l] == 1 or pNetFixedCost[l] > 0.0) and not pLineType[l] == 'DC']
    
    # mTEPES.laa = mTEPES.lea | mTEPES.lca
    mTEPES.laa = mTEPES.lea + [l for l in mTEPES.lca if l not in mTEPES.lea]

    # define DC existing  lines     non-switchable
    mTEPES.led = [l for l in mTEPES.le if pIndBinLineSwitch[l] == 0                             and pLineType[l] == 'DC']
    
    # define DC candidate lines and     switchable lines
    # 候选线路或者可以switchable的线路
    mTEPES.lcd = [l for l in mTEPES.la if (pIndBinLineSwitch[l] == 1 or pNetFixedCost[l] > 0.0) and pLineType[l] == 'DC']

    # mTEPES.lad = mTEPES.led | mTEPES.lcd
    mTEPES.lad = mTEPES.led + [l for l in mTEPES.lcd if l not in mTEPES.led]

    # line type
    pLineType = pLineType.reset_index().set_index(['level_0','level_1','level_2','LineType'])

    print(pLineType)
    mTEPES.pLineType = pLineType.index.to_list()

    #%% inverse index load level to stage
    pStageToLevel = pLevelToStage.reset_index().set_index('Stage').set_axis(['LoadLevel'], axis=1, inplace=False)[['LoadLevel']]
    pStageToLevel = pStageToLevel.loc[pStageToLevel['LoadLevel'].isin(mTEPES.n)]
    pStage2Level  = pStageToLevel.reset_index().set_index(['Stage','LoadLevel'])

    # mTEPES.s2n = Set(initialize=pStage2Level.index, ordered=False, doc='load level to stage')
    mTEPES.s2n = pStage2Level.index.to_list()

    if pAnnualDiscRate == 0.0:
        pDiscountFactor = pd.Series(data=[pPeriodWeight[p] for p in mTEPES.p], index=mTEPES.p)
    else:
        pDiscountFactor = pd.Series(data=[((1.0+pAnnualDiscRate)**pPeriodWeight[p]-1.0) / (pAnnualDiscRate*(1.0+pAnnualDiscRate)**(pPeriodWeight[p]-1+p-pCurrentYear)) for p in mTEPES.p], index=mTEPES.p)

    # mTEPES.pLoadLevelWeight = Param(mTEPES.n, initialize=0.0, within=NonNegativeReals, doc='Load level weight', mutable=True)
    mTEPES.pLoadLevelWeight = {n: 0.0 for n in mTEPES.n}
    for st,n in mTEPES.s2n:
        mTEPES.pLoadLevelWeight[n] = pStageWeight[st]

    #%% inverse index node to generator
    pNodeToGen = pGenToNode.reset_index().set_index('Node').set_axis(['Generator'], axis=1, inplace=False)[['Generator']]
    pNodeToGen = pNodeToGen.loc[pNodeToGen['Generator'].isin(mTEPES.g)]
    pNode2Gen  = pNodeToGen.reset_index().set_index(['Node', 'Generator'])

    # mTEPES.n2g = Set(initialize=pNode2Gen.index, ordered=False, doc='node   to generator')
    mTEPES.n2g = pNode2Gen.index.to_list()

    # pZone2Gen   = pd.DataFrame(0, dtype=int, index=pd.MultiIndex.from_tuples(mTEPES.zn*mTEPES.g, names=('Zone',   'Generator')), columns=['Y/N'])
    # pArea2Gen   = pd.DataFrame(0, dtype=int, index=pd.MultiIndex.from_tuples(mTEPES.ar*mTEPES.g, names=('Area',   'Generator')), columns=['Y/N'])
    # pRegion2Gen = pd.DataFrame(0, dtype=int, index=pd.MultiIndex.from_tuples(mTEPES.rg*mTEPES.g, names=('Region', 'Generator')), columns=['Y/N'])

    pZone2Gen   = pd.DataFrame(0, dtype=int, index=pd.MultiIndex.from_tuples(((zn, g) for zn in mTEPES.zn for g in mTEPES.g), names=('Zone',   'Generator')), columns=['Y/N'])
    pArea2Gen   = pd.DataFrame(0, dtype=int, index=pd.MultiIndex.from_tuples(((ar, g) for ar in mTEPES.ar for g in mTEPES.g), names=('Area',   'Generator')), columns=['Y/N'])
    pRegion2Gen = pd.DataFrame(0, dtype=int, index=pd.MultiIndex.from_tuples(((rg, g) for rg in mTEPES.rg for g in mTEPES.g), names=('Region', 'Generator')), columns=['Y/N'])

    for nd,g in mTEPES.n2g:
        for zn in mTEPES.zn:
            if (nd,zn) in mTEPES.ndzn:
                pZone2Gen.loc[zn,g] = 1
            for ar in mTEPES.ar:
                if (nd,zn) in mTEPES.ndzn and (zn,ar) in mTEPES.znar:
                    pArea2Gen.loc[ar,g] = 1
                for rg in mTEPES.rg:
                    if (nd,zn) in mTEPES.ndzn and (zn,ar) in mTEPES.znar and (zn,rg) in mTEPES.arrg:
                        pRegion2Gen.loc[rg,g] = 1

    # mTEPES.a2g = Set(initialize=mTEPES.ar*mTEPES.g, ordered=False, doc='area   to generator', filter=lambda mTEPES,ar,g: (ar,g) in mTEPES.ar*mTEPES.g and pArea2Gen.loc  [ar,g]['Y/N'] == 1)
    mTEPES.a2g = [(ar,g) for ar in mTEPES.ar for g in mTEPES.g if  pArea2Gen.loc  [ar,g]['Y/N'] == 1]

    #%% inverse index generator to technology
    pTechnologyToGen = pGenToTechnology.reset_index().set_index('Technology').set_axis(['Generator'], axis=1, inplace=False)[['Generator']]
    pTechnologyToGen = pTechnologyToGen.loc[pTechnologyToGen['Generator'].isin(mTEPES.g)]
    pTechnology2Gen  = pTechnologyToGen.reset_index().set_index(['Technology', 'Generator'])

    # mTEPES.t2g = Set(initialize=pTechnology2Gen.index, ordered=False, doc='technology to generator')
    mTEPES.t2g = pTechnology2Gen.index.to_list()

    # ESS and RES technologies
    # mTEPES.ot = Set(initialize=mTEPES.gt, ordered=False, doc='storage technologies', filter=lambda mTEPES,gt: gt in mTEPES.gt and sum(1 for es in mTEPES.es if (gt,es) in mTEPES.t2g))
    mTEPES.ot = [gt for gt in mTEPES.gt if sum(1 for es in mTEPES.es if (gt,es) in mTEPES.t2g)]
    # mTEPES.rt = Set(initialize=mTEPES.gt, ordered=False, doc='RES     technologies', filter=lambda mTEPES,gt: gt in mTEPES.gt and sum(1 for r  in mTEPES.r  if (gt,r ) in mTEPES.t2g))
    mTEPES.rt = [gt for gt in mTEPES.gt if sum(1 for r  in mTEPES.r  if (gt,r ) in mTEPES.t2g)]
    
    #%% inverse index generator to mutually exclusive generator
    pExclusiveGenToGen = pGenToExclusiveGen.reset_index().set_index('MutuallyExclusive').set_axis(['Generator'], axis=1, inplace=False)[['Generator']]
    pExclusiveGenToGen = pExclusiveGenToGen.loc[pExclusiveGenToGen['Generator'].isin(mTEPES.g)]
    pExclusiveGen2Gen  = pExclusiveGenToGen.reset_index().set_index(['MutuallyExclusive', 'Generator'])

    # mTEPES.g2g = Set(initialize=pExclusiveGen2Gen.index, ordered=False, doc='mutually exclusive generator to generator', filter=lambda mTEPES,gg,g: (gg,g) in mTEPES.gg*mTEPES.g)
    mTEPES.g2g = [] # 不能同时运行的发电机

    # minimum and maximum variable power
    # 注意光伏不能没处理不能为0，否则会被替换成nan
    pVariableMinPower   = pVariableMinPower.replace(0.0, float('nan')) # 这里改为输入曲线是确认的
    pVariableMaxPower   = pVariableMaxPower.replace(0.0, float('nan'))
    pMinPower           = pd.DataFrame([pRatedMinPower]*len(pVariableMinPower.index), index=pd.MultiIndex.from_tuples(pVariableMinPower.index), columns=pRatedMinPower.index)
    pMaxPower           = pd.DataFrame([pRatedMaxPower]*len(pVariableMaxPower.index), index=pd.MultiIndex.from_tuples(pVariableMaxPower.index), columns=pRatedMaxPower.index)
    pMinPower           = pMinPower.reindex        (sorted(pMinPower.columns        ), axis=1)
    pMaxPower           = pMaxPower.reindex        (sorted(pMaxPower.columns        ), axis=1)
    pVariableMinPower   = pVariableMinPower.reindex(sorted(pVariableMinPower.columns), axis=1)
    pVariableMaxPower   = pVariableMaxPower.reindex(sorted(pVariableMaxPower.columns), axis=1)
    pMinPower           = pVariableMinPower.where         (pVariableMinPower > pMinPower, other=pMinPower)
    pMaxPower           = pVariableMaxPower.where         (pVariableMaxPower < pMaxPower, other=pMaxPower)
    # pMinPower           = pMinPower.where                 (pMinPower         > 0.0,       other=0.0) # 并网点功率反 取消这个限制
    pMaxPower           = pMaxPower.where                 (pMaxPower         > 0.0,       other=0.0)

    # minimum and maximum variable charge
    pVariableMinCharge  = pVariableMinCharge.replace(0.0, float('nan'))
    pVariableMaxCharge  = pVariableMaxCharge.replace(0.0, float('nan'))
    pMinCharge          = pd.DataFrame([pRatedMinCharge]*len(pVariableMinCharge.index), index=pd.MultiIndex.from_tuples(pVariableMinCharge.index), columns=pRatedMinCharge.index)
    pMaxCharge          = pd.DataFrame([pRatedMaxCharge]*len(pVariableMaxCharge.index), index=pd.MultiIndex.from_tuples(pVariableMaxCharge.index), columns=pRatedMaxCharge.index)
    pMinCharge          = pMinCharge.reindex        (sorted(pMinCharge.columns        ), axis=1)
    pMaxCharge          = pMaxCharge.reindex        (sorted(pMaxCharge.columns        ), axis=1)
    pVariableMinCharge  = pVariableMinCharge.reindex(sorted(pVariableMinCharge.columns), axis=1)
    pVariableMaxCharge  = pVariableMaxCharge.reindex(sorted(pVariableMaxCharge.columns), axis=1)
    pMinCharge          = pVariableMinCharge.where         (pVariableMinCharge > pMinCharge, other=pMinCharge)
    pMaxCharge          = pVariableMaxCharge.where         (pVariableMaxCharge < pMaxCharge, other=pMaxCharge)
    pMinCharge          = pMinCharge.where                 (pMinCharge         > 0.0,        other=0.0)
    pMaxCharge          = pMaxCharge.where                 (pMaxCharge         > 0.0,        other=0.0)

    # minimum and maximum variable storage capacity
    pVariableMinStorage = pVariableMinStorage.replace(0.0, float('nan'))
    pVariableMaxStorage = pVariableMaxStorage.replace(0.0, float('nan'))
    pMinStorage         = pd.DataFrame([pRatedMinStorage]*len(pVariableMinStorage.index), index=pd.MultiIndex.from_tuples(pVariableMinStorage.index), columns=pRatedMinStorage.index)
    pMaxStorage         = pd.DataFrame([pRatedMaxStorage]*len(pVariableMaxStorage.index), index=pd.MultiIndex.from_tuples(pVariableMaxStorage.index), columns=pRatedMaxStorage.index)
    pMinStorage         = pMinStorage.reindex        (sorted(pMinStorage.columns        ), axis=1)
    pMaxStorage         = pMaxStorage.reindex        (sorted(pMaxStorage.columns        ), axis=1)
    pVariableMinStorage = pVariableMinStorage.reindex(sorted(pVariableMinStorage.columns), axis=1)
    pVariableMaxStorage = pVariableMaxStorage.reindex(sorted(pVariableMaxStorage.columns), axis=1)
    pMinStorage         = pVariableMinStorage.where         (pVariableMinStorage > pMinStorage, other=pMinStorage)
    pMaxStorage         = pVariableMaxStorage.where         (pVariableMaxStorage < pMaxStorage, other=pMaxStorage)
    pMinStorage         = pMinStorage.where                 (pMinStorage         > 0.0,         other=0.0)
    pMaxStorage         = pMaxStorage.where                 (pMaxStorage         > 0.0,         other=0.0)

    # parameter that allows the initial inventory to change with load level
    pIniInventory       = pd.DataFrame([pInitialInventory]*len(pVariableMinStorage.index), index=pd.MultiIndex.from_tuples(pVariableMinStorage.index), columns=pInitialInventory.index)
    # initial inventory must be between minimum and maximum
    # pIniInventory       = pMinStorage.where(pMinStorage > pIniInventory, other=pIniInventory)
    # pIniInventory       = pMaxStorage.where(pMaxStorage < pIniInventory, other=pIniInventory)

    # minimum up and down time and maximum shift time converted to an integer number of time steps
    pUpTime    = round(pUpTime   /pTimeStep).astype('int')
    pDwTime    = round(pDwTime   /pTimeStep).astype('int')
    pShiftTime = round(pShiftTime/pTimeStep).astype('int')

    # %% definition of the time-steps leap to observe the stored energy at an ESS
    pCycleTimeStep    = (pUpTime*0+   1).astype('int')
    pOutflowsTimeStep = (pUpTime*0+8736).astype('int')
    for es in mTEPES.es:
        if pStorageType[es] == 'Daily'  :
            pCycleTimeStep[es] =       1
        if pStorageType[es] == 'Weekly' :
            pCycleTimeStep[es] = int( 24/pTimeStep)
        if pStorageType[es] == 'Monthly':
            pCycleTimeStep[es] = int(168/pTimeStep)

        if pEnergyOutflows.sum()[es]:
            if pOutflowsType[es] == 'Hourly' :
                pOutflowsTimeStep[es] =        1
            if pOutflowsType[es] == 'Daily'  :
                pOutflowsTimeStep[es] = int(  24/pTimeStep)
            if pOutflowsType[es] == 'Weekly' :
                pOutflowsTimeStep[es] = int( 168/pTimeStep)
            if pOutflowsType[es] == 'Monthly':
                pOutflowsTimeStep[es] = int( 672/pTimeStep)
            if pOutflowsType[es] == 'Yearly' :
                pOutflowsTimeStep[es] = int(8736/pTimeStep)

        pCycleTimeStep[es] = min(pCycleTimeStep[es], pOutflowsTimeStep[es])

    # the stage duration is the maximum between the defined stage duration and the storage type and the outflows type for any ESS to avoid breaking the energy outflows constraints
    # pStageDuration = max(pStageDuration, pCycleTimeStep.max(), pOutflowsTimeStep.max())

    # drop load levels with duration 0
    pDuration         = pDuration.loc        [                   mTEPES.n          ]
    # pDemand           = pDemand.loc          [mTEPES.p*mTEPES.sc*mTEPES.n          ]
    pDemand           = pDemand.loc          [[(p,sc,n)    for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n                    ]]
    # pSystemInertia    = pSystemInertia.loc   [mTEPES.p*mTEPES.sc*mTEPES.n*mTEPES.ar]
    pSystemInertia    = pSystemInertia.loc   [[(p,sc,n,ar) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for ar in mTEPES.ar]]
    # pOperReserveUp    = pOperReserveUp.loc   [mTEPES.p*mTEPES.sc*mTEPES.n*mTEPES.ar]
    pOperReserveUp    = pOperReserveUp.loc   [[(p,sc,n,ar) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for ar in mTEPES.ar]]
    # pOperReserveDw    = pOperReserveDw.loc   [mTEPES.p*mTEPES.sc*mTEPES.n*mTEPES.ar]
    pOperReserveDw    = pOperReserveDw.loc   [[(p,sc,n,ar) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for ar in mTEPES.ar]]
    # pPrice            = pPrice.loc           [                   mTEPES.n          ]
    pPrice            = pPrice.loc           [[n                                                 for n in mTEPES.n                    ]]
    pPrice_avg        = pPrice.mean()            
    # pMinPower         = pMinPower.loc        [mTEPES.p*mTEPES.sc*mTEPES.n          ]
    pMinPower         = pMinPower.loc        [[(p,sc,n)    for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n                    ]]        
    # pMaxPower         = pMaxPower.loc        [mTEPES.p*mTEPES.sc*mTEPES.n          ]
    pMaxPower         = pMaxPower.loc        [[(p,sc,n)    for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n                    ]]
    # pMinCharge        = pMinCharge.loc       [mTEPES.p*mTEPES.sc*mTEPES.n          ]
    pMinCharge        = pMinCharge.loc       [[(p,sc,n)    for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n                    ]]
    # pMaxCharge        = pMaxCharge.loc       [mTEPES.p*mTEPES.sc*mTEPES.n          ]
    pMaxCharge        = pMaxCharge.loc       [[(p,sc,n)    for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n                    ]]
    # pEnergyInflows    = pEnergyInflows.loc   [mTEPES.p*mTEPES.sc*mTEPES.n          ]
    pEnergyInflows    = pEnergyInflows.loc   [[(p,sc,n)    for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n                    ]]
    # pEnergyOutflows   = pEnergyOutflows.loc  [mTEPES.p*mTEPES.sc*mTEPES.n          ]
    pEnergyOutflows   = pEnergyOutflows.loc  [[(p,sc,n)    for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n                    ]]
    # pMinStorage       = pMinStorage.loc      [mTEPES.p*mTEPES.sc*mTEPES.n          ]
    pMinStorage       = pMinStorage.loc      [[(p,sc,n)    for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n                    ]]
    # pMaxStorage       = pMaxStorage.loc      [mTEPES.p*mTEPES.sc*mTEPES.n          ]
    pMaxStorage       = pMaxStorage.loc      [[(p,sc,n)    for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n                    ]]
    # pIniInventory     = pIniInventory.loc    [mTEPES.p*mTEPES.sc*mTEPES.n          ]
    pIniInventory     = pIniInventory.loc    [[(p,sc,n)    for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n                    ]]

    # separate positive and negative demands to avoid converting negative values to 0
    pDemandPos        = pDemand.where        (pDemand >= 0.0, other=0.0)
    pDemandNeg        = pDemand.where        (pDemand <  0.0, other=0.0)

    # small values are converted to 0
    pPeakDemand         = pd.Series(data=[0.0 for ar in mTEPES.ar], index=mTEPES.ar)
    for ar in mTEPES.ar:
        # values < 1e-5 times the maximum demand for each area (an area is related to operating reserves procurement, i.e., country) are converted to 0
        pPeakDemand[ar] = pDemand      [[nd for nd in mTEPES.nd if (nd,ar) in mTEPES.ndar]].sum(axis=1).max()
        pEpsilon        = pPeakDemand[ar]*2.5e-5
        # values < 1e-5 times the maximum system demand are converted to 0
        # pEpsilon      = pDemand.sum(axis=1).max()*1e-5

        # these parameters are in GW
        pDemandPos     [pDemandPos     [[nd for nd in mTEPES.nd if (nd,ar) in mTEPES.ndar]] <  pEpsilon] = 0.0
        pDemandNeg     [pDemandNeg     [[nd for nd in mTEPES.nd if (nd,ar) in mTEPES.ndar]] > -pEpsilon] = 0.0
        pSystemInertia [pSystemInertia [[                                              ar]] <  pEpsilon] = 0.0
        pOperReserveUp [pOperReserveUp [[                                              ar]] <  pEpsilon] = 0.0
        pOperReserveDw [pOperReserveDw [[                                              ar]] <  pEpsilon] = 0.0
        # pMinPower      [pMinPower      [[g  for  g in mTEPES.g  if (ar,g)  in mTEPES.a2g ]] <  pEpsilon] = 0.0
        pMinPower      [abs(pMinPower  [[g  for  g in mTEPES.g  if (ar,g)  in mTEPES.a2g ]]) <  pEpsilon] = 0.0 # 并网 边界需要小 
        pMaxPower      [pMaxPower      [[g  for  g in mTEPES.g  if (ar,g)  in mTEPES.a2g ]] <  pEpsilon] = 0.0
        pMinCharge     [pMinCharge     [[es for es in mTEPES.es if (ar,es) in mTEPES.a2g ]] <  pEpsilon] = 0.0
        pMaxCharge     [pMaxCharge     [[es for es in mTEPES.es if (ar,es) in mTEPES.a2g ]] <  pEpsilon] = 0.0
        pEnergyInflows [pEnergyInflows [[es for es in mTEPES.es if (ar,es) in mTEPES.a2g ]] <  pEpsilon/pTimeStep] = 0.0
        pEnergyOutflows[pEnergyOutflows[[es for es in mTEPES.es if (ar,es) in mTEPES.a2g ]] <  pEpsilon/pTimeStep] = 0.0

        # these parameters are in GWh
        pMinStorage    [pMinStorage    [[es for es in mTEPES.es if (ar,es) in mTEPES.a2g ]] <  pEpsilon] = 0.0
        pMaxStorage    [pMaxStorage    [[es for es in mTEPES.es if (ar,es) in mTEPES.a2g ]] <  pEpsilon] = 0.0
        pIniInventory  [pIniInventory  [[es for es in mTEPES.es if (ar,es) in mTEPES.a2g ]] <  pEpsilon] = 0.0

        pInitialInventory.update(pd.Series([0 for es in mTEPES.es if (ar, es) in mTEPES.a2g and pInitialInventory[es] < pEpsilon], index=[es for es in mTEPES.es if (ar, es) in mTEPES.a2g and pInitialInventory[es] < pEpsilon], dtype='float64'))

        pLineNTCFrw.update(pd.Series([0.0 for (ni,nf,cc) in mTEPES.la if pLineNTCFrw[ni,nf,cc] < pEpsilon], index = [(ni,nf,cc) for (ni,nf,cc) in mTEPES.la if pLineNTCFrw[ni,nf,cc] < pEpsilon], dtype='float64'))
        pLineNTCBck.update(pd.Series([0.0 for (ni,nf,cc) in mTEPES.la if pLineNTCBck[ni,nf,cc] < pEpsilon], index = [(ni,nf,cc) for (ni,nf,cc) in mTEPES.la if pLineNTCBck[ni,nf,cc] < pEpsilon], dtype='float64'))

        # merging positive and negative values of the demand
        # pDemand            = pDemandPos.where(pDemandPos >= 0.0, other=pDemandNeg)

        pMaxPower2ndBlock  = pMaxPower  - pMinPower
        pMaxCharge2ndBlock = pMaxCharge - pMinCharge

        pMaxPower2ndBlock [pMaxPower2ndBlock [[es for es in mTEPES.es if (ar,es) in mTEPES.a2g]] < pEpsilon] = 0.0
        pMaxCharge2ndBlock[pMaxCharge2ndBlock[[es for es in mTEPES.es if (ar,es) in mTEPES.a2g]] < pEpsilon] = 0.0

    # replace very small costs by 0
    pEpsilon = 1e-4           # this value in  GWh is related to the smallest reduced cost, independent of the area
    pLinearOperCost.update (pd.Series([0 for gg in mTEPES.gg if pLinearOperCost [gg] < pEpsilon], index=[gg for gg in mTEPES.gg if pLinearOperCost [gg] < pEpsilon]))
    pLinearVarCost.update  (pd.Series([0 for gg in mTEPES.gg if pLinearVarCost  [gg] < pEpsilon], index=[gg for gg in mTEPES.gg if pLinearVarCost  [gg] < pEpsilon], dtype='float64'))
    pLinearOMCost.update   (pd.Series([0 for gg in mTEPES.gg if pLinearOMCost   [gg] < pEpsilon], index=[gg for gg in mTEPES.gg if pLinearOMCost   [gg] < pEpsilon], dtype='float64'))
    pConstantVarCost.update(pd.Series([0 for gg in mTEPES.gg if pConstantVarCost[gg] < pEpsilon], index=[gg for gg in mTEPES.gg if pConstantVarCost[gg] < pEpsilon], dtype='float64'))
    pOperReserveCost.update(pd.Series([0 for gg in mTEPES.gg if pOperReserveCost[gg] < pEpsilon], index=[gg for gg in mTEPES.gg if pOperReserveCost[gg] < pEpsilon]))
    pCO2EmissionCost.update(pd.Series([0 for gg in mTEPES.gg if pCO2EmissionCost[gg] < pEpsilon], index=[gg for gg in mTEPES.gg if pCO2EmissionCost[gg] < pEpsilon]))
    pStartUpCost.update    (pd.Series([0 for gg in mTEPES.gg if pStartUpCost    [gg] < pEpsilon], index=[gg for gg in mTEPES.gg if pStartUpCost    [gg] < pEpsilon]))
    pShutDownCost.update   (pd.Series([0 for gg in mTEPES.gg if pShutDownCost   [gg] < pEpsilon], index=[gg for gg in mTEPES.gg if pShutDownCost   [gg] < pEpsilon]))

    # replace < 0.0 by 0.0
    pMaxPower2ndBlock  = pMaxPower2ndBlock.where (pMaxPower2ndBlock  > 0.0, other=0.0)
    pMaxCharge2ndBlock = pMaxCharge2ndBlock.where(pMaxCharge2ndBlock > 0.0, other=0.0)

    # BigM maximum flow to be used in the Kirchhoff's 2nd law disjunctive constraint
    pBigMFlowBck = pLineNTCBck*0.0
    pBigMFlowFrw = pLineNTCFrw*0.0
    for lea in mTEPES.lea:
        pBigMFlowBck.loc[lea] = pLineNTCBck[lea]
        pBigMFlowFrw.loc[lea] = pLineNTCFrw[lea]
    for lca in mTEPES.lca:
        pBigMFlowBck.loc[lca] = pLineNTCBck[lca]*1.5
        pBigMFlowFrw.loc[lca] = pLineNTCFrw[lca]*1.5
    for led in mTEPES.led:
        pBigMFlowBck.loc[led] = pLineNTCBck[led]
        pBigMFlowFrw.loc[led] = pLineNTCFrw[led]
    for lcd in mTEPES.lcd:
        pBigMFlowBck.loc[lcd] = pLineNTCBck[lcd]*1.5 #？？？？
        pBigMFlowFrw.loc[lcd] = pLineNTCFrw[lcd]*1.5

    # if BigM are 0.0 then converted to 1.0 to avoid division by 0.0
    pBigMFlowBck = pBigMFlowBck.where(pBigMFlowBck != 0.0, other=1.0)
    pBigMFlowFrw = pBigMFlowFrw.where(pBigMFlowFrw != 0.0, other=1.0)

    # maximum voltage angle
    pMaxTheta = pDemand * 0.0 + math.pi/2
    # pMaxTheta = pMaxTheta.loc[mTEPES.ps*mTEPES.n]
    pMaxTheta = pMaxTheta.loc[[(p, sc, n) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n]]

    # this option avoids a warning in the following assignments
    pd.options.mode.chained_assignment = None

    # %% parameters
    mTEPES.pIndBinGenInvest      = pIndBinGenInvest
    mTEPES.pIndBinGenRetire      = pIndBinGenRetire
    mTEPES.pIndBinGenOperat      = pIndBinGenOperat
    mTEPES.pIndBinSingleNode     = pIndBinSingleNode
    mTEPES.pIndBinGenRamps       = pIndBinGenRamps
    mTEPES.pIndBinGenMinTime     = pIndBinGenMinTime
    mTEPES.pIndBinNetInvest      = pIndBinNetInvest
    mTEPES.pIndBinLineCommit     = pIndBinLineCommit
    mTEPES.pIndBinNetLosses      = pIndBinNetLosses
    mTEPES.pENSCost              = pENSCost
    mTEPES.pCO2Cost              = pCO2Cost
    mTEPES.pAnnualDiscRate       = pAnnualDiscRate
    mTEPES.pUpReserveActivation  = pUpReserveActivation
    mTEPES.pDwReserveActivation  = pDwReserveActivation
    mTEPES.pMinRatioDwUp         = pMinRatioDwUp
    mTEPES.pMaxRatioDwUp         = pMaxRatioDwUp
    mTEPES.pSBase                = pSBase
    mTEPES.pTimeStep             = pTimeStep
    mTEPES.pOffGridState         = pOffGridState # 离网模式
    mTEPES.pOffGridHour          = pOffGridHour  # 离网小时


    mTEPES.pReserveMargin        = pReserveMargin.to_dict()
    mTEPES.pPeakDemand           = pPeakDemand.to_dict()
    mTEPES.pDemand               = pDemand.stack().to_dict()


    def calculate_max_continuous_load(mTEPES, x_hours): # 求mTEPES.pDemand中最大连续x小时的离网负荷 
        """计算连续x小时内系统总负荷的最大总和及对应的起始时段"""
        pTimeStep = mTEPES.pTimeStep  # 获取时间步长（小时）
        window_size = max(1, round(x_hours / pTimeStep))  # 计算时间步窗口大 
        max_sum = -float('inf')
        max_start_time = None
        max_period_indices = []
        n_list = list[Any](mTEPES.n) # 获取所有时间步的列表
        # 遍历所有时段和场景
        for p in mTEPES.p:
            for sc in mTEPES.sc:
                # 计算每个时间步的系统总负荷（所有节点负荷之和）
                system_load = []
                for n in mTEPES.n:
                    total = 0.0
                    for nd in mTEPES.nd:
                        total += mTEPES.pDemand[p, sc, n, nd]
                    system_load.append(total)
                # 计算滚动窗口总和
                rolling_sum = []
                for i in range(len(system_load) - window_size + 1):
                    window_sum = sum(system_load[i:i+window_size])
                    rolling_sum.append(window_sum)
                # 更新全局最大 
                if rolling_sum:
                    current_max = max(rolling_sum)
                    if current_max > max_sum:
                        max_sum = current_max
                        max_index = rolling_sum.index(current_max)
                        max_start_time = n_list[max_index]
                        max_period_indices = n_list[max_index : max_index + window_size]
        print(f"Maximum continuous {x_hours}h load sum: {max_sum} GW, starting at time step: {max_start_time}")
        return max_sum, max_period_indices
    
    def calculate_min_continuous_load_time(mTEPES, x_hours): # 求mTEPES.pDemand中全年连 2小时最小的负荷及对应时 
        """计算连续x小时内系统总负荷最小的起始时段"""
        pTimeStep = mTEPES.pTimeStep  # 获取时间步长（小时）
        window_size = max(1, round(x_hours / pTimeStep))  # 计算时间步窗口大 
        min_sum = float('inf')
        min_start_time = None
        min_period_indices = []
        n_list = list(mTEPES.n) # 获取所有时间步的列表，以便通过索引查找对应的n
        # 取demand大于0的list
        positive_demand = {}
        for p in mTEPES.p:
            for sc in mTEPES.sc:
                for n in mTEPES.n:
                    for nd in mTEPES.nd:
                        if mTEPES.pDemand[p, sc, n, nd] > 0.0:
                            positive_demand[(p, sc, n, nd)] = mTEPES.pDemand[p, sc, n, nd]
                        else:
                            positive_demand[(p, sc, n, nd)] = 0.0
        for p in mTEPES.p: # 遍历所有时段和场景
            for sc in mTEPES.sc: # 计算每个时间步的系统总负荷（所有节点负荷之和）
                system_load = []
                for n in mTEPES.n:
                    total = 0.0
                    for nd in mTEPES.nd:
                        # total += mTEPES.pDemand[p, sc, n, nd]
                        total += positive_demand[(p, sc, n, nd)]
                    system_load.append(total)
                rolling_sum = [] # 计算滚动窗口总和
                # 注意：rolling_sum的长度是 len(system_load) - window_size + 1
                # 第i个rolling_sum对应的时间段是从 n_list[i] 开始的
                for i in range(len(system_load) - window_size + 1):
                    window_sum = sum(system_load[i:i+window_size])
                    rolling_sum.append(window_sum)
                # 更新全局最小值及对应的起始时 
                if rolling_sum:
                    current_min = min(rolling_sum)
                    if current_min < min_sum:
                        min_sum = current_min
                        min_index = rolling_sum.index(current_min)
                        min_start_time = n_list[min_index]
                        min_period_indices = n_list[min_index : min_index + window_size]
        print(f"Minimum continuous {x_hours}h load sum: {min_sum} GW, starting at time step: {min_start_time}")
        return min_sum, min_period_indices
    
    mTEPES.pOffgridMinDemand, mTEPES.pMinLoadPeriod = 0.0, []
    mTEPES.pOffgridDemand,    mTEPES.pMaxLoadPeriod = 0.0, []

    if mTEPES.pOffGridState == 1 and mTEPES.pOffGridHour > 0:  # 常规离网: 保证一天离网即 
        mTEPES.pOffgridMinDemand, mTEPES.pMinLoadPeriod = calculate_min_continuous_load_time(mTEPES, x_hours = mTEPES.pOffGridHour) # 找最小的离网电量
    if mTEPES.pOffGridState == 2 and mTEPES.pOffGridHour > 0:  # 极端离网，保证最大负荷的基础保障负荷25%
        mTEPES.pOffgridDemand,    mTEPES.pMaxLoadPeriod = calculate_max_continuous_load     (mTEPES, x_hours = mTEPES.pOffGridHour)  # 找最大负荷，乘系数，关键负荷占比25%

    mTEPES.pPeriodWeight         = pPeriodWeight.to_dict()
    mTEPES.pDiscountFactor       = pDiscountFactor.to_dict()
    mTEPES.pScenProb             = pScenProb.to_dict()
    mTEPES.pStageWeight          = pStageWeight.to_dict()
    mTEPES.pDuration             = pDuration.to_dict()
    mTEPES.pPrice                = pPrice.to_dict()
    mTEPES.pPrice_avg            = pPrice_avg
    mTEPES.pNodeLon              = pNodeLon.to_dict()
    mTEPES.pNodeLat              = pNodeLat.to_dict()
    mTEPES.pSystemInertia        = pSystemInertia.stack().to_dict()
    mTEPES.pOperReserveUp        = pOperReserveUp.stack().to_dict()
    mTEPES.pOperReserveDw        = pOperReserveDw.stack().to_dict()
    mTEPES.pMinPower             = pMinPower.stack().to_dict()
    mTEPES.pMaxPower             = pMaxPower.stack().to_dict()
    mTEPES.pMinCharge            = pMinCharge.stack().to_dict()
    mTEPES.pMaxCharge            = pMaxCharge.stack().to_dict()
    mTEPES.pMaxPower2ndBlock     = pMaxPower2ndBlock.stack().to_dict()
    mTEPES.pMaxCharge2ndBlock    = pMaxCharge2ndBlock.stack().to_dict()
    mTEPES.pEnergyInflows        = pEnergyInflows.stack().to_dict()
    mTEPES.pEnergyOutflows       = pEnergyOutflows.stack().to_dict()
    mTEPES.pMinStorage           = pMinStorage.stack().to_dict()
    mTEPES.pMaxStorage           = pMaxStorage.stack().to_dict()
    mTEPES.pRatedMaxPower        = pRatedMaxPower.to_dict()
    mTEPES.pRatedMaxStorage      = pRatedMaxStorage.to_dict()
    mTEPES.pMustRun              = pMustRun.to_dict()
    mTEPES.pInertia              = pInertia.to_dict()
    mTEPES.pPeriodIniGen         = pPeriodIniGen.to_dict()
    mTEPES.pPeriodFinGen         = pPeriodFinGen.to_dict()
    mTEPES.pAvailability         = pAvailability.to_dict()
    mTEPES.pEFOR                 = pEFOR.to_dict()
    mTEPES.pLinearOperCost       = pLinearOperCost.to_dict()
    mTEPES.pLinearVarCost        = pLinearVarCost.to_dict()
    mTEPES.pLinearOMCost         = pLinearOMCost.to_dict()
    mTEPES.pConstantVarCost      = pConstantVarCost.to_dict()
    mTEPES.pOperReserveCost      = pOperReserveCost.to_dict()
    mTEPES.pCO2EmissionCost      = pCO2EmissionCost.to_dict()
    mTEPES.pCO2EmissionRate      = pCO2EmissionRate.to_dict()
    mTEPES.pStartUpCost          = pStartUpCost.to_dict()
    mTEPES.pShutDownCost         = pShutDownCost.to_dict()
    mTEPES.pRampUp               = pRampUp.to_dict()
    mTEPES.pRampDw               = pRampDw.to_dict()
    mTEPES.pUpTime               = pUpTime.to_dict()
    mTEPES.pDwTime               = pDwTime.to_dict()
    mTEPES.pShiftTime            = pShiftTime.to_dict()
    mTEPES.pRatedMaxCharge       = pRatedMaxCharge.to_dict()
    mTEPES.pGenInvestCost        = pGenInvestCost.to_dict()
    mTEPES.pGenRetireCost        = pGenRetireCost.to_dict()
    mTEPES.pIndBinUnitInvest     = pIndBinUnitInvest.to_dict()
    mTEPES.pIndBinUnitRetire     = pIndBinUnitRetire.to_dict()
    mTEPES.pIndBinUnitCommit     = pIndBinUnitCommit.to_dict()
    mTEPES.pIndOperReserve       = pIndOperReserve.to_dict()
    mTEPES.pEfficiency           = pEfficiency.to_dict()
    mTEPES.pCycleTimeStep        = pCycleTimeStep.to_dict()
    mTEPES.pOutflowsTimeStep     = pOutflowsTimeStep.to_dict
    mTEPES.pIniInventory         = pIniInventory.stack().to_dict()
    mTEPES.pInitialInventory     = pInitialInventory.to_dict()
    mTEPES.pStorageType          = pStorageType.to_dict()
    mTEPES.pLoadLevelDuration    = {n: 0 for n in mTEPES.n}
    for n in mTEPES.n:
        mTEPES.pLoadLevelDuration[n] = mTEPES.pLoadLevelWeight[n] * mTEPES.pDuration[n]
    mTEPES.pPeriodProb           = {(p, sc): 0 for p in mTEPES.p for sc in mTEPES.sc}
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            mTEPES.pPeriodProb[p,sc] = mTEPES.pPeriodWeight[p] * mTEPES.pScenProb[p,sc]
    mTEPES.pLineLossFactor       = pLineLossFactor.to_dict()
    mTEPES.pLineR                = pLineR.to_dict()
    mTEPES.pLineX                = pLineX.to_dict()
    mTEPES.pLineBsh              = pLineBsh.to_dict()
    mTEPES.pLineTAP              = pLineTAP.to_dict()
    mTEPES.pLineLength           = pLineLength.to_dict()
    mTEPES.pPeriodIniNet         = pPeriodIniNet.to_dict()
    mTEPES.pPeriodFinNet         = pPeriodFinNet.to_dict()
    mTEPES.pLineVoltage          = pLineVoltage.to_dict()
    mTEPES.pLineNTCFrw           = pLineNTCFrw.to_dict()
    mTEPES.pLineNTCBck           = pLineNTCBck.to_dict()
    mTEPES.pNetFixedCost         = pNetFixedCost.to_dict()
    mTEPES.pIndBinLineInvest     = pIndBinLineInvest.to_dict
    mTEPES.pIndBinLineSwitch     = pIndBinLineSwitch.to_dict()
    mTEPES.pSwOnTime             = pSwitchOnTime.to_dict()
    mTEPES.pSwOffTime            = pSwitchOffTime.to_dict()
    mTEPES.pBigMFlowBck          = pBigMFlowBck.to_dict()
    mTEPES.pBigMFlowFrw          = pBigMFlowFrw.to_dict()
    mTEPES.pMaxTheta             = pMaxTheta.stack().to_dict()
    mTEPES.pAngMin               = pAngMin.to_dict()
    mTEPES.pAngMax               = pAngMax.to_dict()

    # if unit availability = 0 changed to 1
    for g in mTEPES.g:
        if  mTEPES.pAvailability[g] == 0.0:
            mTEPES.pAvailability[g] =  1.0

    # if line length = 0 changed to geographical distance with an additional 10%
    # 如果距离没填 用经纬度计算线路长度
    for ni,nf,cc in mTEPES.la:
        if  mTEPES.pLineLength[ni,nf,cc] == 0.0:
            mTEPES.pLineLength[ni,nf,cc] =  1.1 * 6371 * 2 * math.asin(math.sqrt(math.pow(math.sin((mTEPES.pNodeLat[nf]-mTEPES.pNodeLat[ni])*math.pi/180/2),2) + math.cos(mTEPES.pNodeLat[ni]*math.pi/180)*math.cos(mTEPES.pNodeLat[nf]*math.pi/180)*math.pow(math.sin((mTEPES.pNodeLon[nf]-mTEPES.pNodeLon[ni])*math.pi/180/2),2)))

    # initialize generation output, unit commitment and line switching
    pInitialOutput = pd.DataFrame([[0.0]*len(mTEPES.gg)]*len(mTEPES.n), index=pd.MultiIndex.from_tuples(((p,sc,n)    for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n)), columns=list(mTEPES.gg))
    pInitialUC     = pd.DataFrame([[0  ]*len(mTEPES.gg)]*len(mTEPES.n), index=pd.MultiIndex.from_tuples(((p,sc,n)    for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n)), columns=list(mTEPES.gg))
    pInitialSwitch = pd.DataFrame([[0  ]*len(mTEPES.ln)]*len(mTEPES.n), index=pd.MultiIndex.from_tuples(((p,sc,n)    for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n)), columns=list(mTEPES.ln))

    mTEPES.pInitialOutput = pInitialOutput.stack().to_dict()
    mTEPES.pInitialUC     = pInitialUC.stack().to_dict()
    mTEPES.pInitialSwitch = pInitialSwitch.stack().to_dict()
    
    SettingUpDataTime = time.time() - StartTime
    print('Setting up input data                  ... ', round(SettingUpDataTime), 's')
    
def SettingUpVariables_poi(OptModel, mTEPES):
    StartTime = time.time() 
    #%% variables
    # 成本相关变量                                                                                                   doc='弃光             cost                          [MEUR]')
    OptModel.vTotalFCost           = OptModel.add_variables(mTEPES.p,                      domain=poi.VariableDomain.Continuous, lb=0.0,            name="total system fixed                   cost      [MEUR]") 
    OptModel.vTotalGCost           = OptModel.add_variables(mTEPES.ps, mTEPES.n,           domain=poi.VariableDomain.Continuous,                    name="total variable generation  operation cost      [MEUR]")
    OptModel.vTotalCCost           = OptModel.add_variables(mTEPES.ps, mTEPES.n,           domain=poi.VariableDomain.Continuous, lb=0.0,            name="total variable consumption operation cost      [MEUR]")
    OptModel.vTotalECost           = OptModel.add_variables(mTEPES.ps, mTEPES.n,           domain=poi.VariableDomain.Continuous, lb=0.0,            name="total system emission                cost      [MEUR]")
    OptModel.vTotalRCost           = OptModel.add_variables(mTEPES.ps, mTEPES.n,           domain=poi.VariableDomain.Continuous, lb=0.0,            name="total system reliability             cost      [MEUR]")
    OptModel.vTotalAbandonCost     = OptModel.add_variables(mTEPES.ps, mTEPES.n,           domain=poi.VariableDomain.Continuous, lb=0.0,            name="弃光             cost                          [MEUR]")
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                OptModel.set_variable_bounds(OptModel.vTotalRCost[p,sc,n], -0.00000001, 10000000)
    # 运行相关变量   
    OptModel.vTotalOutput          = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.g , domain=poi.VariableDomain.Continuous,         name="total output of the unit     [GW]")
    OptModel.vTotalOutputAbs       = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.g , domain=poi.VariableDomain.Continuous,         name="total output of the unit     [GW]")
    OptModel.vOutput2ndBlock       = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.nr, domain=poi.VariableDomain.Continuous,         name="second block of the unit     [GW]")
    OptModel.vReserveUp            = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.nr, domain=poi.VariableDomain.Continuous,         name="upward   operating reserve   [GW]")
    OptModel.vReserveDown          = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.nr, domain=poi.VariableDomain.Continuous,         name="downward operating reserve   [GW]")
    OptModel.vEnergyOutflows       = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.es, domain=poi.VariableDomain.Continuous,         name="total outflows of the ESS unit [GW]")
    OptModel.vESSInventory         = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.es, domain=poi.VariableDomain.Continuous,         name="ESS inventory                [GWh]")
    OptModel.vESSSpillage          = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.es, domain=poi.VariableDomain.Continuous,         name="ESS spillage                 [GWh]") # 储能溢出设定 
    OptModel.vESSTotalCharge       = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.es, domain=poi.VariableDomain.Continuous,         name="ESS total charge power        [GW]")
    OptModel.vESSChargeState       = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.es, domain=poi.VariableDomain.Binary,             name="ESS charge state             {0,1}") # 充放电状 
    OptModel.vESSDischargeState    = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.es, domain=poi.VariableDomain.Binary,             name="ESS discharge state          {0,1}")
    OptModel.vCharge2ndBlock       = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.es, domain=poi.VariableDomain.Continuous,         name="ESS charge power              [GW]")
    OptModel.vESSReserveUp         = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.es, domain=poi.VariableDomain.Continuous,         name="ESS upward   operating reserve [GW]")
    OptModel.vESSReserveDown       = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.es, domain=poi.VariableDomain.Continuous,         name="ESS downward operating reserve [GW]")
    OptModel.vENS                  = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.nd, domain=poi.VariableDomain.Continuous,         name="energy not served in node      [GW]")
    OptModel.vPloss                = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.nd, domain=poi.VariableDomain.Continuous,         name="energy abandoned in node       [GW]")
    OptModel.vDRUp                 = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.nd, domain=poi.VariableDomain.Continuous,         name="up demand response            [GW]") # 关闭需求响 
    OptModel.vDRDown               = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.nd, domain=poi.VariableDomain.Continuous,         name="down demand response          [GW]") # 关闭需求响 
    # 对以上的变量增加上下 
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for g in mTEPES.g:
                    new_tuple = add_to_tuple(p, sc, n, g)
                    OptModel.set_variable_bounds   (OptModel.vTotalOutput   [new_tuple], mTEPES.pMinPower[p,sc,n,g],    mTEPES.pMaxPower[p,sc,n,g])
                    OptModel.set_variable_bounds   (OptModel.vTotalOutputAbs[new_tuple], 0.0,                           mTEPES.pMaxPower[p,sc,n,g])
                    OptModel.set_variable_attribute(OptModel.vTotalOutput   [new_tuple], poi.VariableAttribute.PrimalStart, 0) 
                    OptModel.set_variable_attribute(OptModel.vTotalOutputAbs[new_tuple], poi.VariableAttribute.PrimalStart, 0)
                for nr in mTEPES.nr:
                    new_tuple = add_to_tuple(p, sc, n, nr)
                    OptModel.set_variable_bounds(OptModel.vOutput2ndBlock[new_tuple], 0.0,                           mTEPES.pMaxPower2ndBlock [p,sc,n,nr])
                    OptModel.set_variable_bounds(OptModel.vReserveUp     [new_tuple], 0.0,                           mTEPES.pMaxPower2ndBlock [p,sc,n,nr])
                    OptModel.set_variable_bounds(OptModel.vReserveDown   [new_tuple], 0.0,                           mTEPES.pMaxPower2ndBlock [p,sc,n,nr])
                for es in mTEPES.es:
                    new_tuple = add_to_tuple(p, sc, n, es)
                    OptModel.set_variable_bounds(OptModel.vEnergyOutflows[new_tuple], 0.0,                           max(mTEPES.pMaxPower[p,sc,n,es],mTEPES.pMaxCharge[p,sc,n,es]))
                    # OptModel.set_variable_bounds(OptModel.vESSInventory  [new_tuple], mTEPES.pMinStorage[p,sc,n,es], mTEPES.pMaxStorage[p,sc,n,es])
                    OptModel.set_variable_bounds(OptModel.vESSInventory  [new_tuple], 0.0,                           mTEPES.pMaxStorage[p,sc,n,es]       )
                    OptModel.set_variable_bounds(OptModel.vESSSpillage   [new_tuple], 0.0,                           0.0                                 ) # 储能溢出设定 
                    OptModel.set_variable_bounds(OptModel.vESSTotalCharge[new_tuple], 0.0,                           mTEPES.pMaxCharge[p,sc,n,es]        )
                    OptModel.set_variable_bounds(OptModel.vCharge2ndBlock[new_tuple], 0.0,                           mTEPES.pMaxCharge2ndBlock[p,sc,n,es])
                    OptModel.set_variable_bounds(OptModel.vESSReserveUp  [new_tuple], 0.0,                           mTEPES.pMaxCharge2ndBlock[p,sc,n,es])
                    OptModel.set_variable_bounds(OptModel.vESSReserveDown[new_tuple], 0.0,                           mTEPES.pMaxCharge2ndBlock[p,sc,n,es])
                for nd in mTEPES.nd:
                    new_tuple = add_to_tuple(p, sc, n, nd)
                    OptModel.set_variable_bounds(OptModel.vENS           [new_tuple], 0.0000000000,                  max(0.0,mTEPES.pDemand   [p,sc,n,nd]))
                    OptModel.set_variable_bounds(OptModel.vPloss         [new_tuple], 0.0,                           min(0.0,mTEPES.pDemand   [p,sc,n,nd])*-1) # 倒送时是负值， 1变正值和0比较
                    OptModel.set_variable_bounds(OptModel.vDRUp          [new_tuple], 0.0,                           0.0) # 关闭需求响 
                    OptModel.set_variable_bounds(OptModel.vDRDown        [new_tuple], 0.0,                           0.0) # 关闭需求响 


    # 根据参数设置二进制或连续变量

    if mTEPES.pIndBinGenInvest == 0:
        OptModel.vGenerationInvest = OptModel.add_variables(mTEPES.p, mTEPES.gc, domain=poi.VariableDomain.Continuous,lb = 0.0, ub = 1.0, name='generation investment decision exists in a year [0,1]')    
    else:
        OptModel.vGenerationInvest = OptModel.add_variables(mTEPES.p, mTEPES.gc, domain=poi.VariableDomain.Binary, name='generation investment decision exists in a year [0,1]')    
    if mTEPES.pIndBinGenRetire == 0:
        OptModel.vGenerationRetire = OptModel.add_variables(mTEPES.p, mTEPES.gd, domain=poi.VariableDomain.Continuous,lb = 0.0, ub = 1.0,  name='generation retirement decision exists in a year [0,1]')
    else:
        OptModel.vGenerationRetire = OptModel.add_variables(mTEPES.p, mTEPES.gd, domain=poi.VariableDomain.Binary,  name='generation retirement decision exists in a year [0,1]')
    if mTEPES.pIndBinNetInvest == 0:
        # OptModel.vNetworkInvest    = OptModel.add_variables(mTEPES.p, mTEPES.lc, domain=poi.VariableDomain.Continuous,lb = 0.0, ub = 1.0,  name='network    investment decision exists in a year [0,1]')
        OptModel.vNetworkInvest    = OptModel.add_variables(mTEPES.p, mTEPES.lc, domain=poi.VariableDomain.Binary,  name='network    investment decision exists in a year [0,1]')
    else:
        OptModel.vNetworkInvest    = OptModel.add_variables(mTEPES.p, mTEPES.lc, domain=poi.VariableDomain.Binary,  name='network    investment decision exists in a year [0,1]')
    
    if mTEPES.pIndBinGenOperat == 0:
        OptModel.vCommitment       = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.nr, domain=poi.VariableDomain.Continuous,lb = 0.0, ub = 1.0,  name='commitment of the unit                          [0,1]')
        OptModel.vStartUp          = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.nr, domain=poi.VariableDomain.Continuous,lb = 0.0, ub = 1.0,  name='startup    of the unit                          [0,1]')
        OptModel.vShutDown         = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.nr, domain=poi.VariableDomain.Continuous,lb = 0.0, ub = 1.0,  name='shutdown   of the unit                          [0,1]')
        for p in mTEPES.p:
            for sc in mTEPES.sc:
                for n in mTEPES.n:
                    for nr in mTEPES.nr:
                        OptModel.set_variable_attribute(OptModel.vCommitment  [p,sc,n,nr], poi.VariableAttribute.PrimalStart, 0) 
                        OptModel.set_variable_attribute(OptModel.vStartUp     [p,sc,n,nr], poi.VariableAttribute.PrimalStart, 0)
                        OptModel.set_variable_attribute(OptModel.vShutDown    [p,sc,n,nr], poi.VariableAttribute.PrimalStart, 0)
    else:
        OptModel.vCommitment       = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.nr, domain=poi.VariableDomain.Binary,  name='commitment of the unit                          [0,1]')
        OptModel.vStartUp          = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.nr, domain=poi.VariableDomain.Binary,  name='startup    of the unit                          [0,1]')
        OptModel.vShutDown         = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.nr, domain=poi.VariableDomain.Binary,  name='shutdown   of the unit                          [0,1]')
        for p in mTEPES.p:
            for sc in mTEPES.sc:
                for n in mTEPES.n:
                    for nr in mTEPES.nr:
                        OptModel.set_variable_attribute(OptModel.vCommitment  [p,sc,n,nr], poi.VariableAttribute.PrimalStart, 0) 
                        OptModel.set_variable_attribute(OptModel.vStartUp     [p,sc,n,nr], poi.VariableAttribute.PrimalStart, 0)
                        OptModel.set_variable_attribute(OptModel.vShutDown    [p,sc,n,nr], poi.VariableAttribute.PrimalStart, 0)
    
    if mTEPES.pIndBinLineCommit == 0:
        OptModel.vLineCommit       = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.la, domain=poi.VariableDomain.Continuous,lb = 0.0, ub = 1.0,  name='line switching      of the line                 [0,1]')
        OptModel.vLineOnState      = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.la, domain=poi.VariableDomain.Continuous,lb = 0.0, ub = 1.0,  name='switching on  state of the line                 [0,1]')
        OptModel.vLineOffState     = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.la, domain=poi.VariableDomain.Continuous,lb = 0.0, ub = 1.0,  name='switching off state of the line                 [0,1]')
        for p in mTEPES.p:
            for sc in mTEPES.sc:
                for n in mTEPES.n:
                    for la in mTEPES.la:
                        OptModel.set_variable_attribute(OptModel.vLineCommit    [add_to_tuple(p,sc,n,la)], poi.VariableAttribute.PrimalStart, 0) 
                        OptModel.set_variable_attribute(OptModel.vLineOnState   [add_to_tuple(p,sc,n,la)], poi.VariableAttribute.PrimalStart, 0)
                        OptModel.set_variable_attribute(OptModel.vLineOffState  [add_to_tuple(p,sc,n,la)], poi.VariableAttribute.PrimalStart, 0)
    else:
        OptModel.vLineCommit       = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.la, domain=poi.VariableDomain.Binary,  name='line switching      of the line                 [0,1]')
        OptModel.vLineOnState      = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.la, domain=poi.VariableDomain.Binary,  name='switching on  state of the line                 [0,1]')
        OptModel.vLineOffState     = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.la, domain=poi.VariableDomain.Binary,  name='switching off state of the line                 [0,1]')
        for p in mTEPES.p:
            for sc in mTEPES.sc:
                for n in mTEPES.n:
                    for la in mTEPES.la:
                        OptModel.set_variable_attribute(OptModel.vLineCommit    [add_to_tuple(p,sc,n,la)], poi.VariableAttribute.PrimalStart, 0) 
                        OptModel.set_variable_attribute(OptModel.vLineOnState   [add_to_tuple(p,sc,n,la)], poi.VariableAttribute.PrimalStart, 0)
                        OptModel.set_variable_attribute(OptModel.vLineOffState  [add_to_tuple(p,sc,n,la)], poi.VariableAttribute.PrimalStart, 0)
    for p in mTEPES.p:
        for gc in mTEPES.gc:
            new_tuple = add_to_tuple(p, gc)
            if mTEPES.pIndBinGenInvest != 0 and mTEPES.pIndBinUnitInvest[gc      ] == 0:
                OptModel.vGenerationInvest = OptModel.add_variables(mTEPES.p, mTEPES.gc, domain=poi.VariableDomain.Continuous, lb = 0.0, ub = 1.0, name='generation investment decision exists in a year [0,1]')        
            if mTEPES.pIndBinGenInvest == 2:
                OptModel.set_variable_bounds(OptModel.vGenerationInvest [new_tuple], 0.0,    0.0)
    for p in mTEPES.p:
        for ni,nf,cc in mTEPES.lc:
            new_tuple = add_to_tuple(p,ni,nf,cc)
            if mTEPES.pIndBinNetInvest != 0 and mTEPES.pIndBinLineInvest[ni,nf,cc] == 0:
                OptModel.vNetworkInvest    = OptModel.add_variables(mTEPES.p, mTEPES.lc, domain=poi.VariableDomain.Continuous, lb = 0.0, ub = 1.0, name='network    investment decision exists in a year [0,1]')
            if mTEPES.pIndBinNetInvest == 2:        
                OptModel.set_variable_bounds(OptModel.vNetworkInvest    [new_tuple], 0.0,    0.0)


    # relax binary condition in generation retirement decisions
    for p in mTEPES.p:
        for gd in mTEPES.gd:
            new_tuple = add_to_tuple(p, gd)
            if mTEPES.pIndBinGenRetire != 0 and mTEPES.pIndBinUnitRetire[gd      ] == 0: 
                OptModel.vGenerationRetire = OptModel.add_variables(mTEPES.p, mTEPES.gd, domain=poi.VariableDomain.Continuous, lb = 0.0, ub = 1.0, name='generation retirement decision exists in a year [0,1]')  
            if mTEPES.pIndBinGenRetire == 2:     
                OptModel.set_variable_bounds(OptModel.vGenerationRetire [new_tuple], 0.0,    0.0)

    # relax binary condition in unit generation, startup and shutdown decision
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for nr in mTEPES.nr:
                    new_tuple = add_to_tuple(p, sc, n, nr)
                    if mTEPES.pIndBinUnitCommit[nr] == 0:
                        OptModel.set_variable_bounds(OptModel.vCommitment   [new_tuple], 0.0,    1.0)
                        OptModel.set_variable_bounds(OptModel.vStartUp      [new_tuple], 0.0,    1.0)
                        OptModel.set_variable_bounds(OptModel.vShutDown     [new_tuple], 0.0,    1.0)
    # maximum value of time step commitment for mutually exclusive non-renewable generators
    OptModel.vMaxCommitment = OptModel.add_variables(mTEPES.nr, domain=poi.VariableDomain.Binary, name='maximum commitment of the unit {0,1}')

    # existing lines are always committed if no switching decision is modeled
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for ni,nf,cc in mTEPES.le:
                    new_tuple = add_to_tuple(ni,nf,cc)
                    if mTEPES.pIndBinLineSwitch[new_tuple] == 0:
                        new_tuple = add_to_tuple(p,sc,n,ni,nf,cc)
                        OptModel.set_variable_bounds(OptModel.vLineCommit   [new_tuple], 1.0,    1.0)
                        OptModel.set_variable_bounds(OptModel.vLineOnState  [new_tuple], 0.0,    0.0)
                        OptModel.set_variable_bounds(OptModel.vLineOffState [new_tuple], 0.0,    0.0)
    
    OptModel.vLineLosses = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.ll, domain=poi.VariableDomain.Continuous, name ='half line losses [GW]')
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for ll in mTEPES.ll:
                    new_tuple = add_to_tuple(p,sc,n,ll)
                    OptModel.set_variable_bounds(OptModel.vLineLosses [new_tuple], 0.0 , 0.5*mTEPES.pLineLossFactor[ll]*max(mTEPES.pLineNTCBck[ll],mTEPES.pLineNTCFrw[ll]))
    if mTEPES.pIndBinSingleNode == 0:
        OptModel.vFlow   = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.la, domain=poi.VariableDomain.Continuous, name='flow             [GW]')                                             
        for p in mTEPES.p:
            for sc in mTEPES.sc:
                for n in mTEPES.n:
                    for la in mTEPES.la:
                        new_tuple = add_to_tuple(p,sc,n,la)
                        OptModel.set_variable_bounds(OptModel.vFlow   [new_tuple], -mTEPES.pLineNTCBck[la] ,mTEPES.pLineNTCFrw[la])
    else:
        OptModel.vFlow   = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.la, domain=poi.VariableDomain.Continuous, name='flow             [GW]')
    OptModel.vTheta      = OptModel.add_variables(mTEPES.ps, mTEPES.n, mTEPES.nd, domain=poi.VariableDomain.Continuous, name='voltage angle   [rad]')
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for nd in mTEPES.nd:
                        new_tuple = add_to_tuple(p,sc,n,nd)    
                        OptModel.set_variable_bounds(OptModel.vTheta   [new_tuple], -mTEPES.pMaxTheta[new_tuple] ,mTEPES.pMaxTheta[new_tuple])                        

    # fix the must-run units and their output
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for g in mTEPES.g:
                    new_tuple = add_to_tuple(p,sc,n,g)
                    if mTEPES.pMustRun[g] == 1: 
                        print('----------must run---------------')
                        OptModel.set_variable_lb(OptModel.vTotalOutput      [new_tuple], mTEPES.pMinPower[new_tuple])
                    if mTEPES.pMaxPower[p,sc,n,g] == 0.0:
                        # print(p,sc,n,g,'----------no total output---------------')
                        OptModel.set_variable_bounds(OptModel.vTotalOutput  [new_tuple], 0.0 , 0.0) 

    
    # for p,sc,n,r  in mTEPES.ps*mTEPES.n*mTEPES.r :
    #    if mTEPES.pMinPower[p,sc,n,r] == mTEPES.pMaxPower[p,sc,n,r] and mTEPES.pLinearOMCost[r] == 0.0:
    #        OptModel.vTotalOutput[p,sc,n,r].fix(mTEPES.pMaxPower[p,sc,n,r])

    # for p,sc,n,nr in mTEPES.ps*mTEPES.n*mTEPES.nr:
    #     # must run units or units with no minimum power or ESS units are always committed and must produce at least their minimum output
    #     # not applicable to mutually exclusive units
    #     if (mTEPES.pMustRun[nr] == 1 or (mTEPES.pMinPower[p,sc,n,nr] == 0.0 and mTEPES.pConstantVarCost[nr] == 0.0) or nr in mTEPES.es) and sum(1 for g in mTEPES.nr if (nr,g) in mTEPES.g2g or (g,nr) in mTEPES.g2g) == 0:
    #         OptModel.vCommitment    [p,sc,n,nr].fix(1)
    #         OptModel.vStartUp       [p,sc,n,nr].fix(0)
    #         OptModel.vShutDown      [p,sc,n,nr].fix(0)
    #     # if min and max power coincide there are neither second block, nor operating reserve
    #     if  mTEPES.pMaxPower2ndBlock[p,sc,n,nr] ==  0.0:
    #         print('储能不能放电', nr)
    #         OptModel.vOutput2ndBlock[p,sc,n,nr].fix(0.0)
    #         OptModel.vReserveUp     [p,sc,n,nr].fix(0.0)
    #         OptModel.vReserveDown   [p,sc,n,nr].fix(0.0)
    #     if  mTEPES.pIndOperReserve  [       nr] !=  0.0:
    #         OptModel.vReserveUp     [p,sc,n,nr].fix(0.0)
    #         OptModel.vReserveDown   [p,sc,n,nr].fix(0.0)
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for nr in mTEPES.nr:
                        new_tuple = add_to_tuple(p,sc,n,nr)
                        if (mTEPES.pMustRun[nr] == 1 or (mTEPES.pMinPower[p,sc,n,nr] == 0.0 and mTEPES.pConstantVarCost[nr] == 0.0) or nr in mTEPES.es) and sum(1 for g in mTEPES.nr if (nr,g) in mTEPES.g2g or (g,nr) in mTEPES.g2g) == 0:
                            OptModel.set_variable_bounds(OptModel.vCommitment    [new_tuple], 1.0, 1.0)
                            OptModel.set_variable_bounds(OptModel.vStartUp       [new_tuple], 0.0, 0.0)
                            OptModel.set_variable_bounds(OptModel.vShutDown      [new_tuple], 0.0, 0.0)
                        # if min and max power coincide there are neither second block, nor operating reserve
                        if  mTEPES.pMaxPower2ndBlock[p,sc,n,nr] ==  0.0:
                            print('储能不能放电', nr)
                            OptModel.set_variable_bounds(OptModel.vOutput2ndBlock[new_tuple], 0.0, 0.0)
                            OptModel.set_variable_bounds(OptModel.vReserveUp     [new_tuple], 0.0, 0.0)
                            OptModel.set_variable_bounds(OptModel.vReserveDown   [new_tuple], 0.0, 0.0)
                        if  mTEPES.pIndOperReserve  [       nr] !=  0.0:
                            OptModel.set_variable_bounds(OptModel.vReserveUp     [new_tuple], 0.0, 0.0)
                            OptModel.set_variable_bounds(OptModel.vReserveDown   [new_tuple], 0.0, 0.0)

    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for es in mTEPES.es:
                    new_tuple = add_to_tuple(p,sc,n,es)
                    if mTEPES.pMaxCharge        [new_tuple] ==  0.0:
                        OptModel.set_variable_bounds(OptModel.vESSTotalCharge[new_tuple], 0.0, 0.0)
                    if mTEPES.pMaxCharge2ndBlock[new_tuple] ==  0.0:
                        OptModel.set_variable_bounds(OptModel.vCharge2ndBlock[new_tuple], 0.0, 0.0)
                        OptModel.set_variable_bounds(OptModel.vESSReserveUp  [new_tuple], 0.0, 0.0)
                        OptModel.set_variable_bounds(OptModel.vESSReserveDown[new_tuple], 0.0, 0.0)
                    if  mTEPES.pIndOperReserve  [       es] !=  0.0:
                        OptModel.set_variable_bounds(OptModel.vESSReserveUp  [new_tuple], 0.0, 0.0)
                        OptModel.set_variable_bounds(OptModel.vESSReserveDown[new_tuple], 0.0, 0.0)
                    if mTEPES.pMaxStorage       [new_tuple] ==  0.0:
                        OptModel.set_variable_bounds(OptModel.vESSInventory  [new_tuple], 0.0, 0.0)

    # thermal and RES units ordered by increasing variable operation cost, excluding reactive generating units
    if len(mTEPES.tq):
        mTEPES.go = [k for k in sorted(mTEPES.pLinearVarCost, key=mTEPES.pLinearVarCost.__getitem__) if k not in mTEPES.gq]
    else:
        mTEPES.go = [k for k in sorted(mTEPES.pLinearVarCost, key=mTEPES.pLinearVarCost.__getitem__)                      ]

    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for es in mTEPES.es:
                    new_tuple = add_to_tuple(p,sc,n,es)
                    if mTEPES.pMaxPower[new_tuple] == 0.0:
                        OptModel.set_variable_bounds(OptModel.vEnergyOutflows[new_tuple], mTEPES.pEnergyOutflows[new_tuple], mTEPES.pEnergyOutflows[new_tuple])

    
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for st in mTEPES.stt:
                # activate only period, scenario, and load levels to formulate
                mTEPES.st = [stt for stt in mTEPES.stt               if st == stt and mTEPES.pStageWeight[stt] and sum(1 for (st,nn) in mTEPES.s2n)]
                mTEPES.n  = [nn  for nn  in mTEPES.pDuration         if (st,nn) in mTEPES.s2n]

                if len(mTEPES.n):
                    # determine the first load level of each stage
                    n1 = add_to_tuple(p,sc,n)
                    # commit the units and their output at the first load level of each stage
                    pSystemOutput = 0.0
                    for nr in mTEPES.nr:
                        if pSystemOutput < sum(mTEPES.pDemand[add_to_tuple(n1,nd)] for nd in mTEPES.nd) and mTEPES.pMustRun[nr] == 1:
                            mTEPES.pInitialOutput[add_to_tuple(n1,nr)] = mTEPES.pMaxPower[add_to_tuple(n1,nr)]
                            mTEPES.pInitialUC    [add_to_tuple(n1,nr)] = 1
                            pSystemOutput               += mTEPES.pInitialOutput[add_to_tuple(n1,nr)]

                    # determine the initial committed units and their output at the first load level of each period, scenario, and stage
                    for go in mTEPES.go:
                        if pSystemOutput < sum(mTEPES.pDemand[add_to_tuple(n1,nd)] for nd in mTEPES.nd) and mTEPES.pMustRun[go] != 1:
                            if go in mTEPES.r:
                                mTEPES.pInitialOutput[add_to_tuple(n1,go)] = mTEPES.pMaxPower[add_to_tuple(n1,go)]
                            else:
                                mTEPES.pInitialOutput[add_to_tuple(n1,go)] = mTEPES.pMinPower[add_to_tuple(n1,go)]
                            mTEPES.pInitialUC[add_to_tuple(n1,go)] = 1
                            pSystemOutput = pSystemOutput + mTEPES.pInitialOutput[add_to_tuple(n1,go)]

                    # determine the initial committed lines
                    for la in mTEPES.la:
                        if la in mTEPES.lc:
                            mTEPES.pInitialSwitch[add_to_tuple(n1,la)] = 0
                        else:
                            mTEPES.pInitialSwitch[add_to_tuple(n1,la)] = 1

                    # fixing the ESS inventory at the last load level for every period and scenario
                    # for p in mTEPES.p:
                    #     for sc in mTEPES.sc:
                    #         for n in mTEPES.n:
                    #             for es in mTEPES.es:
                    #                 new_tuple = add_to_tuple(p,sc,n,es)
                    #                 OptModel.set_variable_bounds(OptModel.vESSInventory[new_tuple], mTEPES.pInitialInventory[es], mTEPES.pInitialInventory[es])
                    for p in mTEPES.p:
                        for sc in mTEPES.sc:
                            for es in mTEPES.es:
                                new_tuple = add_to_tuple(p,sc,n,es)
                                if n == mTEPES.n[-1]:
                                    OptModel.set_variable_bounds(OptModel.vESSInventory[new_tuple], mTEPES.pInitialInventory[es], mTEPES.pInitialInventory[es]) # 初始容量就是最小规划容 

    # activate all the periods, scenarios, and load levels again
    mTEPES.st = [stt for stt in  mTEPES.stt if mTEPES.pStageWeight[stt] and sum(1 for (stt,nn) in mTEPES.s2n)]
    mTEPES.n  = [nn  for nn  in  mTEPES.pDuration]

    # 储能周期性约 
    # fixing the ESS inventory at the end of the following pCycleTimeStep (daily, weekly, monthly), i.e., for daily ESS is fixed at the end of the week, for weekly/monthly ESS is fixed at the end of the year
    # if no operating reserve is required no variables are needed

    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for ar in mTEPES.ar:
                    for nr in mTEPES.nr:
                        if (ar,nr) in mTEPES.a2g:
                            new_tuple = add_to_tuple(p,sc,n,nr)
                            if mTEPES.pOperReserveUp    [p,sc,n,ar] ==  0.0:
                                OptModel.set_variable_bounds(OptModel.vReserveUp     [new_tuple], 0.0, 0.0)
                            if mTEPES.pOperReserveDw    [p,sc,n,ar] ==  0.0:
                                OptModel.set_variable_bounds(OptModel.vReserveDown   [new_tuple], 0.0, 0.0)
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for ar in mTEPES.ar:
                    for es in mTEPES.es:
                        if (ar,es) in mTEPES.a2g:
                            new_tuple = add_to_tuple(p,sc,n,es)
                            if mTEPES.pOperReserveUp    [p,sc,n,ar] ==  0.0:
                                OptModel.set_variable_bounds(OptModel.vReserveUp     [new_tuple], 0.0, 0.0)
                            if mTEPES.pOperReserveDw    [p,sc,n,ar] ==  0.0:
                                OptModel.set_variable_bounds(OptModel.vReserveDown   [new_tuple], 0.0, 0.0)
                        

    # if there are no energy outflows no variable is needed
    for es in mTEPES.es:
        if sum(mTEPES.pEnergyOutflows[p,sc,n,es] for p in mTEPES.p for sc in mTEPES.sc  for n in mTEPES.n) == 0:
                for p in mTEPES.p:
                    for sc in mTEPES.sc:
                        for n in mTEPES.n:
                            new_tuple = add_to_tuple(p,sc,n,es)
                            OptModel.set_variable_bounds(OptModel.vEnergyOutflows   [new_tuple], 0.0, 0.0)

    # fixing the voltage angle of the reference node for each scenario, period, and load level
    if mTEPES.pIndBinSingleNode == 0:
        for p in mTEPES.p:
            for sc in mTEPES.sc:
                for n in mTEPES.n:
                    new_tuple = add_to_tuple(p,sc,n)
                    OptModel.set_variable_bounds(OptModel.vTheta                    [add_to_tuple(new_tuple,mTEPES.rf[0])], 0.0, 0.0)
    # fixing the ENS in nodes with no demand
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for nd in mTEPES.nd:
                    new_tuple = add_to_tuple(p,sc,n,nd)
                    if mTEPES.pDemand[new_tuple] == 0.0:
                        OptModel.set_variable_bounds(OptModel.vENS                  [new_tuple], 0.0, 0.0)
    # do not install/retire power plants and lines if not allowed in this period
    for p in mTEPES.p:
        for gc in mTEPES.gc:
            new_tuple = add_to_tuple(p,gc)
            if mTEPES.pPeriodIniGen[gc] > p or mTEPES.pPeriodFinGen[gc] < p:
                OptModel.set_variable_bounds(OptModel.vGenerationInvest             [new_tuple], 0.0, 0.0)
    for p in mTEPES.p:
        for gd in mTEPES.gd:
            new_tuple = add_to_tuple(p,gd)
            if mTEPES.pPeriodIniGen[gd] > p or mTEPES.pPeriodFinGen[gd] < p:
                OptModel.set_variable_bounds(OptModel.vGenerationRetire             [new_tuple], 0.0, 0.0)
    for p in mTEPES.p:
        for ni,nf,cc in mTEPES.lc:
            new_tuple = add_to_tuple(p,ni,nf,cc)
            if mTEPES.pPeriodIniNet[ni,nf,cc] > p or mTEPES.pPeriodFinNet[ni,nf,cc] < p:
                OptModel.set_variable_bounds(OptModel.vNetworkInvest                [new_tuple], 0.0, 0.0)

    # remove power plants and lines not installed in this period
    for p in mTEPES.p:
        for g in mTEPES.g:
            if g  not in mTEPES.gc and (mTEPES.pPeriodIniGen[g ] > p or mTEPES.pPeriodFinGen[g ] < p):
                for sc in mTEPES.sc:
                    for n in mTEPES.n:
                        new_tuple = add_to_tuple(p,sc,n,g)
                        OptModel.set_variable_bounds(OptModel.vTotalOutput         [new_tuple], 0.0, 0.0)

    for p in mTEPES.p:
        for nr in mTEPES.nr:
            if nr not in mTEPES.gc and (mTEPES.pPeriodIniGen[nr] > p or mTEPES.pPeriodFinGen[nr] < p):
                OptModel.set_variable_bounds(OptModel.vMaxCommitment[nr], 0.0, 0.0)
                for sc in mTEPES.sc:
                    for n in mTEPES.n:
                        new_tuple = add_to_tuple(p,sc,n,nr)
                        OptModel.set_variable_bounds(OptModel.vOutput2ndBlock      [new_tuple], 0.0, 0.0)
                        OptModel.set_variable_bounds(OptModel.vReserveUp           [new_tuple], 0.0, 0.0)
                        OptModel.set_variable_bounds(OptModel.vReserveDown         [new_tuple], 0.0, 0.0)
                        OptModel.set_variable_bounds(OptModel.vCommitment          [new_tuple], 0  , 0  )
                        OptModel.set_variable_bounds(OptModel.vStartUp             [new_tuple], 0  , 0  )
                        OptModel.set_variable_bounds(OptModel.vShutDown            [new_tuple], 0  , 0  )
    for p in mTEPES.p:
        for es in mTEPES.es:
            if es not in mTEPES.gc and (mTEPES.pPeriodIniGen[es] > p or mTEPES.pPeriodFinGen[es] < p):
                for sc in mTEPES.sc:
                    for n in mTEPES.n:
                        new_tuple = add_to_tuple(p,sc,n,es)
                        OptModel.set_variable_bounds(OptModel.vEnergyOutflows      [new_tuple], 0.0, 0.0)
                        print('储能不能溢出')
                        OptModel.set_variable_bounds(OptModel.vEnergyOutflows      [new_tuple], 0.0, 0.0)
                        OptModel.set_variable_bounds(OptModel.vESSInventory        [new_tuple], 0.0, 0.0)
                        OptModel.set_variable_bounds(OptModel.vESSSpillage         [new_tuple], 0.0, 0.0)
                        OptModel.set_variable_bounds(OptModel.vESSTotalCharge      [new_tuple], 0.0, 0.0)
                        OptModel.set_variable_bounds(OptModel.vCharge2ndBlock      [new_tuple], 0.0, 0.0)
                        OptModel.set_variable_bounds(OptModel.vESSReserveUp        [new_tuple], 0.0, 0.0)
                        OptModel.set_variable_bounds(OptModel.vESSReserveDown      [new_tuple], 0.0, 0.0)
                        mTEPES.pIniInventory    [new_tuple] = 0.0
                        mTEPES.pEnergyInflows   [new_tuple] = 0.0
                

    for p in mTEPES.p:
        for ni,nf,cc in mTEPES.la:
            if (ni,nf,cc) not in mTEPES.lc and (mTEPES.pPeriodIniNet[ni,nf,cc] > p or mTEPES.pPeriodFinNet[ni,nf,cc] < p):
                for sc in mTEPES.sc:
                    for n in mTEPES.n:
                        new_tuple = add_to_tuple(p,sc,n,ni,nf,cc) 
                        OptModel.set_variable_bounds(OptModel.vFlow                [new_tuple], 0.0, 0.0)
                        OptModel.set_variable_bounds(OptModel.vLineCommit          [new_tuple], 0  , 0  )
                        OptModel.set_variable_bounds(OptModel.vLineOnState         [new_tuple], 0  , 0  )
                        OptModel.set_variable_bounds(OptModel.vLineOffState        [new_tuple], 0  , 0  )
    for p in mTEPES.p:
        for ni,nf,cc in mTEPES.ll:
            if (ni,nf,cc) not in mTEPES.lc and (mTEPES.pPeriodIniNet[ni,nf,cc] > p or mTEPES.pPeriodFinNet[ni,nf,cc] < p):
                for sc in mTEPES.sc:
                    for n in mTEPES.n:
                        new_tuple = add_to_tuple(p,sc,n,ni,nf,cc) 
                        OptModel.set_variable_bounds(OptModel.vLineLosses          [new_tuple], 0.0, 0.0)

    # detecting infeasibility: sum of scenario probabilities must be 1 in each period
    # for p in mTEPES.p:
    #     if abs(sum(mTEPES.pScenProb[p,sc] for sc in mTEPES.sc)-1.0) > 1e-6:
    #         print('### Sum of scenario probabilities different fr5om 1 in period ', p)
    #         assert (0==1)

    # detecting infeasibility: total min ESS output greater than total inflows, total max ESS charge lower than total outflows
    
    for es in mTEPES.es:
        if sum(mTEPES.pMinPower [p,sc,n,es]-mTEPES.pEnergyInflows [p,sc,n,es] for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n) > 0.0:
            print('### Total minimum output greater than total inflows  for ESS unit ', es)
            assert (0==1)
        if sum(mTEPES.pMaxCharge[p,sc,n,es]-mTEPES.pEnergyOutflows[p,sc,n,es] for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n) < 0.0:
            print('### Total maximum charge greater than total outflows for ESS unit ', es)
            assert (0==1)

    SettingUpVariablesTime = time.time() - StartTime
    print('Setting up variables                   ... ', round(SettingUpVariablesTime), 's')


def EVplan_inputdata(DirName, CaseName, model, pIndLogConsole):
    print('Input EV PLAN data                     ****')  # 打印控制台信息：开始输入EV规划数据
    _path = _resolve_config_dir()               # 输入 CSV 位于项目 config/
    StartTime = time.time()                               # 记录当前时间用于后续计算运行耗时
    
    #%% reading data from CSV
    # ==========================================
    # 1. 基础参数与数据读 (Data Input & Parameters)
    # ==========================================
    # 读取电动汽车负荷数据特征 (8760小时)
    model.df_EV = pd.read_csv(_path+'/oT_Data_EV_'                +CaseName+'.csv') # 利用pandas读取储存在对应路径下的EV负荷CSV文件数据，存入model.df_EV
    # 时间步数与映 
    model.T = model.df_EV['LoadLevel'].values             # 使用 LoadLevel 的数组替代整 T
    model.T_len = len(model.df_EV)                        # 将长度存 T_len
    # 参数设定
    model.E_BATT_MAX            = 50.0                    # 设定单辆电动汽车的最大电池容量为 50.0 kWh
    model.P_CHR_MAX             = 60.0                    # 设定单个充电桩的最大充/放电功率限制 60.0 kW
    model.MAX_STATION_DISCHARGE = 120.0                   # 设定整个充电站向电网反向放电（V2G）的最大功率容量为 120.0 kW（防止过载）
    model.ENABLE_V2G            = 1                       # V2G功能使能标志位（0代表关闭该功能，1代表开启该功能 
    model.EFF_CHR               = 0.95                    # 设定电动汽车充电过程的能量转换效率为 0.95
    model.EFF_DIS               = 0.95                    # 设定电动汽车放电过程（包含逆变等）的能量转换效率为 0.95
    model.C_INV_PILE            = 2000.0                  # 设定新增建设单个充电桩的综合投资折算费用 2000.0  
    model.P_ELEC                = 0.6                     # 设定默认/基础基准电价 0.6  kWh（在此段未真正使用，被下面分时电价覆盖）
    model.C_PENALTY             = 10000.0                 # 设定未满足能量需求等条件的过高惩罚因 价格（在此基础版本暂无显现 
    
    model.arrivals    = model.df_EV['arrivals'].values    # 将每个时段到达充电站的EV数量数组提取 model.arrivals
    model.visit_time  = model.df_EV['visit_time'].values.astype(int) # 将每批次EV打算停留的小时数转化为整型数组提 
    model.initial_soc = model.df_EV['initial_soc'].values / 100.0    # 提取初始State of Charge(SOC)百分比并化作小数(0-1)区间
    model.target_soc  = model.df_EV['target_soc'].values / 100.0     # 提取车主期望达到的目标SOC并化作小 0-1)区间
    model.ev_node     = model.df_EV['node'].unique()          # 提取当前数据集中所有独立出现的接入节点编号
    
    # 构造简单的分时电价 (TOU Pricing)
    base_price_profile = np.zeros(24)                     # 初始化长度为24的一维全零数组，表示一 4小时的基础电价
    for h in range(24):                                   # 遍历0 3小时
        if h < 8:                                         # 0点到上午8点之前为谷电时期
            base_price_profile[h] = 0.3                   # 谷电电价设为 0.3  kWh
        elif (8 <= h < 14) or (17 <= h < 20):             # 覆盖早上到中午以及傍晚的部分为平段时 
            base_price_profile[h] = 0.6                   # 平电电价设为 0.6  kWh
        else:                                             # 其余时间（如下午及晚高峰 
            base_price_profile[h] = 1.2                   # 峰电电价设为 1.2  kWh
            
    model.P_ELEC_CHR = np.tile(base_price_profile, model.T_len // 24) # 平铺上述24小时电价，使其覆盖全年的 model.T_len 时长（充电买电成本）
    model.P_ELEC_DIS = np.where(model.P_ELEC_CHR >= 1.0, 1.5, 0.4) # 根据充电电价动态生成V2G放电价格（卖电收益）：尖峰时段奖励高买价1.5，其他低买价0.4
    
    model.demand_energy_per_ev = np.maximum(0, (model.target_soc - model.initial_soc) * model.E_BATT_MAX) # 计算单车在此次驻留中亟需充入的合法能量偏差（确保不为负）
    model.target_energy_per_cohort = model.arrivals * model.target_soc * model.E_BATT_MAX     # 计算该时段到达的所有EV构成 群组(cohort)"需要的总目标绝对能 
    model.initial_energy_per_cohort = model.arrivals * model.initial_soc * model.E_BATT_MAX   # 计算该群组初始携带的绝对系统能量本底
    
    model.naive_demand_curve = (model.target_energy_per_cohort - model.initial_energy_per_cohort) / model.EFF_CHR # 在无调度情况下如果一到达就必须充满所需的理想硬需求曲 
    
    # ==========================================
    # 定义决策变量 (Decision Variables)
    # ==========================================
    model.N_pile = model.add_variable(domain=poi.VariableDomain.Integer, lb=0, name="N_pile") # 在PyOptInterface中增加非负整数变 N_pile：代表需新建的最优充电桩数量
    
    model.P_chr = {}                                      # 初始化用于存放每一批次每一时刻充电功率变量的字 
    model.P_dis = {}                                      # 初始化用于存放每一批次每一时刻放电功率变量的字 
    model.E_cohort = {}                                   # 初始化用于存放每一批次群体跨时段能量追踪状 SoE)变量的字 
    import collections
    model.grid_p_chr_vars = collections.defaultdict(list) # 用于聚合同一时刻(p,sc,n)电网承担的所有充电功率变量集 
    model.grid_p_dis_vars = collections.defaultdict(list) # 用于聚合同一时刻所有放电功率变量集 
    
    # 构建元组映射列表
    model.idx_tuples = list(zip(model.df_EV['Period'].values, model.df_EV['Scenario'].values, model.df_EV['LoadLevel'].values))
    
    for t in range(model.T_len):                          # 遍历系统模拟的每一小时 t （也是一批EV到达的起始时刻）
        V_t = model.visit_time[t]                         # 提取 t 时刻到达群体的可停泊时长
        if V_t == 0 or model.arrivals[t] == 0:            # 如果驻留时间 或到达数量为0，则这批车对系统无直接交换作 
            continue                                      # 跳过本次循环，不建立对应决策变量
        
        for k in range(t, min(model.T_len, t + V_t)):     # 变量分配阶段：在 t 到达后驻留的时间窗内，按绝对时间轴索 k 执行
            k_tuple = model.idx_tuples[k]                 # 获取当前时刻对应 (p, sc, n) 元组
            k_lvl = k_tuple[2]                            # 取得 LoadLevel 字符 
            p_c = model.add_variable(domain=poi.VariableDomain.Continuous, lb=0, name=f"P_EV_{t}_{k_lvl}_chr") # 添加t批次在第k小时的连续非负充电功率变 
            model.P_chr[t, k] = p_c                       # 将变量存入字典以便模型计算时索引调用
            model.grid_p_chr_vars[k_tuple].append(p_c)    # 将这批车在第k小时的充电功率归拢到 p, sc, n)元组 
            
            p_d = model.add_variable(domain=poi.VariableDomain.Continuous, lb=0, name=f"P_EV_{t}_{k_lvl}_dis") # 添加对应的非负放电功率变 
            model.P_dis[t, k] = p_d                       # 保存放电功率变量引用
            model.grid_p_dis_vars[k_tuple].append(p_d)    # 加入第k小时全局电网放电列表 
            
            # 个体硬件极限
            model.add_linear_constraint(p_c <= model.arrivals[t] * model.P_CHR_MAX, name=f"MaxCharge_{t}_{k_lvl}") # 约束该批汽车的集群充电功率不得越过这批车总的物理充电器功率顶
            model.add_linear_constraint(p_d <= model.arrivals[t] * model.P_CHR_MAX * model.ENABLE_V2G, name=f"MaxDischarge_{t}_{k_lvl}") # 放电类似限制
            
        for k in range(t, min(model.T_len, t + V_t) + 1): # 增加一个离散时间点追踪储能转移
            k_lvl = model.idx_tuples[k][2] if k < model.T_len else "end"
            e_var = model.add_variable(domain=poi.VariableDomain.Continuous, 
                                       lb=0, ub=model.arrivals[t] * model.E_BATT_MAX, 
                                       name=f"E_{t}_{k_lvl}")
            model.E_cohort[t, k] = e_var                  # 存入对应字典

def inputdata_ammonia(model, DirName, CaseName):
    """准备输入数据与模型参数，将结果存入 model.params_ammonia 并返回。"""
    import pandas as pd
    import os
    _path = _resolve_config_dir()
    df_demand = pd.read_csv(_path + '/oT_Data_Demand_' + CaseName + '.csv')
    T = df_demand['LoadLevel'].tolist()

    params = {
        'T': T,
        'price_grid': 0.3, # 无穷大电源电价设 
        # costs (年化或单位成本，示例 
        'cost_elec': 4000 * 0.1,
        'cost_nh3': 5000 * 0.1,
        # revenues
        'price_h2': 20.0,
        'price_nh3': 4.0,
        # process rates and min loads
        'rate_h2_prod': 0.0188,
        'min_elec_load': 0.057,
        'rate_nh3_h2_in': 0.33,
        'rate_nh3_prod': 1.84,
        'min_nh3_load': 0.30,
        # other
        'constant_load': 0.0,
        'max_annual_cost': 10000000.0,
        'eh_node': 'Node2'
    }

    print('已生成氨模型输入数据')
    model.params_ammonia = params
    
    # 将模型参数导出到 output/oT_Data_H2AnParameter_{CaseName}.csv
    param_records = [{'Parameter': k, 'Value': v} for k, v in params.items() if k != 'T']
    df_params = pd.DataFrame(param_records)
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'output')
    os.makedirs(out_dir, exist_ok=True)
    df_params.to_csv(os.path.join(out_dir, f'oT_Data_H2AnParameter_{CaseName}.csv'), index=False)
    print(f'已提取并保存制氢制氨参数到 oT_Data_H2AnParameter_{CaseName}.csv')
    
    return params      

# ==================== 热系统输入数据函数 ====================
def ThermalInputData_poi(DirName, CaseName, mTEPES, pIndLogConsole):
    """
    读取热系统规划参数
    
    Args:
        DirName: 数据目录
        CaseName: 算例名称
        mTEPES: 模型对象
        pIndLogConsole: 是否输出日志
    """
    print('\n热系统数据读取                        ****')
    StartTime = time.time()
    
    _path = _resolve_config_dir()

    mTEPES.ht_node = ['Node2']
    
    # 读取热负荷数据（格式与电负荷一致：Period/Scenario/LoadLevel 为索引，Node 列为负荷）
    thermal_demand_file = _path + '/oT_Data_ThermalDemand_' + CaseName + '.csv'
    if os.path.exists(thermal_demand_file):
        dfThermalDemand = pd.read_csv(thermal_demand_file, index_col=[0,1,2])
        # 提取第一个节点的热负荷数据作为系统热负荷
        if 'Node1' in dfThermalDemand.columns:
            mTEPES.pThermalDemand = dfThermalDemand['Node1'].values
        else:
            mTEPES.pThermalDemand = dfThermalDemand.iloc[:, 0].values
        
        mTEPES.dfThermalDemand = dfThermalDemand
        
        if pIndLogConsole == 1:
            print(f'  热负荷数据格式: {dfThermalDemand.shape}')
            print(f'  节点列: {list(dfThermalDemand.columns)}')
    else:
        print(f'[警告] 热负荷文件不存在: {thermal_demand_file}')
        n_timesteps = len(list(mTEPES.n))
        mTEPES.pThermalDemand = np.zeros(n_timesteps)
        print(f'[警告] 使用默认热负荷（全零），请提供实际热负荷数据')
    
    # 读取热系统参数
    thermal_param_file = _path + '/oT_Data_ThermalParameter_' + CaseName + '.csv'
    if os.path.exists(thermal_param_file):
        dfThermalParam = pd.read_csv(thermal_param_file, index_col=[0])
        mTEPES.pThermalParams = dfThermalParam['Value'].to_dict()
    else:
        print(f'[警告] 热系统参数文件不存在: {thermal_param_file}，使用默认参数')
        mTEPES.pThermalParams = _get_default_thermal_parameters()
    
    # 容量单位（MW）
    mTEPES.pThermalCapacityUnit = 0.01  # 0.01 MW = 10 kW
    
    LoadingTime = time.time() - StartTime
    if pIndLogConsole == 1:
        print(f'热系统数据读取完成                    ... {LoadingTime:.2f} s')
        if len(mTEPES.pThermalDemand) > 0:
            print(f'  热负荷时间步数: {len(mTEPES.pThermalDemand)}')
            print(f'  热负荷: 最小={mTEPES.pThermalDemand.min():.2f} MW, 最大={mTEPES.pThermalDemand.max():.2f} MW')

    # 读取制冷负荷 CSV
    chiller_demand_file = _path + '/oT_Data_ChillerDemand_' + CaseName + '.csv'
    if os.path.exists(chiller_demand_file):
        dfChillerDemand = pd.read_csv(chiller_demand_file, index_col=[0,1,2])
        if 'Node1' in dfChillerDemand.columns:
            mTEPES.pChillerDemand = dfChillerDemand['Node1'].values
        else:
            mTEPES.pChillerDemand = dfChillerDemand.iloc[:, 0].values
        mTEPES.dfChillerDemand = dfChillerDemand
        if pIndLogConsole == 1:
            print(f'  制冷负荷: 最大={mTEPES.pChillerDemand.max():.2f} kW, 非零时刻数={np.sum(mTEPES.pChillerDemand > 0)}')
    else:
        print(f'[警告] 制冷负荷文件不存在: {chiller_demand_file}，制冷需求设为零')
        mTEPES.pChillerDemand = np.zeros(len(mTEPES.pThermalDemand))


def _get_default_thermal_parameters():
    """获取默认热系统参数"""
    return {
        # CHP参数
        'enable_chp_planning': 1,
        'chp_capacity_min': 0,
        'chp_capacity_max': 200000,
        'chp_unit_cost': 3750,
        'chp_heat_to_power_ratio': 0.91,
        'chp_elec_efficiency': 0.45,
        'chp_heat_efficiency': 0.41,
        'gas_price': 0.12,
        # GT（燃气轮机）参数
        'enable_gt_planning': 1,
        'gt_capacity_min': 0,
        'gt_capacity_max': 326000,
        'gt_unit_cost': 2905,
        'gt_fixed_cost': 0,
        'gt_opex': 0.014,
        'gt_startup_cost': 0.07,
        'gt_elec_efficiency': 0.404,
        'gt_heat_efficiency': 0.534,
        'gt_ramp_rate': 3,
        'gt_lifetime_h': 200000,
        # ST（蒸汽轮机）参数 - 消耗GT余热蒸汽发电
        'enable_st_planning': 1,
        'st_capacity_min': 0,
        'st_capacity_max': 5000,
        'st_unit_cost': 7000,
        'st_fixed_cost': 0,
        'st_opex': 0.007,
        'st_elec_efficiency': 0.30,
        'st_ramp_rate': 0.05,
        'st_lifetime_h': 175200,
        # 锅炉参数
        'boiler_efficiency': 0.99,
        'boiler_capacity_min': 0,
        'boiler_capacity_max': 150000,
        'boiler_unit_cost': 0,
        'boiler_fixed_cost': 0,
        # 热泵参数
        'hp_capacity_min': 0,
        'hp_capacity_max': 150000,
        'hp_unit_cost': 1000,
        'hp_fixed_cost': 0,
        'hp_cop': 2.43,
        # 储热罐参数
        'storage_capacity_min': 0,
        'storage_capacity_max': 300000,
        'storage_unit_cost': 204.2,
        'storage_fixed_cost': 0,
        'storage_init_ratio': 0.3,
        'storage_charge_rate': 0.5,
        'storage_discharge_rate': 0.5,
        'storage_eta_charge': 0.98,
        'storage_eta_discharge': 0.98,
        'storage_loss_rate': 0.02,
        'storage_penalty': 0.001,
        # 经济参数
        'investment_years': 10,
        'discount_rate': 0.08,
        # 区域供热
        'district_q_max': 200000,
        'district_heat_price': 0.3,
        # 吸收式制冷机参数
        'enable_chiller_planning': 1,          # 是否启用制冷机规划
        'chiller_capacity_min': 0,             # 制冷机容量下限 [kW]
        'chiller_capacity_max': 200000,        # 制冷机容量上限 [kW]
        'chiller_unit_cost': 800,              # 单位容量投资成本 [元/kW]
        'chiller_fixed_cost': 0,               # 固定投资成本 [元]
        'chiller_eta_min': 0.65,               # 最小环境温度下的制冷效率 (COP)
        'chiller_eta_max': 0.80,               # 最大环境温度下的制冷效率 (COP)
        'chiller_T_min': 10.0,                 # 最小有效环境温度 [°C]
        'chiller_T_max': 40.0,                 # 最大有效环境温度 [°C]
        'chiller_T_design': 30.0,              # 设计环境温度 [°C]（用于线性化预计算效率）
        # 压缩式制冷机参数 (Compression Chiller)
        'enable_comp_chiller_planning': 1,       # 是否启用压缩式制冷机规划
        'comp_chiller_capacity_min': 0,          # 容量下限 [kW的]
        'comp_chiller_capacity_max': 200000,     # 容量上限 [kW的]
        'comp_chiller_unit_cost': 600,           # 单位容量投资成本 [元/kW的]
        'comp_chiller_fixed_cost': 0,            # 固定投资成本 [元]
        'comp_chiller_cop': 2.7,                 # COP: 185 kW电入 -> 500 kW制冷输出
        'comp_chiller_load_min': 0.2,            # 最小负荷比例
        'comp_chiller_load_max': 1.0,            # 最大负荷比例
    }


def DC_inputdata(DirName, CaseName, mTEPES, pIndLogConsole):
    """
    数据中心(EHCCS)数据输入入口。

    根据 `数据中心/EHCCS复现参数变量约束梳理.md` 的“参数/变量/约束”结构，
    加载数据中心工作负载输入：
    - 从 `oT_Data_DCWorkload_{CaseName}.csv` 读取每个时刻的交互式/批处理任务量
    - 与 openTEPES 的 LoadLevel（mTEPES.nn）按 `LoadLevel` 字符串对齐
    """
    _path = _resolve_config_dir()

    # 占位：用 dict 保存数据中心相关输入，避免后续属性缺失
    if not hasattr(mTEPES, "pDC"):
        mTEPES.pDC = {}

    # 记录基本路径，便于输出/调试
    mTEPES.pDC["path"] = _path
    mTEPES.pDC["enabled"] = 1

    # ========= 基本索引 =========
    # 当前用 openTEPES 的时间步（LoadLevel）作为 DC 的时序索引
    # DC_inputdata 被调用时，mTEPES.n 往往尚未激活，优先使用全局 nn
    n_list = list(getattr(mTEPES, "nn", []))
    mTEPES.pDC["n_list"] = n_list
    mTEPES.pDC["T"] = len(n_list)
    mTEPES.pDC["n_to_t_map"] = {n_val: idx for idx, n_val in enumerate(n_list)}

    # ========= 参数（Zenodo Tab.A1-A5 的典型取值）=========
    # 单位：这里尽量保持“kW / kWh / 小时”口径，避免与 openTEPES 的 MW 混用
    mTEPES.pDCParams = {
        # 服务器
        "srv_exist_q": 0,          # Q_z^{srv,exist} 台（Zenodo Tab.A1）
        "srv_max_q": 10000,          # Q_srv^{max} 台（Zenodo Tab.A3）
        "idle_p_kw": 0.35,           # P_idle (kW/台)
        "peak_p_kw": 0.7,            # P_peak (kW/台)
        # 单台服务器最大处理任务量（任务/时段），需与 inter_load/batch_load 的“时段”一致
        # 这里按你当前“单台服务器满载可处理 10000 个任务”的口径取值（与 \zeta^{req}=1/10000 对应）
        "srv_lambda_max": 10000.0,
        # 冷却
        "cool_exist_q_kw": 0,    # 既有冷却容量 (kW)（Zenodo Tab.A1）
        "beta_1": 1.05,
        "beta_2_kw": 4.0,            # kW
        "cool_max_q_kw": 3000.0,     # 3 MW
        # WHRS（先留接口）
        "theta_whrs": 3.0,
        "omega_re": 0.95,
        "whrs_max_q_kw": 2000.0,     # 2 MW
        # 工作负载（占位）
        "delay_max_h": 7,            # 批处理任务最大延迟时间（小时）
        # 成本（先用于目标函数的基本项；可按需扩展）
        "srv_inv_cny_per_unit": 8000.0,     # 元/台
        "cool_inv_cny_per_kw": 1500.0,      # 元/kW
        "srv_opex_cny_per_kwh": 0.08,       # 元/kWh（示例口径）
        "cool_opex_cny_per_kwh": 0.10,      # 元/kWh（示例口径）
        # CPU 热阻-热容温度 (文献式(20)(21))：配合 DC_modelformulation 中一阶离散 + 总 IT 功率按 n_ref 均分
        "cpu_temp_enable": 1,              # 1 启用 CPU 温度上界约束
        "cpu_R_K_per_W": 0.35,              # R_z^{cpu} [K/W] Zenodo Tab.A1
        "cpu_C_J_per_K": 340.0,            # C_z^{cpu} [J/K]
        "cpu_T_ini_K": 318.0,              # T_z^{cpu,ini} [K]
        "cpu_T_max_K": 343.15,             # T_z^{cpu,max} [K]
        "cpu_T_in_K": 298.15,              # 机房温度取常数 T^{in} [K]（未联立(25)-(27)时）
        # 均分单机功率：P_srv ≈ P_IT(kW)×1000/n_ref [W]；None 时若有既有台数则用 srv_exist_q，否则 0.05*srv_max_q 与 [50,500] 取夹逼
        "cpu_temp_equal_split_n_ref": None,

        # 室内热动力学 (文献式(25)-(27))：单位采用 ℃ / kW / kWh / 小时
        "indoor_temp_enable": 1,            # 1 启用室内温度与变化率约束 + 与冷却/IT热耦合
        "dc_R_C_per_kW": 1.9,               # R_z [℃/kW] Zenodo Tab.A1
        "dc_C_kWh_per_C": 16.19,            # C_z^{DC} [kWh/℃] Zenodo Tab.A1
        "dc_T_in_ini_C": 20.0,              # 室内温度初值 [℃]
        "dc_T_in_min_C": 15.0,              # T_z^{in,min} [℃] Zenodo Tab.A1
        "dc_T_in_max_C": 25.0,              # T_z^{in,max} [℃] Zenodo Tab.A1
        "dc_r_in_min_C_per_h": -5.0,        # r_z^{in,min} [℃/h] Zenodo Tab.A1
        "dc_r_in_max_C_per_h": 5.0,         # r_z^{in,max} [℃/h] Zenodo Tab.A1
        "kappa_IT_kwth_per_kw": 1.0,        # H_IT = kappa_IT * P_IT (kW_th per kW_e)
    }

    # ========= 时序输入（读取 oT_Data_DCWorkload_{CaseName}.csv）=========
    T = mTEPES.pDC["T"]
    workload_path = os.path.join(_path, f"oT_Data_DCWorkload_{CaseName}.csv")
    df_w = pd.read_csv(workload_path)
    need_cols = {"LoadLevel", "inter_load", "batch_load"}
    miss = [c for c in need_cols if c not in df_w.columns]
    if miss:
        raise KeyError(f"DC workload file missing columns: {miss} in {workload_path}")

    # 用 LoadLevel 字符串对齐
    df_w = df_w.set_index("LoadLevel")
    inter_map = df_w["inter_load"].to_dict()
    batch_map = df_w["batch_load"].to_dict()

    mTEPES.pDC["lambda_inter"] = np.array([float(inter_map.get(str(n), 0.0)) for n in n_list], dtype=float)
    mTEPES.pDC["lambda_batch"] = np.array([float(batch_map.get(str(n), 0.0)) for n in n_list], dtype=float)

    # 其他常规负载功率（kW）
    mTEPES.pDC["p_other_kw"] = np.full(T, 0.0, dtype=float)

    # 室外温度时序（℃）：若存在 CSV 则读取，否则默认常数 20℃
    # 文件格式：LoadLevel,t_out_C（LoadLevel 用字符串，与 DCWorkload 一致对齐）
    tout_path = os.path.join(_path, f"oT_Data_DCTout_{CaseName}.csv")
    t_out_C = np.full(T, 20.0, dtype=float)
    if os.path.exists(tout_path):
        df_to = pd.read_csv(tout_path)
        if "LoadLevel" not in df_to.columns or "t_out_C" not in df_to.columns:
            raise KeyError(f"DC tout file must have columns LoadLevel,t_out_C: {tout_path}")
        df_to = df_to.set_index("LoadLevel")
        tout_map = df_to["t_out_C"].to_dict()
        t_out_C = np.array([float(tout_map.get(str(n), 20.0)) for n in n_list], dtype=float)
    mTEPES.pDC["t_out_C"] = t_out_C

    if pIndLogConsole == 1:
        print("\n" + "=" * 60)
        print("数据中心(EHCCS)输入已加载（读取DCWorkload CSV）")
        print("=" * 60)
        print(f"  时间点数 T = {T}")
        print(f"  服务器既有数量 = {mTEPES.pDCParams['srv_exist_q']}")
        print(f"  冷却既有容量 = {mTEPES.pDCParams['cool_exist_q_kw']} kW")
        if T > 0 and "t_out_C" in mTEPES.pDC:
            print(f"  室外温度(首时刻) = {mTEPES.pDC['t_out_C'][0]} ℃")
        if T > 0:
            print(f"  交互式负载(首时刻) = {mTEPES.pDC['lambda_inter'][0]}")
            print(f"  批处理负载(首时刻) = {mTEPES.pDC['lambda_batch'][0]}")
            print(f"  交互式负载(最大) = {mTEPES.pDC['lambda_inter'].max()}")
            print(f"  批处理负载(最大) = {mTEPES.pDC['lambda_batch'].max()}")

    return None

