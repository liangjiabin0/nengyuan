"""
Open Generation, Storage, and Transmission Operation and Expansion Planning Model with RES and ESS (openTEPES) - June 14, 2022
"""

import time
import math
import os
import pandas as pd
import altair as alt
import plotly.io as pio
import plotly.graph_objs as go
import matplotlib.pyplot as plt
from   collections   import defaultdict
# from   pyomo.environ import Set
from   colour        import Color
import numpy_financial as npf
import numpy as np
import pyoptinterface as poi

# 保存服务 
server_flag = 0

def _resolve_output_dir():
    """结果统一写到项目根目录下的 output/。"""
    override = os.environ.get('MGPLAN_OUTPUT_DIR', '').strip()
    if override:
        out_dir = override
    else:
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        out_dir = os.path.join(repo_root, 'output')
    os.makedirs(out_dir, exist_ok=True)
    return out_dir

# Definition of Pie plots
def PiePlots(period, scenario, df, Category, Value):
    df                    = df.reset_index()
    df                    = df.loc[(df['level_0'] == period) & (df['level_1'] == scenario)]
    df                    = df.set_index(['level_0', 'level_1', 'level_2', 'level_3'])
    OutputToPlot          = df.reset_index().groupby(['level_3']).sum()
    OutputToPlot['%']     = (OutputToPlot[0] / OutputToPlot[0].sum()) * 100.0
    OutputToPlot          = OutputToPlot.reset_index().rename(columns={'level_3': Category, 0: 'MWh'})
    OutputToPlot['MWh']   = round(OutputToPlot['MWh'], 1)
    OutputToPlot['%'  ]   = round(OutputToPlot['%'  ], 1)
    OutputToPlot          = OutputToPlot[(OutputToPlot[['MWh']] != 0).all(axis=1)]
    OutputToPlot['Label'] = [OutputToPlot[Category][i] + ' (' + str(OutputToPlot['%'][i]) + ' %' + ', ' + str(OutputToPlot['MWh'][i]) + ' MWh' + ')' for i in OutputToPlot.index]
    ComposedCategory      = Category+':N'
    ComposedValue         = Value   +':Q'

    # base  = alt.Chart(OutputToPlot).encode(theta=alt.Theta(ComposedValue, stack=True), color=alt.Color(ComposedCategory, legend=alt.Legend(title=Category))).properties(width=800, height=800)
    # pie   = base.mark_arc(outerRadius=240)
    # text  = base.mark_text(radius=340, size=15).encode(text='Label:N')
    # chart = pie+text
    base  = alt.Chart(OutputToPlot).encode(theta=alt.Theta(ComposedValue, stack=True), color=alt.Color(ComposedCategory, legend=alt.Legend(title=Category))).properties(width=600, height=600)
    pie   = base.mark_arc(outerRadius=180)
    text  = base.mark_text(radius=250, size=15).encode(text='Label:N')
    chart = pie+text

    return chart


# Definition of Area plots
def AreaPlots(period, scenario, df, Category, X, Y, OperationType):
    Results = df.loc[period,scenario,:,:]
    Results = Results.reset_index().rename(columns={'level_0': X, 'level_1': Category, 0: Y})
    # Change the format of the LoadLevel
    # Results[X] = Results[X].str[:14]
    Results[X] = Results[X].str[:19]
    # Results[X] = (Results[X]+'+01:00')
    # Results[X] = (str(period)+'-'+Results[X])
    # Results[X] = pd.to_datetime(Results[X])
    # Results[X] = Results[X].dt.strftime('%Y-%m-%d %H:%M:%S')
    # Composed Names
    C_C = Category+':N'

    C_X = X+':T'
    C_Y = Y+':Q'
    # Define and build the chart
    # alt.data_transformers.enable('json')
    alt.data_transformers.disable_max_rows()
    interval = alt.selection_interval(encodings=['x'])
    selection = alt.selection_multi(fields=[Category], bind='legend')

    # base  = alt.Chart(Results).mark_area().encode(x=alt.X(C_X, axis=alt.Axis(title='')), y=alt.Y(C_Y, axis=alt.Axis(title=Y)), color=C_C)
    base  = alt.Chart(Results).mark_area().encode(x=alt.X(C_X, axis=alt.Axis(title='')), y=alt.Y(C_Y, axis=alt.Axis(title=Y)), color=alt.Color(C_C, scale=alt.Scale(scheme='category20c')), opacity=alt.condition(selection, alt.value(1), alt.value(0.2))).add_selection(selection)
    # chart = base.encode(x=alt.X(C_X, axis=alt.Axis(title=''), scale=alt.Scale(domain=interval.ref()))).properties(width=1200, height=450)
    # view  = base.add_selection(interval).properties(width=1200, height=50)
    chart = base.encode(x=alt.X(C_X, axis=alt.Axis(title=''), scale=alt.Scale(domain=interval.ref()))).properties(width=1000, height=300)
    view  = base.add_selection(interval).properties(width=1000, height=40)
    plot  = chart & view

    return plot


# Definition of Line plots
def LinePlots(period, scenario, df, Category, X, Y, OperationType):
    Results = df.loc[period,scenario,:,:]
    Results = Results.reset_index().rename(columns={'level_0': X, 'level_1': Category, 0: Y})
    # Change the format of the LoadLevel
    Results[X] = Results[X].str[:14]
    Results[X] = (Results[X]+'+01:00')
    Results[X] = (str(period)+'-'+Results[X])
    Results[X] = pd.to_datetime(Results[X])
    Results[X] = Results[X].dt.strftime('%Y-%m-%d %H:%M:%S')
    # Composed Names
    C_C = Category+':N'

    C_X = X+':T'
    C_Y = Y+':Q'
    # Define and build the chart
    # alt.data_transformers.enable('json')
    alt.data_transformers.disable_max_rows()
    interval = alt.selection_interval(encodings=['x'])
    selection = alt.selection_multi(fields=[Category], bind='legend')

    # base  = alt.Chart(Results).mark_line().encode(x=alt.X(C_X, axis=alt.Axis(title='')), y=alt.Y(C_Y, axis=alt.Axis(title=Y)), color=C_C)
    base  = alt.Chart(Results).mark_line().encode(x=alt.X(C_X, axis=alt.Axis(title='')), y=alt.Y(C_Y, axis=alt.Axis(title=Y)), color=alt.Color(C_C, scale=alt.Scale(scheme='category20c')), opacity=alt.condition(selection, alt.value(1), alt.value(0.2))).add_selection(selection)
    chart = base.encode(x=alt.X(C_X, axis=alt.Axis(title=''), scale=alt.Scale(domain=interval.ref()))).properties(width=1200, height=450)
    view  = base.add_selection(interval).properties(width=1200, height=50)
    plot  = chart & view

    return plot


def InvestmentResults_poi(DirName, CaseName, OptModel, mTEPES):
    #%% outputting the investment decisions
    _path = _resolve_output_dir()
    StartTime = time.time()

    if len(mTEPES.gc):
        # Saving generation investment into CSV file
        OutputToFile = pd.Series(data=[mTEPES.pRatedMaxPower[gc] * OptModel.get_value(OptModel.vGenerationInvest[p,gc])*1e3 for p in mTEPES.p for gc in mTEPES.gc], index=pd.Index((p,gc) for p in mTEPES.p for gc in mTEPES.gc))
        OutputToFile = OutputToFile.fillna(0).to_frame(name='MW').reset_index().rename(columns={'level_0': 'Period', 'level_1': 'GeneratingUnit'})
        # 增加一列投资成 
        CostData = [mTEPES.pDiscountFactor[p] * mTEPES.pGenInvestCost[gc] * mTEPES.pRatedMaxPower[gc] * OptModel.get_value(OptModel.vGenerationInvest[p,gc]) for p in mTEPES.p for gc in mTEPES.gc]
        OutputToFile['CNY'] = CostData
        
        # === 追加热力侧与制氢制氨设备投资结果 ===
        extra_records = []
        p_first = mTEPES.p[0] if len(mTEPES.p) > 0 else 2025
        
        # 热力 
        if hasattr(mTEPES, 'ht_node'):
            cap_unit = mTEPES.pThermalCapacityUnit
            params = mTEPES.pThermalParams
            
            b_cap = OptModel.get_value(mTEPES.vCAP_boiler_units) * cap_unit
            b_cost = b_cap * params.get('boiler_unit_cost', 0)
            extra_records.append({'Period': p_first, 'GeneratingUnit': 'Boiler', 'MW': b_cap/1000, 'CNY': b_cost})
            
            hp_cap = OptModel.get_value(mTEPES.vCAP_hp_units) * cap_unit
            hp_cost = hp_cap * params.get('hp_unit_cost', 0)
            extra_records.append({'Period': p_first, 'GeneratingUnit': 'HeatPump', 'MW': hp_cap/1000, 'CNY': hp_cost})
            
            st_cap = OptModel.get_value(mTEPES.vCAP_storage_units) * cap_unit
            st_cost = st_cap * params.get('storage_unit_cost', 0)
            extra_records.append({'Period': p_first, 'GeneratingUnit': 'StorageTank_MWh', 'MW': st_cap/1000, 'CNY': st_cost})
            
            if hasattr(mTEPES, 'vCAP_chp_units'):
                chp_cap = OptModel.get_value(mTEPES.vCAP_chp_units) * cap_unit
                chp_cost = chp_cap * params.get('chp_unit_cost', 0)
                extra_records.append({'Period': p_first, 'GeneratingUnit': 'CHP', 'MW': chp_cap/1000, 'CNY': chp_cost})
            
            if hasattr(mTEPES, 'vCAP_chiller_units'):
                ac_cap = OptModel.get_value(mTEPES.vCAP_chiller_units) * cap_unit
                ac_cost = ac_cap * params.get('chiller_unit_cost', 0)
                extra_records.append({'Period': p_first, 'GeneratingUnit': 'AbsorptionChiller', 'MW': ac_cap/1000, 'CNY': ac_cost})
            
            if hasattr(mTEPES, 'vCAP_comp_units'):
                cc_cap = OptModel.get_value(mTEPES.vCAP_comp_units) * cap_unit
                cc_cost = cc_cap * params.get('comp_chiller_unit_cost', 0)
                extra_records.append({'Period': p_first, 'GeneratingUnit': 'CompressionChiller', 'MW': cc_cap/1000, 'CNY': cc_cost})

        # 制氢制氨设备
        if hasattr(mTEPES, 'params_ammonia'):
            nh3_params = mTEPES.params_ammonia
            cap_e_kw = OptModel.get_value(mTEPES.var_dict_ammonia['cap_elec'])
            cap_n_kw = OptModel.get_value(mTEPES.var_dict_ammonia['cap_nh3'])
            
            e_cost = cap_e_kw * nh3_params.get('cost_elec', 0)
            n_cost = cap_n_kw * nh3_params.get('cost_nh3', 0)
            
            extra_records.append({'Period': p_first, 'GeneratingUnit': 'H2_Electrolyzer', 'MW': cap_e_kw/1000.0, 'CNY': e_cost})
            extra_records.append({'Period': p_first, 'GeneratingUnit': 'NH3_Synthesis', 'MW': cap_n_kw/1000.0, 'CNY': n_cost})
            
        # EV充电站设 
        if hasattr(mTEPES, 'ev_node'):
            n_pile_val = OptModel.get_value(mTEPES.N_pile)
            p_chr_max = getattr(mTEPES, 'P_CHR_MAX', 60.0)  # kW
            c_inv_pile = getattr(mTEPES, 'C_INV_PILE', 2000.0)  # CNY
            
            ev_cap_mw = (n_pile_val * p_chr_max) / 1000.0
            ev_cost = n_pile_val * c_inv_pile
            
            extra_records.append({'Period': p_first, 'GeneratingUnit': 'EV_ChargingStation', 'MW': ev_cap_mw, 'CNY': ev_cost})
            
        if extra_records:
            df_extra = pd.DataFrame(extra_records)
            OutputToFile = pd.concat([OutputToFile, df_extra], ignore_index=True)

        # 将表格中所有数字保 位小 
        OutputToFile = OutputToFile.round(3)
        OutputToFile.to_csv(_path+'/oT_Result_GenerationInvestment_'+CaseName+'.csv', sep=',', index=False)
        OutputToFile = OutputToFile.set_index(['Period', 'GeneratingUnit'])
        '''
        if len(mTEPES.ar) > 1:
            GenInvestToArea   = pd.Series(data=[OutputToFile['MW'][p,gc] for p,ar,gc in mTEPES.p*mTEPES.ar*mTEPES.gc if (ar,gc) in mTEPES.a2g], index=pd.MultiIndex.from_tuples((p,ar,gc) for p,ar,gc in mTEPES.p*mTEPES.ar*mTEPES.gc if (ar,gc) in mTEPES.a2g)).to_frame(name='MW')
            GenInvestToArea.index.names = ['Period', 'Area', 'GeneratingUnit']
            chart = alt.Chart(GenInvestToArea.reset_index()).mark_bar().encode(x='GeneratingUnit:O', y='sum(MW):Q', color='Area:N', column='Period:N').properties(width=600, height=400)
            chart.save(_path+'/oT_Plot_GenerationInvestmentPerArea_'+CaseName+'.html', embed_options={'renderer':'svg'})
            TechInvestToArea  = pd.Series(data=[sum(OutputToFile['MW'][p,gc] for gc in mTEPES.gc if (ar,gc) in mTEPES.a2g and (gt,gc) in mTEPES.t2g) for p,ar,gt in mTEPES.p*mTEPES.ar*mTEPES.gt], index=pd.MultiIndex.from_tuples(mTEPES.p*mTEPES.ar*mTEPES.gt)).to_frame(name='MW')
            TechInvestToArea.index.names = ['Period', 'Area', 'Technology']
            chart = alt.Chart(TechInvestToArea.reset_index()).mark_bar().encode(x='Technology:O', y='sum(MW):Q', color='Area:N', column='Period:N').properties(width=600, height=400)
            chart.save(_path+'/oT_Plot_TechnologyInvestmentPerArea_'+CaseName+'.html', embed_options={'renderer':'svg'})

        # Ordering data to plot the investment decision
        OutputResults1 = pd.Series(data=[gt for p,gc,gt in mTEPES.p*mTEPES.gc*mTEPES.gt if (gt,gc) in mTEPES.t2g], index=pd.Index(mTEPES.p*mTEPES.gc))
        OutputResults1 = OutputResults1.to_frame(name='Technology')
        OutputResults2 = OutputToFile
        OutputResults   = pd.concat([OutputResults1, OutputResults2], axis=1)
        OutputResults.index.names = ['Period','GeneratingUnit']
        OutputResults   = OutputResults.reset_index().groupby(['Period', 'Technology']).sum()
        OutputResults['MW'] = round(OutputResults['MW'], 2)
        OutputResults   = OutputResults.reset_index()
        OutputResults.to_csv(_path+'/oT_Result_TechnologyInvestment_'+CaseName+'.csv', sep=',', index=False)

        chart = alt.Chart(OutputResults).mark_bar().encode(x='Technology:O', y='sum(MW):Q', color='Technology:N', column='Period:N').properties(width=600, height=400)
        chart.save(_path+'/oT_Plot_TechnologyInvestment_'+CaseName+'.html', embed_options={'renderer':'svg'})

        # Saving and plotting generation investment cost into CSV file
        OutputResults0 = OutputResults.set_index(['Period', 'Technology'])
        OutputToFile = pd.Series(data=[mTEPES.pDiscountFactor[p] * mTEPES.pGenInvestCost[gc] * mTEPES.pRatedMaxPower[gc] * OptModel.vGenerationInvest[p,gc]() for p,gc in mTEPES.p*mTEPES.gc], index=pd.Index(mTEPES.p*mTEPES.gc))
        OutputToFile = OutputToFile.fillna(0).to_frame(name='MEUR').reset_index().rename(columns={'level_0': 'Period', 'level_1': 'GeneratingUnit'})
        OutputToFile = OutputToFile.set_index(['Period', 'GeneratingUnit'])

        OutputResults1 = pd.Series(data=[gt for p,gc,gt in mTEPES.p*mTEPES.gc*mTEPES.gt if (gt,gc) in mTEPES.t2g], index=pd.Index(mTEPES.p*mTEPES.gc))
        OutputResults1 = OutputResults1.to_frame(name='Technology')
        OutputResults2 = OutputToFile
        OutputResults   = pd.concat([OutputResults1, OutputResults2], axis=1)
        OutputResults.index.names = ['Period','GeneratingUnit']
        OutputResults   = OutputResults.reset_index().groupby(['Period', 'Technology']).sum()
        OutputResults['MEUR'] = round(OutputResults['MEUR'], 2)

        OutputResults.reset_index().to_csv(_path+'/oT_Result_TechnologyInvestmentCost_'+CaseName+'.csv', sep=',', index=False)

        chart = alt.Chart(OutputResults.reset_index()).mark_bar().encode(x='Technology:O', y='sum(MEUR):Q', color='Technology:N', column='Period:N').properties(width=600, height=400)
        chart.save(_path+'/oT_Plot_TechnologyInvestmentCost_'+CaseName+'.html', embed_options={'renderer':'svg'})

        OutputResults = OutputResults['MEUR']/OutputResults0['MW']
        OutputResults = OutputResults.fillna(0).to_frame(name='MEUR/MW')
        OutputResults = OutputResults.reset_index()
        OutputResults.to_csv(_path+'/oT_Result_TechnologyInvestmentCostPerMW_'+CaseName+'.csv', sep=',', index=False)

        chart = alt.Chart(OutputResults).mark_bar().encode(x='Technology:O', y='sum(MEUR/MW):Q', color='Technology:N', column='Period:N').properties(width=600, height=400)
        chart.save(_path+'/oT_Plot_TechnologyInvestmentCostPerMW_'+CaseName+'.html', embed_options={'renderer':'svg'})

    if len(mTEPES.gd):
        # Saving generation retirement into CSV file
        OutputToFile = pd.Series(data=[mTEPES.pRatedMaxPower[gd]*OptModel.vGenerationRetire[p,gd]()*1e3 for p,gd in mTEPES.p*mTEPES.gd], index=pd.Index(mTEPES.p*mTEPES.gd))
        OutputToFile = OutputToFile.fillna(0).to_frame(name='MW').reset_index().rename(columns={'level_0': 'Period', 'level_1': 'GeneratingUnit'})
        OutputToFile.to_csv(_path+'/oT_Result_GenerationRetirement_'+CaseName+'.csv', sep=',', index=False)
        OutputToFile = OutputToFile.set_index(['Period', 'GeneratingUnit'])

        if len(mTEPES.ar) > 1:
            GenRetireToArea   = pd.Series(data=[OutputToFile['MW'][p,gd] for p,ar,gd in mTEPES.p*mTEPES.ar*mTEPES.gd if (ar,gd) in mTEPES.a2g], index=pd.MultiIndex.from_tuples((p,ar,gd) for p,ar,gd in mTEPES.p*mTEPES.ar*mTEPES.gd if (ar,gd) in mTEPES.a2g)).to_frame(name='MW')
            GenRetireToArea.index.names = ['Period', 'Area', 'GeneratingUnit']
            chart = alt.Chart(GenRetireToArea.reset_index()).mark_bar().encode(x='GeneratingUnit:O', y='sum(MW):Q', color='Area:N', column='Period:N').properties(width=600, height=400)
            chart.save(_path+'/oT_Plot_GenerationRetirementPerArea_'+CaseName+'.html', embed_options={'renderer':'svg'})
            TechRetireToArea  = pd.Series(data=[sum(OutputToFile['MW'][p,gd] for gd in mTEPES.gd if (ar,gd) in mTEPES.a2g and (gt,gd) in mTEPES.t2g) for p,ar,gt in mTEPES.p*mTEPES.ar*mTEPES.gt], index=pd.MultiIndex.from_tuples(mTEPES.p*mTEPES.ar*mTEPES.gt)).to_frame(name='MW')
            TechRetireToArea.index.names = ['Period', 'Area', 'Technology']
            chart = alt.Chart(TechRetireToArea.reset_index()).mark_bar().encode(x='Technology:O', y='sum(MW):Q', color='Area:N', column='Period:N').properties(width=600, height=400)
            chart.save(_path+'/oT_Plot_TechnologyRetirementPerArea_'+CaseName+'.html', embed_options={'renderer':'svg'})

        # Ordering data to plot the investment retirement
        OutputResults1 = pd.Series(data=[gt for p,gd,gt in mTEPES.p*mTEPES.gd*mTEPES.gt if (gt,gd) in mTEPES.t2g], index=pd.Index(mTEPES.p*mTEPES.gd))
        OutputResults1 = OutputResults1.to_frame(name='Technology')
        OutputResults2 = OutputToFile
        OutputResults   = pd.concat([OutputResults1, OutputResults2], axis=1)
        OutputResults.index.names = ['Period','GeneratingUnit']
        OutputResults   = OutputResults.reset_index().groupby(['Period', 'Technology']).sum()
        OutputResults['MW'] = round(OutputResults['MW'], 2)
        OutputResults   = OutputResults.reset_index()
        OutputResults.to_csv(_path+'/oT_Result_TechnologyRetirement_'+CaseName+'.csv', sep=',', index=False)

        chart = alt.Chart(OutputResults).mark_bar().encode(x='Technology:O', y='sum(MW):Q', color='Technology:N', column='Period:N').properties(width=600, height=400)
        chart.save(_path+'/oT_Plot_TechnologyRetirement_'+CaseName+'.html', embed_options={'renderer':'svg'})

    if len(mTEPES.lc):
        # Saving investment decisions
        OutputToFile = pd.Series(data=[OptModel.vNetworkInvest[p,ni,nf,cc]() for p,ni,nf,cc in mTEPES.p*mTEPES.lc], index=pd.Index(mTEPES.p*mTEPES.lc))
        OutputToFile = OutputToFile.fillna(0).to_frame(name='Investment Decision').reset_index().rename(columns={'level_0': 'Period', 'level_1': 'InitialNode', 'level_2': 'FinalNode', 'level_3': 'Circuit'})
        OutputToFile.to_csv(_path+'/oT_Result_NetworkInvestment_'+CaseName+'.csv', sep=',', index=False)

        # Ordering data to plot the investment decision
        OutputResults1 = pd.Series(data=[lt for p,ni,nf,cc,lt in mTEPES.p*mTEPES.lc*mTEPES.lt if (ni,nf,cc,lt) in mTEPES.pLineType], index=pd.Index(mTEPES.p*mTEPES.lc))
        OutputResults1 = OutputResults1.to_frame(name='LineType')
        OutputResults2 = OutputToFile.set_index(['Period', 'InitialNode', 'FinalNode', 'Circuit'])
        OutputResults   = pd.concat([OutputResults1, OutputResults2], axis=1)
        OutputResults.index.names = ['Period','InitialNode','FinalNode','Circuit']
        OutputResults   = OutputResults.reset_index().groupby(['LineType', 'Period']).sum()
        OutputResults['Investment Decision'] = round(OutputResults['Investment Decision'], 2)
        OutputResults   = OutputResults.reset_index()

        chart = alt.Chart(OutputResults).mark_bar().encode(x='LineType:O', y='sum(Investment Decision):Q', color='LineType:N', column='Period:N').properties(width=600, height=400)
        chart.save(_path+'/oT_Plot_NetworkInvestment_'+CaseName+'.html', embed_options={'renderer':'svg'})

        OutputToFile = pd.Series(data=[OptModel.vNetworkInvest[p,ni,nf,cc]()*mTEPES.pLineNTCFrw[ni,nf,cc]/mTEPES.pLineLength[ni,nf,cc]()*1e3 for p,ni,nf,cc in mTEPES.p*mTEPES.lc], index= pd.MultiIndex.from_tuples(mTEPES.p*mTEPES.lc))
        OutputToFile = OutputToFile.fillna(0).to_frame(name='MW-km').reset_index().rename(columns={'level_0': 'Period', 'level_1': 'InitialNode', 'level_2': 'FinalNode', 'level_3': 'Circuit'})
        # OutputToFile.to_csv(_path+'/oT_Result_NetworkInvestment_MWkm_'+CaseName+'.csv', sep=',')

        # Ordering data to plot the investment decision per kilometer
        OutputResults1 = pd.Series(data=[lt for p,ni,nf,cc,lt in mTEPES.p*mTEPES.lc*mTEPES.lt if (ni,nf,cc,lt) in mTEPES.pLineType], index=pd.Index(mTEPES.p*mTEPES.lc))
        OutputResults1 = OutputResults1.to_frame(name='LineType')
        OutputResults2 = OutputToFile.set_index(['Period', 'InitialNode', 'FinalNode', 'Circuit'])
        OutputResults   = pd.concat([OutputResults1, OutputResults2], axis=1)
        OutputResults.index.names = ['Period','InitialNode','FinalNode','Circuit']
        OutputResults   = OutputResults.reset_index().groupby(['LineType', 'Period']).sum()
        OutputResults['MW-km'] = round(OutputResults['MW-km'], 2)
        OutputResults   = OutputResults.reset_index()

        chart = alt.Chart(OutputResults).mark_bar().encode(x='LineType:O', y='sum(MW-km):Q', color='LineType:N', column='Period:N')
        # chart.save(_path+'/oT_Plot_NetworkInvestment_MW-km_'+CaseName+'.html', embed_options={'renderer':'svg'})'''

    WritingResultsTime = time.time() - StartTime
    StartTime          = time.time()
    print('Writing           investment results   ... ', round(WritingResultsTime), 's')


def ESSOperationResults_poi(DirName, CaseName, OptModel, mTEPES):

    _path = _resolve_output_dir()
    StartTime = time.time()

    class BatterySimulationModel:
        """电池储能系统物理仿真模型"""

        # ==========================================
        # 第一步：定参 (初始化类)
        # ==========================================
        def __init__(self, input_df, sim_hours=196, initial_soc=0.76, initial_temp=25.0, ambient_temp=25.0, dt=3600.0, custom_params=None):
                # 1. 绑定系统参数
                if custom_params is None:
                    # self.params = {
                    #     'N_rack': 81, 'N_mod': 8,
                    #     'Q_capacity_Ah': 280.0, 'U_max': 187.2, 'U_min': 145.6, 
                    #     'I_max': 140.0, 'U_nom': 166.4, 'ALPHA_OCV': 0.1262, 
                    #     'U_BASE': 160.09, 'T_max': 52.0, 'T_min': 5.0, 
                    #     'T_dist_safe': 2.0, 'C_th': 323400.0, 'k_cool': 0.0001,
                    #     'TEMP_AXIS_R': np.array([5.0, 15.0, 25.0, 45.0, 52.0]),
                    #     'R_TEMP_MAP':  np.array([0.03500, 0.02956, 0.02288, 0.01352, 0.01200]), 
                    #     'SOC_AXIS_R_FACTOR': np.array([0.0, 0.05, 0.10, 0.20, 0.50, 0.90, 1.0]),
                    #     'R_SOC_FACTOR_MAP':  np.array([1.85, 1.85, 1.58, 1.38, 1.13, 1.0, 1.0])
                    # }
                    self.params = {
                        'N_rack': 81, 'N_mod': 8,
                        'Q_capacity_Ah': 280.0, 'U_max': 187.2, 'U_min': 145.6, 
                        'I_max': 140.0, 'U_nom': 166.4, 'ALPHA_OCV': 0.1262, 
                        'U_BASE': 160.09, 'T_max': 52.0, 'T_min': 5.0, 
                        'T_dist_safe': 2.0, 'C_th': 323400.0, 'k_cool': 0.0001,
                        
                        'TEMP_AXIS_R': np.array([5.0, 15.0, 25.0, 45.0, 52.0]),
                        'R_TEMP_MAP':  np.array([0.03500, 0.02956, 0.02288, 0.01352, 0.01200]), 
                        
                        # 🌟 更精 SOC-内阻 浴缸曲线映射
                        'SOC_AXIS_R_FACTOR': np.array([0.0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.50, 0.70, 0.85, 0.95, 1.0]),
                        'R_SOC_FACTOR_MAP':  np.array([2.00, 1.85, 1.58, 1.45, 1.25, 1.08, 1.02, 1.02, 1.05, 1.08, 1.10]),
                        
                        # 🌟 充放电不对称性与系统损耗参 
                        'R_DIS_FACTOR': 1,  # 放电内阻放大倍数 (假设放电内阻比充电大 10%)
                        'ETA_PCS_DIS': 0.9,   # 放电 PCS 效率 (电网 00kW，电池发 100/0.96=104kW)
                        'ETA_PCS_CHG': 1    # 充电 PCS 效率 (电网 00kW，电池充 100*1=100kW)
                    }
                else:
                    self.params = custom_params
                    
                self.dt = dt
                self.ambient_temp = ambient_temp
                self.sys_energy_kwh = self.params['Q_capacity_Ah'] * self.params['U_nom'] * self.params['N_rack'] * self.params['N_mod'] / 1000.0

                # 2. 初始化运行状 
                self.current_soc = initial_soc
                self.current_temp = initial_temp
                
                # 3. 读取外部传入 DataFrame
                self.raw_df = input_df.copy().head(sim_hours)
                
                # 兼容传入 df_ess_power (可能是各储能设备的列, 我们取总和或者默认第一个储 
                # 修改 2：处理输入列 
                if 'ESS (all) power set point [kW]' in self.raw_df.columns:
                    self.ems_power_req_kw = self.raw_df['ESS (all) power set point [kW]'].values
                else:
                    # c。选取各es的充放电 (列名除Period/Scenario/LoadLevel外均为es)
                    data_cols = [c for c in self.raw_df.columns if c not in ['Period', 'Scenario', 'LoadLevel']]
                    self.ems_power_req_kw = self.raw_df[data_cols].sum(axis=1).values * 1000.0 # openTEPES传进来的总功率为MW，乘 000转为kW

                if 'time step [-]' in self.raw_df.columns:
                    self.hours = self.raw_df['time step [-]'].values
                elif 'LoadLevel' in self.raw_df.columns:
                    self.hours = self.raw_df.index.values # 使用索引或新建时间序 
                else:
                    self.hours = np.arange(len(self.raw_df))
                    
                # 处理初始 SOC，如果传进来的是 DataFrame 且包含对 SOC    
                if isinstance(initial_soc, pd.DataFrame):
                    data_cols = [c for c in initial_soc.columns if c not in ['Period', 'Scenario', 'LoadLevel']]
                    # 假定取总合或均值作为系统的初期 SOC (0.0~1.0 之间)
                    self.current_soc = initial_soc[data_cols].mean(axis=1).values[0] if not initial_soc.empty else 0.76
                else:    
                    self.current_soc = initial_soc
                    
                # 4. 初始化结果容 
                self.res_dict = {'P_req': [], 'P_actual': [], 'SoC': [], 'Voltage': [], 'Current': [], 'Temp': []}
                self.df_res = None # 用于存储最终的 DataFrame

        # --- 内部辅助方法 (私有方法，不对外暴露) ---
        def _get_mod_ocv_linear(self):
            return self.params['U_BASE'] + self.params['ALPHA_OCV'] * (self.current_soc * 100.0)

        def _lookup_mod_r_temp(self):
            temp_clipped = np.clip(self.current_temp, self.params['TEMP_AXIS_R'][0], self.params['TEMP_AXIS_R'][-1])
            return np.interp(temp_clipped, self.params['TEMP_AXIS_R'], self.params['R_TEMP_MAP'])

        def _lookup_mod_r_soc_factor(self):
            return np.interp(self.current_soc, self.params['SOC_AXIS_R_FACTOR'], self.params['R_SOC_FACTOR_MAP'])

        # --- 核心物理引擎 (单步推演) ---
        # def _step_simulation(self, p_sys_req_w):
        #     # 1. 均分到单模块的指 
        #     total_modules = self.params['N_rack'] * self.params['N_mod']
        #     p_req_mod = p_sys_req_w / total_modules
            
        #     # 2. 计算模块物理 
        #     u_ocv = self._get_mod_ocv_linear()
        #     r_mod = self._lookup_mod_r_temp() * self._lookup_mod_r_soc_factor()
            
        #     discriminant = u_ocv**2 - 4 * r_mod * p_req_mod
            
        #     if discriminant < 0:
        #         i_mod = u_ocv / (2 * r_mod)  
        #     else:
        #         i_mod = (u_ocv - math.sqrt(discriminant)) / (2 * r_mod)
                
        #     # 模块限流与限压保 
        #     i_mod = max(-self.params['I_max'], min(self.params['I_max'], i_mod))
        #     u_mod = u_ocv - i_mod * r_mod
            
        #     if u_mod > self.params['U_max']:
        #         u_mod = self.params['U_max']
        #         i_mod = (u_ocv - u_mod) / r_mod  
        #     elif u_mod < self.params['U_min']:
        #         u_mod = self.params['U_min']
        #         i_mod = (u_ocv - u_mod) / r_mod

        #     # 3. 状态更 (直接修改类属 self.current_soc  self.current_temp)
        #     p_actual_mod = u_mod * i_mod
        #     capacity_as = self.params['Q_capacity_Ah'] * 3600
            
        #     self.current_soc -= (i_mod * self.dt) / capacity_as
        #     self.current_soc = max(0.0, min(1.0, self.current_soc))
            
        #     q_gen = (i_mod ** 2) * r_mod 
        #     delta_t = (q_gen / self.params['C_th'] - self.params['k_cool'] * (self.current_temp - self.ambient_temp)) * self.dt
        #     self.current_temp += delta_t
        #     self.current_temp = max(self.params['T_min'], min(self.params['T_max'], self.current_temp))
            
        #     # 4. 汇总为系统级输出并返回
        #     u_sys = u_mod * self.params['N_mod']                 
        #     i_sys = i_mod * self.params['N_rack']                
        #     p_actual_sys = p_actual_mod * total_modules     
            
        #     return u_sys, i_sys, p_actual_sys

        def _step_simulation(self, p_sys_req_w):
            # 🌟 引入 PCS 充放电效率不对称
            if p_sys_req_w > 0:
                # 放电：为了满足电网需求，电池直流侧需要吐出更多功 
                p_bat_req_w = p_sys_req_w / self.params['ETA_PCS_DIS']
            elif p_sys_req_w < 0:
                # 充电：电网过来的功率，经 PCS 损耗后，真正充进电池的变少 
                p_bat_req_w = p_sys_req_w * self.params['ETA_PCS_CHG']
            else:
                p_bat_req_w = 0.0

            # 均分到单模块的指 
            total_modules = self.params['N_rack'] * self.params['N_mod']
            p_req_mod = p_bat_req_w / total_modules
            
            u_ocv = self._get_mod_ocv_linear()
            r_base = self._lookup_mod_r_temp() * self._lookup_mod_r_soc_factor()
            
            # 🌟 放电内阻放大逻辑
            if p_req_mod > 0:
                r_mod = r_base * self.params['R_DIS_FACTOR']  
            else:
                r_mod = r_base  
            
            # 求解二次方程算电 
            discriminant = u_ocv**2 - 4 * r_mod * p_req_mod
            
            if discriminant < 0:
                i_mod = u_ocv / (2 * r_mod)  
            else:
                i_mod = (u_ocv - math.sqrt(discriminant)) / (2 * r_mod)
                
            i_mod = max(-self.params['I_max'], min(self.params['I_max'], i_mod))
            u_mod = u_ocv - i_mod * r_mod
            
            # 物理边界保护
            if u_mod > self.params['U_max']:
                u_mod = self.params['U_max']
                i_mod = (u_ocv - u_mod) / r_mod  
            elif u_mod < self.params['U_min']:
                u_mod = self.params['U_min']
                i_mod = (u_ocv - u_mod) / r_mod

            p_actual_mod = u_mod * i_mod
            capacity_as = self.params['Q_capacity_Ah'] * 3600
            
            # 状态更 
            self.current_soc -= (i_mod * self.dt) / capacity_as
            self.current_soc = max(0.0, min(1.0, self.current_soc))
            
            q_gen = (i_mod ** 2) * r_mod 
            delta_t = (q_gen / self.params['C_th'] - self.params['k_cool'] * (self.current_temp - self.ambient_temp)) * self.dt
            self.current_temp += delta_t
            self.current_temp = max(self.params['T_min'], min(self.params['T_max'], self.current_temp))
            
            u_sys = u_mod * self.params['N_mod']                 
            i_sys = i_mod * self.params['N_rack']                
            p_actual_sys = p_actual_mod * total_modules     
            
            return u_sys, i_sys, p_actual_sys

        # ==========================================
        # 第二步：走迭 (暴露给外部运行的 API)
        # ==========================================
        def run(self):
            """执行完整时间序列的迭代仿真"""
            print("启动物理模型仿真迭代...")
            for i in range(len(self.hours)):
                p_sys_req_w = self.ems_power_req_kw[i] * 1000.0
                
                # 单步推演 (会自动更新内 SOC  Temp)
                u_sys, i_sys, p_actual_w = self._step_simulation(p_sys_req_w)
                
                # 记录数据
                self.res_dict['P_req'].append(p_sys_req_w / 1000.0)
                self.res_dict['P_actual'].append(p_actual_w / 1000.0)
                self.res_dict['SoC'].append(self.current_soc * 100.0)
                self.res_dict['Temp'].append(self.current_temp)
                self.res_dict['Voltage'].append(u_sys)
                self.res_dict['Current'].append(i_sys)

            # 转换 DataFrame 保存到类属性中
            self.df_res = pd.DataFrame(self.res_dict, index=self.hours)
            if 'ESS (all) energy content [kWh]' in self.raw_df.columns:
                self.df_res['Planned_SoC'] = (self.raw_df['ESS (all) energy content [kWh]'].values / self.sys_energy_kwh) * 100.0
            else:
                self.df_res['Planned_SoC'] = self.df_res['SoC'] # 如果没有这列则使用模拟值占 
            print("迭代完成")
            return self.df_res

        # ==========================================
        # 第三步：画图
        # ==========================================
        def plot(self, save_path=None):
            """绘制仿真结果图表"""
            if self.df_res is None:
                print("请先调用 run() 方法执行仿真")
                return
                
            print("正在生成系统状态图 ..")
            fig, axes = plt.subplots(5, 1, figsize=(15, 18))
            plt.subplots_adjust(hspace=0.4)

            # 1. 指令跟踪
            axes[0].step(self.df_res.index, self.df_res['P_req'], where='post', color='lightgray', linewidth=5, label='EMS Command')
            axes[0].step(self.df_res.index, self.df_res['P_actual'], where='post', color='purple', linewidth=2, label='Actual Output')
            axes[0].set_ylabel('Power [kW]')
            axes[0].set_title('Battery Dispatch Tracking', loc='left', fontweight='bold')
            axes[0].legend(loc='lower right')

            # 2. SOC验证
            axes[1].plot(self.df_res.index, self.df_res['SoC'], 'g.-', linewidth=2, label='Simulated SOC')
            axes[1].plot(self.df_res.index, self.df_res['Planned_SoC'], color='gray', linestyle='--', label='Planned SOC')
            axes[1].set_ylabel('SOC [%]')
            axes[1].set_title('System State of Charge', loc='left', fontweight='bold')
            axes[1].legend(loc='lower right')

            # 3. 电压边界
            axes[2].plot(self.df_res.index, self.df_res['Voltage'], 'b.-', linewidth=1.5)
            axes[2].axhline(self.params['U_max'] * self.params['N_mod'], color='r', linestyle=':', label='Overvoltage')
            axes[2].axhline(self.params['U_min'] * self.params['N_mod'], color='r', linestyle=':', label='Undervoltage')
            axes[2].set_ylabel('Bus Voltage [V]')
            axes[2].legend(loc='lower right')

            # 4. 电流约束
            axes[3].plot(self.df_res.index, self.df_res['Current'], 'r.-', linewidth=1.5)
            limit_i = self.params['I_max'] * self.params['N_rack']
            axes[3].axhline(limit_i, color='k', linestyle='--', label='Limit')
            axes[3].axhline(-limit_i, color='k', linestyle='--')
            axes[3].set_ylabel('Total Current [A]')
            axes[3].legend(loc='lower right')

            # 5. 热动力学
            axes[4].plot(self.df_res.index, self.df_res['Temp'], color='darkorange', linewidth=2, label='Cell Temp')
            axes[4].axhline(self.ambient_temp, color='blue', linestyle='-.', alpha=0.5, label='Ambient')
            axes[4].set_ylabel('Temperature [°C]')
            axes[4].set_xlabel('Time [Hours]')
            axes[4].legend(loc='upper right')

            for ax in axes: 
                ax.grid(True, linestyle='--', alpha=0.5)
                
            if save_path:
                plt.savefig(save_path, bbox_inches='tight')
                plt.close(fig)
            else:
                plt.show()
    if len(mTEPES.es):
        '''
        OutputToFile = pd.Series(data=[OptModel.vEnergyOutflows    [p,sc,n,es]()*1e3 for p,sc,n,es in mTEPES.ps*mTEPES.n*mTEPES.es], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.es))
        OutputToFile.to_frame(name='MW').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationOutflows_'        +CaseName+'.csv', sep=',')

        OutputToFile = pd.Series(data=[sum(OutputToFile[p,sc,n,es] for es in mTEPES.es if (ot,es) in mTEPES.t2g) for p,sc,n,ot in mTEPES.ps*mTEPES.n*mTEPES.ot], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.ot))
        OutputToFile.to_frame(name='MW').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_TechnologyOutflows_'        +CaseName+'.csv', sep=',')

        OutputToFile = pd.Series(data=[-OptModel.vESSTotalCharge   [p,sc,n,es]()*1e3 for p,sc,n,es in mTEPES.ps*mTEPES.n*mTEPES.es], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.es))
        # OutputToFile.to_frame(name='MW').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_ChargeOutput_'              +CaseName+'.csv', sep=',')

        OutputToFile = pd.Series(data=[sum(OutputToFile[p,sc,n,es] for es in mTEPES.es if (ot,es) in mTEPES.t2g) for p,sc,n,ot in mTEPES.ps*mTEPES.n*mTEPES.ot], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.ot))
        OutputToFile.to_frame(name='MW').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_TechnologyOutputESS_'       +CaseName+'.csv', sep=',')

        OutputToFile = pd.Series(data=[OptModel.vEnergyOutflows    [p,sc,n,es]()*mTEPES.pLoadLevelDuration[n]() for p,sc,n,es in mTEPES.ps*mTEPES.n*mTEPES.es], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.es))
        OutputToFile.to_frame(name='GWh').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='GWh', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationOutflowsEnergy_'+CaseName+'.csv', sep=',')

        OutputToFile = pd.Series(data=[sum(OutputToFile[p,sc,n,es] for es in mTEPES.es if (ot,es) in mTEPES.t2g) for p,sc,n,ot in mTEPES.ps*mTEPES.n*mTEPES.ot], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.ot))
        OutputToFile.to_frame(name='GWh').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='GWh', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_TechnologyOutflowsEnergy_'+CaseName+'.csv', sep=',')

        OutputToFile = pd.Series(data=[-OptModel.vESSTotalCharge   [p,sc,n,es]()*mTEPES.pLoadLevelDuration[n]() for p,sc,n,es in mTEPES.ps*mTEPES.n*mTEPES.es], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.es))
        OutputToFile.to_frame(name='GWh').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='GWh', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_ChargeEnergy_'            +CaseName+'.csv', sep=',')

        OutputToFile = pd.Series(data=[sum(OutputToFile[p,sc,n,es] for es in mTEPES.es if (ot,es) in mTEPES.t2g) for p,sc,n,ot in mTEPES.ps*mTEPES.n*mTEPES.ot], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.ot))
        OutputToFile.to_frame(name='GWh').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='GWh').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_TechnologyEnergyESS_'     +CaseName+'.csv', sep=',')

        OutputToFile *= -1.0
        if OutputToFile.sum() < 0.0:
            for p,sc in mTEPES.ps:
                chart = PiePlots(p, sc, OutputToFile, 'Technology', '%')
                chart.save(_path+'/oT_Plot_TechnologyEnergyESS_'+str(p)+'_'+str(sc)+'_'+CaseName+'.html', embed_options={'renderer': 'svg'})

        for ar in mTEPES.ar:
            if len(mTEPES.ar) > 1:
                OutputToFile = pd.Series(data=[-OptModel.vESSTotalCharge   [p,sc,n,es]()*mTEPES.pLoadLevelDuration[n]() for p,sc,n,es in mTEPES.ps*mTEPES.n*mTEPES.es], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.es))
                OutputToFile = pd.Series(data=[sum(OutputToFile[p,sc,n,es] for es in mTEPES.es if (ar,es) in mTEPES.a2g and (ot,es) in mTEPES.t2g) for p,sc,n,ot in mTEPES.ps*mTEPES.n*mTEPES.ot], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.ot))
                OutputToFile.to_frame(name='GWh').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='GWh', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_TechnologyEnergyESS_'+ar+'_'+CaseName+'.csv', sep=',')

                OutputToFile *= -1.0
                if OutputToFile.sum() < 0.0:
                    for p,sc in mTEPES.ps:
                        chart = PiePlots(p, sc, OutputToFile, 'Technology', '%')
                        chart.save(_path+'/oT_Plot_TechnologyEnergyESS_'+str(p)+'_'+str(sc)+'_'+ar+'_'+CaseName+'.html', embed_options={'renderer': 'svg'})
        '''
        OutputToFile = pd.Series(data=[OptModel.get_value(OptModel.vESSInventory[p,sc,n,es])*1e3                               for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for es in mTEPES.es if (mTEPES.n.index(n) + 1) % mTEPES.pCycleTimeStep[es] == 0], index=pd.MultiIndex.from_tuples(list([(p,sc,n,es) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for es in mTEPES.es if (mTEPES.n.index(n) + 1) % mTEPES.pCycleTimeStep[es] == 0 ])))
        OutputToFile.to_frame(name='GWh').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='GWh', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationInventory_'+CaseName+'.csv', sep=',')

        InventoryUtilization = [(p,sc,n,es) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for es in mTEPES.es if mTEPES.pMaxStorage[p,sc,n,es] and (mTEPES.n.index(n) + 1) % mTEPES.pCycleTimeStep[es] == 0]
        def _ess_inventory_utilization(p, sc, n, es):
            inv_val = OptModel.get_value(OptModel.vESSInventory[p, sc, n, es])
            max_storage = mTEPES.pMaxStorage[p, sc, n, es]
            if not max_storage or max_storage <= 0:
                return 0.0
            if es in mTEPES.gc:
                invest_val = OptModel.get_value(OptModel.vGenerationInvest[p, es])
                denominator = invest_val * max_storage
                return inv_val / denominator if invest_val > 0 else 0.0
            return inv_val / max_storage
        OutputToFile = pd.Series(
            data=[_ess_inventory_utilization(p, sc, n, es) for p, sc, n, es in InventoryUtilization],
            index=pd.MultiIndex.from_tuples(InventoryUtilization),
        )
        OutputToFile = OutputToFile.fillna(0.0)
        OutputToFile.to_frame(name='GWh').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='GWh', dropna=False, aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationInventoryUtilization_'+CaseName+'.csv', sep=',')
        
        
        OutputToFile = pd.Series(data=[OptModel.get_value(OptModel.vESSSpillage [p,sc,n,es])                               for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for es in mTEPES.es if (mTEPES.n.index(n) + 1) % mTEPES.pCycleTimeStep[es] == 0], index=pd.MultiIndex.from_tuples(list([(p,sc,n,es) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for es in mTEPES.es if (mTEPES.n.index(n) + 1) % mTEPES.pCycleTimeStep[es] == 0 ])))
        OutputToFile.to_frame(name='GWh').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='GWh', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationSpillage_'+CaseName+'.csv', sep=',')
        
        # ---------- 新增：汇总所有储能充放电功率 ----------
        ess_power_list = []
        for p in mTEPES.p:
            for sc in mTEPES.sc:
                for n in mTEPES.n:
                    row_data = {
                        'Period': p,
                        'Scenario': sc,
                        'LoadLevel': n
                    }
                    for es in mTEPES.es:
                        charge_val = OptModel.get_value(OptModel.vESSTotalCharge[p,sc,n,es]) *1e3
                        discharge_val = OptModel.get_value(OptModel.vTotalOutput[p,sc,n,es]) *1e3
                        # 放电为正，充电为负，合并为单列功率（根据您的物理惯例，可自由调节正负号意义）
                        row_data[str(es)] = discharge_val - charge_val
                    ess_power_list.append(row_data)

        if ess_power_list:
            df_ess_power = pd.DataFrame(ess_power_list)
            df_ess_power.to_csv(_path + '/oT_Result_ESSChargeDischarge_' + CaseName + '.csv', index=False)
        
        # ---------- 新增：储能初始时刻InventoryUtilization ----------
        ess_init_util_list = []
        n_init = list(mTEPES.n)[0] if len(list(mTEPES.n)) > 0 else None
        if n_init is not None:
            for p in mTEPES.p:
                for sc in mTEPES.sc:
                    row_data = {
                        'Period': p,
                        'Scenario': sc,
                        'LoadLevel': n_init
                    }
                    for es in mTEPES.es:
                        inv_val = OptModel.get_value(OptModel.vESSInventory[p,sc,n_init,es])
                        max_storage = mTEPES.pMaxStorage[p,sc,n_init,es]
                        if es in mTEPES.gc:
                            invest_val = OptModel.get_value(OptModel.vGenerationInvest[p,es])
                            denominator = invest_val * max_storage
                        else:
                            denominator = max_storage
                        util_val = inv_val / denominator if denominator > 1e-6 else 0.0
                        row_data[str(es)] = util_val
                    ess_init_util_list.append(row_data)

            if ess_init_util_list:
                df_init_util = pd.DataFrame(ess_init_util_list)
                df_init_util.to_csv(_path + '/oT_Result_ESSInitialInventoryUtilization_' + CaseName + '.csv', index=False)
        # --------------------------------------------------
        # 储能仿真
        ess_model = BatterySimulationModel(input_df=df_ess_power, sim_hours=8760, initial_soc=df_init_util)
        ess_results_df = ess_model.run()
        ess_model.plot(save_path=_path + '/oT_Plot_ESSSimulation_' + CaseName + '.png')


        '''
        OutputToFile = pd.Series(data=[sum(OutputToFile[p,sc,n,es] for es in mTEPES.es if (ot,es) in mTEPES.t2g) for p,sc,n,ot in mTEPES.ps*mTEPES.n*mTEPES.ot], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.ot))
        # OutputToFile.to_frame(name='MW' ).reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW' , aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_TechnologyCharge_'  +CaseName+'.csv', sep=',')

        TechnologyCharge = OutputToFile.loc[:,:,:,:]

        for p,sc in mTEPES.ps:
            chart = AreaPlots(p, sc, TechnologyCharge, 'Technology', 'LoadLevel', 'MW', 'sum')
            # chart.save(_path+'/oT_Plot_TechnologyCharge_'+str(p)+'_'+str(sc)+'_'+CaseName+'.html', embed_options={'renderer': 'svg'})

        OutputToFile1 = pd.Series(data=[(OptModel.vTotalOutput[p,sc,n,es].ub - OptModel.vTotalOutput[p,sc,n,es]())*mTEPES.pLoadLevelDuration[n]() for p,sc,n,es in mTEPES.ps*mTEPES.n*mTEPES.es], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.es))
        OutputToFile2 = pd.Series(data=[(OptModel.vTotalOutput[p,sc,n,es].ub)*mTEPES.pLoadLevelDuration[n]() for p,sc,n,es in mTEPES.ps*mTEPES.n*mTEPES.es], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.es))
        for p,sc,n,es in mTEPES.ps*mTEPES.n*mTEPES.es:
            if es in mTEPES.gc:
                OutputToFile1[p,sc,n,es] *= OptModel.vGenerationInvest[p,es]()
                OutputToFile2[p,sc,n,es] *= OptModel.vGenerationInvest[p,es]()
        OutputToFile1 = OutputToFile1.to_frame(name='GWh').reset_index().pivot_table(index=['level_0','level_1','level_3'], values='GWh', aggfunc=sum).rename_axis(['Period','Scenario','Unit'], axis=0).rename_axis([None], axis=1)
        OutputToFile2 = OutputToFile2.to_frame(name='GWh').reset_index().pivot_table(index=['level_0','level_1','level_3'], values='GWh', aggfunc=sum).rename_axis(['Period','Scenario','Unit'], axis=0).rename_axis([None], axis=1)
        OutputToFile  = OutputToFile1.div(OutputToFile2)*1e2
        OutputToFile  = OutputToFile.fillna(0.0)
        OutputToFile.rename(columns = {'GWh':'%'}, inplace = True)
        OutputToFile.to_csv(_path+'/oT_Result_GenerationSpillageRelative_'+CaseName+'.csv', sep=',')

        OutputToFile1 = pd.Series(data=[sum(OutputToFile1['GWh'][p,sc,es] for es in mTEPES.es if (ot,es) in mTEPES.t2g) for p,sc,ot in mTEPES.ps*mTEPES.ot], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.ot))
        OutputToFile2 = pd.Series(data=[sum(OutputToFile2['GWh'][p,sc,es] for es in mTEPES.es if (ot,es) in mTEPES.t2g) for p,sc,ot in mTEPES.ps*mTEPES.ot], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.ot))
        OutputToFile  = OutputToFile1.div(OutputToFile2)*1e2
        OutputToFile  = OutputToFile.fillna(0.0)
        OutputToFile.to_frame(name='%').to_csv(_path+'/oT_Result_TechnologySpillageRelative_'+CaseName+'.csv', sep=',')
    '''
    WritingResultsTime = time.time() - StartTime
    StartTime = time.time()
    print('Writing        ESS operation results   ... ', round(WritingResultsTime), 's')


def NetworkOperationResults_poi(DirName, CaseName, OptModel, mTEPES):
    _path = _resolve_output_dir()
    StartTime = time.time()
    '''
    OutputToFile = pd.Series(data=[OptModel.vLineCommit  [p,sc,n,ni,nf,cc]() for p,sc,n,ni,nf,cc in mTEPES.ps*mTEPES.n*mTEPES.la], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.la))
    OutputToFile.index.names = ['Period','Scenario','LoadLevel','InitialNode','FinalNode','Circuit']
    OutputToFile = pd.pivot_table(OutputToFile.to_frame(name='p.u.'), values='p.u.', index=['Period','Scenario','LoadLevel'], columns=['InitialNode','FinalNode','Circuit'], fill_value=0.0)
    OutputToFile.index.names = [None] * len(OutputToFile.index.names)
    OutputToFile.to_csv(_path+'/oT_Result_NetworkCommitment_'+CaseName+'.csv', sep=',')
    OutputToFile = pd.Series(data=[OptModel.vLineOnState [p,sc,n,ni,nf,cc]() for p,sc,n,ni,nf,cc in mTEPES.ps*mTEPES.n*mTEPES.la], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.la))
    OutputToFile.index.names = ['Period','Scenario','LoadLevel','InitialNode','FinalNode','Circuit']
    OutputToFile = pd.pivot_table(OutputToFile.to_frame(name='p.u.'), values='p.u.', index=['Period','Scenario','LoadLevel'], columns=['InitialNode','FinalNode','Circuit'], fill_value=0.0)
    OutputToFile.index.names = [None] * len(OutputToFile.index.names)
    OutputToFile.to_csv(_path+'/oT_Result_NetworkSwitchOn_'  +CaseName+'.csv', sep=',')
    OutputToFile = pd.Series(data=[OptModel.vLineOffState[p,sc,n,ni,nf,cc]() for p,sc,n,ni,nf,cc in mTEPES.ps*mTEPES.n*mTEPES.la], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.la))
    OutputToFile.index.names = ['Period','Scenario','LoadLevel','InitialNode','FinalNode','Circuit']
    OutputToFile = pd.pivot_table(OutputToFile.to_frame(name='p.u.'), values='p.u.', index=['Period','Scenario','LoadLevel'], columns=['InitialNode','FinalNode','Circuit'], fill_value=0.0)
    OutputToFile.index.names = [None] * len(OutputToFile.index.names)
    OutputToFile.to_csv(_path+'/oT_Result_NetworkSwitchOff_' +CaseName+'.csv', sep=',')

    OutputToFile = pd.Series(data=[OptModel.vFlow[p,sc,n,ni,nf,cc]()*1e3 for p,sc,n,ni,nf,cc in mTEPES.ps*mTEPES.n*mTEPES.la], index= pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.la))
    OutputToFile.index.names = ['Period','Scenario','LoadLevel','InitialNode','FinalNode','Circuit']
    OutputToFile = pd.pivot_table(OutputToFile.to_frame(name='MW'), values='MW', index=['Period','Scenario','LoadLevel'], columns=['InitialNode','FinalNode','Circuit'], fill_value=0.0)
    OutputToFile.index.names = [None] * len(OutputToFile.index.names)
    OutputToFile.to_csv(_path+'/oT_Result_NetworkFlow_'       +CaseName+'.csv', sep=',')

    # tolerance to consider avoid division by 0
    pEpsilon = 1e-6

    OutputToFile = pd.Series(data=[max(OptModel.vFlow[p,sc,n,ni,nf,cc]()/(mTEPES.pLineNTCFrw[ni,nf,cc]+pEpsilon),-OptModel.vFlow[p,sc,n,ni,nf,cc]()/(mTEPES.pLineNTCBck[ni,nf,cc]+pEpsilon)) for p,sc,n,ni,nf,cc in mTEPES.ps*mTEPES.n*mTEPES.la], index= pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.la))
    OutputToFile.index.names = ['Period','Scenario','LoadLevel','InitialNode','FinalNode','Circuit']
    OutputToFile = pd.pivot_table(OutputToFile.to_frame(name='pu'), values='pu', index=['Period','Scenario','LoadLevel'], columns=['InitialNode','FinalNode','Circuit'], fill_value=0.0)
    OutputToFile.index.names = [None] * len(OutputToFile.index.names)
    OutputToFile.to_csv(_path+'/oT_Result_NetworkUtilization_'+CaseName+'.csv', sep=',')

    if mTEPES.pIndBinNetLosses():
        OutputToFile = pd.Series(data=[OptModel.get_value(OptModel.vLineLosses[p,sc,n,ni,nf,cc]) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for ni,nf,cc in mTEPES.ll], index= pd.MultiIndex.from_tuples((p,sc,n,ni,nf,cc) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for ni,nf,cc in mTEPES.ll))
        OutputToFile.index.names = ['Period','Scenario','LoadLevel','InitialNode','FinalNode','Circuit']
        OutputToFile = pd.pivot_table(OutputToFile.to_frame(name='pu'), values='pu', index=['Period','Scenario','LoadLevel'], columns=['InitialNode','FinalNode','Circuit'], fill_value=0.0)
        OutputToFile.index.names = [None] * len(OutputToFile.index.names)
        OutputToFile.to_csv(_path+'/oT_Result_NetworkLosses_' +CaseName+'.csv', sep=',')

    OutputToFile = pd.Series(data=[OptModel.get_value(OptModel.vTheta[p,sc,n,nd])                              for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd], index=pd.MultiIndex.from_tuples((p,sc,n,nd) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd))
    OutputToFile.to_frame(name='rad').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='rad').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_NetworkAngle_'+CaseName+'.csv', sep=',')
    '''
    OutputToFile = pd.Series(data=[OptModel.get_value(OptModel.vPloss[p,sc,n,nd])                                * 1e3 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd], index=pd.MultiIndex.from_tuples((p,sc,n,nd) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd))
    OutputToFile.to_frame(name='MW' ).reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW' ).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_NetworkPloss_'  +CaseName+'.csv', sep=',')
    
    OutputToFile = pd.Series(data=[OptModel.get_value(OptModel.vENS[p,sc,n,nd]) * mTEPES.pLoadLevelDuration[n] * 1e3 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd], index=pd.MultiIndex.from_tuples((p,sc,n,nd) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd))
    OutputToFile.to_frame(name='MWh').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MWh').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_NetworkENS_'  +CaseName+'.csv', sep=',')
    
    '''
    # 需求响应结 
    OutputToFile = pd.Series(data=[(OptModel.get_value(OptModel.vDRUp[p,sc,n,nd]) - OptModel.get_value(OptModel.vDRDown[p,sc,n,nd])) * 1e3   for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd], index=pd.MultiIndex.from_tuples((p,sc,n,nd) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd))
    OutputToFile.to_frame(name='MW').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_NetworkDR_'  +CaseName+'.csv', sep=',')
    '''
    WritingResultsTime = time.time() - StartTime
    StartTime = time.time()
    print('Writing    network operation results   ... ', round(WritingResultsTime), 's')


def EconomicResults_poi(DirName, CaseName, OptModel, mTEPES):
    _path = _resolve_output_dir()
    StartTime   = time.time()

    SysCost     = pd.Series(data=[ OptModel.get_value(OptModel.eTotalTCost )                                         ], index=mTEPES.p).to_frame(name='系统总成本'         ).stack()
    GenInvCost  = pd.Series(data=[mTEPES.pDiscountFactor[p] * sum(mTEPES.pGenInvestCost[gc] * mTEPES.pRatedMaxPower[gc] * OptModel.get_value(OptModel.vGenerationInvest[p,gc]) for gc in mTEPES.gc) for p in mTEPES.p], index=mTEPES.p).to_frame(name='电源投资成本').stack()
    # GenRetCost  = pd.Series(data=[mTEPES.pDiscountFactor[p] * sum(mTEPES.pGenRetireCost[gd  ] * OptModel.get_value(OptModel.vGenerationRetire[p,gd  ])  for gd      in mTEPES.gd                                             )     for p in mTEPES.p], index=mTEPES.p).to_frame(name='Generation Retirement Cost').stack()
    # pNetFixedCost 为“单位公里线路投资成本”，因此总投资需乘以线路长度 pLineLength
    NetInvCost  = pd.Series(data=[mTEPES.pDiscountFactor[p] * sum(mTEPES.pNetFixedCost[(ni,nf,c)] * mTEPES.pLineLength[ni,nf,c] * OptModel.get_value(OptModel.vNetworkInvest[p,ni,nf,c]) for ni,nf,c in mTEPES.lc) for p in mTEPES.p], index=mTEPES.p).to_frame(name='网架投资成本'   ).stack()
    GenCost     = pd.Series(data=[mTEPES.pDiscountFactor[p] * sum(mTEPES.pScenProb     [p,sc] * OptModel.get_value(OptModel.vTotalGCost      [p,sc,n])  for sc in mTEPES.sc for n in mTEPES.n       if mTEPES.pScenProb[p,sc])     for p in mTEPES.p], index=mTEPES.p).to_frame(name='运维成本'       ).stack()
    # ConCost     = pd.Series(data=[mTEPES.pDiscountFactor[p] * sum(mTEPES.pScenProb     [p,sc] * OptModel.get_value(OptModel.vTotalCCost      [p,sc,n])  for sc in mTEPES.sc for n in mTEPES.n       if mTEPES.pScenProb[p,sc])     for p in mTEPES.p], index=mTEPES.p).to_frame(name='充电成本').stack()
    EmiCost     = pd.Series(data=[mTEPES.pDiscountFactor[p] * sum(mTEPES.pScenProb     [p,sc] * OptModel.get_value(OptModel.vTotalECost      [p,sc,n])  for sc in mTEPES.sc for n in mTEPES.n       if mTEPES.pScenProb[p,sc])     for p in mTEPES.p], index=mTEPES.p).to_frame(name='碳排放成本'     ).stack()
    RelCost     = pd.Series(data=[mTEPES.pDiscountFactor[p] * sum(mTEPES.pScenProb     [p,sc] * OptModel.get_value(OptModel.vTotalRCost      [p,sc,n])  for sc in mTEPES.sc for n in mTEPES.n       if mTEPES.pScenProb[p,sc])     for p in mTEPES.p], index=mTEPES.p).to_frame(name='缺供电量惩罚成本').stack()
    AbandCost   = pd.Series(data=[mTEPES.pDiscountFactor[p] * sum(mTEPES.pScenProb     [p,sc] * OptModel.get_value(OptModel.vTotalAbandonCost[p,sc,n])  for sc in mTEPES.sc for n in mTEPES.n       if mTEPES.pScenProb[p,sc])     for p in mTEPES.p], index=mTEPES.p).to_frame(name='弃风/弃光成本'   ).stack()
    CostSummary = pd.concat([GenInvCost, NetInvCost, GenCost, EmiCost, AbandCost])
    CostSummary = CostSummary.reset_index().rename(columns={'level_0': 'Period', 'level_1': 'Cost/Payment', 0: 'CNY'})
    # Keep 2 decimals in export
    CostSummary['CNY'] = pd.to_numeric(CostSummary['CNY'], errors='coerce').round(2)
    CostSummary.to_csv(_path+'/oT_Result_CostSummary_'+CaseName+'.csv', sep=',', index=False)
    '''
    for ar in mTEPES.ar:
        if len(mTEPES.ar) > 1:
            OutputToFile = pd.Series(data=[OptModel.vTotalOutput[p,sc,n,g]()*mTEPES.pLoadLevelDuration[n]() for p,sc,n,g in mTEPES.ps*mTEPES.n*mTEPES.g], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.g ))
            OutputToFile = pd.Series(data=[sum(OutputToFile[p,sc,n,g] for g in mTEPES.g if (ar,g) in mTEPES.a2g and (gt,g) in mTEPES.t2g) for p,sc,n,gt in mTEPES.ps*mTEPES.n*mTEPES.gt], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.gt))
            OutputToFile.to_frame(name='GWh').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='GWh', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_TechnologyEnergy_'+ar+'_'+CaseName+'.csv', sep=',')

            for p,sc in mTEPES.ps:
                chart = PiePlots(p, sc, OutputToFile, 'Technology', '%')
                chart.save(_path+'/oT_Plot_TechnologyEnergy_'+str(p)+'_'+str(sc)+'_'+ar+'_'+CaseName+'.html', embed_options={'renderer': 'svg'})
    '''
    # %%  Power balance per period, scenario, and load level
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
    
    NodeTech = [(p,sc,n,nd,gt) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd for gt in mTEPES.gt if sum(1 for g in mTEPES.g if (nd,g) in mTEPES.n2g) + sum(1 for lout in lout[nd]) + sum(1 for ni,cc in lin[nd])]
    NodeList = [(p,sc,n,nd)    for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd           if sum(1 for g in mTEPES.g if (nd,g) in mTEPES.n2g) + sum(1 for lout in lout[nd]) + sum(1 for ni,cc in lin[nd])]
    OutputResults1 = pd.Series(data=[ sum(OptModel.get_value(OptModel.vTotalOutput   [p,sc,n,g       ])*mTEPES.pLoadLevelDuration[n] for g  in mTEPES.g  if (nd,g ) in mTEPES.n2g and (gt,g ) in mTEPES.t2g) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd for gt in mTEPES.gt if sum(1 for g in mTEPES.g if (nd, g) in mTEPES.n2g) + sum(1 for lout in lout[nd]) + sum(1 for ni, cc in lin[nd])], index=pd.MultiIndex.from_tuples(NodeTech)).to_frame(name='Generation'   ).reset_index().pivot_table(index=['level_0','level_1','level_2','level_3'], columns='level_4', values='Generation' , aggfunc=sum)
    OutputResults2 = pd.Series(data=[-sum(OptModel.get_value(OptModel.vESSTotalCharge[p,sc,n,es      ])*mTEPES.pLoadLevelDuration[n] for es in mTEPES.es if (nd,es) in mTEPES.n2g and (gt,es) in mTEPES.t2g) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd for gt in mTEPES.gt if sum(1 for g in mTEPES.g if (nd, g) in mTEPES.n2g) + sum(1 for lout in lout[nd]) + sum(1 for ni, cc in lin[nd])], index=pd.MultiIndex.from_tuples(NodeTech)).to_frame(name='Consumption'  ).reset_index().pivot_table(index=['level_0','level_1','level_2','level_3'], columns='level_4', values='Consumption', aggfunc=sum)
    OutputResults3 = pd.Series(data=[     OptModel.get_value(OptModel.vENS           [p,sc,n,nd      ])*mTEPES.pLoadLevelDuration[n]                                                                         for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd           if sum(1 for g in mTEPES.g if (nd, g) in mTEPES.n2g) + sum(1 for lout in lout[nd]) + sum(1 for ni, cc in lin[nd])], index=pd.MultiIndex.from_tuples(NodeList)).to_frame(name='PNS'          )
    OutputResults4 = pd.Series(data=[-      mTEPES.pDemand        [p,sc,n,nd      ]  *mTEPES.pLoadLevelDuration[n]                                                                         for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd           if sum(1 for g in mTEPES.g if (nd, g) in mTEPES.n2g) + sum(1 for lout in lout[nd]) + sum(1 for ni, cc in lin[nd])], index=pd.MultiIndex.from_tuples(NodeList)).to_frame(name='PowerDemand'  )
    OutputResults5 = pd.Series(data=[-sum(OptModel.get_value(OptModel.vFlow          [p,sc,n,nd,nf,cc])*mTEPES.pLoadLevelDuration[n] for nf,cc in lout [nd])                                                 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd           if sum(1 for g in mTEPES.g if (nd, g) in mTEPES.n2g) + sum(1 for lout in lout[nd]) + sum(1 for ni, cc in lin[nd])], index=pd.MultiIndex.from_tuples(NodeList)).to_frame(name='PowerFlowOut' )
    OutputResults6 = pd.Series(data=[ sum(OptModel.get_value(OptModel.vFlow          [p,sc,n,ni,nd,cc])*mTEPES.pLoadLevelDuration[n] for ni,cc in lin  [nd])                                                 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd           if sum(1 for g in mTEPES.g if (nd, g) in mTEPES.n2g) + sum(1 for lout in lout[nd]) + sum(1 for ni, cc in lin[nd])], index=pd.MultiIndex.from_tuples(NodeList)).to_frame(name='PowerFlowIn'  )
    OutputResults7 = pd.Series(data=[-sum(OptModel.get_value(OptModel.vLineLosses    [p,sc,n,nd,nf,cc])*mTEPES.pLoadLevelDuration[n] for nf,cc in loutl[nd])                                                 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd           if sum(1 for g in mTEPES.g if (nd, g) in mTEPES.n2g) + sum(1 for lout in lout[nd]) + sum(1 for ni, cc in lin[nd])], index=pd.MultiIndex.from_tuples(NodeList)).to_frame(name='LineLossesOut')
    OutputResults8 = pd.Series(data=[-sum(OptModel.get_value(OptModel.vLineLosses    [p,sc,n,ni,nd,cc])*mTEPES.pLoadLevelDuration[n] for ni,cc in linl [nd])                                                 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd           if sum(1 for g in mTEPES.g if (nd, g) in mTEPES.n2g) + sum(1 for lout in lout[nd]) + sum(1 for ni, cc in lin[nd])], index=pd.MultiIndex.from_tuples(NodeList)).to_frame(name='LineLossesIn' )
    outputs_to_concat = [OutputResults1, OutputResults2, OutputResults3, OutputResults4, OutputResults5, OutputResults6, OutputResults7, OutputResults8]
    if hasattr(mTEPES, 'ev_node'):
        OutputResults9 = pd.Series(data=[- (sum(OptModel.get_value(var) / 1000000.0 for var in OptModel.grid_p_chr_vars.get((p,sc,n), [])) - sum(OptModel.get_value(var) / 1000000.0 for var in OptModel.grid_p_dis_vars.get((p,sc,n), []))) * mTEPES.pLoadLevelDuration[n] if nd in mTEPES.ev_node else 0.0 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd if sum(1 for g in mTEPES.g if (nd, g) in mTEPES.n2g) + sum(1 for lout in lout[nd]) + sum(1 for ni, cc in lin[nd])], index=pd.MultiIndex.from_tuples(NodeList)).to_frame(name='EVload')
        outputs_to_concat.append(OutputResults9)
    if hasattr(mTEPES, 'params_ammonia'):
        OutputResults10 = pd.Series(data=[- (OptModel.get_value(mTEPES.var_dict_ammonia['p_grid'][n]) / 1000000.0) * mTEPES.pLoadLevelDuration[n] if nd in mTEPES.params_ammonia['eh_node'] else 0.0 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd if sum(1 for g in mTEPES.g if (nd, g) in mTEPES.n2g) + sum(1 for lout in lout[nd]) + sum(1 for ni, cc in lin[nd])], index=pd.MultiIndex.from_tuples(NodeList)).to_frame(name='ANload')
        outputs_to_concat.append(OutputResults10)
    if hasattr(mTEPES, 'ht_node') and hasattr(mTEPES, 'n_to_t_map'):
        OutputResults11 = pd.Series(data=[- ((OptModel.get_value(OptModel.vP_hp_elec[mTEPES.n_to_t_map[n]])/1000 if hasattr(mTEPES, 'vP_hp_elec') else 0.0) + (OptModel.get_value(OptModel.vP_boiler_elec[mTEPES.n_to_t_map[n]])/1000 if hasattr(mTEPES, 'vP_boiler_elec') else 0.0) - (OptModel.get_value(OptModel.vP_chp_elec[mTEPES.n_to_t_map[n]])/1000 if hasattr(mTEPES, 'vP_chp_elec') else 0.0)) * mTEPES.pLoadLevelDuration[n] if nd in mTEPES.ht_node else 0.0 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd if sum(1 for g in mTEPES.g if (nd, g) in mTEPES.n2g) + sum(1 for lout in lout[nd]) + sum(1 for ni, cc in lin[nd])], index=pd.MultiIndex.from_tuples(NodeList)).to_frame(name='heatload')
        outputs_to_concat.append(OutputResults11)
        
    OutputResults = pd.concat(outputs_to_concat, axis=1)
    
    # 单位换算 MW (对于电量 MWh)，乘 1000，并保留 4 位小 
    OutputResults = (OutputResults * 1000).round(4)
    OutputResults.stack().reset_index().pivot_table(index=['level_0','level_1','level_2','level_4'], columns='level_3', values=0, aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel','Technology'], axis=0).to_csv(_path+'/oT_Result_BalanceEnergy_'+CaseName+'.csv', sep=',')
    
    
    '''
    OutputToFile = pd.Series(data=[(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelDuration[n]() * mTEPES.pLinearVarCost  [nr] * OptModel.vTotalOutput[p,sc,n,nr]() +
                                    mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelDuration[n]() * mTEPES.pConstantVarCost[nr] * OptModel.vCommitment [p,sc,n,nr]() +
                                    mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelWeight  [n]() * mTEPES.pStartUpCost    [nr] * OptModel.vStartUp    [p,sc,n,nr]() +
                                    mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelWeight  [n]() * mTEPES.pShutDownCost   [nr] * OptModel.vShutDown   [p,sc,n,nr]()) for p,sc,n,nr in mTEPES.ps*mTEPES.n*mTEPES.nr], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.nr))
    OutputToFile.to_frame(name='MEUR').reset_index().pivot_table(index=['level_0','level_1','level_2'],     columns='level_3', values='MEUR', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationCostOperation_'     +CaseName+'.csv', sep=',')

    if sum(mTEPES.pOperReserveUp[p,sc,n,ar]+mTEPES.pOperReserveDw[p,sc,n,ar] for p,sc,n,ar in mTEPES.ps*mTEPES.n*mTEPES.ar):
        OutputToFile = pd.Series(data=[(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelWeight[n]() * mTEPES.pOperReserveCost[nr] * OptModel.vReserveUp  [p,sc,n,nr]() +
                                        mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelWeight[n]() * mTEPES.pOperReserveCost[nr] * OptModel.vReserveDown[p,sc,n,nr]()) for p,sc,n,nr in mTEPES.ps*mTEPES.n*mTEPES.nr], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.nr))
        OutputToFile.to_frame(name='MEUR').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MEUR', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationCostOperReserve_'   +CaseName+'.csv', sep=',')

    if len(mTEPES.r):
        OutputToFile = pd.Series(data=[mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelDuration[n]() * mTEPES.pLinearOMCost [ r] * OptModel.vTotalOutput   [p,sc,n, r]() for p,sc,n, r in mTEPES.ps*mTEPES.n*mTEPES.r ], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.r ))
        OutputToFile.to_frame(name='MEUR').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MEUR', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationCostOandM_'         +CaseName+'.csv', sep=',')

    if len(mTEPES.es) and sum(mTEPES.pIndOperReserve[es] for es in mTEPES.es if mTEPES.pIndOperReserve[es] == 0) > 0:
        OutputToFile = pd.Series(data=[mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelDuration[n]() * mTEPES.pLinearVarCost[es] * OptModel.vESSTotalCharge[p,sc,n,es]()  for p,sc,n,es in mTEPES.ps*mTEPES.n*mTEPES.es], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.es))
        OutputToFile.to_frame(name='MEUR').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MEUR', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_ChargeCostOperation_'         +CaseName+'.csv', sep=',')
        OutputToFile = pd.Series(data=[(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelWeight[n]() * mTEPES.pOperReserveCost[es] * OptModel.vESSReserveUp  [p,sc,n,es]() +
                                        mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelWeight[n]() * mTEPES.pOperReserveCost[es] * OptModel.vESSReserveDown[p,sc,n,es]()) for p,sc,n,es in mTEPES.ps*mTEPES.n*mTEPES.es], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.es))
        OutputToFile.to_frame(name='MEUR').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MEUR', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_ChargeCostOperReserve_'+CaseName+'.csv', sep=',')
    
    # 碳排放结 
    OutputToFile = pd.Series(data=[mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelDuration[n]() * mTEPES.pCO2EmissionCost[nr] * OptModel.vTotalOutput[p,sc,n,nr]() for p,sc,n,nr in mTEPES.ps*mTEPES.n*mTEPES.nr], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.nr))
    OutputToFile.to_frame(name='MEUR').reset_index().pivot_table(index=['level_0','level_1','level_2'],     columns='level_3', values='MEUR', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationCostEmission_'      +CaseName+'.csv', sep=',')

    OutputToFile = pd.Series(data=[mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelDuration[n]() * mTEPES.pENSCost()           * OptModel.vENS        [p,sc,n,nd]() for p,sc,n,nd in mTEPES.ps*mTEPES.n*mTEPES.nd], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.nd))
    OutputToFile.to_frame(name='MEUR').reset_index().pivot_table(index=['level_0','level_1','level_2'],     columns='level_3', values='MEUR', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_NetworkCostENS_'              +CaseName+'.csv', sep=',')

    def Transformation1(df, _name):
        df = df.to_frame(name='MEUR')
        df['Cost'] = _name
        df = df.reset_index().pivot_table(index=['level_0', 'level_1', 'Cost'], values='MEUR', aggfunc=sum)
        return df

    for ar in mTEPES.ar:
        if len(mTEPES.ar) >= 1:
            OutputResults1 = pd.DataFrame(data={'MEUR': [0.0]}, index=[(p,sc,'Generation Operation Cost'         ) for p,sc in mTEPES.ps])
            OutputResults2 = pd.DataFrame(data={'MEUR': [0.0]}, index=[(p,sc,'Generation Operating Reserve Cost' ) for p,sc in mTEPES.ps])
            OutputResults3 = pd.DataFrame(data={'MEUR': [0.0]}, index=[(p,sc,'Generation O&M Cost'               ) for p,sc in mTEPES.ps])
            OutputResults4 = pd.DataFrame(data={'MEUR': [0.0]}, index=[(p,sc,'Consumption Operation Cost'        ) for p,sc in mTEPES.ps])
            OutputResults5 = pd.DataFrame(data={'MEUR': [0.0]}, index=[(p,sc,'Consumption Operating Reserve Cost') for p,sc in mTEPES.ps])
            OutputResults6 = pd.DataFrame(data={'MEUR': [0.0]}, index=[(p,sc,'Emission Cost'                     ) for p,sc in mTEPES.ps])
            OutputResults7 = pd.DataFrame(data={'MEUR': [0.0]}, index=[(p,sc,'Reliability Cost'                  ) for p,sc in mTEPES.ps])
            if len(mTEPES.nr):
                GenList = [(p,sc,n,nr) for p,sc,n,nr in mTEPES.ps*mTEPES.n*mTEPES.nr if (ar,nr) in mTEPES.a2g]
                if len(GenList):
                    OutputResults1 = pd.Series(data=[(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelDuration[n]() * mTEPES.pLinearVarCost  [nr] * OptModel.vTotalOutput[p,sc,n,nr]() +
                                                      mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelDuration[n]() * mTEPES.pConstantVarCost[nr] * OptModel.vCommitment [p,sc,n,nr]() +
                                                      mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelWeight  [n]() * mTEPES.pStartUpCost    [nr] * OptModel.vStartUp    [p,sc,n,nr]() +
                                                      mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelWeight  [n]() * mTEPES.pShutDownCost   [nr] * OptModel.vShutDown   [p,sc,n,nr]()) for p,sc,n,nr in mTEPES.ps*mTEPES.n*mTEPES.nr if (ar,nr) in mTEPES.a2g], index=pd.MultiIndex.from_tuples(GenList))
                    OutputResults1 = Transformation1(OutputResults1, 'Generation Operation Cost')

                if sum(mTEPES.pOperReserveUp[p,sc,n,ar]+mTEPES.pOperReserveDw[p,sc,n,ar] for p,sc,n,ar in mTEPES.ps*mTEPES.n*mTEPES.ar) and len(GenList):
                    OutputResults2 = pd.Series(data=[(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelWeight[n]() * mTEPES.pOperReserveCost[nr] * OptModel.vReserveUp  [p,sc,n,nr]() +
                                                      mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelWeight[n]() * mTEPES.pOperReserveCost[nr] * OptModel.vReserveDown[p,sc,n,nr]()) for p,sc,n,nr in mTEPES.ps*mTEPES.n*mTEPES.nr if (ar,nr) in mTEPES.a2g], index=pd.MultiIndex.from_tuples(GenList))
                    OutputResults2 = Transformation1(OutputResults2, 'Generation Operating Reserve Cost')

            if len(mTEPES.r):
                GenList = [(p,sc,n,r) for p,sc,n,r in mTEPES.ps*mTEPES.n*mTEPES.r if (ar,r) in mTEPES.a2g]
                if len(GenList):
                    OutputResults3 = pd.Series(data=[mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelDuration[n]() * mTEPES.pLinearOMCost [ r] * OptModel.vTotalOutput   [p,sc,n, r]() for p,sc,n, r in mTEPES.ps*mTEPES.n*mTEPES.r  if (ar,r ) in mTEPES.a2g], index=pd.MultiIndex.from_tuples(GenList))
                    OutputResults3 = Transformation1(OutputResults3, 'Generation O&M Cost')

            if len(mTEPES.es) and sum(mTEPES.pIndOperReserve[es] for es in mTEPES.es if mTEPES.pIndOperReserve[es] == 0) > 0:
                GenList = [(p,sc,n,es) for p,sc,n,es in mTEPES.ps*mTEPES.n*mTEPES.es if (ar,es) in mTEPES.a2g]
                if len(GenList):
                    OutputResults4 = pd.Series(data=[ mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelDuration[n]() * mTEPES.pLinearVarCost  [es] * OptModel.vESSTotalCharge[p,sc,n,es]()  for p,sc,n,es in mTEPES.ps*mTEPES.n*mTEPES.es if (ar,es) in mTEPES.a2g], index=pd.MultiIndex.from_tuples(GenList))
                    OutputResults5 = pd.Series(data=[(mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelWeight[n]()   * mTEPES.pOperReserveCost[es] * OptModel.vESSReserveUp  [p,sc,n,es]() +
                                                      mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelWeight[n]()   * mTEPES.pOperReserveCost[es] * OptModel.vESSReserveDown[p,sc,n,es]()) for p,sc,n,es in mTEPES.ps*mTEPES.n*mTEPES.es if (ar,es) in mTEPES.a2g], index=pd.MultiIndex.from_tuples(GenList))
                    OutputResults4 = Transformation1(OutputResults4, 'Consumption Operation Cost')
                    OutputResults5 = Transformation1(OutputResults5, 'Consumption Operating Reserve Cost')

            GenList = [(p,sc,n,nr) for p,sc,n,nr in mTEPES.ps*mTEPES.n*mTEPES.nr if (ar,nr) in mTEPES.a2g]
            if len(GenList):
                OutputResults6 = pd.Series(data=[mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelDuration[n]() * mTEPES.pCO2EmissionCost[nr] * OptModel.vTotalOutput[p,sc,n,nr]() for p,sc,n,nr in mTEPES.ps*mTEPES.n*mTEPES.nr if (ar,nr) in mTEPES.a2g], index=pd.MultiIndex.from_tuples(GenList))
                OutputResults6 = Transformation1(OutputResults6, 'Emission Cost')

            NodeList = [(p,sc,n,nd) for p,sc,n,nd in mTEPES.ps*mTEPES.n*mTEPES.nd if (nd,ar) in mTEPES.ndar]
            if len(NodeList):
                OutputResults7 = pd.Series(data=[mTEPES.pDiscountFactor[p] * mTEPES.pScenProb[p,sc] * mTEPES.pLoadLevelDuration[n]() * mTEPES.pENSCost()           * OptModel.vENS        [p,sc,n,nd]() for p,sc,n,nd in mTEPES.ps*mTEPES.n*mTEPES.nd if (nd,ar) in mTEPES.ndar], index=pd.MultiIndex.from_tuples(NodeList))
                OutputResults7 = Transformation1(OutputResults7, 'Reliability Cost')
        OutputResults = pd.concat([OutputResults1, OutputResults2, OutputResults3, OutputResults4, OutputResults5, OutputResults6, OutputResults7], axis=0)
        OutputResults.rename_axis(['Period', 'Scenario', 'Cost'], axis=0).to_csv(_path+'/oT_Result_CostSummary_'+ar+'_'+CaseName+'.csv', sep=',')
    '''
    #  KeyError: "Component with id '2258885842976': eBalance_2030_sc1_st1[2030,sc1,'01-01-00:00:00+8',Node8]" 问题注释
    # OutputResults = []
    # for p,sc,st in mTEPES.ps*mTEPES.st:
    #     mTEPES.del_component(mTEPES.st)
    #     mTEPES.del_component(mTEPES.n )
    #     mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and st == stt and mTEPES.pStageWeight[stt] and sum(1 for (st,nn) in mTEPES.s2n))
    #     mTEPES.n  = Set(initialize=mTEPES.nn , ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn      in                          mTEPES.pDuration         and           (st,nn) in mTEPES.s2n)
    #     if len(mTEPES.n):
    #         OutputToFile = pd.Series(data=[OptModel.dual[getattr(OptModel, 'eBalance_'+str(p)+'_'+str(sc)+'_'+str(st))[p,sc,n,nd]]/mTEPES.pPeriodProb[p,sc]()/mTEPES.pLoadLevelDuration[n]() * OptModel.vTotalOutput[p,sc,n,g]() for p,sc,n,nd,g in mTEPES.ps*mTEPES.n*mTEPES.n2g], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.n2g))
    #     OutputResults.append(OutputToFile)
    # mTEPES.del_component(mTEPES.st)
    # mTEPES.del_component(mTEPES.n )
    # mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and mTEPES.pStageWeight[stt] and sum(1 for (stt,nn) in mTEPES.s2n))
    # mTEPES.n  = Set(initialize=mTEPES.nn,  ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn  in                mTEPES.pDuration                                              )
    # OutputResults = pd.concat(OutputResults)
    # OutputResults.to_frame(name='MEUR').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_4', values='MEUR', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_RevenueEnergyGeneration_'+CaseName+'.csv', sep=',')

    # if len(mTEPES.es):
    #     OutputResults = []
    #     for p,sc,st in mTEPES.ps*mTEPES.st:
    #         mTEPES.del_component(mTEPES.st)
    #         mTEPES.del_component(mTEPES.n )
    #         mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and st == stt and mTEPES.pStageWeight[stt] and sum(1 for (st,nn) in mTEPES.s2n))
    #         mTEPES.n  = Set(initialize=mTEPES.nn , ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn      in                          mTEPES.pDuration         and           (st,nn) in mTEPES.s2n)
    #         if len(mTEPES.n):
    #             OutputToFile      = pd.Series(data=[OptModel.dual[getattr(OptModel, 'eBalance_'+str(p)+'_'+str(sc)+'_'+str(st))[p,sc,n,nd]]/mTEPES.pPeriodProb[p,sc]()/mTEPES.pLoadLevelDuration[n]() * OptModel.vESSTotalCharge[p,sc,n,es]() for p,sc,n,nd,es in mTEPES.ps*mTEPES.n*mTEPES.n2g if es in mTEPES.es], index=pd.MultiIndex.from_tuples([(p,sc,n,nd,es) for p,sc,n,nd,es in mTEPES.ps*mTEPES.n*mTEPES.n2g if es in mTEPES.es]))
    #         OutputResults.append(OutputToFile)
    #     mTEPES.del_component(mTEPES.st)
    #     mTEPES.del_component(mTEPES.n )
    #     mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and mTEPES.pStageWeight[stt] and sum(1 for (stt,nn) in mTEPES.s2n))
    #     mTEPES.n  = Set(initialize=mTEPES.nn,  ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn  in                mTEPES.pDuration                                              )
    #     OutputResults = pd.concat(OutputResults)
    #     OutputResults.to_frame(name='MEUR').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_4', values='MEUR', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_RevenueEnergyCharge_'+CaseName+'.csv', sep=',')

    # if len(mTEPES.gc):
    #     GenRev     = []
    #     ChargeRev  = []
    #     for p,sc,st in mTEPES.ps*mTEPES.st:
    #         mTEPES.del_component(mTEPES.st)
    #         mTEPES.del_component(mTEPES.n )
    #         mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and st == stt and mTEPES.pStageWeight[stt] and sum(1 for (st,nn) in mTEPES.s2n))
    #         mTEPES.n  = Set(initialize=mTEPES.nn , ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn      in                          mTEPES.pDuration         and           (st,nn) in mTEPES.s2n)
    #         if len(mTEPES.n):
    #             OutputToGenRev         = pd.Series(data=[OptModel.dual[getattr(OptModel, 'eBalance_'+str(p)+'_'+str(sc)+'_'+str(st))[p,sc,n,nd]]/mTEPES.pPeriodProb[p,sc]()/mTEPES.pLoadLevelDuration[n]() * OptModel.vTotalOutput   [p,sc,n,gc]() for p,sc,n,nd,gc in mTEPES.ps*mTEPES.n*mTEPES.n2g if gc in mTEPES.gc                                                 ], index=pd.MultiIndex.from_tuples([(p,sc,n,nd,gc) for p,sc,n,nd,gc in mTEPES.ps*mTEPES.n*mTEPES.n2g if gc in mTEPES.gc                                                 ]))
    #             GenRev.append       (OutputToGenRev    )
    #             if len([(p,sc,n,nd,gc) for p,sc,n,nd,gc in mTEPES.ps*mTEPES.n*mTEPES.n2g if gc in mTEPES.gc for ot in mTEPES.ot if (ot,gc)     in mTEPES.t2g]):
    #                 OutputChargeRevESS = pd.Series(data=[OptModel.dual[getattr(OptModel, 'eBalance_'+str(p)+'_'+str(sc)+'_'+str(st))[p,sc,n,nd]]/mTEPES.pPeriodProb[p,sc]()/mTEPES.pLoadLevelDuration[n]() * OptModel.vESSTotalCharge[p,sc,n,gc]() for p,sc,n,nd,gc in mTEPES.ps*mTEPES.n*mTEPES.n2g if gc in mTEPES.gc for ot in mTEPES.ot if (ot,gc)     in mTEPES.t2g], index=pd.MultiIndex.from_tuples([(p,sc,n,nd,gc) for p,sc,n,nd,gc in mTEPES.ps*mTEPES.n*mTEPES.n2g if gc in mTEPES.gc for ot in mTEPES.ot if (ot,gc)     in mTEPES.t2g]))
    #                 ChargeRev.append(OutputChargeRevESS)
    #             if len([(p,sc,n,nd,gc) for p,sc,n,nd,gc in mTEPES.ps*mTEPES.n*mTEPES.n2g if gc in mTEPES.gc for rt in mTEPES.rt if (rt,gc)     in mTEPES.t2g]):
    #                 OutputChargeRevRES = pd.Series(data=[OptModel.dual[getattr(OptModel, 'eBalance_'+str(p)+'_'+str(sc)+'_'+str(st))[p,sc,n,nd]]/mTEPES.pPeriodProb[p,sc]() * 0.0                                                                  for p,sc,n,nd,gc in mTEPES.ps*mTEPES.n*mTEPES.n2g if gc in mTEPES.gc for rt in mTEPES.rt if (rt,gc)     in mTEPES.t2g], index=pd.MultiIndex.from_tuples([(p,sc,n,nd,gc) for p,sc,n,nd,gc in mTEPES.ps*mTEPES.n*mTEPES.n2g if gc in mTEPES.gc for rt in mTEPES.rt if (rt,gc)     in mTEPES.t2g]))
    #                 ChargeRev.append(OutputChargeRevRES)
    #             if len([(p,sc,n,nd,gc) for p,sc,n,nd,gc in mTEPES.ps*mTEPES.n*mTEPES.n2g if gc in mTEPES.gc for ot in mTEPES.ot if (ot,gc) not in mTEPES.t2g]):
    #                 OutputChargeRevThr = pd.Series(data=[OptModel.dual[getattr(OptModel, 'eBalance_'+str(p)+'_'+str(sc)+'_'+str(st))[p,sc,n,nd]]/mTEPES.pPeriodProb[p,sc]() * 0.0                                                                  for p,sc,n,nd,gc in mTEPES.ps*mTEPES.n*mTEPES.n2g if gc in mTEPES.gc for ot in mTEPES.ot if (ot,gc) not in mTEPES.t2g], index=pd.MultiIndex.from_tuples([(p,sc,n,nd,gc) for p,sc,n,nd,gc in mTEPES.ps*mTEPES.n*mTEPES.n2g if gc in mTEPES.gc for ot in mTEPES.ot if (ot,gc) not in mTEPES.t2g]))
    #                 ChargeRev.append(OutputChargeRevThr)
    #     mTEPES.del_component(mTEPES.st)
    #     mTEPES.del_component(mTEPES.n )
    #     mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and mTEPES.pStageWeight[stt] and sum(1 for (stt,nn) in mTEPES.s2n))
    #     mTEPES.n  = Set(initialize=mTEPES.nn,  ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn  in                mTEPES.pDuration                                              )
    #     GenRev    = pd.concat(GenRev)
    #     ChargeRev = pd.concat(ChargeRev)
    #     GenRev    = GenRev.to_frame   ('MEUR').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_4', values='MEUR', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).sum(axis=0)
    #     ChargeRev = ChargeRev.to_frame('MEUR').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_4', values='MEUR', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).sum(axis=0)
    # else:
    #     GenRev    = pd.Series(data=[0.0 for gc in mTEPES.gc], index=mTEPES.gc, dtype='float64')
    #     ChargeRev = pd.Series(data=[0.0 for gc in mTEPES.gc], index=mTEPES.gc, dtype='float64')

    # if sum(mTEPES.pReserveMargin[ar] for ar in mTEPES.ar):
    #     if len(mTEPES.gc):
    #         IndexResRev    = [(st,ar,gc) for st,ar,gc in mTEPES.st*mTEPES.ar*mTEPES.gc if mTEPES.pReserveMargin[ar] and (ar,gc) in mTEPES.a2g]
    #         OutputToResRev = pd.Series(data=[OptModel.dual[getattr(OptModel, 'eAdequacyReserveMargin_'+str(p)+'_'+str(sc)+'_'+str(st))[p,ar]]*mTEPES.pRatedMaxPower[gc]*mTEPES.pAvailability[gc]/1e3 for st,ar,gc in IndexResRev], index=pd.MultiIndex.from_tuples(IndexResRev))
    #         OutputToResRev = OutputToResRev.to_frame(name='MEUR').reset_index().pivot_table(index=['level_0','level_1'], columns='level_2', values='MEUR').rename_axis(['Stages','Areas'], axis=0).rename_axis([None], axis=1).sum(axis=0)
    #         ResRev         = pd.Series(data=[0.0 for gc in mTEPES.gc], index=mTEPES.gc, dtype='float64')
    #         for g in OutputToResRev.index:
    #             ResRev[g] = OutputToResRev[g]
    #     else:
    #         ResRev = pd.Series(data=[0.0 for gc in mTEPES.gc], index=mTEPES.gc, dtype='float64')
    # else:
    #     ResRev     = pd.Series(data=[0.0 for gc in mTEPES.gc], index=mTEPES.gc, dtype='float64')

    # if sum(mTEPES.pOperReserveUp[p,sc,n,ar] for p,sc,n,ar in mTEPES.ps*mTEPES.n*mTEPES.ar) > 0.0 and (sum(1 for ar,nr in mTEPES.ar*mTEPES.nr if (ar,nr) in mTEPES.a2g and mTEPES.pIndOperReserve[nr] == 0) + sum(1 for ar,es in mTEPES.ar*mTEPES.es if (ar,es) in mTEPES.a2g and mTEPES.pIndOperReserve[es] == 0)) > 0:
    #     if len([(p,sc,n,ar,nr) for p,sc,n,ar,nr in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveUp[p,sc,n,ar] and nr in mTEPES.nr]):
    #         OutputResults = []
    #         for p,sc,st in mTEPES.ps*mTEPES.st:
    #             mTEPES.del_component(mTEPES.st)
    #             mTEPES.del_component(mTEPES.n )
    #             mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and st == stt and mTEPES.pStageWeight[stt] and sum(1 for (st,nn) in mTEPES.s2n))
    #             mTEPES.n  = Set(initialize=mTEPES.nn , ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn      in                          mTEPES.pDuration         and           (st,nn) in mTEPES.s2n)
    #             if len(mTEPES.n):
    #                 OutputToFile = pd.Series(data=[OptModel.dual[getattr(OptModel, 'eOperReserveUp_'+str(p)+'_'+str(sc)+'_'+str(st))[p,sc,n,ar]]/mTEPES.pPeriodProb[p,sc]()*OptModel.vReserveUp   [p,sc,n,nr]() for p,sc,n,ar,nr in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveUp[p,sc,n,ar] and nr in mTEPES.nr], index=pd.MultiIndex.from_tuples([(p,sc,n,ar,nr) for p,sc,n,ar,nr in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveUp[p,sc,n,ar] and nr in mTEPES.nr]))
    #             OutputResults.append(OutputToFile)
    #         mTEPES.del_component(mTEPES.st)
    #         mTEPES.del_component(mTEPES.n )
    #         mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and mTEPES.pStageWeight[stt] and sum(1 for (stt,nn) in mTEPES.s2n))
    #         mTEPES.n  = Set(initialize=mTEPES.nn,  ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn  in                mTEPES.pDuration                                              )
    #         OutputResults = pd.concat(OutputResults)
    #         OutputResults.to_frame(name='MEUR').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_4', values='MEUR').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_RevenueOperatingReserveUp_'+CaseName+'.csv', sep=',')
    #     if len([(p,sc,n,ar,es) for p,sc,n,ar,es in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveUp[p,sc,n,ar] and es in mTEPES.es]):
    #         OutputResults = []
    #         for p,sc,st in mTEPES.ps*mTEPES.st:
    #             mTEPES.del_component(mTEPES.st)
    #             mTEPES.del_component(mTEPES.n )
    #             mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and st == stt and mTEPES.pStageWeight[stt] and sum(1 for (st,nn) in mTEPES.s2n))
    #             mTEPES.n  = Set(initialize=mTEPES.nn , ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn      in                          mTEPES.pDuration         and           (st,nn) in mTEPES.s2n)
    #             if len(mTEPES.n):
    #                 OutputToFile = pd.Series(data=[OptModel.dual[getattr(OptModel, 'eOperReserveUp_'+str(p)+'_'+str(sc)+'_'+str(st))[p,sc,n,ar]]/mTEPES.pPeriodProb[p,sc]()*OptModel.vESSReserveUp[p,sc,n,es]() for p,sc,n,ar,es in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveUp[p,sc,n,ar] and es in mTEPES.es], index=pd.MultiIndex.from_tuples([(p,sc,n,ar,es) for p,sc,n,ar,es in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveUp[p,sc,n,ar] and es in mTEPES.es]))
    #             OutputResults.append(OutputToFile)
    #         mTEPES.del_component(mTEPES.st)
    #         mTEPES.del_component(mTEPES.n )
    #         mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and mTEPES.pStageWeight[stt] and sum(1 for (stt,nn) in mTEPES.s2n))
    #         mTEPES.n  = Set(initialize=mTEPES.nn,  ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn  in                mTEPES.pDuration                                              )
    #         OutputResults = pd.concat(OutputResults)
    #         OutputResults.to_frame(name='MEUR').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_4', values='MEUR').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_RevenueOperatingReserveUpESS_'+CaseName+'.csv', sep=',')
    #     if len([(p,sc,n,ar,gc) for p,sc,n,ar,gc in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveUp[p,sc,n,ar] and gc in mTEPES.gc]):
    #         OutputResults = []
    #         for p,sc,st in mTEPES.ps*mTEPES.st:
    #             mTEPES.del_component(mTEPES.st)
    #             mTEPES.del_component(mTEPES.n )
    #             mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and st == stt and mTEPES.pStageWeight[stt] and sum(1 for (st,nn) in mTEPES.s2n))
    #             mTEPES.n  = Set(initialize=mTEPES.nn , ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn      in                          mTEPES.pDuration         and           (st,nn) in mTEPES.s2n)
    #             if len(mTEPES.n):
    #                 OutputToFile = pd.Series(data=[OptModel.dual[getattr(OptModel, 'eOperReserveUp_'+str(p)+'_'+str(sc)+'_'+str(st))[p,sc,n,ar]]/mTEPES.pPeriodProb[p,sc]()*OptModel.vESSReserveUp[p,sc,n,ec]() for p,sc,n,ar,ec in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveUp[p,sc,n,ar] and ec in mTEPES.ec], index=pd.MultiIndex.from_tuples([(p,sc,n,ar,ec) for p,sc,n,ar,ec in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveUp[p,sc,n,ar] and ec in mTEPES.ec]))
    #             OutputResults.append(OutputToFile)
    #         mTEPES.del_component(mTEPES.st)
    #         mTEPES.del_component(mTEPES.n )
    #         mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and mTEPES.pStageWeight[stt] and sum(1 for (stt,nn) in mTEPES.s2n))
    #         mTEPES.n  = Set(initialize=mTEPES.nn,  ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn  in                mTEPES.pDuration                                              )
    #         OutputResults    = pd.concat(OutputResults)
    #         OutputToUpRev = OutputResults.to_frame('MEUR').reset_index().pivot_table(index=['level_0', 'level_1', 'level_2'], columns='level_4', values='MEUR').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).sum(axis=0)
    #         UpRev         = pd.Series(data=[0.0 for gc in mTEPES.gc], index=mTEPES.gc, dtype='float64')
    #         for g in OutputToUpRev.index:
    #             UpRev[g] = OutputToUpRev[g]
    #     else:
    #         UpRev = pd.Series(data=[0.0 for gc in mTEPES.gc], index=mTEPES.gc, dtype='float64')
    # else:
    #     UpRev     = pd.Series(data=[0.0 for gc in mTEPES.gc], index=mTEPES.gc, dtype='float64')

    # if sum(mTEPES.pOperReserveDw[p,sc,n,ar] for p,sc,n,ar in mTEPES.ps*mTEPES.n*mTEPES.ar) > 0.0 and (sum(1 for ar,nr in mTEPES.ar*mTEPES.nr if (ar,nr) in mTEPES.a2g and mTEPES.pIndOperReserve[nr] == 0) + sum(1 for ar,es in mTEPES.ar*mTEPES.es if (ar,es) in mTEPES.a2g and mTEPES.pIndOperReserve[es] == 0)) > 0:
    #     if len([(p,sc,n,ar,nr) for p,sc,n,ar,nr in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveUp[p,sc,n,ar] and nr in mTEPES.nr]):
    #         OutputResults = []
    #         for p,sc,st in mTEPES.ps*mTEPES.st:
    #             mTEPES.del_component(mTEPES.st)
    #             mTEPES.del_component(mTEPES.n )
    #             mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and st == stt and mTEPES.pStageWeight[stt] and sum(1 for (st,nn) in mTEPES.s2n))
    #             mTEPES.n  = Set(initialize=mTEPES.nn , ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn      in                          mTEPES.pDuration         and           (st,nn) in mTEPES.s2n)
    #             if len(mTEPES.n):
    #                 OutputToFile = pd.Series(data=[OptModel.dual[getattr(OptModel, 'eOperReserveDw_'+str(p)+'_'+str(sc)+'_'+str(st))[p,sc,n,ar]]/mTEPES.pPeriodProb[p,sc]()*OptModel.vReserveDown   [p,sc,n,nr]() for p,sc,n,ar,nr in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveDw[p,sc,n,ar] and nr in mTEPES.nr], index=pd.MultiIndex.from_tuples([(p,sc,n,ar,nr) for p,sc,n,ar,nr in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveDw[p,sc,n,ar] and nr in mTEPES.nr]))
    #             OutputResults.append(OutputToFile)
    #         mTEPES.del_component(mTEPES.st)
    #         mTEPES.del_component(mTEPES.n )
    #         mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and mTEPES.pStageWeight[stt] and sum(1 for (stt,nn) in mTEPES.s2n))
    #         mTEPES.n  = Set(initialize=mTEPES.nn,  ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn  in                mTEPES.pDuration                                              )
    #         OutputResults = pd.concat(OutputResults)
    #         OutputResults.to_frame(name='MEUR').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_4', values='MEUR').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_RevenueOperatingReserveDw_'+CaseName+'.csv', sep=',')
    #     if len([(p,sc,n,ar,es) for p,sc,n,ar,es in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveUp[p,sc,n,ar] and es in mTEPES.es]):
    #         OutputResults = []
    #         for p,sc,st in mTEPES.ps*mTEPES.st:
    #             mTEPES.del_component(mTEPES.st)
    #             mTEPES.del_component(mTEPES.n )
    #             mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and st == stt and mTEPES.pStageWeight[stt] and sum(1 for (st,nn) in mTEPES.s2n))
    #             mTEPES.n  = Set(initialize=mTEPES.nn , ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn      in                          mTEPES.pDuration         and           (st,nn) in mTEPES.s2n)
    #             if len(mTEPES.n):
    #                 OutputToFile = pd.Series(data=[OptModel.dual[getattr(OptModel, 'eOperReserveDw_'+str(p)+'_'+str(sc)+'_'+str(st))[p,sc,n,ar]]/mTEPES.pPeriodProb[p,sc]()*OptModel.vESSReserveDown[p,sc,n,es]() for p,sc,n,ar,es in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveDw[p,sc,n,ar] and es in mTEPES.es], index=pd.MultiIndex.from_tuples([(p,sc,n,ar,es) for p,sc,n,ar,es in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveDw[p,sc,n,ar] and es in mTEPES.es]))
    #             OutputResults.append(OutputToFile)
    #         mTEPES.del_component(mTEPES.st)
    #         mTEPES.del_component(mTEPES.n )
    #         mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and mTEPES.pStageWeight[stt] and sum(1 for (stt,nn) in mTEPES.s2n))
    #         mTEPES.n  = Set(initialize=mTEPES.nn,  ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn  in                mTEPES.pDuration                                              )
    #         OutputResults = pd.concat(OutputResults)
    #         OutputResults.to_frame(name='MEUR').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_4', values='MEUR').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_RevenueOperatingReserveDwESS_'+CaseName+'.csv', sep=',')
    #     if len([(p,sc,n,ar,gc) for p,sc,n,ar,gc in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveUp[p,sc,n,ar] and gc in mTEPES.gc]):
    #         OutputResults = []
    #         for p,sc,st in mTEPES.ps*mTEPES.st:
    #             mTEPES.del_component(mTEPES.st)
    #             mTEPES.del_component(mTEPES.n )
    #             mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and st == stt and mTEPES.pStageWeight[stt] and sum(1 for (st,nn) in mTEPES.s2n))
    #             mTEPES.n  = Set(initialize=mTEPES.nn , ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn      in                          mTEPES.pDuration         and           (st,nn) in mTEPES.s2n)
    #             if len(mTEPES.n):
    #                 OutputToFile = pd.Series(data=[OptModel.dual[getattr(OptModel, 'eOperReserveDw_'+str(p)+'_'+str(sc)+'_'+str(st))[p,sc,n,ar]]/mTEPES.pPeriodProb[p,sc]()*OptModel.vESSReserveDown[p,sc,n,ec]() for p,sc,n,ar,ec in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveDw[p,sc,n,ar] and ec in mTEPES.ec], index=pd.MultiIndex.from_tuples([(p,sc,n,ar,ec) for p,sc,n,ar,ec in mTEPES.ps*mTEPES.n*mTEPES.a2g if mTEPES.pOperReserveDw[p,sc,n,ar] and ec in mTEPES.ec]))
    #             OutputResults.append(OutputToFile)
    #         mTEPES.del_component(mTEPES.st)
    #         mTEPES.del_component(mTEPES.n )
    #         mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and mTEPES.pStageWeight[stt] and sum(1 for (stt,nn) in mTEPES.s2n))
    #         mTEPES.n  = Set(initialize=mTEPES.nn,  ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn  in                mTEPES.pDuration                                              )
    #         OutputResults    = pd.concat(OutputResults)
    #         OutputToDwRev = OutputResults.to_frame('MEUR').reset_index().pivot_table(index=['level_0', 'level_1', 'level_2'], columns='level_4', values='MEUR').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).sum(axis=0)
    #         DwRev         = pd.Series(data=[0.0 for gc in mTEPES.gc], index=mTEPES.gc, dtype='float64')
    #         for g in OutputToDwRev.index:
    #             DwRev[g] = OutputToDwRev[g]
    #     else:
    #         DwRev = pd.Series(data=[0.0 for gc in mTEPES.gc], index=mTEPES.gc, dtype='float64')
    # else:
    #     DwRev     = pd.Series(data=[0.0 for gc in mTEPES.gc], index=mTEPES.gc, dtype='float64')

    # if len(mTEPES.gc):
    #     InvCost = pd.Series(data=[mTEPES.pGenInvestCost[gc] for gc in mTEPES.gc], index= pd.Index(mTEPES.gc), dtype='float64')
    #     Balance = pd.Series(data=[GenRev[gc]+ChargeRev[gc]+UpRev[gc]+DwRev[gc]+ResRev[gc]-InvCost[gc] for gc in mTEPES.gc], index= pd.Index(mTEPES.gc), dtype='float64')
    #     CostRecoveryESS = pd.concat([GenRev,ChargeRev,UpRev,DwRev,ResRev,InvCost,Balance], axis=1, keys=['Generation revenue [MEUR]','Consumption revenue [MEUR]','Up reserve revenue [MEUR]','Down reserve revenue [MEUR]','Reserve capacity revenue [MEUR]','Investment Cost [MEUR]','Balance [MEUR]'])
    #     CostRecoveryESS.stack().to_frame(name='MEUR').reset_index().pivot_table(values='MEUR', index=['level_1'], columns=['level_0']).rename_axis([None], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_CostRecovery_'+CaseName+'.csv', index=True, sep=',')

    WritingResultsTime = time.time() - StartTime
    print('Writing             economic results   ... ', round(WritingResultsTime), 's')


def NetworkMapResults_poi(DirName, CaseName, OptModel, mTEPES):
    _path = _resolve_output_dir()
    DIR   = os.path.dirname(__file__)
    StartTime = time.time()

    # # Sub functions
    # def oT_make_series(_var, _sets, _factor):
    #     return pd.Series(data=[OptModel.get_value(_var[p,sc,n,ni,nf,cc]) * _factor for p,sc,n,ni,nf,cc in _sets], index=pd.MultiIndex.from_tuples(list(_sets)))

    def oT_selecting_data(p,sc,n):
        # Nodes data
        pio.renderers.default = 'chrome'

        loc_df = pd.Series(data=[mTEPES.pNodeLat[i] for i in mTEPES.nd], index=mTEPES.nd).to_frame(name='Lat')
        loc_df['Lon'   ] =  0.0
        loc_df['Zone'  ] =  0.0
        loc_df['Demand'] =  0.0
        loc_df['Size'  ] = 15.0

        for nd,zn in mTEPES.ndzn:
            loc_df['Lon'   ][nd] = mTEPES.pNodeLon[nd]
            loc_df['Zone'  ][nd] = zn
            loc_df['Demand'][nd] = mTEPES.pDemand[p,sc,n,nd]*1e3

        loc_df = loc_df.reset_index().rename(columns={'Type': 'Scenario'}, inplace=False)

        # Edges data
        # OutputToFile = oT_make_series(OptModel.vFlow, mTEPES.ps*mTEPES.n*mTEPES.la, 1e3)
        OutputToFile = pd.Series(data=[OptModel.get_value(OptModel.vFlow[p,sc,n,ni,nf,cc]) * 1e3 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for ni,nf,cc in mTEPES.la], index=pd.MultiIndex.from_tuples((p,sc,n,ni,nf,cc) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for ni,nf,cc in mTEPES.la))
        OutputToFile.index.names = ['Period','Scenario','LoadLevel', 'InitialNode', 'FinalNode', 'Circuit']
        OutputToFile = OutputToFile.to_frame(name='MW')

        # tolerance to consider avoid division by 0
        pEpsilon = 1e-6

        line_df = pd.DataFrame(data={'NTCFrw': pd.Series(data=[mTEPES.pLineNTCFrw[i] * 1e3 + pEpsilon for i in mTEPES.la], index=pd.MultiIndex.from_tuples(mTEPES.la)),
                                     'NTCBck': pd.Series(data=[mTEPES.pLineNTCBck[i] * 1e3 + pEpsilon for i in mTEPES.la], index=pd.MultiIndex.from_tuples(mTEPES.la))}, index=pd.MultiIndex.from_tuples(mTEPES.la))
        line_df['vFlow'      ] = 0.0
        line_df['utilization'] = 0.0
        line_df['color'      ] = 0.0
        line_df['voltage'    ] = 0.0
        line_df['width'      ] = 0.0
        line_df['lon'        ] = 0.0
        line_df['lat'        ] = 0.0
        line_df['ni'         ] = 0.0
        line_df['nf'         ] = 0.0
        line_df['cc'         ] = 0.0

        line_df = line_df.groupby(level=[0,1]).sum()
        ncolors = 11
        colors = list(Color('lightgreen').range_to(Color('darkred'), ncolors))
        colors = ['rgb'+str(x.rgb) for x in colors]

        for ni,nf,cc in mTEPES.la:
            line_df['vFlow'      ][ni,nf] += OutputToFile['MW'][p,sc,n,ni,nf,cc]
            line_df['utilization'][ni,nf]  = max(line_df['vFlow'][ni,nf]/line_df['NTCFrw'][ni,nf],-line_df['vFlow'][ni,nf]/line_df['NTCBck'][ni,nf])*100.0
            line_df['lon'        ][ni,nf]  = (mTEPES.pNodeLon[ni]+mTEPES.pNodeLon[nf]) * 0.5
            line_df['lat'        ][ni,nf]  = (mTEPES.pNodeLat[ni]+mTEPES.pNodeLat[nf]) * 0.5
            line_df['ni'         ][ni,nf]  = ni
            line_df['nf'         ][ni,nf]  = nf
            line_df['cc'         ][ni,nf] += 1

            if   0.0 <= line_df['utilization'][ni,nf] <= 10.0:
                line_df['color'][ni,nf] = colors[0]
            if  10.0 <  line_df['utilization'][ni,nf] <= 20.0:
                line_df['color'][ni,nf] = colors[1]
            if  20.0 <  line_df['utilization'][ni,nf] <= 30.0:
                line_df['color'][ni,nf] = colors[2]
            if  30.0 <  line_df['utilization'][ni,nf] <= 40.0:
                line_df['color'][ni,nf] = colors[3]
            if  40.0 <  line_df['utilization'][ni,nf] <= 50.0:
                line_df['color'][ni,nf] = colors[4]
            if  50.0 <  line_df['utilization'][ni,nf] <= 60.0:
                line_df['color'][ni,nf] = colors[5]
            if  60.0 <  line_df['utilization'][ni,nf] <= 70.0:
                line_df['color'][ni,nf] = colors[6]
            if  70.0 <  line_df['utilization'][ni,nf] <= 80.0:
                line_df['color'][ni,nf] = colors[7]
            if  80.0 <  line_df['utilization'][ni,nf] <= 90.0:
                line_df['color'][ni,nf] = colors[8]
            if  90.0 <  line_df['utilization'][ni,nf] <= 100.0:
                line_df['color'][ni,nf] = colors[9]
            if 100.0 <  line_df['utilization'][ni,nf]:
                line_df['color'][ni,nf] = colors[10]

            line_df['voltage'][ni,nf] = mTEPES.pLineVoltage[ni,nf,cc]
            if   700 < line_df['voltage'][ni,nf] <= 900:
                line_df['width'][ni,nf] = 4
            elif 500 < line_df['voltage'][ni,nf] <= 700:
                line_df['width'][ni,nf] = 3
            elif 350 < line_df['voltage'][ni,nf] <= 500:
                line_df['width'][ni,nf] = 2.5
            elif 290 < line_df['voltage'][ni,nf] <= 350:
                line_df['width'][ni,nf] = 2
            elif 200 < line_df['voltage'][ni,nf] <= 290:
                line_df['width'][ni,nf] = 1.5
            elif  50 < line_df['voltage'][ni,nf] <= 200:
                line_df['width'][ni,nf] = 1
            else:
                line_df['width'][ni,nf] = 0.5

        # Rounding to decimals
        line_df = line_df.round(decimals=2)

        return loc_df, line_df

    p = list(mTEPES.p)[0]
    load_levels = list(mTEPES.n)

    if len(mTEPES.sc) > 1:
        for scc in mTEPES.sc:
            if mTEPES.pScenProb[p,scc] == 1.0:
                sc = scc
    else:
        sc = list(mTEPES.sc)[0]

    # 预先计算每个时刻的数据（将每个时刻存为一 frame 
    n0 = load_levels[0]
    loc_df0, line_df0 = oT_selecting_data(p, sc, n0)

    x, y = loc_df0['Lon'].values, loc_df0['Lat'].values
    pos_dict = {}
    for index, iata in enumerate(loc_df0['index']):
        pos_dict[iata] = (x[index], y[index])

    token = open(DIR+'/openTEPES.mapbox_token').read()

    # 创建基础 trace：节 + 每条 + 线路标签
    n_lines = len(list(mTEPES.la))
    n_traces = 1 + n_lines + 1   # 节点迹迹 + 线路迹迹 + 线路标签迹迹

    fig = go.Figure()

    # trace 0: 节点
    fig.add_trace(go.Scattermapbox(
        lat=loc_df0['Lat'], lon=loc_df0['Lon'], mode='markers',
        marker=go.scattermapbox.Marker(size=loc_df0['Size']*10, sizeref=1.1, sizemode='area', color='LightSkyBlue'),
        hoverinfo='text',
        text='<br>节点名称: ' + loc_df0['index'] + '<br>负荷[MW]: ' + loc_df0['Demand'].astype(str),
        name='节点'
    ))

    # trace 1..n_lines: 线路 
    la_list = list(mTEPES.la)
    for ni, nf, cc in la_list:
        fig.add_trace(go.Scattermapbox(
            lon=[pos_dict[ni][0], pos_dict[nf][0]],
            lat=[pos_dict[ni][1], pos_dict[nf][1]],
            mode='lines+markers',
            marker=dict(size=0),
            line=dict(width=line_df0['width'][ni, nf], color=line_df0['color'][ni, nf]),
            opacity=1, hoverinfo='skip'
        ))

    # trace -1: 线路中点标签
    fig.add_trace(go.Scattermapbox(
        lat=line_df0['lat'], lon=line_df0['lon'], mode='markers',
        marker=go.scattermapbox.Marker(size=15, color='LightSkyBlue'),
        opacity=0, hoverinfo='text',
        text='<br>线路: ' + line_df0['ni'] + ' - ' + line_df0['nf'] +
             '<br>潮流[MW]: ' + line_df0['vFlow'].astype(str) +
             '<br>利用率[%]: ' + line_df0['utilization'].astype(str),
        name='线路'
    ))

    # 逐个时刻生成 frames
    frames = []
    slider_steps = []
    # 为减少运行时间，使用抽样（最 168 个时 = 7 天）
    max_frames = 168
    sample_step = max(1, len(load_levels) // max_frames)
    sampled_levels = load_levels[::sample_step]

    for n_cur in sampled_levels:
        loc_df_t, line_df_t = oT_selecting_data(p, sc, n_cur)

        # 节点 hover 文本更新
        node_text = '<br>节点名称: ' + loc_df_t['index'] + '<br>负荷[MW]: ' + loc_df_t['Demand'].astype(str)

        # 线路更新：使用完 go.Scattermapbox 对象，避 Plotly 解析 dict key 路径报错
        frame_data = [go.Scattermapbox(
            lat=loc_df_t['Lat'].tolist(), lon=loc_df_t['Lon'].tolist(),
            mode='markers', hoverinfo='text', text=node_text.tolist()
        )]
        for ni, nf, cc in la_list:
            frame_data.append(go.Scattermapbox(
                lon=[pos_dict[ni][0], pos_dict[nf][0]],
                lat=[pos_dict[ni][1], pos_dict[nf][1]],
                mode='lines', marker=dict(size=0),
                line=dict(color=line_df_t['color'].get((ni, nf), 'lightgreen'),
                          width=line_df_t['width'].get((ni, nf), 1)),
                hoverinfo='skip'
            ))
        frame_data.append(go.Scattermapbox(
            lat=line_df_t['lat'].tolist(), lon=line_df_t['lon'].tolist(),
            mode='markers', marker=dict(size=15, color='LightSkyBlue'),
            opacity=0, hoverinfo='text',
            text=('<br>线路: ' + line_df_t['ni'] + ' - ' + line_df_t['nf'] +
                  '<br>潮流[MW]: ' + line_df_t['vFlow'].astype(str) +
                  '<br>利用率[%]: ' + line_df_t['utilization'].astype(str)).tolist()
        ))

        frame = go.Frame(
            data=frame_data,
            traces=list(range(n_traces)),
            name=str(n_cur),
            layout=go.Layout(title_text='系统潮流分布<br>时刻: ' + str(n_cur))
        )
        frames.append(frame)
        slider_steps.append(dict(
            args=[[str(n_cur)], dict(frame=dict(duration=0, redraw=True), mode='immediate', transition=dict(duration=0))],
            label=str(n_cur)[:13],
            method='animate'
        ))

    fig.frames = frames

    map_center = dict(
        lat=(loc_df0['Lat'].max() + loc_df0['Lat'].min()) * 0.5,
        lon=(loc_df0['Lon'].max() + loc_df0['Lon'].min()) * 0.5
    )

    fig.update_layout(
        title={'text': '系统潮流分布<br>时刻: ' + str(n0), 'x': 0.5, 'xanchor': 'center', 'yanchor': 'top'},
        font=dict(size=9),
        hovermode='closest',
        mapbox=dict(style='dark', accesstoken=token, bearing=0, center=map_center, pitch=0, zoom=3),
        showlegend=False,
        updatemenus=[dict(
            type='buttons', showactive=False, x=0.01, y=0.01, xanchor='left', yanchor='bottom',
            buttons=[
                dict(label=' 播放', method='animate',
                     args=[None, dict(frame=dict(duration=300, redraw=True), fromcurrent=True, mode='immediate', transition=dict(duration=0))]),
                dict(label=' 暂停', method='animate',
                     args=[[None], dict(frame=dict(duration=0, redraw=False), mode='immediate', transition=dict(duration=0))])
            ]
        )],
        sliders=[dict(
            active=0,
            currentvalue=dict(prefix='当前时刻: ', visible=True, xanchor='center'),
            pad=dict(b=10, t=50),
            steps=slider_steps
        )]
    )

    # Saving the figure
    fig.write_html(_path+'/oT_Plot_MapNetwork_'+CaseName+'.html')

    # 服务 
    if server_flag == 1:
        fig.write_html(_path+'/oT_Plot_MapNetwork_'+CaseName+'.html')

    PlottingNetMapsTime = time.time() - StartTime
    print('Plotting network maps                  ... ', round(PlottingNetMapsTime), 's')


def GenerationOperationResults_poi(DirName, CaseName, OptModel, mTEPES):
    _path = _resolve_output_dir()
    StartTime = time.time()

    
    if len(mTEPES.nr):
        OutputToFile = pd.Series(data=[OptModel.get_value(OptModel.vCommitment[p,sc,n,nr]) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nr in mTEPES.nr], index=pd.MultiIndex.from_tuples((p,sc,n,nr) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nr in mTEPES.nr))
        OutputToFile.to_frame(name='p.u.').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='p.u.').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationCommitment_'+CaseName+'.csv', sep=',')
        OutputToFile = pd.Series(data=[OptModel.get_value(OptModel.vStartUp   [p,sc,n,nr]) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nr in mTEPES.nr], index=pd.MultiIndex.from_tuples((p,sc,n,nr) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nr in mTEPES.nr))
        OutputToFile.to_frame(name='p.u.').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='p.u.').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationStartUp_'   +CaseName+'.csv', sep=',')
        OutputToFile = pd.Series(data=[OptModel.get_value(OptModel.vShutDown  [p,sc,n,nr]) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nr in mTEPES.nr], index=pd.MultiIndex.from_tuples((p,sc,n,nr) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nr in mTEPES.nr))
        OutputToFile.to_frame(name='p.u.').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='p.u.').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationShutDown_'  +CaseName+'.csv', sep=',')
    if len(mTEPES.es):
        OutputToFile = pd.Series(data=[OptModel.get_value(OptModel.vESSDischargeState[p,sc,n,es]) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for es in mTEPES.es], index=pd.MultiIndex.from_tuples((p,sc,n,es) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for es in mTEPES.es))
        OutputToFile.to_frame(name='p.u.').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='p.u.').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_ESSDischargeState_'+CaseName+'.csv', sep=',')
        OutputToFile = pd.Series(data=[OptModel.get_value(OptModel.vESSChargeState[p,sc,n,es]) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for es in mTEPES.es], index=pd.MultiIndex.from_tuples((p,sc,n,es) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for es in mTEPES.es))
        OutputToFile.to_frame(name='p.u.').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='p.u.').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_ESSChargeState_'+CaseName+'.csv', sep=',')
        
            
    
    '''
    if sum(mTEPES.pOperReserveUp[p,sc,n,ar] for p,sc,n,ar in mTEPES.ps*mTEPES.n*mTEPES.ar):
        if len(mTEPES.nr):
            OutputToFile = pd.Series(data=[OptModel.vReserveUp     [p,sc,n,nr]()*1e3 for p,sc,n,nr in mTEPES.ps*mTEPES.n*mTEPES.nr], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.nr))
            OutputToFile = OutputToFile.fillna(0.0)
            OutputToFile.to_frame(name='MW').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationReserveUp_'+CaseName+'.csv', sep=',')

            OutputToFile = pd.Series(data=[sum(OutputToFile[p,sc,n,nr] for nr in mTEPES.nr if (gt,nr) in mTEPES.t2g) for p,sc,n,gt in mTEPES.ps*mTEPES.n*mTEPES.gt], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.gt))
            OutputToFile.to_frame(name='MW').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_TechnologyReserveUp_'+CaseName+'.csv', sep=',')

        if len(mTEPES.es):
            OutputToFile = pd.Series(data=[OptModel.vESSReserveUp  [p,sc,n,es]()*1e3 for p,sc,n,es in mTEPES.ps*mTEPES.n*mTEPES.es], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.es))
            OutputToFile = OutputToFile.fillna(0.0)
            OutputToFile.to_frame(name='MW').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_ChargeReserveUp_'+CaseName+'.csv', sep=',')

            OutputToFile = pd.Series(data=[sum(OutputToFile[p,sc,n,es] for es in mTEPES.es if (ot,es) in mTEPES.t2g) for p,sc,n,ot in mTEPES.ps*mTEPES.n*mTEPES.ot], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.ot))
            OutputToFile.to_frame(name='MW').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_TechnologyReserveUpESS_'+CaseName+'.csv', sep=',')

    if sum(mTEPES.pOperReserveDw[p,sc,n,ar] for p,sc,n,ar in mTEPES.ps*mTEPES.n*mTEPES.ar):
        if len(mTEPES.nr):
            OutputToFile = pd.Series(data=[OptModel.vReserveDown   [p,sc,n,nr]()*1e3 for p,sc,n,nr in mTEPES.ps*mTEPES.n*mTEPES.nr], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.nr))
            OutputToFile = OutputToFile.fillna(0.0)
            OutputToFile.to_frame(name='MW').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationReserveDown_'+CaseName+'.csv', sep=',')

            OutputToFile = pd.Series(data=[sum(OutputToFile[p,sc,n,nr] for nr in mTEPES.nr if (gt,nr) in mTEPES.t2g) for p,sc,n,gt in mTEPES.ps*mTEPES.n*mTEPES.gt], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.gt))
            OutputToFile.to_frame(name='MW').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_TechnologyReserveDown_'+CaseName+'.csv', sep=',')

        if len(mTEPES.es):
            OutputToFile = pd.Series(data=[OptModel.vESSReserveDown[p,sc,n,es]()*1e3 for p,sc,n,es in mTEPES.ps*mTEPES.n*mTEPES.es], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.es))
            OutputToFile = OutputToFile.fillna(0.0)
            OutputToFile.to_frame(name='MW').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_ChargeReserveDown_'       +CaseName+'.csv', sep=',')

            OutputToFile = pd.Series(data=[sum(OutputToFile[p,sc,n,es] for es in mTEPES.es if (ot,es) in mTEPES.t2g) for p,sc,n,ot in mTEPES.ps*mTEPES.n*mTEPES.ot], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.ot))
            OutputToFile.to_frame(name='MW').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_TechnologyReserveDownESS_'+CaseName+'.csv', sep=',')
    '''
    # 修改
    OutputToFile = pd.Series(data=[OptModel.get_value(OptModel.vTotalOutput[p,sc,n,g])*1e3   for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for g in mTEPES.g], index=pd.MultiIndex.from_tuples(((p,sc,n,g)    for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for g in mTEPES.g)))
    
    # 叠加储能充电曲线
    for p in mTEPES.p:
        for sc in mTEPES.sc:
            for n in mTEPES.n:
                for es in mTEPES.es:
                    OutputToFile[p,sc,n,es] += -OptModel.get_value(OptModel.vESSTotalCharge[p,sc,n,es])*1e3
        # OutputToFileESS[p,sc,n,es] += -OptModel.vESSTotalCharge[p,sc,n,es]()*1e3*mTEPES.pEfficiency[es] # [-OptModel.vESSTotalCharge   [p,sc,n,es]()*1e3 for p,sc,n,es in mTEPES.ps*mTEPES.n*mTEPES.es], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.es))
        # OutputToFilecharge[p,sc,n,es] += -OptModel.vESSTotalCharge[p,sc,n,es]()*1e3 # [-OptModel.vESSTotalCharge   [p,sc,n,es]()*1e3 for p,sc,n,es in mTEPES.ps*mTEPES.n*mTEPES.es], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.es))

    # 叠加并网点上网电 
    # OutputToFile.loc[:,:,:,'Grid'] = OutputToFile.loc[:,:,:,'Grid'] - OutputToFile0
    # OutputToFileESS.to_frame(name='MW ').reset_index().pivot_table(index=['level_0','level_1','level_2'],        columns='level_3', values='MW ').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationOutputESS_'       +CaseName+'.csv', sep=',')
    OutputToFile.to_frame(name='MW ').reset_index().pivot_table(index=['level_0','level_1','level_2'],        columns='level_3', values='MW ').rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationOutput_'       +CaseName+'.csv', sep=',', float_format='%.6f')
    
    '''
    OutputResults = []
    for p,sc,st in mTEPES.ps*mTEPES.st:
        mTEPES.del_component(mTEPES.st)
        mTEPES.del_component(mTEPES.n )
        mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and st == stt and mTEPES.pStageWeight[stt] and sum(1 for (st,nn) in mTEPES.s2n))
        mTEPES.n  = Set(initialize=mTEPES.nn , ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn      in                          mTEPES.pDuration         and           (st,nn) in mTEPES.s2n)
        if len(mTEPES.n*mTEPES.nr):
            RampSurplusGens = [(p,sc,n,nr) for p,sc,n,nr in mTEPES.ps*mTEPES.n*mTEPES.nr if mTEPES.pRampUp[nr] and mTEPES.pIndBinGenRamps() == 1 and mTEPES.pRampUp[nr] < mTEPES.pMaxPower2ndBlock[p,sc,n,nr] and n == mTEPES.n.first()]
            if len(RampSurplusGens):
                OutputToFile = pd.Series(data=[(getattr(OptModel, 'eRampUp_'+str(p)+'_'+str(sc)+'_'+str(st))[p,sc,n,nr].uslack())*mTEPES.pDuration[n]*mTEPES.pRampUp[nr]*1e3*(mTEPES.pInitialUC[p,sc,n,nr]()                   - OptModel.vStartUp[p,sc,n,nr]()) for p,sc,n,nr in RampSurplusGens], index=pd.MultiIndex.from_tuples(RampSurplusGens))
                OutputResults.append(OutputToFile)
            RampSurplusGens = [(p,sc,n,nr) for p,sc,n,nr in mTEPES.ps*mTEPES.n*mTEPES.nr if mTEPES.pRampUp[nr] and mTEPES.pIndBinGenRamps() == 1 and mTEPES.pRampUp[nr] < mTEPES.pMaxPower2ndBlock[p,sc,n,nr] and n != mTEPES.n.first()]
            if len(RampSurplusGens):
                OutputToFile = pd.Series(data=[(getattr(OptModel, 'eRampUp_'+str(p)+'_'+str(sc)+'_'+str(st))[p,sc,n,nr].uslack())*mTEPES.pDuration[n]*mTEPES.pRampUp[nr]*1e3*(OptModel.vCommitment[p,sc,mTEPES.n.prev(n),nr]() - OptModel.vStartUp[p,sc,n,nr]()) for p,sc,n,nr in RampSurplusGens], index=pd.MultiIndex.from_tuples(RampSurplusGens))
                OutputResults.append(OutputToFile)
    mTEPES.del_component(mTEPES.st)
    mTEPES.del_component(mTEPES.n )
    mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and mTEPES.pStageWeight[stt] and sum(1 for (stt,nn) in mTEPES.s2n))
    mTEPES.n  = Set(initialize=mTEPES.nn,  ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn  in                mTEPES.pDuration                                              )
    if len(OutputResults):
        OutputResults = pd.concat(OutputResults)
        OutputResults.to_frame(name='MW/h').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW/h', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationRampUpSurplus_'+CaseName+'.csv', sep=',')

    OutputResults = []
    for p,sc,st in mTEPES.ps*mTEPES.st:
        mTEPES.del_component(mTEPES.st)
        mTEPES.del_component(mTEPES.n )
        mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and st == stt and mTEPES.pStageWeight[stt] and sum(1 for (st,nn) in mTEPES.s2n))
        mTEPES.n  = Set(initialize=mTEPES.nn , ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn      in                          mTEPES.pDuration         and           (st,nn) in mTEPES.s2n)
        if len(mTEPES.n*mTEPES.nr):
            RampSurplusGens = [(p,sc,n,nr) for p,sc,n,nr in mTEPES.ps*mTEPES.n*mTEPES.nr if mTEPES.pRampDw[nr] and mTEPES.pIndBinGenRamps() == 1 and mTEPES.pRampDw[nr] < mTEPES.pMaxPower2ndBlock[p,sc,n,nr] and n == mTEPES.n.first()]
            if len(RampSurplusGens):
                OutputToFile = pd.Series(data=[(getattr(OptModel, 'eRampDw_'+str(p)+'_'+str(sc)+'_'+str(st))[p,sc,n,nr].uslack())*mTEPES.pDuration[n]*mTEPES.pRampDw[nr]*1e3*(- mTEPES.pInitialUC[p,sc,n,nr]()                   + OptModel.vShutDown[p,sc,n,nr]()) for p,sc,n,nr in RampSurplusGens], index=pd.MultiIndex.from_tuples(RampSurplusGens))
                OutputResults.append(OutputToFile)
            RampSurplusGens = [(p,sc,n,nr) for p,sc,n,nr in mTEPES.ps*mTEPES.n*mTEPES.nr if mTEPES.pRampDw[nr] and mTEPES.pIndBinGenRamps() == 1 and mTEPES.pRampDw[nr] < mTEPES.pMaxPower2ndBlock[p,sc,n,nr] and n != mTEPES.n.first()]
            if len(RampSurplusGens):
                OutputToFile = pd.Series(data=[(getattr(OptModel, 'eRampDw_'+str(p)+'_'+str(sc)+'_'+str(st))[p,sc,n,nr].uslack())*mTEPES.pDuration[n]*mTEPES.pRampDw[nr]*1e3*(- OptModel.vCommitment[p,sc,mTEPES.n.prev(n),nr]() + OptModel.vShutDown[p,sc,n,nr]()) for p,sc,n,nr in RampSurplusGens], index=pd.MultiIndex.from_tuples(RampSurplusGens))
                OutputResults.append(OutputToFile)
    mTEPES.del_component(mTEPES.st)
    mTEPES.del_component(mTEPES.n )
    mTEPES.st = Set(initialize=mTEPES.stt, ordered=True, doc='stages',      filter=lambda mTEPES,stt: stt in mTEPES.stt and mTEPES.pStageWeight[stt] and sum(1 for (stt,nn) in mTEPES.s2n))
    mTEPES.n  = Set(initialize=mTEPES.nn,  ordered=True, doc='load levels', filter=lambda mTEPES,nn : nn  in                mTEPES.pDuration                                              )
    if len(OutputResults):
        OutputResults = pd.concat(OutputResults)
        OutputResults.to_frame(name='MW/h').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW/h', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationRampDwSurplus_'+CaseName+'.csv', sep=',')

    if len(mTEPES.r):
        OutputToFile1 = pd.Series(data=[(OptModel.vTotalOutput[p,sc,n,r].ub - OptModel.vTotalOutput[p,sc,n,r]())*mTEPES.pLoadLevelDuration[n]() for p,sc,n,r in mTEPES.ps*mTEPES.n*mTEPES.r], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.r))
        OutputToFile2 = pd.Series(data=[(OptModel.vTotalOutput[p,sc,n,r].ub)*mTEPES.pLoadLevelDuration[n]() for p,sc,n,r in mTEPES.ps*mTEPES.n*mTEPES.r], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.r))
        for p,sc,n,r in mTEPES.ps*mTEPES.n*mTEPES.r:
            if r in mTEPES.gc:
                OutputToFile1[p,sc,n,r] *= OptModel.vGenerationInvest[p,r]()
                OutputToFile2[p,sc,n,r] *= OptModel.vGenerationInvest[p,r]()
        OutputToFile1 = OutputToFile1.to_frame(name='GWh').reset_index().pivot_table(index=['level_0','level_1','level_3'], values='GWh', aggfunc=sum).rename_axis(['Period','Scenario','Unit'], axis=0).rename_axis([None], axis=1)
        OutputToFile2 = OutputToFile2.to_frame(name='GWh').reset_index().pivot_table(index=['level_0','level_1','level_3'], values='GWh', aggfunc=sum).rename_axis(['Period','Scenario','Unit'], axis=0).rename_axis([None], axis=1)
        OutputToFile  = OutputToFile1.div(OutputToFile2)*1e2
        OutputToFile  = OutputToFile.fillna(0.0)
        OutputToFile.rename(columns = {'GWh':'%'}, inplace = True)
        OutputToFile.to_csv(_path+'/oT_Result_GenerationCurtailmentEnergyRelative_'+CaseName+'.csv', sep=',')

        OutputToFile1 = pd.Series(data=[sum(OutputToFile1['GWh'][p,sc,r] for r in mTEPES.r if (rt,r) in mTEPES.t2g) for p,sc,rt in mTEPES.ps*mTEPES.rt], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.rt))
        OutputToFile2 = pd.Series(data=[sum(OutputToFile2['GWh'][p,sc,r] for r in mTEPES.r if (rt,r) in mTEPES.t2g) for p,sc,rt in mTEPES.ps*mTEPES.rt], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.rt))
        OutputToFile  = OutputToFile1.div(OutputToFile2)*1e2
        OutputToFile  = OutputToFile.fillna(0.0)
        OutputToFile.to_frame(name='%').to_csv(_path+'/oT_Result_TechnologyCurtailmentEnergyRelative_'+CaseName+'.csv', sep=',')

        OutputToFile = pd.Series(data=[(OptModel.vTotalOutput[p,sc,n,r].ub - OptModel.vTotalOutput[p,sc,n,r]())*1e3  for p,sc,n,r in mTEPES.ps*mTEPES.n*mTEPES.r], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.r))
        for p,sc,n,r in mTEPES.ps*mTEPES.n*mTEPES.r:
            if r in mTEPES.gc:
                OutputToFile[p,sc,n,r] *= OptModel.vGenerationInvest[p,r]()
        OutputToFile.to_frame(name='MW' ).reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW' , aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationCurtailment_'+CaseName+'.csv', sep=',')

        OutputToFile = pd.Series(data=[(OptModel.vTotalOutput[p,sc,n,r].ub - OptModel.vTotalOutput[p,sc,n,r]())*mTEPES.pLoadLevelDuration[n]() for p,sc,n,r in mTEPES.ps*mTEPES.n*mTEPES.r], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.r))
        for p,sc,n,r in mTEPES.ps*mTEPES.n*mTEPES.r:
            if r in mTEPES.gc:
                OutputToFile[p,sc,n,r] *= OptModel.vGenerationInvest[p,r]()
        OutputToFile.to_frame(name='GWh').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='GWh', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationCurtailmentEnergy_'+CaseName+'.csv', sep=',')

        OutputToFile = pd.Series(data=[sum(OutputToFile[p,sc,n,r] for r in mTEPES.r if (rt,r) in mTEPES.t2g) for p,sc,n,rt in mTEPES.ps*mTEPES.n*mTEPES.rt], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.rt))
        OutputToFile.to_frame(name='GWh').reset_index().pivot_table(           index=['level_0','level_1','level_2'], columns='level_3', values='GWh', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_TechnologyCurtailmentEnergy_'+CaseName+'.csv', sep=',')
        TechCurt = OutputToFile.to_frame(name='GWh').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='GWh', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).stack().rename_axis(['Period','Scenario','LoadLevel','Technology']).reset_index().groupby(['Period','Scenario','Technology']).sum().rename(columns={0: 'GWh'})
        TechCurt = TechCurt[(TechCurt[['GWh']] != 0).all(axis=1)]

        TechCurt = TechCurt.reset_index()

        chart = alt.Chart(TechCurt).mark_bar().encode(x='Technology', y='GWh', color='Scenario:N', column='Period:N').properties(width=600, height=400)
        chart.save(_path+'/oT_Plot_TechnologyCurtailment_'+CaseName+'.html', embed_options={'renderer':'svg'})

    OutputToFile = pd.Series(data=[OptModel.vTotalOutput[p,sc,n,g ]()*mTEPES.pLoadLevelDuration[n]() for p,sc,n,g  in mTEPES.ps*mTEPES.n*mTEPES.g ], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.g ))
    OutputToFile.to_frame(name='GWh'  ).reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='GWh'  , aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationEnergy_'  +CaseName+'.csv', sep=',')

    OutputToFile1 = pd.Series(data=[sum(OptModel.vTotalOutput[p,sc,n,r ]() for r in mTEPES.r if (nd,r) in mTEPES.n2g) for p,sc,n,nd  in mTEPES.ps*mTEPES.n*mTEPES.nd ], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.nd ))
    OutputToFile2 = pd.Series(data=[    mTEPES.pDemand     [p,sc,n,nd]                                                for p,sc,n,nd  in mTEPES.ps*mTEPES.n*mTEPES.nd ], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.nd ))
    OutputToFile  = OutputToFile2 - OutputToFile1
    OutputToFile  = OutputToFile.to_frame(name='GWh'  )
    OutputToFile.reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='GWh'  , aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_NetDemandPerNode_'  +CaseName+'.csv', sep=',')
    OutputToFile.reset_index().pivot_table(index=['level_0','level_1','level_2'],                    values='GWh'  , aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_NetDemand_'         +CaseName+'.csv', sep=',')
    '''
    if len(mTEPES.nr):
        OutputToFile = pd.Series(data=[OptModel.get_value(OptModel.vTotalOutput[p,sc,n,nr]) * 1e3 * mTEPES.pLoadLevelDuration[n] * mTEPES.pCO2EmissionRate[nr] for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nr in mTEPES.nr], index=pd.MultiIndex.from_tuples((p,sc,n,nr) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nr in mTEPES.nr))
        OutputToFile.to_frame(name='tCO2').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='tCO2', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_GenerationEmission_'+CaseName+'.csv', sep=',', float_format='%.6f')

        # for ar in mTEPES.ar:
        #     if len(mTEPES.ar) > 1:
        #         TechList = [(p,sc,n,gt,nr) for p,sc,n,gt,nr in mTEPES.ps*mTEPES.n*mTEPES.gt*mTEPES.nr if (ar,nr) in mTEPES.a2g and (gt,nr) in mTEPES.t2g]
        #         if len(TechList):
        #             OutputResults= pd.Series(data=[OutputToFile[p,sc,n,nr] for p,sc,n,gt,nr in mTEPES.ps*mTEPES.n*mTEPES.gt*mTEPES.nr if (ar,nr) in mTEPES.a2g and (gt,nr) in mTEPES.t2g], index=pd.MultiIndex.from_tuples(TechList))
        #             OutputResults.to_frame(name='MtCO2').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MtCO2', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_TechnologyEmission_'+ar+'_'+CaseName+'.csv', sep=',')

        # OutputToFile = pd.Series(data=[sum(OutputToFile[p,sc,n,nr] for nr in mTEPES.nr if (gt,nr) in mTEPES.t2g) for p,sc,n,gt in mTEPES.ps*mTEPES.n*mTEPES.gt], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.gt))
        # OutputToFile.to_frame(name='MtCO2').reset_index().pivot_table(          index=['level_0','level_1','level_2'], columns='level_3', values='MtCO2', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_TechnologyEmission_'+CaseName+'.csv', sep=',')
        # TechCO2 = OutputToFile.to_frame(name='MtCO2').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MtCO2', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).stack().rename_axis(['Period','Scenario','LoadLevel','Technology']).reset_index().groupby(['Period','Scenario','Technology']).sum().rename(columns={0: 'MtCO2'})
        # TechCO2 = TechCO2[(TechCO2[['MtCO2']] != 0).all(axis=1)]
    '''

    if len(TechCO2):
        TechCO2 = TechCO2.reset_index()

        chart = alt.Chart(TechCO2).mark_bar().encode(x='Technology', y='MtCO2', color='Scenario:N', column='Period:N').properties(width=600, height=400)
        chart.save(_path+'/oT_Plot_TechnologyEmission_'+CaseName+'.html', embed_options={'renderer': 'svg'})
    '''

    OutputToFile = pd.Series(data=[sum(OptModel.get_value(OptModel.vTotalOutput[p,sc,n,g]) for g in mTEPES.g if (gt,g) in mTEPES.t2g and OptModel.get_value(OptModel.vTotalOutput[p,sc,n,g]) > 0)*1e3 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for gt in mTEPES.gt], index=pd.MultiIndex.from_tuples((p,sc,n,gt) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for gt in mTEPES.gt))
    df_tech_out = OutputToFile.to_frame(name='MW').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MW', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1)

    # 汇总 Grid 机组在 vTotalOutput < 0 时的功率（MW，负值表示反送），并入 Grid 技术列
    if 'Grid' in mTEPES.g:
        grid_neg_series = pd.Series(
            data=[sum(OptModel.get_value(OptModel.vTotalOutput[p,sc,n,g]) for g in mTEPES.g if g == 'Grid' and OptModel.get_value(OptModel.vTotalOutput[p,sc,n,g]) < 0) * 1e3
                  for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n],
            index=pd.MultiIndex.from_tuples((p,sc,n) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n)
        )
        grid_neg_series.index.names = ['Period','Scenario','LoadLevel']
        if 'Grid' not in df_tech_out.columns:
            df_tech_out['Grid'] = 0.0
        df_tech_out['Grid'] = pd.to_numeric(df_tech_out['Grid'], errors='coerce').fillna(0.0) + grid_neg_series

    # 汇总储能充电功率（MW，按出力符号约定写为负值），并入 Battery 技术列
    if hasattr(OptModel, 'vESSTotalCharge') and len(mTEPES.es):
        ess_charge_series = pd.Series(
            data=[-sum(OptModel.get_value(OptModel.vESSTotalCharge[p,sc,n,es]) for es in mTEPES.es) * 1e3
                  for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n],
            index=pd.MultiIndex.from_tuples((p,sc,n) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n)
        )
        ess_charge_series.index.names = ['Period','Scenario','LoadLevel']
        if 'Battery' not in df_tech_out.columns:
            df_tech_out['Battery'] = 0.0
        df_tech_out['Battery'] = pd.to_numeric(df_tech_out['Battery'], errors='coerce').fillna(0.0) + ess_charge_series

    # 按节点汇总网络损耗，并以负号并入技术出力结果（-vPloss）
    if hasattr(OptModel, 'vPloss'):
        loss_series = pd.Series(
            data=[-sum(OptModel.get_value(OptModel.vPloss[p,sc,n,nd]) for nd in mTEPES.nd)*1e3 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n],
            index=pd.MultiIndex.from_tuples((p,sc,n) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n)
        )
        loss_series.index.names = ['Period','Scenario','LoadLevel']
        df_tech_out['Ploss'] = loss_series

    # 只保留有实际出力的技术列（排除全 0 的无意义列）
    df_tech_out = df_tech_out.loc[:, (df_tech_out != 0).any(axis=0)]
    df_tech_out.to_csv(_path+'/oT_Result_TechnologyOutput_'+CaseName+'.csv', sep=',')

    
    # TechnologyOutput = OutputToFile.loc[:,:,:,:]
    # for p,sc in mTEPES.ps:
    #     chart = AreaPlots(p, sc, TechnologyOutput, 'Technology', 'LoadLevel', 'MW', 'sum')
    #     chart.save(_path+'/oT_Plot_TechnologyOutput_'+CaseName+'.html', embed_options={'renderer': 'svg'})
    #     # 服务 
    #     if server_flag == 1:
    #         chart.save(_path+'/oT_Plot_TechnologyOutput_'+CaseName+'.html', embed_options={'renderer': 'svg'})
    
    OutputToFile = pd.Series(data=[OptModel.get_value(OptModel.vTotalOutput[p,sc,n,g])*mTEPES.pLoadLevelDuration[n]*1000 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for g in mTEPES.g], index=pd.MultiIndex.from_tuples((p,sc,n,g) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for g in mTEPES.g))
    OutputToFile = pd.Series(data=[sum(OutputToFile[p,sc,n,g] for g in mTEPES.g if (gt,g) in mTEPES.t2g) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for gt in mTEPES.gt], index=pd.MultiIndex.from_tuples((p,sc,n,gt) for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for gt in mTEPES.gt))
    OutputToFile.to_frame(name='MWh').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='MWh', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_TechnologyEnergy_'+CaseName+'.csv', sep=',')
    '''
    for p,sc in mTEPES.ps:
        chart = PiePlots(p, sc, OutputToFile, 'Technology', '%')
        chart.save(_path+'/oT_Plot_TechnologyEnergy_'+CaseName+'.html', embed_options={'renderer': 'svg'})
        # 服务 
        if server_flag == 1:
            chart.save(_path+'/oT_Plot_TechnologyEnergy_'+CaseName+'.html', embed_options={'renderer': 'svg'})

    for ar in mTEPES.ar:
        if len(mTEPES.ar) > 1:
            OutputToFile = pd.Series(data=[OptModel.vTotalOutput[p,sc,n,g]()*mTEPES.pLoadLevelDuration[n]() for p,sc,n,g in mTEPES.ps*mTEPES.n*mTEPES.g], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.g ))
            OutputToFile = pd.Series(data=[sum(OutputToFile[p,sc,n,g] for g in mTEPES.g if (ar,g) in mTEPES.a2g and (gt,g) in mTEPES.t2g) for p,sc,n,gt in mTEPES.ps*mTEPES.n*mTEPES.gt], index=pd.MultiIndex.from_tuples(mTEPES.ps*mTEPES.n*mTEPES.gt))
            OutputToFile.to_frame(name='GWh').reset_index().pivot_table(index=['level_0','level_1','level_2'], columns='level_3', values='GWh', aggfunc=sum).rename_axis(['Period','Scenario','LoadLevel'], axis=0).rename_axis([None], axis=1).to_csv(_path+'/oT_Result_TechnologyEnergy_'+ar+'_'+CaseName+'.csv', sep=',')

            for p,sc in mTEPES.ps:
                chart = PiePlots(p, sc, OutputToFile, 'Technology', '%')
                chart.save(_path+'/oT_Plot_TechnologyEnergy_'+str(p)+'_'+str(sc)+'_'+ar+'_'+CaseName+'.html', embed_options={'renderer': 'svg'})'''

    WritingResultsTime = time.time() - StartTime
    StartTime          = time.time()
    print('Writing generation operation results   ... ', round(WritingResultsTime), 's')



def PlanEvaluation_poi(DirName, CaseName, OptModel, mTEPES):
    _path = _resolve_output_dir()
    StartTime = time.time()
    # 分布式电源的总发电量
    generation_sum = sum([OptModel.get_value(OptModel.vTotalOutput[p,sc,n,r]) * 1e3 * mTEPES.pLoadLevelDuration[n] for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for r in mTEPES.r])
    # 负荷用电 
    demand_sum = sum([mTEPES.pDemand[p,sc,n,nd]*1e3 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd])
    # 平均负荷
    demand_ave = sum([mTEPES.pDemand[p,sc,n,nd]*1e3 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nd in mTEPES.nd]) / len(mTEPES.n)
    # 最大负 
    demand_max = max(pd.Series(sum([mTEPES.pDemand[p, sc, n, nd]*1e3 for p in mTEPES.p for sc in mTEPES.sc for nd in mTEPES.nd]) for n in mTEPES.n))
    # 发用电量之差
    diff_generation_demand = generation_sum - demand_sum
    # 计及储能损耗总用电量
    sum_demand_with_storage_loss = demand_sum # 还没加储 
    # 发用 
    ratio_generation_demand = generation_sum / demand_sum
    # 源荷 
    res_capacity = sum([mTEPES.pRatedMaxPower[g] * 1e3 for g in mTEPES.r]) # mTEPES.r新能源机组的容量
    ratio_gen_demand = res_capacity / demand_max
    # 储荷 
    ratio_ess_demand = 8 / demand_max
    # 最大反送电 
    grid_up_max = 0
    try: 
        grid_up_max = abs(min([OptModel.get_value(OptModel.vTotalOutput[p,sc,n,g])*1e3 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for g in mTEPES.g if g == 'Grid']))
    except:
        pass
    # 最大下网电 
    grid_down_max = 0
    try: 
        grid_down_max = max([OptModel.get_value(OptModel.vTotalOutput[p,sc,n,g])*1e3 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for g in mTEPES.g if g == 'Grid'])
    except:
        pass
    # 反送总电 
    grid_up_sum = 0
    try: 
        grid_up_sum = abs(sum([OptModel.get_value(OptModel.vTotalOutput[p,sc,n,g])*1e3 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for g in mTEPES.g if g == 'Grid' and OptModel.get_value(OptModel.vTotalOutput[p, sc, n, g]) < 0]))
    except:
        pass
    # 下网总电 
    grid_down_sum = 0
    try: 
        grid_down_sum = sum([OptModel.get_value(OptModel.vTotalOutput[p,sc,n,g])*1e3 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for g in mTEPES.g if g == 'Grid' and OptModel.get_value(OptModel.vTotalOutput[p, sc, n, g]) > 0])
    except:
        pass
    # 外 受入电量
    grid_up_minus_down = grid_up_sum - grid_down_sum    
    # 交换总电 = 反送总电 + 下网总电 
    grid_exchange_sum = grid_up_sum + grid_down_sum
    # 负荷利用小时 
    utilization_h_demand = demand_sum / demand_max
    # 水电年利用小时数
    generation_hydro = abs(sum([OptModel.get_value(OptModel.vTotalOutput[p,sc,n,g])*1e3 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for g in mTEPES.g if ('Hydro', g) in mTEPES.t2g])) # 对所有hydro的出力求 
    if sum([mTEPES.pRatedMaxPower[g]*1e3 for (t,g) in mTEPES.t2g if t == 'Hydro']) == 0:
        utilization_h_hydro = 0
    else:
        utilization_h_hydro = generation_hydro / sum([mTEPES.pRatedMaxPower[g]*1e3 for (t,g) in mTEPES.t2g if t == 'Hydro']) # 对所有hydro的容量求 
    # 光伏年利用小时数
    generation_solar = abs(sum([OptModel.get_value(OptModel.vTotalOutput[p,sc,n,g])*1e3 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for g in mTEPES.g if ('PV', g) in mTEPES.t2g])) # 对所有PV的出力求 
    if sum([mTEPES.pRatedMaxPower[g]*1e3 for (t,g) in mTEPES.t2g if t == 'PV']) == 0:
        utilization_h_solar = 0
    else:
        utilization_h_solar = generation_solar / sum([mTEPES.pRatedMaxPower[g]*1e3 for (t,g) in mTEPES.t2g if t == 'PV']) # 对所有PV的容量求 
    # 风电年利用小时数 
    generation_wind = abs(sum([OptModel.get_value(OptModel.vTotalOutput[p,sc,n,g])*1e3 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for g in mTEPES.g if ('Wind', g) in mTEPES.t2g]))  # 对所有Wind的出力求 
    if sum([mTEPES.pRatedMaxPower[g]*1e3 for (t,g) in mTEPES.t2g if t == 'Wind']) == 0:
        utilization_h_wind = 0
    else:
        utilization_h_wind = generation_wind / sum([mTEPES.pRatedMaxPower[g]*1e3 for (t,g) in mTEPES.t2g if t == 'Wind']) # 对所有Wind的容量求 
    # 交换功率峰谷差率：连续一天的最大峰谷差/当天最大的负荷
    demand_curve = pd.Series(sum([mTEPES.pDemand[p, sc, n, nd]*1e3 for p in mTEPES.p for sc in mTEPES.sc for nd in mTEPES.nd]) for n in mTEPES.n)
    max_demand_curve_24h = demand_curve.rolling(window=24).max() # max_demand_curve_24h 的前23个数会是 NaN，这是因为在计算滑动窗口最大值时，前24个时间点还没有足够的数据来计算出一个有效的最大值 
    max_demand_curve_24h = max_demand_curve_24h.fillna(0) #  max_demand_curve_24h 中的 NaN 值替换为0，防止计算问 
    grid_curve = pd.Series(OptModel.get_value(OptModel.vTotalOutput[p,sc,n,g])*1e3 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for g in mTEPES.g if g == 'Grid')
    max_grid_curve_24h = grid_curve.rolling(window=24).max()
    min_grid_curve_24h = grid_curve.rolling(window=24).min()
    max_grid_curve_24h = max_grid_curve_24h.fillna(0)
    min_grid_curve_24h = min_grid_curve_24h.fillna(0)
    maxmin_grid_curve_24h = max_grid_curve_24h - min_grid_curve_24h
    # ratio_exchange_peakvalley = (maxmin_grid_curve_24h / max_demand_curve_24h).max() # 曲线除以曲线
    ratio_exchange_peakvalley = maxmin_grid_curve_24h.max() / demand_max

    # 扣除外送电量的累计交换电量占比
    ratio_exchange_power = (grid_up_sum + grid_down_sum) / demand_sum - (ratio_generation_demand - 1)
    # 能源自给自足率
    ritio_self_sufficiency = (demand_sum - grid_down_sum) / demand_sum
    # 可再生能源发电利用率
    generation_fore_sum = sum([mTEPES.pMaxPower[p,sc,n,r] * 1e3 * mTEPES.pLoadLevelDuration[n] for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for r in mTEPES.r])
    if generation_fore_sum == 0:
        ratio_res_use = 0
    else:
        ratio_res_use = 1 - (generation_fore_sum - generation_sum) / generation_fore_sum
    # 储能外部充电（未考虑充电损耗）
    ess_total_charge = sum([OptModel.get_value(OptModel.vESSTotalCharge[p,sc,n,es])*1e3 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for es in mTEPES.es])
    # 储能外部放电
    ess_total_discharge = sum([OptModel.get_value(OptModel.vTotalOutput[p,sc,n,es])*1e3 for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for es in mTEPES.es])
    # 储能充电损失电量
    ess_total_charge_loss = ess_total_charge - ess_total_discharge
    # 储能年等效全充全放次数
    ess_full_time = ess_total_discharge / sum([mTEPES.pRatedMaxStorage[g]*1e3 for (t,g) in mTEPES.t2g if t == 'Battery']) # 对储能容量求和
    # 储能利用率
    ration_ess_utilization = (ess_total_charge + ess_total_discharge) / sum([mTEPES.pRatedMaxPower[g]*1e3 for (t,g) in mTEPES.t2g if t == 'Battery']) /8760
    # 储能实际放电量/充电量
    ratio_ess_charge_discharge = ess_total_discharge / ess_total_charge if ess_total_charge!= 0 else 0
    # 可再生能源就地消纳率
    ratio_res_consume = (generation_sum - grid_up_sum) / (demand_sum + ess_total_charge_loss)

    # 碳排放相关
    # 电力侧碳排放量
    CO2_emission_sum_electricity = sum([OptModel.get_value(OptModel.vTotalOutput[p,sc,n,nr]) * 1e3 * mTEPES.pLoadLevelDuration[n] * mTEPES.pCO2EmissionRate[nr] for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for nr in mTEPES.nr])
    
    # 热力侧碳排放量 (仅包含直接燃气消耗)
    CO2_emission_sum_heat = 0      
    ef_gas = 0.202  # 假设天然气碳排放因子 kgCO2/kWh (按热值计)，请根据实际情况调整
    T = len(mTEPES.pThermalDemand) if hasattr(mTEPES, 'pThermalDemand') else 0
    
    if T > 0:
        if mTEPES.pThermalParams.get('enable_chp_planning', 1) > 0 and hasattr(mTEPES, 'vF_chp_gas'):
            chp_gas_sum = sum(OptModel.get_value(mTEPES.vF_chp_gas[t]) for t in range(T))
            CO2_emission_sum_heat += chp_gas_sum * ef_gas
            
        if mTEPES.pThermalParams.get('enable_gt_planning', 1) > 0 and hasattr(mTEPES, 'vF_gt_gas'):
            gt_gas_sum = sum(OptModel.get_value(mTEPES.vF_gt_gas[t]) for t in range(T))
            CO2_emission_sum_heat += gt_gas_sum * ef_gas

    # 间接碳排放 (电力消耗的碳排已在电力侧计算，此处不再重复)
    CO2_emission_sum_indirect = 0    
    # 总碳排放量
    CO2_emission_sum = CO2_emission_sum_electricity + CO2_emission_sum_heat + CO2_emission_sum_indirect
    
    # 电力消费能耗按照等价值计算成“吨标准煤” 电力的当量折标系数 0.1229千克标准煤/千瓦时 = 0.1229吨标准煤/兆瓦时
    CO2_emission_sum_coal = demand_sum * 0.1229
    
    CO2_emission_unit = CO2_emission_sum / CO2_emission_sum_coal
    
    # 指标输出
    data = {
        'metric': ['generation_sum', 
                   'demand_sum', 
                   'demand_ave', 
                   'demand_max', 
                   'diff_generation_demand',
                   'sum_demand_with_storage_loss',
                   'CO2_emission_sum',
                   'CO2_emission_unit',
                   'ratio_generation_demand',
                   'ratio_gen_demand',
                   'ratio_ess_demand',
                   'grid_up_max',
                   'grid_down_max',
                   'grid_up_sum',
                   'grid_down_sum',
                   'grid_up_minus_down',
                   'grid_exchange_sum',
                   'utilization_h_demand',
                   'utilization_h_hydro',
                   'utilization_h_solar',
                   'utilization_h_wind',
                   'ratio_exchange_peakvalley',
                   'ratio_exchange_power',
                   'ritio_self_sufficiency',
                   'ratio_res_consume',
                   'ratio_res_use',
                   'ess_full_time',
                   'ration_ess_utilization',
                   'ess_total_charge',
                   'ess_total_discharge',
                   'ess_total_charge_loss',
                   'ratio_ess_charge_discharge'
                    ],
        'name': [   '总发电量', 
                    '总用电量', 
                    '平均负荷', 
                    '最大负荷', 
                    '发用电量之差', 
                    '计及储能损耗总用电量',
                    'CO2排放量',
                    '单位能耗碳排放',
                    '发用比',
                    '源荷比',
                    '储荷比',
                    '最大外送电力',
                    '最大受入电力',
                    '总外送电量',
                    '总受入电量',
                    '外送与受入电量之差',
                    '总交换电量',
                    '负荷利用小时数',
                    '水电年利用小时数',
                    '光伏年利用小时数',
                    '风电年利用小时数',
                    '交换功率峰谷差率',
                    '扣除外送电量的累计交换电量占比',
                    '能源自给自足率',
                    '可再生能源就地消纳率',
                    '可再生能源发电利用率',
                    '储能全充全放次数',
                    '储能利用率',
                    '储能总充电量',
                    '储能总放电量',
                    '储能总充电损失电量',
                    '储能实际放电量/充电量'
                    ],
        'value': [generation_sum, 
                  demand_sum, 
                  demand_ave, 
                  demand_max, 
                  diff_generation_demand, 
                  sum_demand_with_storage_loss,
                  CO2_emission_sum,
                  CO2_emission_unit,
                  ratio_generation_demand,
                  ratio_gen_demand,
                  ratio_ess_demand,
                  grid_up_max,
                  grid_down_max,
                  grid_up_sum,
                  grid_down_sum,
                  grid_up_minus_down,
                  grid_exchange_sum,
                  utilization_h_demand,
                  utilization_h_hydro,
                  utilization_h_solar,
                  utilization_h_wind,
                  ratio_exchange_peakvalley,
                  ratio_exchange_power*100,
                  ritio_self_sufficiency*100,
                  ratio_res_consume*100,
                  ratio_res_use*100,
                  ess_full_time,
                  ration_ess_utilization*100,
                  ess_total_charge,
                  ess_total_discharge,
                  ess_total_charge_loss,
                  ratio_ess_charge_discharge*100
                  ],
        'unit': [  'MWh', 
                   'MWh', 
                   'MW', 
                   'MW', 
                   'MWh',
                   'MWh',
                   'tCO2',
                   'tCO2/吨标准煤',
                   '/',
                   '/',
                   '/',
                   'MW',
                   'MW',
                   'MWh',
                   'MWh',
                   'MWh',
                   'MWh',
                   'h',
                   'h',
                   'h',
                   'h',
                   '/',
                   '%',
                   '%',
                   '%',
                   '%',
                   'time',
                   '%',
                   'MWh',
                   'MWh',
                   'MWh',
                   '%'
                   ]
    }
    # 将字典转换为DataFrame
    metrics_df = pd.DataFrame(data)
    # 限制数值到三位小数
    metrics_df = metrics_df.round(3)
    # 保存到CSV文件
    # metrics_df.to_csv(_path+'/oT_Result_Evaluations_'+CaseName+'.csv', sep=',', index=True, index_label='nid')
    metrics_df.to_csv(_path+'/oT_Result_Evaluations_'+CaseName+'.csv', sep=',', index=False)

    # 计算经济指标
    # 通过现金流计算静态投资回收期
    def static_cycle(out_list, in_list):
        out_len = len(out_list)
        in_len = len(in_list)
        net_cash_flow = []
        cumulative_cash_flow = []
        positive_time = 0
        if out_len == in_len and in_len != 0:
            for n in range(0, out_len):
                net_cash_flow.append(in_list[n]-out_list[n])   # 净现金流量

            for j in range(0, out_len):
                if j == 0:
                    cumulative_cash_flow.append(net_cash_flow[0])
                else:
                    cumulative_cash_flow.append(net_cash_flow[j]+cumulative_cash_flow[j-1])
                if cumulative_cash_flow[j] > 0:
                    positive_time = int(j)
                    break
            # print(cumulative_cash_flow)
            # print(positive_time)
            count_out = 0
            count_in = 0

            for k in range(0, positive_time):
                count_out = count_out + out_list[k]
                count_in = count_in + in_list[k]
            cycle_time = positive_time - 1 + abs((count_out - count_in) / (in_list[positive_time] - out_list[positive_time]))
            cycle_time = round(cycle_time, 2)
            print("静态投资回收期：{} 年".format(cycle_time))
            return cycle_time
        else:
            print("收入和支出次数不一致，请检查")
    # 通过现金流计算动态投资回收期
    def dynamic_cycle(i, out_list, in_list):
        out_len = len(out_list)
        in_len = len(in_list)
        net_cash_flow = []
        cumulative_cash_flow = []
        positive_time = 0
        if out_len == in_len and in_len != 0:
            for n in range(0, out_len):
                net_cash_flow.append(in_list[n]-out_list[n])   # 净现金流量
            # print(net_cash_flow)

            for l in range(0, out_len):
                if l != 0:
                    net_cash_flow[l] = npf.pv(i, l, 0, -net_cash_flow[l])  # 净现 考虑折现 
                    net_cash_flow[l] = round(net_cash_flow[l], 2)
                else:
                    net_cash_flow[0] = 1 * net_cash_flow[l]
            # print(net_cash_flow)
            for j in range(0, out_len):
                if j == 0:
                    cumulative_cash_flow.append(net_cash_flow[0])
                else:
                    cumulative_cash_flow.append(round(net_cash_flow[j] + cumulative_cash_flow[j-1], 2))
                if cumulative_cash_flow[j] >= 0:
                    positive_time = int(j)
                    break
                if j == out_len-1 and cumulative_cash_flow[j] < 0:
                    # raise Exception("在现金流的年份内，累计金额没有达到正值，即回收期超过设置的现金流年限!")
                    print("在现金流的年份内，累计金额没有达到正值，即回收期超过设置的现金流年限!")
            # print(cumulative_cash_flow)
            # print(positive_time)

            count_i = cumulative_cash_flow[positive_time-1]
            count_i = round(count_i, 2)
            # print(count_i)
            positive_va = net_cash_flow[positive_time]

            cycle_time = positive_time - 1 + abs(count_i/positive_va)
            cycle_time = round(cycle_time, 2)
            print("动态投资回收期：{} 年".format(cycle_time))
            return cycle_time
        else:
            print("收入和支出次数不一致，请检查")
    
    # 收益计算
    # 新能源发电补贴收 
    revenue_generation = generation_sum * 1e3 * 0.2 # MWh to kWh × 补贴价格
    # print('Revenue of generation: ', revenue_generation)
    # 电网售电收益
    # revenue_grid = grid_up_sum * 1e3 * 0.8
    # print('Revenue of grid: ', revenue_grid)
    revenue_generation = revenue_generation * 1e-4 # 单位：万 

    # 成本计算
    # 初始投资
    initial_investment = sum(mTEPES.pGenInvestCost[gc] * mTEPES.pRatedMaxPower[gc] * OptModel.get_value(OptModel.vGenerationInvest[p,gc]) for p in mTEPES.p for gc in mTEPES.gc) * 1e-4
    # 新能源年运维成本
    cost_res_oper = sum([mTEPES.pLinearOMCost[r ] * OptModel.get_value(OptModel.vTotalOutput[p,sc,n,r ])  for p in mTEPES.p for sc in mTEPES.sc for n in mTEPES.n for r in mTEPES.r ]) * 1e-4
    # 电网购电成本
    cost_grid_purchase = grid_down_sum * 1e3 * 0.5 # MWh to kWh × 购电价格
    cost_grid_purchase = cost_grid_purchase * 1e-4 # 单位：万 
    cost_per_yr = cost_res_oper + cost_grid_purchase
    
    # 指标计算
    # 收入现金 
    income_list  = [0, revenue_generation, revenue_generation, revenue_generation, revenue_generation, revenue_generation, revenue_generation, revenue_generation]
    # 支出现金 
    outcome_list = [initial_investment + cost_per_yr, cost_per_yr, cost_per_yr, cost_per_yr, cost_per_yr, cost_per_yr, cost_per_yr, cost_per_yr]
    # 静态投资回收期
    static_cycle_result = static_cycle(outcome_list, income_list)
    if static_cycle_result < 0:
        static_cycle_result = 0
        print('在投资周期内无法收回初始投资') 
    # 折现 
    i = 0.1 
    # 动态投资回收期
    dynamic_cycle_result = dynamic_cycle(i, outcome_list, income_list)
    if dynamic_cycle_result < 0:
        dynamic_cycle_result = 0 
    # 内部收益 
    irr = npf.irr(np.array(income_list) - np.array(outcome_list))
    if irr < 0:
        irr = 0
    print("内部收益率：", round(irr, 4) * 100, "%")

    eco_data = {
        'metric': ['initial_investment', 
                   'cost_grid_purchase',
                   'cost_res_oper',
                   'revenue_generation',
                   'irr',
                   'i',
                   'static_cycle',
                   'dynamic_cycle'
                    ],
        'name':   [ '初始投资', 
                    '电网年购电成本',
                    '新能源年运维成本',
                    '新能源发电年补贴收益',
                    '内部收益率',
                    '折现率',
                    '静态投资回收期',
                    '动态投资回收期'
                    ],
        'value': [initial_investment, 
                   cost_grid_purchase,
                   cost_res_oper,
                   revenue_generation,
                   round(irr, 4) * 100,
                   i*100,
                   static_cycle_result,
                   dynamic_cycle_result
                  ],
        'unit': [  '万元', 
                   '万元',
                   '万元',
                   '万元',
                   '%',
                   '%',
                   '年',
                   '年'
                   ]
    }
    # 将字典转换为DataFrame
    eco_metrics_df = pd.DataFrame(eco_data)
    # 限制数值到三位小数
    eco_metrics_df = eco_metrics_df.round(3)
    # 保存到CSV文件
    # eco_metrics_df.to_csv(_path+'/oT_Result_EvaluationsEco_'+CaseName+'.csv', sep=',', index=True, index_label='nid')
    eco_metrics_df.to_csv(_path+'/oT_Result_EvaluationsEco_'+CaseName+'.csv', sep=',', index=False)

    EvaluationTime = time.time() - StartTime
    StartTime          = time.time()
    print('Writing           evaluation results   ... ', round(EvaluationTime), 's')


def EVplan_outputresult(model, dir_path):
    import numpy as np
    import pandas as pd
    import pyoptinterface as poi
    dir_path = _resolve_output_dir()
    # ==========================================
    # 结果提取与可视化 (Results & Plot Results)
    # ==========================================
    try:
        obj_val = model.get_model_attribute(poi.ModelAttribute.ObjectiveValue)
        n_pile_opt = model.get_value(model.N_pile)
        
        p_chr_opt = np.zeros(model.T_len)
        p_dis_opt = np.zeros(model.T_len)
        for k in range(model.T_len):
            k_tuple = model.idx_tuples[k]
            if len(model.grid_p_chr_vars[k_tuple]) > 0:
                p_chr_opt[k] = sum(model.get_value(var) for var in model.grid_p_chr_vars[k_tuple])
            if len(model.grid_p_dis_vars[k_tuple]) > 0:
                p_dis_opt[k] = sum(model.get_value(var) for var in model.grid_p_dis_vars[k_tuple])
        
        p_net_opt = p_chr_opt - p_dis_opt
                
        print("\n" + "="*40)
        print("规划与运行结果总结 (Summary of Results)")
        print("="*40)
        print(f"最低总年化成本 (Total Cost)   : ￥ {obj_val:,.2f}")
        print(f"最优充电桩建设数量 (N_pile) : {n_pile_opt:.0f} 个")
        print(f"全网总购电量 (Total charged)  : {np.sum(p_chr_opt):,.2f} kWh")
        print(f"全网总放电量 (TO-GRID V2G)    : {np.sum(p_dis_opt):,.2f} kWh")
        print("="*40 + "\n")
        
        result_df = model.df_EV.copy()
        result_df['Arriving_Demand_kW'] = model.naive_demand_curve
        result_df['Optimized_Charge_Power_kW'] = p_chr_opt
        result_df['Optimized_Discharge_Power_kW'] = p_dis_opt
        result_df['Optimized_Net_Grid_Power_kW'] = p_net_opt
        result_df['Grid_Buy_Price_CNY'] = model.P_ELEC_CHR
        result_df['Grid_Sell_Price_CNY'] = model.P_ELEC_DIS
        
        output_path = os.path.join(dir_path, 'oT_Result_EV_planning_results.csv')
        result_df.to_csv(output_path, index=False)
        print(f"详细运行曲线已保存至: {output_path}")

        import matplotlib.pyplot as plt
        from matplotlib import font_manager
        
        plt.rcParams['font.sans-serif'] = ['SimSun', 'Times New Roman']
        plt.rcParams['font.family'] = 'sans-serif'
        plt.rcParams['axes.unicode_minus'] = False
        
        plot_hours = min(model.T_len, 168)
        
        plt.figure(figsize=(12, 6))
        plt.plot(range(plot_hours), model.naive_demand_curve[:plot_hours], label='预计充电负荷', linestyle='--', alpha=0.7)
        
        plt.plot(range(plot_hours), p_net_opt[:plot_hours], label='充电站净功率曲线', color='red', alpha=0.9, linewidth=2)
        plt.fill_between(range(plot_hours), p_net_opt[:plot_hours], 0, where=(p_net_opt[:plot_hours] > 0), color='salmon', alpha=0.3)

        plt.axhline(y=n_pile_opt * model.P_CHR_MAX, color='green', linestyle=':', label='充电站容量')
        plt.axhline(y=-model.MAX_STATION_DISCHARGE, color='blue', linestyle=':', label='V2G最大放电功率')
        
        plt.title(f'双向电动汽车 V2G 规划调度结果 (首个 {plot_hours} 小时)', fontsize=16)
        plt.xlabel('时间 (小时)', fontsize=14)
        plt.ylabel('功率 (kW)', fontsize=14)
        plt.legend()
        plt.grid(True, linestyle='--', alpha=0.6)
        plt.tight_layout()
        
        plot_path = os.path.join(dir_path, 'oT_Result_EV_planning_curves.png')
        plt.savefig(plot_path, dpi=300)
        plt.close()
        print(f"运行曲线图已保存至: {plot_path}")

        plt.figure(figsize=(12, 4))
        plt.plot(range(plot_hours), model.P_ELEC_CHR[:plot_hours], label='购电价 (Buy Price - 充电成本)', color='orange', linestyle='-', linewidth=2)
        plt.plot(range(plot_hours), model.P_ELEC_DIS[:plot_hours], label='卖电价 (Sell Price - 放电收益)', color='purple', linestyle='--', linewidth=2)
        
        plt.title(f'电网充放分时电价分布 (首个 {plot_hours} 小时)', fontsize=16)
        plt.xlabel('时间 (小时)', fontsize=14)
        plt.ylabel('电价 (￥/kWh)', fontsize=14)
        plt.legend()
        plt.grid(True, linestyle='--', alpha=0.6)
        plt.tight_layout()
        
        price_plot_path = os.path.join(dir_path, 'oT_Result_EV_price_curves.png')
        plt.savefig(price_plot_path, dpi=300)
        plt.close()
        print(f"分时电价图已保存至: {price_plot_path}")
        
    except Exception as e:
        print(f"模型求解未处于最优状态或取值失败: {e}")
        try:
            print("尝试计算 IIS (Irreducible Inconsistent Subsystem) 以诊断无解原因...")
            poi.compute_iis(model)
            ilp_path = os.path.join(dir_path, 'infeasible_EV_model.ilp')
            model.write(ilp_path)
            print(f"致死约束排查线索 IIS 已输出到: {ilp_path}")
        except Exception as e2:
            print(f'IIS 计算自身也失败: {e2}')

def outputresult_ammonia(model, DirName, CaseName):
    import pyoptinterface as poi
    import pandas as pd
    import os
    
    var_dict = model.var_dict_ammonia
    _path = _resolve_output_dir()
    T = model.params_ammonia['T']
    
    cap_e_val = model.get_value(var_dict['cap_elec'])
    cap_n_val = model.get_value(var_dict['cap_nh3'])
    
    print("=== 制氢制氨模型优化结果 ===")
    print(f'制氢设备 (电解槽) 容量: {cap_e_val:.2f} kW')
    print(f"制氨设备容量         : {cap_n_val:.2f} kg/h")
    
    # 提取多级索引
    if hasattr(model, 'dfThermalDemand'):
        idx = model.dfThermalDemand.index  # MultiIndex: (Period, Scenario, LoadLevel)
    else:
        # 如果没有 thermal demand，则尝试从 T 构造
        idx = pd.Index(T, name='LoadLevel')
    
    # 构建运行曲线 DataFrame
    h2an_data = {}
    h2an_data['H2_Power'] = [model.get_value(var_dict['p_elec'][t]) for t in T]
    h2an_data['NH3_Power'] = [model.get_value(var_dict['p_nh3'][t]) for t in T]
    h2an_data['H2_Production'] = [model.get_value(var_dict['h2_prod'][t]) for t in T]
    h2an_data['NH3_Production'] = [model.get_value(var_dict['nh3_prod'][t]) for t in T]
    h2an_data['H2_Consumption'] = [model.get_value(var_dict['h2_cons'][t]) for t in T]
    h2an_data['H2_Sold'] = [model.get_value(var_dict['h2_sold'][t]) for t in T]
    
    df_h2an = pd.DataFrame(h2an_data, index=idx)
    df_h2an.to_csv(os.path.join(_path, f'oT_Result_H2AnOutput_{CaseName}.csv'))
    print(f'制氢制氨运行结果已保存: oT_Result_H2AnOutput_{CaseName}.csv  ({df_h2an.shape})')



# ==================== 热系统结果输出函数 ====================

def ThermalInvestmentResults_poi(OptModel, mTEPES, DirName, CaseName, pIndLogConsole):
    """输出热系统投资规划结果"""
    print('\n' + '='*60)
    print('热系统投资规划结果')
    print('='*60)
    
    if mTEPES.pSolveStatus != poi.TerminationStatusCode.OPTIMAL:
        print('[错误] 模型未找到最优解，无法输出结果')
        return
    
    params = mTEPES.pThermalParams
    capacity_unit = mTEPES.pThermalCapacityUnit
    
    # 获取容量规划结果（单位：MW）
    cap_boiler_val = OptModel.get_value(mTEPES.vCAP_boiler_units) * capacity_unit
    cap_hp_val = OptModel.get_value(mTEPES.vCAP_hp_units) * capacity_unit
    install_boiler_val = OptModel.get_value(mTEPES.vInstall_boiler)
    install_hp_val = OptModel.get_value(mTEPES.vInstall_hp)
    cap_storage_val = OptModel.get_value(mTEPES.vCAP_storage_units) * capacity_unit
    
    print(f'\n【容量规划结果】')
    print(f"锅炉容量: {cap_boiler_val:.2f} MW")
    print(f"锅炉是否安装: {'是' if install_boiler_val > 0.5 else '否'}")
    print(f"热泵容量: {cap_hp_val:.2f} MW")
    print(f"热泵是否安装: {'是' if install_hp_val > 0.5 else '否'}")
    print(f'储热罐容量: {cap_storage_val:.2f} MWh')
    
    # CHP结果
    enable_chp = params.get('enable_chp_planning', 0)
    if enable_chp > 0:
        cap_chp_val = OptModel.get_value(mTEPES.vCAP_chp_units) * capacity_unit
        install_chp_val = OptModel.get_value(mTEPES.vInstall_chp)
        
        print(f"CHP容量: {cap_chp_val:.2f} MW")
        print(f"CHP是否安装: {'是' if install_chp_val > 0.5 else '否'}")

    # GT（燃气轮机）结果
    enable_gt = params.get('enable_gt_planning', 1)
    if enable_gt > 0 and hasattr(mTEPES, 'vCAP_gt_units'):
        cap_gt_val = OptModel.get_value(mTEPES.vCAP_gt_units) * capacity_unit
        install_gt_val = OptModel.get_value(mTEPES.vInstall_gt)
        print(f"GT容量: {cap_gt_val:.2f} MW")
        print(f"GT是否安装: {'是' if install_gt_val > 0.5 else '否'}")

    # ST（蒸汽轮机）结果
    enable_st = params.get('enable_st_planning', 1)
    if enable_st > 0 and enable_gt > 0 and hasattr(mTEPES, 'vCAP_st_units'):
        cap_st_val = OptModel.get_value(mTEPES.vCAP_st_units) * capacity_unit
        install_st_val = OptModel.get_value(mTEPES.vInstall_st)
        print(f"ST容量: {cap_st_val:.2f} MW")
        print(f"ST是否安装: {'是' if install_st_val > 0.5 else '否'}")
    
    # 吸收式制冷机结果
    enable_chiller = params.get('enable_chiller_planning', 0)
    if enable_chiller > 0 and hasattr(mTEPES, 'vCAP_chiller_units'):
        cap_chiller_val    = OptModel.get_value(mTEPES.vCAP_chiller_units) * capacity_unit
        install_chiller_val = OptModel.get_value(mTEPES.vInstall_chiller)
        
        # 计算设计效率系数 alpha
        eta_min  = params.get('chiller_eta_min', 0.65)
        eta_max  = params.get('chiller_eta_max', 0.80)
        T_min    = params.get('chiller_T_min', 10.0)
        T_max    = params.get('chiller_T_max', 40.0)
        T_design = params.get('chiller_T_design', 30.0)
        c1 = (1.0/eta_max - 1.0/eta_min) / (T_max - T_min)
        c2 = 1.0/eta_max - T_max * c1
        alpha = c1 * T_design + c2
        cop_design = 1.0 / alpha  # 设计工况COP
        
        print(f"\n吸收式制冷机容量: {cap_chiller_val:.2f} MW")
        print(f"吸收式制冷机是否安装: {'是' if install_chiller_val > 0.5 else '否'}")
        print(f"设计工况COP ({T_design}°C): {cop_design:.3f}")
        print(f'热输入/制冷比 alpha: {alpha:.4f}')
    
    # 压缩式制冷机结果
    enable_comp = params.get('enable_comp_chiller_planning', 0)
    if enable_comp > 0 and hasattr(mTEPES, 'vCAP_comp_units'):
        cap_comp_val     = OptModel.get_value(mTEPES.vCAP_comp_units) * capacity_unit
        install_comp_val = OptModel.get_value(mTEPES.vInstall_comp)
        cop_val          = params.get('comp_chiller_cop', 2.7)
        
        print(f"\n压缩式制冷机容量: {cap_comp_val:.2f} MW")
        print(f"压缩式制冷机是否安装: {'是' if install_comp_val > 0.5 else '否'}")
        print(f"额定COP: {cop_val:.2f}")
        if cap_comp_val > 0:
            cop_elec = cap_comp_val / cop_val
            print(f'满负荷电耗: {cop_elec:.2f} MW')

def ThermalEconomicResults_poi(OptModel, mTEPES, DirName, CaseName, pIndLogConsole):
    """输出热系统经济性结果"""
    print('\n' + '='*60)
    print('热系统经济性结果')
    print('='*60)
    
    if mTEPES.pSolveStatus != poi.TerminationStatusCode.OPTIMAL:
        print('[错误] 模型未找到最优解')
        return
    
    # 计算并输出成本信息
    print('\n热系统成本已包含在总成本中')


def ThermalOperationResults_poi(OptModel, mTEPES, DirName, CaseName, pIndLogConsole):
    """输出热系统运行结果：制冷/制热平衡 CSV"""
    print('\n' + '='*60)
    print('热系统运行结果')
    print('='*60)
    
    if mTEPES.pSolveStatus != poi.TerminationStatusCode.OPTIMAL:
        print('[错误] 模型未找到最优解')
        return
    
    _path = _resolve_output_dir()
    params   = mTEPES.pThermalParams
    T        = len(mTEPES.pThermalDemand)
    
    # 使用 dfThermalDemand 的三级索引（Period, Scenario, LoadLevel）作为行索引
    if hasattr(mTEPES, 'dfThermalDemand'):
        idx = mTEPES.dfThermalDemand.index  # MultiIndex: (Period, Scenario, LoadLevel)
    else:
        idx = pd.RangeIndex(T)
    
    # ── 制冷平衡 oT_Result_BalanceCooling ────────────────────────────
    cooling_data = {}
    
    # 制冷负荷（需求）
    cooling_data['ChillerDemand'] = mTEPES.pChillerDemand[:T]
    
    # 吸收式制冷机
    enable_chiller = params.get('enable_chiller_planning', 0)
    if enable_chiller > 0 and hasattr(mTEPES, 'vQ_chiller_cool'):
        cooling_data['AbsorptionChiller'] = [
            OptModel.get_value(mTEPES.vQ_chiller_cool[t]) for t in range(T)
        ]
    
    # 压缩式制冷机
    enable_comp = params.get('enable_comp_chiller_planning', 0)
    if enable_comp > 0 and hasattr(mTEPES, 'vQ_comp_cool'):
        cooling_data['CompressionChiller'] = [
            OptModel.get_value(mTEPES.vQ_comp_cool[t]) for t in range(T)
        ]
    
    df_cooling = pd.DataFrame(cooling_data, index=idx)
    df_cooling.index.names = ['Period', 'Scenario', 'LoadLevel']
    df_cooling.to_csv(_path + '/oT_Result_BalanceCooling_' + CaseName + '.csv')
    print(f'\n制冷平衡结果已保存: oT_Result_BalanceCooling_{CaseName}.csv  ({df_cooling.shape})')
    
    # ── 制热平衡 oT_Result_BalanceHeating ────────────────────────────
    heating_data = {}
    
    # 热负荷（需求）
    heating_data['ThermalDemand'] = mTEPES.pThermalDemand[:T]
    
    # 锅炉
    if hasattr(mTEPES, 'vQ_boiler_out'):
        heating_data['Boiler'] = [
            OptModel.get_value(mTEPES.vQ_boiler_out[t]) for t in range(T)
        ]
    
    # 热泵
    if hasattr(mTEPES, 'vQ_hp_out'):
        heating_data['HeatPump'] = [
            OptModel.get_value(mTEPES.vQ_hp_out[t]) for t in range(T)
        ]
    
    # CHP 供热
    enable_chp = params.get('enable_chp_planning', 0)
    if enable_chp > 0 and hasattr(mTEPES, 'vQ_chp_heat'):
        heating_data['CHP'] = [
            OptModel.get_value(mTEPES.vQ_chp_heat[t]) for t in range(T)
        ]

    # GT 余热进入热网（正项）
    enable_gt = params.get('enable_gt_planning', 1)
    if enable_gt > 0 and hasattr(mTEPES, 'vQ_gt_heat'):
        heating_data['GTHeat'] = [
            OptModel.get_value(mTEPES.vQ_gt_heat[t]) for t in range(T)
        ]

    # ST 消耗 GT 蒸汽（负项，按热平衡式从热网扣减）
    enable_st = params.get('enable_st_planning', 1)
    if enable_st > 0 and hasattr(mTEPES, 'vQ_st_steam'):
        heating_data['STSteamConsumption'] = [
            -OptModel.get_value(mTEPES.vQ_st_steam[t]) for t in range(T)
        ]
    
    # 储热罐（充/放）
    if hasattr(mTEPES, 'vQ_storage_discharge'):
        heating_data['StorageDischarge'] = [
            OptModel.get_value(mTEPES.vQ_storage_discharge[t]) for t in range(T)
        ]
        heating_data['StorageCharge'] = [
            -OptModel.get_value(mTEPES.vQ_storage_charge[t]) for t in range(T)  # 充热取负，表示消耗
        ]
    
    # 区域供热
    if hasattr(mTEPES, 'vQ_district'):
        heating_data['DistrictHeat'] = [
            OptModel.get_value(mTEPES.vQ_district[t]) for t in range(T)
        ]
    
    df_heating = pd.DataFrame(heating_data, index=idx)
    df_heating.index.names = ['Period', 'Scenario', 'LoadLevel']
    df_heating.to_csv(_path + '/oT_Result_BalanceHeating_' + CaseName + '.csv')
    print(f'制热平衡结果已保存: oT_Result_BalanceHeating_{CaseName}.csv  ({df_heating.shape})')



def ThermalPlotResults_poi(OptModel, mTEPES, DirName, CaseName, pIndLogConsole):
    """绘制热系统结果图表"""
    print('\n' + '='*60)
    print('热系统结果可视化')
    print('='*60)
    
    if mTEPES.pSolveStatus != poi.TerminationStatusCode.OPTIMAL:
        print('[错误] 模型未找到最优解')
        return
    
    print('\n热系统可视化功能待实现')


def DC_outputresult(DirName, CaseName, mTEPES, pIndLogConsole):
    """
    数据中心(EHCCS)结果输出入口。

    输出交互式/批处理/总负荷，以及“优化调度后”（批处理延迟执行后的实际执行曲线）到 CSV，
    并绘制前 168 个点曲线到同一张图。
    """
    # mTEPES 在本项目里通常同时扮演 OptModel
    OptModel = mTEPES

    if not hasattr(mTEPES, "pDC") or not hasattr(mTEPES, "pDCParams"):
        return None
    if not hasattr(mTEPES, "vDC_SrvAdd"):
        # 未建模（可能 DCPlanning=1 但未执行 modelformulation）
        return None

    print("\n" + "=" * 60)
    print("数据中心(EHCCS)结果（打印）")
    print("=" * 60)

    try:
        srv_add = OptModel.get_value(mTEPES.vDC_SrvAdd)
        cool_add = OptModel.get_value(mTEPES.vDC_CoolAdd_kW)
    except Exception:
        # 若求解失败或接口不一致，避免中断主流程
        print("  [提示] 当前无法读取 DC 规划变量的求解值（模型可能未求解到可读状态）")
        return None

    srv_exist = int(mTEPES.pDCParams.get("srv_exist_q", 0))
    print(f"  新增服务器数量 vDC_SrvAdd = {srv_add}")
    print(f"  服务器总数 = {srv_exist + srv_add}")
    print(f"  新增冷却容量 vDC_CoolAdd_kW = {float(cool_add):.1f} kW")
    if "lambda_inter" in mTEPES.pDC and "lambda_batch" in mTEPES.pDC:
        li = mTEPES.pDC["lambda_inter"]
        lb = mTEPES.pDC["lambda_batch"]
        print(f"  任务量统计: inter max={float(np.max(li)):.0f}, batch max={float(np.max(lb)):.0f}, total max={float(np.max(li+lb)):.0f}")

    # 打印前若干个时刻的运行量
    T = int(mTEPES.pDC.get("T", 0))
    k = min(5, T)
    if hasattr(mTEPES, "vDC_P_DC") and T > 0:
        print(f"  前 {k} 个时刻 DC 总功率(kW):")
        for t in range(k):
            try:
                pdc = OptModel.get_value(mTEPES.vDC_P_DC[t])
                pit = OptModel.get_value(mTEPES.vDC_P_IT[t])
                pcool = OptModel.get_value(mTEPES.vDC_P_cool[t])
                nsrv = OptModel.get_value(mTEPES.vDC_NSrv[t])
                print(f"    t={t}: N_srv={nsrv:.3f}, P_IT={pit:.3f}, P_cool={pcool:.3f}, P_DC={pdc:.3f}")
            except Exception:
                break

    # ========= 输出负荷曲线（到CSV + 一张图）=========
    if "n_list" not in mTEPES.pDC or "lambda_inter" not in mTEPES.pDC or "lambda_batch" not in mTEPES.pDC:
        return None

    n_list = mTEPES.pDC["n_list"]
    li = np.asarray(mTEPES.pDC["lambda_inter"], dtype=float)
    lb_arrival = np.asarray(mTEPES.pDC["lambda_batch"], dtype=float)
    total_arrival = li + lb_arrival

    # 优化调度后批处理执行曲线：batch_exec[t] = sum_{tau=max(0,t-D)..t} x[tau,t]
    lb_exec = np.zeros_like(lb_arrival)
    if hasattr(mTEPES, "vDC_BatchExec"):
        for t_idx in range(len(lb_exec)):
            s = 0.0
            tau_row0 = max(0, t_idx - (len(mTEPES.vDC_BatchExec[0]) - 1))
            for tau in range(tau_row0, t_idx + 1):
                k = t_idx - tau
                if tau < len(mTEPES.vDC_BatchExec) and k < len(mTEPES.vDC_BatchExec[tau]):
                    v = mTEPES.vDC_BatchExec[tau][k]
                    if v is not None:
                        s += float(OptModel.get_value(v))
            lb_exec[t_idx] = s

    total_scheduled = li + lb_exec

    # 写 CSV（索引从 config/ 的 Demand 读取；结果写到 output/）
    _path = _resolve_output_dir()
    _config = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'config')
    demand_path = os.path.join(_config, f"oT_Data_Demand_{CaseName}.csv")

    df_idx = pd.read_csv(demand_path, usecols=["Period", "Scenario", "LoadLevel"])
    df_idx["LoadLevel"] = df_idx["LoadLevel"].astype(str)

    df_loads = pd.DataFrame(
        {
            "LoadLevel": [str(n) for n in n_list],
            "inter_load": np.round(li).astype(int),
            "batch_load": np.round(lb_arrival).astype(int),
            "total_load": np.round(total_arrival).astype(int),
            "batch_exec_load": np.round(lb_exec).astype(int),
            "scheduled_total_load": np.round(total_scheduled).astype(int),
        }
    )

    # 以 Demand 的索引为准，按 LoadLevel 拼接（若有缺失则置 0）
    df_out = df_idx.merge(df_loads, on="LoadLevel", how="left")
    for c in ["inter_load", "batch_load", "total_load", "batch_exec_load", "scheduled_total_load"]:
        df_out[c] = df_out[c].fillna(0).astype(int)

    out_csv = os.path.join(_path, f"oT_Result_DCWorkload_{CaseName}.csv")
    df_out.to_csv(out_csv, index=False)
    print(f"  数据中心负荷曲线已保存: {out_csv}  ({df_out.shape})")

    # 画图：同一张图，前168点
    try:
        plt.rcParams["font.family"] = ["SimSun", "Times New Roman"]
        plt.rcParams["font.size"] = 14
        plt.rcParams["axes.unicode_minus"] = False

        kk = min(168, len(df_out))
        x = np.arange(kk)
        fig, ax = plt.subplots(nrows=1, ncols=1, figsize=(12, 5))
        # 交互式/批处理用虚线，2条总负载用粗实线区分“到达前”与“优化调度后”
        ax.plot(x, df_out["inter_load"].iloc[:kk].to_numpy(), color="tab:red", linewidth=1.5, linestyle="--", label="交互式负载")
        ax.plot(x, df_out["batch_load"].iloc[:kk].to_numpy(), color="tab:blue", linewidth=1.5, linestyle="--", label="批处理到达负载")
        ax.plot(x, df_out["total_load"].iloc[:kk].to_numpy(), color="tab:green", linewidth=3.0, linestyle="-", label="到达总负载")
        ax.plot(x, df_out["scheduled_total_load"].iloc[:kk].to_numpy(), color="tab:purple", linewidth=3.0, linestyle="-", label="优化调度后总负载")
        ax.set_title("数据中心负荷曲线（前168个点）")
        ax.set_xlabel("时刻（h）")
        ax.set_ylabel("负载（个）")
        ax.grid(True, alpha=0.3)
        ax.legend(loc="upper left")
        fig.tight_layout()
        out_png = os.path.join(_path, f"oT_Result_DCWorkload_{CaseName}.png")
        fig.savefig(out_png, dpi=150)
        plt.close(fig)
        print(f"  数据中心负荷图已保存: {out_png}")
    except Exception as e:
        print(f"  [提示] 绘图失败，已跳过: {e}")

    # ========= 画图：H_IT(=kappa*P_IT)、H_cool 与室内温度（同一张图）=========
    try:
        if (
            not hasattr(mTEPES, "vDC_P_IT")
            or not hasattr(mTEPES, "vDC_H_cool")
            or not hasattr(mTEPES, "vDC_T_in")
            or mTEPES.vDC_T_in is None
        ):
            return None

        plt.rcParams["font.family"] = ["SimSun", "Times New Roman"]
        plt.rcParams["font.size"] = 14
        plt.rcParams["axes.unicode_minus"] = False

        kk = min(168, T)
        x = np.arange(kk)

        pit_kw = np.array(
            [float(OptModel.get_value(mTEPES.vDC_P_IT[t])) for t in range(kk)],
            dtype=float,
        )
        h_cool_kwth = np.array(
            [float(OptModel.get_value(mTEPES.vDC_H_cool[t])) for t in range(kk)],
            dtype=float,
        )
        tin_c = np.array(
            [float(OptModel.get_value(mTEPES.vDC_T_in[t])) for t in range(kk)],
            dtype=float,
        )

        kappa = 1.0
        try:
            kappa = float(mTEPES.pDCParams.get("kappa_IT_kwth_per_kw", 1.0))
        except Exception:
            kappa = 1.0
        h_it_kwth = kappa * pit_kw

        fig, (ax1, ax2) = plt.subplots(
            nrows=2, ncols=1, figsize=(12, 7), sharex=True
        )

        ax1.plot(x, h_it_kwth, color="tab:orange", linewidth=2.5, label="IT/CPU产热 $H^{IT}=\\kappa P^{IT}$ (kW_th)")
        ax1.plot(x, h_cool_kwth, color="tab:blue", linewidth=2.5, label="制冷量 $H^{cool}$ (kW_th)")
        # 围护结构与室外温度引起的传热：H_env = (T_out - T_in)/R，单位 kW（与式(25)一致）
        try:
            r_dc = float(mTEPES.pDCParams.get("dc_R_C_per_kW", 0.0))
            if r_dc > 0 and "t_out_C" in mTEPES.pDC:
                t_out_c = np.asarray(mTEPES.pDC["t_out_C"], dtype=float)[:kk]
                h_env_kwth = (t_out_c - tin_c) / r_dc
                ax1.plot(x, h_env_kwth, color="tab:green", linewidth=2.5, label="室外传热 $(T^{out}-T^{in})/R$ (kW_th)")
        except Exception:
            pass
        ax1.set_title("室内热动力学相关量（前168个点）")
        ax1.set_ylabel("热功率 (kW_th)")
        ax1.grid(True, alpha=0.3)
        ax1.legend(loc="upper left")

        ax2.plot(x, tin_c, color="tab:red", linewidth=2.5, label="室内温度 $T^{in}$ (℃)")
        ax2.set_xlabel("时刻（h）")
        ax2.set_ylabel("室内温度 (℃)")
        ax2.grid(True, alpha=0.3)
        ax2.legend(loc="upper left")

        fig.tight_layout()
        out_png = os.path.join(_path, f"oT_Result_DCThermal_{CaseName}.png")
        fig.savefig(out_png, dpi=150)
        plt.close(fig)
        print(f"  室内温度/产热/制冷量 图已保存: {out_png}")
    except Exception as e:
        print(f"  [提示] 室内温度/产热/制冷量 绘图失败，已跳过: {e}")

    return None
