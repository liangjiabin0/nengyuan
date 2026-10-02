import math
import os
import sys
from datetime import datetime

# 设置路径
CUR_PATH = os.path.abspath(os.path.dirname(__file__))
lib_dir = os.path.dirname(os.path.dirname(CUR_PATH))
if lib_dir not in sys.path:
    sys.path.insert(0, lib_dir)

import time

import numpy as np
import pandas as pd
from power_grid_model import CalculationType, PowerGridModel
from power_grid_model.validation import assert_valid_input_data

from lib.dms.common.grid_model_builder import ModelBuilder
from lib.helper.log import logger
from lib.helper.time_utils import get_day_begin
from lib.loss.tools import division_0, format_complex


class CalcBase:
    def __init__(self, grid_model_builder: ModelBuilder):
        self.grid_model_builder = grid_model_builder
        self.calc_result = {}
        self.result = {}
        self.method = None
        self.grid_data: dict = {}

        self.init_result_df()

    def init_result_df(self):
        # 支路计算结果

        # dms_pas_se_notusemeas: 电力人工过滤遥测表，量测误差绝对值大于1000kW
        self.dms_pas_se_notusemeas = pd.DataFrame(
            {},
            columns=pd.Index(
                [
                    'MEAS_ID',
                    'MEAS_NAME',
                    'DEV_NAME',
                    'MEAS_TYPE',
                    'MEAS_VALUE',
                    'MAX_VALUE',
                    'MIN_VALUE',
                    'MEAS_STATUS',
                    'SE_VALUE',
                    'MEAS_FEEDER',
                    'MEAS_BULK',
                    'MEAS_ST',
                    'MEAS_MPSYS',
                    'MEAS_TIME',
                ]
            ),
        )

        # dms_pas_se_filtermeas: 电力预过滤遥测表，量测误差绝对值大于300kW且小于1000kW
        self.dms_pas_se_filtermeas = pd.DataFrame(
            {},
            columns=pd.Index(
                [
                    'MEAS_ID',
                    'MEAS_NAME',
                    'DEV_NAME',
                    'MEAS_TYPE',
                    'MEAS_VALUE',
                    'MAX_VALUE',
                    'MIN_VALUE',
                    'MEAS_STATUS',
                    'SE_VALUE',
                    'MEAS_FEEDER',
                    'MEAS_BULK',
                    'FILTER_REASON',
                    'MEAS_ST',
                    'MEAS_MPSYS',
                    'MEAS_TIME',
                ]
            ),
        )
        # dms_pas_se_badmeas: 电力系统状态估计坏数据表，量测误差绝对值大于100kW且小于等于300kW
        self.dms_pas_se_badmeas = pd.DataFrame(
            {},
            columns=pd.Index(
                [
                    'MEAS_ID',
                    'MEAS_NAME',
                    'DEV_NAME',
                    'MEAS_TYPE',
                    'MEAS_VALUE',
                    'MAX_VALUE',
                    'MIN_VALUE',
                    'MEAS_STATUS',
                    'SE_VALUE',
                    'MEAS_FEEDER',
                    'MEAS_BULK',
                    'MEAS_ST',
                    'MEAS_MPSYS',
                    'MEAS_TIME',
                ]
            ),
        )

        # dms_pas_se_meas: 电力系统状态估计量测数据表，所有量测信息
        self.dms_pas_se_meas = pd.DataFrame(
            {},
            columns=pd.Index(
                [
                    'MEAS_ID',
                    'MEAS_NAME',
                    'DEV_NAME',
                    'MEAS_TYPE',
                    'MEAS_VALUE',
                    'MAX_VALUE',
                    'MIN_VALUE',
                    'MEAS_STATUS',
                    'SE_VALUE',
                    'IS_FILTER',
                    'IS_BAD',
                    'IS_AVAL',
                    'IS_GOOD',
                    'MEAS_FEEDER',
                    'MEAS_BULK',
                    'MEAS_ST',
                    'MEAS_MPSYS',
                    'MEAS_TIME',
                ]
            ),
        )

        self.all_meas = pd.DataFrame(
            {},
            columns=pd.Index(
                [
                    'ID',
                    'NAME',
                    'FEEDER_ID',
                    'BULK_ID',
                    'ST_ID',
                    'TYPE',
                    'NOMINAL_ERROR',
                    'MEAS_VALUE',
                    'ESTIMATED_VALUE',
                    'ESTIMATED_ERROR',
                ]
            ),
        )

    def calc_result_static(self):
        meas_time = time.time()

        result = self.calc_result

        """处理计算结果，返回处理好的表结构"""
        branch_pq_se = self.grid_model_builder.branch_df
        dms_pas_se_notusemeas = self.dms_pas_se_notusemeas
        dms_pas_se_filtermeas = self.dms_pas_se_filtermeas
        dms_pas_se_badmeas = self.dms_pas_se_badmeas
        dms_pas_se_meas = self.dms_pas_se_meas

        cons_para = self.grid_model_builder.cons_para
        all_meas = self.all_meas
        feeder_model = self.grid_model_builder.feeder_model

        feeder_id = feeder_model['FEEDER_ID']

        bug_feeder = False
        if len(self.grid_data['sym_load']) == 0:
            bug_feeder = True
        branch_df = self.grid_model_builder.branch_df
        bus_df = self.grid_model_builder.bus_df
        nbus_df = len(bus_df)

        trwd = self.grid_model_builder.trwd
        ntrwd = len(trwd)
        load = self.grid_model_builder.load
        nload = len(load)

        ntopo = self.grid_model_builder.feeder_model['subcount']
        ndevload = len(self.grid_model_builder.feeder_model['trwd']) / 2 + len(self.grid_model_builder.feeder_model['load'])
        n_bus = len(self.grid_model_builder.bus_df)
        self.bus_df = bus_df
        self.branch_df = branch_df

        total_baderr = 0
        total_notuseerr = 0
        total_err = 0
        total_filtererr = 0
        ncount_badmeas = 0
        ncount_filtermeas = 0
        ncount_notusemeas = 0

        if result is not None:
            bus_vol_results = pd.DataFrame(result['node']['u'])
            bus_angle_results = pd.DataFrame(result['node']['u_angle'])
            branch_if_results = pd.DataFrame(result['line']['i_from'])
            branch_pf_results = pd.DataFrame(result['line']['p_from'])
            branch_qf_results = pd.DataFrame(result['line']['q_from'])
            branch_pt_results = pd.DataFrame(result['line']['p_to'])
            branch_qt_results = pd.DataFrame(result['line']['q_to'])

            for i_br in range(len(self.grid_model_builder.branch_df)):
                branch_pq_se.loc[
                    i_br,
                    [
                        'BV_ID',
                        'FEEDER_ID',
                        'INODE_ID',
                        'ZNODE_ID',
                        'BR_TYPE',
                        'ORI_INODE_ID',
                        'ORI_ZNODE_ID',
                        'RDF_ID',
                        'NAME',
                        'MVA',
                    ],
                ] = self.grid_model_builder.branch_df.loc[
                    i_br,
                    [
                        'BV_ID',
                        'FEEDER_ID',
                        'INODE_ID',
                        'ZNODE_ID',
                        'BR_TYPE',
                        'ORI_INODE_ID',
                        'ORI_ZNODE_ID',
                        'RDF_ID',
                        'NAME',
                        'MVA',
                    ],
                ]
                inode_id = branch_pq_se.at[i_br, 'INODE_ID'] - 1
                Ua = bus_vol_results.at[inode_id, 0]
                thea = bus_angle_results.at[inode_id, 0]
                Ub = bus_vol_results.at[inode_id, 1]
                theb = bus_angle_results.at[inode_id, 1]
                Uc = bus_vol_results.at[inode_id, 2]
                thec = bus_angle_results.at[inode_id, 2]

                branch_pq_se.loc[
                    i_br,
                    [
                        'PA',
                        'PB',
                        'PC',
                        'P_SUM',
                        'QA',
                        'QB',
                        'QC',
                        'Q_SUM',
                        'VMA',
                        'VMB',
                        'VMC',
                        'VAA',
                        'VAB',
                        'VAC',
                        'IMA',
                        'IMB',
                        'IMC',
                        'UAB',
                        'UBC',
                        'UCA',
                        'IAB',
                        'IBC',
                        'ICA',
                    ],
                ] = [
                    branch_pf_results.at[i_br, 0],
                    branch_pf_results.at[i_br, 1],
                    branch_pf_results.at[i_br, 2],
                    branch_pf_results.at[i_br, 0] + branch_pf_results.at[i_br, 1] + branch_pf_results.at[i_br, 2],
                    branch_qf_results.at[i_br, 0],
                    branch_qf_results.at[i_br, 1],
                    branch_qf_results.at[i_br, 2],
                    branch_qf_results.at[i_br, 0] + branch_qf_results.at[i_br, 1] + branch_qf_results.at[i_br, 2],
                    Ua,  # 相电压
                    Ub,  # 相电压
                    Uc,  # 相电压
                    thea,
                    theb,
                    thec,
                    branch_if_results.at[i_br, 0],
                    branch_if_results.at[i_br, 1],
                    branch_if_results.at[i_br, 2],
                    # np.abs((Ub * np.cos(theb) + 1j * Ub * np.sin(theb)) - (Ua * np.cos(thea) + 1j * Ua * np.sin(thea))),
                    Ua,
                    # np.abs((Uc * np.cos(thec) + 1j * Uc * np.sin(thec)) - (Ub * np.cos(theb) + 1j * Ub * np.sin(theb))),
                    Ub,
                    # np.abs((Ua * np.cos(thea) + 1j * Ua * np.sin(thea)) - (Uc * np.cos(thec) + 1j * Uc * np.sin(thec))),
                    Uc,
                    branch_if_results.at[i_br, 0] * np.sqrt(3),
                    branch_if_results.at[i_br, 1] * np.sqrt(3),
                    branch_if_results.at[i_br, 2] * np.sqrt(3),
                ]

            float_columns = [
                'PA',
                'PB',
                'PC',
                'P_SUM',
                'QA',
                'QB',
                'QC',
                'Q_SUM',
                'VMA',
                'VMB',
                'VMC',
                'VAA',
                'VAB',
                'VAC',
                'IMA',
                'IMB',
                'IMC',
                'UAB',
                'UBC',
                'UCA',
                'IAB',
                'IBC',
                'ICA',
            ]
            for col in float_columns:
                branch_pq_se[col] = branch_pq_se[col].astype(float)
            # branch_pq_se[float_columns] = branch_pq_se[float_columns].apply(pd.to_numeric, errors='coerce').fillna(0.0)
            # 上一行是更健壮的写法，可根据实际需求选择是否填充无效值
            ################################################---变压器功率计算结果有名化---######################################################

            # 消除类型可能异常的警告

            if ntrwd > 0:
                trwd[['PA', 'PB', 'PC', 'QA', 'QB', 'QC']] = trwd[['PA', 'PB', 'PC', 'QA', 'QB', 'QC']].astype(float)

            for itrwd in range(ntrwd):
                for ibus in range(nbus_df):
                    if trwd.at[itrwd, 'NODE_ID'] == bus_df.at[ibus, 'ORI_ID']:
                        node_id = bus_df.at[ibus, 'ID']
                        trwd.at[itrwd, 'VMA'] = bus_vol_results.at[ibus, 0]
                        trwd.at[itrwd, 'VMB'] = bus_vol_results.at[ibus, 1]
                        trwd.at[itrwd, 'VMC'] = bus_vol_results.at[ibus, 2]

                        for ibr in range(len(branch_df)):
                            if branch_df.at[ibr, 'INODE_ID'] == node_id and branch_df.at[ibr, 'BR_TYPE'] == 4:
                                # P12
                                trwd.loc[itrwd, ['PA', 'PB', 'PC', 'QA', 'QB', 'QC']] = [
                                    branch_pf_results.at[ibr, 0],
                                    branch_pf_results.at[ibr, 1],
                                    branch_pf_results.at[ibr, 2],
                                    # Q12
                                    branch_qf_results.at[ibr, 0],
                                    branch_qf_results.at[ibr, 1],
                                    branch_qf_results.at[ibr, 2],
                                ]
                                trwd.at[itrwd, 'P'] = trwd.at[itrwd, 'PA'] + trwd.at[itrwd, 'PB'] + trwd.at[itrwd, 'PC']
                                trwd.at[itrwd, 'Q'] = trwd.at[itrwd, 'QA'] + trwd.at[itrwd, 'QB'] + trwd.at[itrwd, 'QC']
                            if branch_df.at[ibr, 'ZNODE_ID'] == node_id and branch_df.at[ibr, 'BR_TYPE'] == 4:
                                # P12
                                trwd.loc[itrwd, ['PA', 'PB', 'PC', 'QA', 'QB', 'QC']] = [
                                    (-1) * branch_pt_results.at[ibr, 0],
                                    (-1) * branch_pt_results.at[ibr, 1],
                                    (-1) * branch_pt_results.at[ibr, 2],
                                    (-1) * branch_qt_results.at[ibr, 0],
                                    (-1) * branch_qt_results.at[ibr, 1],
                                    (-1) * branch_qt_results.at[ibr, 2],
                                ]
                                trwd.at[itrwd, 'P'] = trwd.at[itrwd, 'PA'] + trwd.at[itrwd, 'PB'] + trwd.at[itrwd, 'PC']
                                trwd.at[itrwd, 'Q'] = trwd.at[itrwd, 'QA'] + trwd.at[itrwd, 'QB'] + trwd.at[itrwd, 'QC']

            for col in ['PA', 'PB', 'PC', 'QA', 'QB', 'QC']:
                if col not in load.columns:
                    load[col] = 0.0
            for iload in range(nload):
                for ibus in range(nbus_df):
                    if load.at[iload, 'NODE_ID'] == bus_df.at[ibus, 'ORI_ID']:
                        node_id = bus_df.at[ibus, 'ID']
                        load.at[iload, 'VMA'] = bus_vol_results.at[ibus, 0]
                        load.at[iload, 'VMB'] = bus_vol_results.at[ibus, 1]
                        load.at[iload, 'VMC'] = bus_vol_results.at[ibus, 2]
                        for ibr in range(len(branch_df)):
                            if branch_df.at[ibr, 'ZNODE_ID'] == node_id:
                                # P12
                                load.loc[iload, ['PA', 'PB', 'PC', 'QA', 'QB', 'QC']] = [
                                    (-1) * branch_pt_results.at[ibr, 0],
                                    (-1) * branch_pt_results.at[ibr, 1],
                                    (-1) * branch_pt_results.at[ibr, 2],
                                    # Q12
                                    (-1) * branch_qt_results.at[ibr, 0],
                                    (-1) * branch_qt_results.at[ibr, 1],
                                    (-1) * branch_qt_results.at[ibr, 2],
                                ]
                                load.at[iload, 'P'] = load.at[iload, 'PA'] + load.at[iload, 'PB'] + load.at[iload, 'PC']
                                load.at[iload, 'Q'] = load.at[iload, 'QA'] + load.at[iload, 'QB'] + load.at[iload, 'QC']

            if self.method == 'se':
                #########################################################---添加量测---######################################################
                # sym voltage sensor
                imeas = 0

                for ibus in range(len(bus_df)):
                    if (
                        bus_df.at[ibus, 'VMA_PRE'] * cons_para.voltage_input_factor >= 0.7 * cons_para.Ubase_low
                        and bus_df.at[ibus, 'VMA_PRE'] * cons_para.voltage_input_factor <= 1.3 * cons_para.Ubase_low
                        and bus_df.at[ibus, 'VMB_PRE'] * cons_para.voltage_input_factor >= 0.7 * cons_para.Ubase_low
                        and bus_df.at[ibus, 'VMB_PRE'] * cons_para.voltage_input_factor <= 1.3 * cons_para.Ubase_low
                        and bus_df.at[ibus, 'VMC_PRE'] * cons_para.voltage_input_factor >= 0.7 * cons_para.Ubase_low
                        and bus_df.at[ibus, 'VMC_PRE'] * cons_para.voltage_input_factor <= 1.3 * cons_para.Ubase_low
                    ):
                        # all_meas 统计量测
                        all_meas.loc[
                            imeas,
                            [
                                'ID',
                                'NAME',
                                'FEEDER_ID',
                                'BULK_ID',
                                'ST_ID',
                                'TYPE',
                                'NOMINAL_ERROR',
                                'MEAS_VALUE',
                            ],
                        ] = [
                            imeas + 1,
                            bus_df.at[ibus, 'NAME'],
                            feeder_id,
                            feeder_model['so']['BULK_ID'],
                            feeder_model['ST_ID'],
                            'A相电压量测',
                            10,
                            bus_df.at[ibus, 'VMA_PRE'] * cons_para.voltage_input_factor,
                        ]
                        imeas += 1

                        all_meas.loc[
                            imeas,
                            [
                                'ID',
                                'NAME',
                                'FEEDER_ID',
                                'BULK_ID',
                                'ST_ID',
                                'TYPE',
                                'NOMINAL_ERROR',
                                'MEAS_VALUE',
                            ],
                        ] = [
                            imeas + 1,
                            bus_df.at[ibus, 'NAME'],
                            feeder_id,
                            feeder_model['so']['BULK_ID'],
                            feeder_model['ST_ID'],
                            'B相电压量测',
                            10,
                            bus_df.at[ibus, 'VMB_PRE'] * cons_para.voltage_input_factor,
                        ]
                        imeas += 1

                        all_meas.loc[
                            imeas,
                            [
                                'ID',
                                'NAME',
                                'FEEDER_ID',
                                'BULK_ID',
                                'ST_ID',
                                'TYPE',
                                'NOMINAL_ERROR',
                                'MEAS_VALUE',
                            ],
                        ] = [
                            imeas + 1,
                            bus_df.at[ibus, 'NAME'],
                            feeder_id,
                            feeder_model['so']['BULK_ID'],
                            feeder_model['ST_ID'],
                            'C相电压量测',
                            10,
                            bus_df.at[ibus, 'VMC_PRE'] * cons_para.voltage_input_factor,
                        ]
                        imeas += 1

                if all_meas.shape[0] == 0:
                    # all_meas 统计量测
                    all_meas.loc[
                        imeas,
                        [
                            'ID',
                            'NAME',
                            'FEEDER_ID',
                            'BULK_ID',
                            'ST_ID',
                            'TYPE',
                            'NOMINAL_ERROR',
                            'MEAS_VALUE',
                        ],
                    ] = [
                        imeas + 1,
                        bus_df.at[0, 'NAME'],
                        feeder_id,
                        feeder_model['so']['BULK_ID'],
                        feeder_model['ST_ID'],
                        'A相电压量测',
                        10,
                        cons_para.Ubase_low,
                    ]
                    imeas += 1

                    all_meas.loc[
                        imeas,
                        [
                            'ID',
                            'NAME',
                            'FEEDER_ID',
                            'BULK_ID',
                            'ST_ID',
                            'TYPE',
                            'NOMINAL_ERROR',
                            'MEAS_VALUE',
                        ],
                    ] = [
                        imeas + 1,
                        bus_df.at[0, 'NAME'],
                        feeder_id,
                        feeder_model['so']['BULK_ID'],
                        feeder_model['ST_ID'],
                        'B相电压量测',
                        10,
                        cons_para.Ubase_low,
                    ]
                    imeas += 1

                    all_meas.loc[
                        imeas,
                        [
                            'ID',
                            'NAME',
                            'FEEDER_ID',
                            'BULK_ID',
                            'ST_ID',
                            'TYPE',
                            'NOMINAL_ERROR',
                            'MEAS_VALUE',
                        ],
                    ] = [
                        imeas + 1,
                        bus_df.at[0, 'NAME'],
                        feeder_id,
                        feeder_model['so']['BULK_ID'],
                        feeder_model['ST_ID'],
                        'C相电压量测',
                        10,
                        cons_para.Ubase_low,
                    ]
                    imeas += 1

                for i_bus_df in range(nbus_df):
                    pa_pre = bus_df.at[i_bus_df, 'PA_PRE']
                    if pa_pre != 0 and pa_pre >= -10000 and pa_pre <= 10000:
                        bus_df_ibus = bus_df.loc[i_bus_df]
                        all_meas.loc[
                            imeas,
                            [
                                'ID',
                                'NAME',
                                'FEEDER_ID',
                                'BULK_ID',
                                'ST_ID',
                                'TYPE',
                                'NOMINAL_ERROR',
                                'MEAS_VALUE',
                            ],
                        ] = [
                            imeas + 1,
                            bus_df_ibus['NAME'],
                            feeder_id,
                            feeder_model['so']['BULK_ID'],
                            feeder_model['ST_ID'],
                            '负荷有功功率量测',
                            1,
                            pa_pre + bus_df_ibus['PB_PRE'] + bus_df_ibus['PC_PRE'],
                        ]
                        imeas += 1

                        all_meas.loc[
                            imeas,
                            [
                                'ID',
                                'NAME',
                                'FEEDER_ID',
                                'BULK_ID',
                                'ST_ID',
                                'TYPE',
                                'NOMINAL_ERROR',
                                'MEAS_VALUE',
                            ],
                        ] = [
                            imeas + 1,
                            bus_df_ibus['NAME'],
                            feeder_id,
                            feeder_model['so']['BULK_ID'],
                            feeder_model['ST_ID'],
                            '负荷无功功率量测',
                            1,
                            bus_df_ibus['QA_PRE'] + bus_df_ibus['QB_PRE'] + bus_df_ibus['QC_PRE'],
                        ]
                        imeas += 1

                # 添加支路功率量测 line
                for ibr in range(self.grid_model_builder.nbr_df):
                    if branch_df.at[ibr, 'PA_PRE'] != 0:
                        # all_meas 统计量测
                        all_meas.loc[
                            imeas,
                            [
                                'ID',
                                'NAME',
                                'FEEDER_ID',
                                'BULK_ID',
                                'ST_ID',
                                'TYPE',
                                'NOMINAL_ERROR',
                                'MEAS_VALUE',
                            ],
                        ] = [
                            imeas + 1,
                            branch_df.at[ibr, 'NAME'],
                            feeder_id,
                            feeder_model['so']['BULK_ID'],
                            feeder_model['ST_ID'],
                            '支路有功功率量测',
                            100,
                            branch_df.at[ibr, 'PA_PRE'] + branch_df.at[ibr, 'PB_PRE'] + branch_df.at[ibr, 'PC_PRE'],
                        ]
                        imeas += 1

                        # all_meas 统计量测
                        all_meas.loc[
                            imeas,
                            [
                                'ID',
                                'NAME',
                                'FEEDER_ID',
                                'BULK_ID',
                                'ST_ID',
                                'TYPE',
                                'NOMINAL_ERROR',
                                'MEAS_VALUE',
                            ],
                        ] = [
                            imeas + 1,
                            branch_df.at[ibr, 'NAME'],
                            feeder_id,
                            feeder_model['so']['BULK_ID'],
                            feeder_model['ST_ID'],
                            '支路无功功率量测',
                            100,
                            branch_df.at[ibr, 'QA_PRE'] + branch_df.at[ibr, 'QB_PRE'] + branch_df.at[ibr, 'QC_PRE'],
                        ]
                        imeas += 1

                umag_residual = self.calc_result['asym_voltage_sensor']['u_residual']
                if len(self.grid_data['sym_load']) > 0:
                    nvol_meas = len(self.grid_model_builder.asym_voltage_sensor)
                    npower_meas = len(self.grid_model_builder.sym_power_sensor)

                    for i in range(nvol_meas):
                        all_meas.at[3 * i + 0, 'ESTIMATED_VALUE'] = all_meas.at[3 * i + 0, 'MEAS_VALUE'] - float(umag_residual[i][0])
                        all_meas.at[3 * i + 1, 'ESTIMATED_VALUE'] = all_meas.at[3 * i + 1, 'MEAS_VALUE'] - float(umag_residual[i][1])
                        all_meas.at[3 * i + 2, 'ESTIMATED_VALUE'] = all_meas.at[3 * i + 2, 'MEAS_VALUE'] - float(umag_residual[i][2])
                        all_meas.at[3 * i + 0, 'ESTIMATED_ERROR'] = float(umag_residual[i][0])
                        all_meas.at[3 * i + 1, 'ESTIMATED_ERROR'] = float(umag_residual[i][1])
                        all_meas.at[3 * i + 2, 'ESTIMATED_ERROR'] = float(umag_residual[i][2])

                    for i_power in range(npower_meas):
                        index = 3 * nvol_meas + 2 * i_power

                        # 有功
                        p_residual = float(np.sum(result['sym_power_sensor']['p_residual'][i_power]))
                        all_meas.at[index + 0, 'ESTIMATED_ERROR'] = p_residual
                        all_meas.at[index + 0, 'ESTIMATED_VALUE'] = all_meas.at[index + 0, 'MEAS_VALUE'] - all_meas.at[index + 0, 'ESTIMATED_ERROR']

                        # 无功
                        q_residual = float(np.sum(result['sym_power_sensor']['q_residual'][i_power]))
                        all_meas.at[index + 1, 'ESTIMATED_ERROR'] = q_residual
                        all_meas.at[index + 1, 'ESTIMATED_VALUE'] = all_meas.at[index + 1, 'MEAS_VALUE'] - q_residual

            i_notusemeas = 0
            i_filter_meas = 0
            i_bad_meas = 0
            i_meas = 0

            sbase_3 = 3 * cons_para.Sbase
            sbase_0_5 = 0.5 * cons_para.Sbase

            # 总量测残差，标幺值

            meas_type = 0
            for imeas in range(len(all_meas)):
                # 所有量测
                cur_meas = all_meas.iloc[imeas]
                np_abs_cur = np.abs(cur_meas['ESTIMATED_ERROR'])
                if np.isnan(np_abs_cur):
                    np_abs_cur = 0
                if cur_meas['TYPE'] in ['负荷有功功率量测', '支路有功功率量测']:
                    meas_type = 1
                if cur_meas['TYPE'] in ['负荷无功功率量测', '支路无功功率量测']:
                    meas_type = 2
                if cur_meas['TYPE'] in ['A相电压量测', 'B相电压量测', 'C相电压量测']:
                    meas_type = 3
                if cur_meas['TYPE'] == '支路电流量测':
                    meas_type = 4
                dms_pas_se_meas.loc[i_meas] = {
                    'MEAS_ID': cur_meas['ID'],
                    'MEAS_NAME': cur_meas['NAME'] + cur_meas['TYPE'],
                    'DEV_NAME': cur_meas['NAME'],
                    'MEAS_TYPE': meas_type,
                    'MEAS_VALUE': cur_meas['MEAS_VALUE'],
                    'MAX_VALUE': cur_meas['ESTIMATED_VALUE'] + sbase_3,
                    'MIN_VALUE': cur_meas['ESTIMATED_VALUE'] - sbase_3,
                    'MEAS_STATUS': 1,
                    'SE_VALUE': cur_meas['ESTIMATED_VALUE'],
                    'IS_FILTER': 1 if np_abs_cur >= sbase_3 else 0,
                    'IS_BAD': 1 if sbase_0_5 <= np_abs_cur < sbase_3 else 0,
                    'IS_AVAL': 0 if np_abs_cur >= sbase_3 else 1,
                    'IS_GOOD': 1 if np_abs_cur < sbase_0_5 else 0,
                    'MEAS_FEEDER': cur_meas['FEEDER_ID'],
                    'MEAS_BULK': cur_meas['BULK_ID'],
                    'MEAS_ST': cur_meas['ST_ID'],
                    'MEAS_MPSYS': 1,
                    'MEAS_TIME': meas_time,
                }

                i_meas += 1

                # 人工预过滤
                if np_abs_cur >= 10 * cons_para.Sbase:
                    dms_pas_se_notusemeas.loc[i_notusemeas] = {
                        'MEAS_ID': cur_meas['ID'],
                        'MEAS_NAME': cur_meas['NAME'] + cur_meas['TYPE'],
                        'DEV_NAME': cur_meas['NAME'],
                        'MEAS_TYPE': meas_type,
                        'MEAS_VALUE': cur_meas['MEAS_VALUE'],
                        'MAX_VALUE': cur_meas['ESTIMATED_VALUE'] + sbase_3,
                        'MIN_VALUE': cur_meas['ESTIMATED_VALUE'] - sbase_3,
                        'MEAS_STATUS': 1,
                        'SE_VALUE': cur_meas['ESTIMATED_VALUE'],
                        'MEAS_FEEDER': cur_meas['FEEDER_ID'],
                        'MEAS_BULK': cur_meas['BULK_ID'],
                        'MEAS_ST': cur_meas['ST_ID'],
                        'MEAS_MPSYS': 1,
                        'MEAS_TIME': meas_time,
                    }
                    i_notusemeas += 1

                # 预过滤
                if np_abs_cur >= sbase_3 and np_abs_cur <= 10 * cons_para.Sbase:
                    filter = ''
                    if cur_meas['MEAS_VALUE'] > cur_meas['ESTIMATED_VALUE'] + sbase_3:
                        filter = '越上限'
                    if cur_meas['MEAS_VALUE'] < cur_meas['ESTIMATED_VALUE'] - sbase_3:
                        filter = '越下限'
                    dms_pas_se_filtermeas.loc[i_filter_meas] = {
                        'MEAS_ID': cur_meas['ID'],
                        'MEAS_NAME': cur_meas['NAME'] + cur_meas['TYPE'],
                        'DEV_NAME': cur_meas['NAME'],
                        'MEAS_TYPE': meas_type,
                        'MEAS_VALUE': cur_meas['MEAS_VALUE'],
                        'MAX_VALUE': cur_meas['ESTIMATED_VALUE'] + sbase_3,
                        'MIN_VALUE': cur_meas['ESTIMATED_VALUE'] - sbase_3,
                        'MEAS_STATUS': 1,
                        'SE_VALUE': cur_meas['ESTIMATED_VALUE'],
                        'FILTER_REASON': filter,
                        'MEAS_FEEDER': cur_meas['FEEDER_ID'],
                        'MEAS_BULK': cur_meas['BULK_ID'],
                        'MEAS_ST': cur_meas['ST_ID'],
                        'MEAS_MPSYS': 1,
                        'MEAS_TIME': meas_time,
                    }

                    i_filter_meas += 1

                # 坏数据
                if np_abs_cur >= sbase_0_5 and np_abs_cur < sbase_3:
                    dms_pas_se_badmeas.loc[i_bad_meas] = {
                        'MEAS_ID': cur_meas['ID'],
                        'MEAS_NAME': cur_meas['NAME'] + cur_meas['TYPE'],
                        'DEV_NAME': cur_meas['NAME'],
                        'MEAS_TYPE': meas_type,
                        'MEAS_VALUE': cur_meas['MEAS_VALUE'],
                        'MAX_VALUE': cur_meas['ESTIMATED_VALUE'] + sbase_0_5,
                        'MIN_VALUE': cur_meas['ESTIMATED_VALUE'] - sbase_3,
                        'MEAS_STATUS': 1,
                        'SE_VALUE': cur_meas['ESTIMATED_VALUE'],
                        'MEAS_FEEDER': cur_meas['FEEDER_ID'],
                        'MEAS_BULK': cur_meas['BULK_ID'],
                        'MEAS_ST': cur_meas['ST_ID'],
                        'MEAS_MPSYS': 1,
                        'MEAS_TIME': meas_time,
                    }
                    i_bad_meas += 1

                if cur_meas['TYPE'] in ['负荷有功功率量测', '支路有功功率量测', '负荷无功功率量测', '支路无功功率量测']:
                    total_err += np_abs_cur / cons_para.Sbase
                if cur_meas['TYPE'] in ['A相电压量测', 'B相电压量测', 'C相电压量测']:
                    total_err += np_abs_cur / cons_para.Ubase_low

            for df in [
                dms_pas_se_notusemeas,
                dms_pas_se_filtermeas,
                dms_pas_se_badmeas,
                dms_pas_se_meas,
            ]:
                for col in ['MAX_VALUE', 'MIN_VALUE', 'MEAS_VALUE', 'SE_VALUE']:
                    df[col] = df[col].astype(float)

            # 统计人工预过滤量测的残差，标幺值
            ncount_notusemeas = len(dms_pas_se_notusemeas)  # 人工预过滤量测数
            ncount_filtermeas = len(dms_pas_se_filtermeas)  # 预过滤量测数
            ncount_badmeas = len(dms_pas_se_badmeas)  # 坏数据量测数
            for i_notusemeas in range(ncount_notusemeas):
                if dms_pas_se_notusemeas.at[i_notusemeas, 'MEAS_TYPE'] == 1 or dms_pas_se_notusemeas.at[i_notusemeas, 'MEAS_TYPE'] == 2:
                    total_notuseerr += np.abs(dms_pas_se_notusemeas.at[i_notusemeas, 'MEAS_VALUE'] - dms_pas_se_notusemeas.at[i_notusemeas, 'SE_VALUE']) / cons_para.Sbase
                if dms_pas_se_notusemeas.at[i_notusemeas, 'MEAS_TYPE'] == 3:
                    total_notuseerr += np.abs(dms_pas_se_notusemeas.at[i_notusemeas, 'MEAS_VALUE'] - dms_pas_se_notusemeas.at[i_notusemeas, 'SE_VALUE']) / cons_para.Ubase_low

            # 统计预过滤量测的残差，标幺值

            for i_filtermeas in range(ncount_filtermeas):
                if dms_pas_se_filtermeas.at[i_filtermeas, 'MEAS_TYPE'] == 1 or dms_pas_se_filtermeas.at[i_filtermeas, 'MEAS_TYPE'] == 2:
                    total_filtererr += np.abs(dms_pas_se_filtermeas.at[i_filtermeas, 'MEAS_VALUE'] - dms_pas_se_filtermeas.at[i_filtermeas, 'SE_VALUE']) / cons_para.Sbase
                if dms_pas_se_filtermeas.at[i_filtermeas, 'MEAS_TYPE'] == 3:
                    total_filtererr += np.abs(dms_pas_se_filtermeas.at[i_filtermeas, 'MEAS_VALUE'] - dms_pas_se_filtermeas.at[i_filtermeas, 'SE_VALUE']) / cons_para.Ubase_low

            # 统计坏数据量测的残差，标幺值

            for i_badmeas in range(ncount_badmeas):
                if dms_pas_se_badmeas.at[i_badmeas, 'MEAS_TYPE'] == 1 or dms_pas_se_badmeas.at[i_badmeas, 'MEAS_TYPE'] == 2:
                    total_baderr += np.abs(dms_pas_se_badmeas.at[i_badmeas, 'MEAS_VALUE'] - dms_pas_se_badmeas.at[i_badmeas, 'SE_VALUE']) / cons_para.Sbase
                if dms_pas_se_badmeas.at[i_badmeas, 'MEAS_TYPE'] == 3:
                    total_baderr += np.abs(dms_pas_se_badmeas.at[i_badmeas, 'MEAS_VALUE'] - dms_pas_se_badmeas.at[i_badmeas, 'SE_VALUE']) / cons_para.Ubase_low

        self.result = {
            'tables': {
                'all_meas': all_meas,
                'dms_pas_se_notusemeas': dms_pas_se_notusemeas,
                'dms_pas_se_filtermeas': dms_pas_se_filtermeas,
                'dms_pas_se_badmeas': dms_pas_se_badmeas,
                'dms_pas_se_meas': dms_pas_se_meas,
                'branch_pq_se': branch_pq_se,
            },
            'statics': {
                'bug_feeder': bug_feeder,
                'ntopo': ntopo,
                'ndevload': ndevload,
                'n_bus': n_bus,
                'ncount_notusemeas': ncount_notusemeas,
                'ncount_filtermeas': ncount_filtermeas,
                'ncount_badmeas': ncount_badmeas,
                'total_notuseerr': total_notuseerr,
                'total_filtererr': total_filtererr,
                'total_baderr': total_baderr,
                'total_err': total_err,
            },
        }

        # output_path = os.path.join(CUR_PATH, 'output')
        # logger.info(f"计算结果生成文件到：{output_path}")
        # all_meas.to_csv(os.path.join(output_path, 'all_meas.csv'), index=False, float_format='%.4f', encoding='utf-8')
        # dms_pas_se_notusemeas.to_csv(os.path.join(output_path, 'dms_pas_se_notusemeas.csv'), index=False,
        #                              float_format='%.4f', encoding='utf-8')
        # dms_pas_se_filtermeas.to_csv(os.path.join(output_path, 'dms_pas_se_filtermeas.csv'), index=False,
        #                              float_format='%.4f', encoding='utf-8')
        # dms_pas_se_badmeas.to_csv(os.path.join(output_path, 'dms_pas_se_badmeas.csv'), index=False,
        #                            float_format='%.4f', encoding='utf-8')
        # dms_pas_se_meas.to_csv(os.path.join(output_path, 'dms_pas_se_meas.csv'), index=False,
        #                          float_format='%.4f', encoding='utf-8')
        # branch_pq_se.to_csv(os.path.join(output_path, 'branch_pq_se.csv'), index=False,
        #                       float_format='%.4f', encoding='utf-8')
        # trwd.to_csv(os.path.join(output_path, 'trwd.csv'), index=False,
        #               float_format='%.4f', encoding='utf-8')

        # logger.info(f"计算结果已准备完毕，用时 {time.time() - meas_time:.2f} 秒")
        # logger.info(f'\t[tables] '
        #       f'\n\t\t all_meas: {len(all_meas)} '
        #       f'\n\t\t dms_pas_se_notusemeas: {len(dms_pas_se_notusemeas)} '
        #       f'\n\t\t dms_pas_se_filtermeas: {len(dms_pas_se_filtermeas)} '
        #       f'\n\t\t dms_pas_se_badmeas: {len(dms_pas_se_badmeas)} '
        #       f'\n\t\t dms_pas_se_meas: {len(dms_pas_se_meas)} '
        #       f'\n\t\t branch_pq_se: {len(branch_pq_se)} '
        #       f'\n\t\t trwd: {len(trwd)} '
        #       f'\n\t\t load: {len(load)} ')
        # logger.info(f'\t[statics] '
        #       f'\n\t\t bug_feeder: {bug_feeder} '
        #       f'\n\t\t ntopo: {ntopo} '
        #       f'\n\t\t ndevload: {ndevload} '
        #       f'\n\t\t n_bus: {n_bus} '
        #       f'\n\t\t ncount_notusemeas: {ncount_notusemeas} '
        #       f'\n\t\t ncount_filtermeas: {ncount_filtermeas} ')

        return self.result

    def calc_dev_meas(self):
        pass


class StateEstimate(CalcBase):
    def __init__(self, grid_model_builder: ModelBuilder):
        super().__init__(grid_model_builder)
        self.method = 'se'

    def validate_model(self):
        """验证模型有效性"""
        assert_valid_input_data(
            input_data=self.grid_data,
            calculation_type=CalculationType.power_flow,
            symmetric=False,
        )

        assert_valid_input_data(
            input_data=self.grid_data,
            calculation_type=CalculationType.state_estimation,
            symmetric=False,
        )

    def calculate(self):
        """执行状态估计计算"""

        self.grid_data = self.grid_model_builder.build_se()
        self.validate_model()

        try:
            self.calc_result = PowerGridModel(self.grid_data).calculate_state_estimation(symmetric=False, error_tolerance=1e-3)
            logger.success(f'{self.grid_model_builder.feeder_model["FEEDER_NAME"]} 状态估计 收敛')

        except Exception as e:
            logger.error(f'{self.grid_model_builder.feeder_model["FEEDER_NAME"]} 状态估计 不收敛')
            logger.exception(e)
            self.calc_result = None

        return self.calc_result


class PowerFlow(CalcBase):
    def __init__(self, grid_model_builder: ModelBuilder):
        super().__init__(grid_model_builder)
        self.method = 'olf'

    def validate_model(self):
        """验证模型有效性"""
        assert_valid_input_data(
            input_data=self.grid_data,
            calculation_type=CalculationType.power_flow,
            symmetric=False,
        )

    def calculate(self):
        """执行潮流计算"""
        self.grid_data = self.grid_model_builder.build_olf()
        self.validate_model()
        try:
            self.calc_result = PowerGridModel(self.grid_data).calculate_power_flow(symmetric=False, error_tolerance=1e-3)
            logger.success(f'{self.grid_model_builder.feeder_model["FEEDER_NAME"]} 潮流 收敛')

        except Exception as e:
            logger.exception(e)
            logger.error(f'{self.grid_model_builder.feeder_model["FEEDER_NAME"]} 潮流 不收敛')
            self.calc_result = None

        return self.calc_result


class Loss(CalcBase):
    def __init__(self, grid_model_builder: ModelBuilder):
        super().__init__(grid_model_builder)
        self.method = 'loss'
        self.model_error = False
        self.calc_error = False
        self.error_msg = ''
        self.error_code = 0

    def init_result_df(self):
        """初始化结果表"""
        super().init_result_df()

        # 配网、台区共有
        # 计算信息统计表
        self.feeder_statics = pd.DataFrame(
            {},
            columns=pd.Index(
                [
                    'IDX',
                    'FEEDER_ID',
                    'FEEDER_NAME',
                    'RDF_ID',
                    'LOSS_RATE',
                    'CODE',
                    'MESSAGE',
                    'DATA_TIME',
                ]
            ),
        )
        self.feederloss = pd.DataFrame(
            {},
            columns=pd.Index(
                [
                    'IDX',
                    'FEEDER_ID',
                    'FEEDER_RDFID',
                    'FEEDER_NAME',
                    'SUBSTATION_ID',
                    'SUBSTATION_NAME',
                    'SUBSTATION_RDFID',
                    'LOSS_RATE',
                    'P_LOSS',
                    'Q_LOSS',
                    'PG',
                    'QG',
                    'CALC_METHOD',
                    'DISTRIBUTION_LINE_ID',
                    'DISTRIBUTION_LINE_NAME',
                    'COMPANY_RDFID',
                    'COMPANY_NAME',
                    'AVERAGE_VOLT',
                    'ACTI_ENER',
                    'REAC_ENER',
                    'POWER_FACTOR',
                    'LINE_LOSS',
                    'TRAN_LOSS',
                    'TRAN_COPPLOSS',
                    'TRAN_IRONLOSS',
                    'TRAN_COPPIRON_RATIO',
                    'CAPACITOR_LOSS',
                    'OTHER_LOSS',
                    'TOT_LOSS',
                    'DISTRANS_RATE',
                    'IRON_RATE',
                    'COPP_RATE',
                    'TOT_RATE',
                    'THEO_POWESUPP',
                    'THEO_POWESUPP_LOSSRATE',
                    'PRIVATE_TRAN_COPPLOSS',
                    'PRIVATE_TRAN_IRONLOSS',
                    'PUBLIC_TRAN_COPPLOSS',
                    'PUBLIC_TRAN_IRONLOSS',
                    'LOSSRATE_NOT_PRIVATETRAN',
                    'LINE_LENGTH',
                    'TRAN_CAPA',
                    'TRAN_NUMB',
                    'GB_TRAN_CAPA',
                    'GB_TRAN_NUMB',
                    'ZB_TRAN_CAPA',
                    'ZB_TRAN_NUMB',
                    'BEST_LINELOSSRATE',
                    'AVER_CURRENT',
                    'DATA_TIME',
                    'SUPPORT_ACTI',
                    'SUPPORT_REAC',
                    'OUTPOWER',
                    'AVG_LOAD',
                    'OUTPUT_ACTI_POWER',
                    'OUTPUT_REAC_POWER',
                    'ELEC_SALES',
                    'CALC_TIME',
                ]
            ),
        )

        # 能量输入输出
        self.energy_input_and_output = pd.DataFrame(
            {},
            columns=pd.Index(
                [
                    'idx',
                    'companyid',
                    'companyname',
                    'datatime',
                    'distributionlineid',
                    'distributionlinename',
                    'psrid',
                    'psrname',
                    'psrtype',
                    'datasource',
                    'datatype',
                    'reacener',
                    'actiener',
                    'energytype',
                ]
            ),
        )

        # 原始电容器表
        self.capacitorloss = pd.DataFrame(
            {},
            columns=pd.Index(
                [
                    'idx',
                    'yearmonth',
                    'companyid',
                    'companyname',
                    'substationid',
                    'substationname',
                    'distributionlineid',
                    'distributionlinename',
                    'calctime',
                    'datatime',
                    'capacitorbankid',
                    'capacitorbankname',
                    'capacity',
                    'loss',
                    'lossofthetotperc',
                    'voltage',
                ]
            ),
        )

        # 新定义的变压器损耗表
        self.dms_loss_trfm_result = pd.DataFrame(
            {},
            columns=pd.Index(
                [
                    # 变压器基础信息
                    'TRAN_ID',
                    'TRAN_NAME',
                    'TRAN_RDFID',
                    'FEEDER_ID',
                    'FEEDER_NAME',
                    'FEEDER_RDFID',
                    'COMPANY_ID',
                    'COMPANY_NAME',
                    'COMPANY_RDFID',
                    'SUBSTATION_ID',
                    'SUBSTATION_NAME',
                    'SUBSTATION_RDFID',
                    'TRAN_TYPE',
                    'TRAN_SPEC',
                    # 变压器电气参数
                    'TRAN_MVA',
                    'TRAN_CURRENT',
                    'TRAN_VOLTAGE',
                    'TRAN_HIGH_ACTI',
                    'TRAN_HIGH_REAC',
                    'TRAN_HIGH_TREND_STR',
                    'TRAN_POWER_FACTOR',
                    'TRAN_LOW_ACTI',
                    'TRAN_LOW_REAC',
                    'TRAN_LOW_TREND_STR',
                    'TRAN_POSITIVE_ACTI',
                    'TRAN_REVERSE_ACTI',
                    # 损耗相关指标
                    'AVG_LOAD',
                    'COPP_ACTI_LOSS',
                    'COPP_REAC_LOSS',
                    'COPP_LOSSRATE',
                    'IRON_ACTI_LOSS',
                    'IRON_REAC_LOSS',
                    'IRON_LOSSRATE',
                    'COPP_IRON_RATIO',
                    'TRAN_ACTI_LOSS',
                    'TRAN_REAC_LOSS',
                    'TRAN_LOSSRATE',
                    'TRAN_LOSS_OF_TOTAL',
                    # 行政区划
                    'PROVINCIAL_ID',
                    'CITY_ID',
                    'COUNTY_ID',
                    # 时间信息
                    'DATA_TIME',
                    'TIME_INDEX',
                    'CALC_TIME',
                    # 计算方法
                    'CALC_METHOD',
                ]
            ),
        )
        # 新定义的线段损耗表
        self.dms_loss_lnseg_result = pd.DataFrame(
            {},
            columns=pd.Index(
                [
                    # 线路段基础信息
                    'LNSEG_ID',
                    'LNSEG_NAME',
                    'LNSEG_RDFID',
                    'FEEDER_ID',
                    'FEEDER_NAME',
                    'FEEDER_RDFID',
                    'SUBSTATION_ID',
                    'SUBSTATION_NAME',
                    'SUBSTATION_RDFID',
                    'LNSEG_SPEC',
                    'LNSEG_POWER_FACTOR',
                    # 线路阻抗参数
                    'LNSEG_RAA',  # 电阻（欧姆）
                    'LNSEG_XAA',  # 电抗（欧姆）
                    'LNSEG_LENGTH',  # 长度（km或m）
                    # 电流电压参数
                    'LNSEG_AVERAGE_CURRENT',
                    'HEAD_TERMINAL_ID',
                    'END_TERMINAL_ID',
                    'LNSEG_HEAD_VOLTAGE',
                    'LNSEG_END_VOLTAGE',
                    # 功率参数
                    'LNSEG_HEAD_ACTI',  # 首端有功（kW/MW）
                    'LNSEG_END_ACTI',  # 末端有功
                    'LNSEG_HEAD_REAC',  # 首端无功（kVar/MVar）
                    'LNSEG_END_REAC',  # 末端无功
                    'LNSEG_ACTI_TREND',
                    'LNSEG_REAC_TREND',
                    'LNSEG_ACTI_TREND_STR',
                    'LNSEG_REAC_TREND_STR',
                    # 损耗指标
                    'LNSEG_ACTI_LOSS',  # 总损耗
                    'LNSEG_REAC_LOSS',
                    'LNSEG_LOSSRATE',  # 损耗率
                    'FEEDER_ELEC_SALES',  # 馈线售电量
                    'LNSEG_LOSS_OF_TOTAL',  # 损耗占比
                    # 行政区划
                    'PROVINCIAL_ID',
                    'CITY_ID',
                    'COUNTY_ID',
                    # 时间信息
                    'DATA_TIME',
                    'TIME_INDEX',
                    'CALC_TIME',
                    # 计算方法
                    'CALC_METHOD',
                ]
            ),
        )
        # 新定义的分布式电源表
        self.dms_loss_dg_result = pd.DataFrame(
            {},
            columns=pd.Index(
                [
                    # 基础信息
                    'DISGEN_ID',  # 分布式电源标识
                    'DISGEN_NAME',  # 名称
                    'DISGEN_RDFID',  # RDF标识
                    # 拓扑关联
                    'FEEDER_ID',  # 所属馈线ID
                    'FEEDER_NAME',  # 馈线名称
                    'FEEDER_RDFID',  # 馈线RDF标识
                    'COMPANY_ID',  # 供电公司ID
                    'COMPANY_NAME',  # 供电公司名称
                    'COMPANY_RDFID',  # 供电公司源端ID
                    'SUBSTATION_ID',  # 变电站ID
                    'SUBSTATION_NAME',  # 变电站名称
                    'SUBSTATION_RDFID',  # 变电站RDF标识
                    # 关联设备
                    'RELATED_PRIVATE_ID',  # 关联私有设备ID
                    'RELATED_PRIVATE_NAME',  # 私有设备名称
                    'RELATED_PRIVATE_RDFID',  # 私有设备RDF标识
                    # 电气参数
                    'DISGEN_CURRENT',  # 分布式电源电流
                    'DISGEN_VOLTAGE',  # 分布式电源电压
                    'DISGEN_ACTI_POWER',  # 有功功率
                    'DISGEN_REAC_POWER',  # 无功功率
                    'DISGEN_POSITIVE_ACTI',  # 正向有功功率
                    'DISGEN_REVERSE_ACTI',  # 反向有功功率
                    # 行政区划
                    'PROVINCIAL_ID',  # 省份ID
                    'CITY_ID',  # 城市ID
                    'COUNTY_ID',  # 区县ID
                    # 时间信息
                    'DATA_TIME',  # 数据时间戳
                    'TIME_INDEX',  # 时间索引
                    'CALC_TIME',  # 计算时间
                    # 计算信息
                    'CALC_METHOD',  # 计算方法
                ]
            ),
        )
        # 新定义的馈线统计表
        self.dms_loss_feeder_result = pd.DataFrame(
            {},
            columns=pd.Index(
                [
                    # 拓扑标识
                    'FEEDER_ID',  # 馈线标识
                    'FEEDER_NAME',  # 馈线名称
                    'FEEDER_RDFID',  # RDF标识
                    'COMPANY_ID',  # 供电公司ID
                    'COMPANY_NAME',  # 供电公司名称
                    'COMPANY_RDFID',  # 供电公司源端ID
                    'SUBSTATION_ID',  # 变电站ID
                    'SUBSTATION_NAME',  # 变电站名称
                    'SUBSTATION_RDFID',  # 变电站RDF标识
                    # 电气量测
                    'FEEDER_AVERAGE_CURRENT',  # 平均电流
                    'FEEDER_AVERAGE_VOLTAGE',  # 平均电压
                    'ACTI_POWER',  # 有功功率
                    'REAC_POWER',  # 无功功率
                    'FEEDER_POWER_FACTOR',  # 功率因数
                    'OUTPUT_ACTI_POWER',  # 输出有功电量
                    'OUTPUT_REAC_POWER',  # 输出无功电量
                    # 分布式电源
                    'DISGEN_NUMB',  # 分布式电源数量
                    'DISGEN_ACTI_POWER',  # 分布式电源有功
                    'DISGEN_REAC_POWER',  # 分布式电源无功
                    # 损耗参数
                    'FEEDER_LNSEG_LENGTH',  # 馈线导线段总长度
                    'LNSEG_LOSS',  # 线路损耗
                    'LNSEG_LOSSRATE',  # 线路损耗率
                    'PRIVATE_NUMB',  # 所有专变数量
                    'PUBLIC_NUMB',  # 所有公变数量
                    'TRAN_NUMB',  # 变压器整体数量
                    'PRIVATE_CAPA',  # 所有专变容量
                    'PUBLIC_CAPA',  # 所有公变容量
                    'TRAN_CAPA',  # 变压器整体容量
                    'FEEDER_LOAD_RATE',  # 馈线负载率
                    'PRIVATE_COPP_LOSS',  # 用户侧铜损
                    'PUBLIC_COPP_LOSS',  # 公共网络铜损
                    'TRAN_COPP_LOSS',  # 变压器铜损
                    'TRAN_COPP_LOSSRATE',  # 变压器铜损率
                    'PRIVATE_IRON_LOSS',  # 用户侧铁损
                    'PUBLIC_IRON_LOSS',  # 公共网络铁损
                    'TRAN_IRON_LOSS',  # 变压器铁损
                    'TRAN_IRON_LOSSRATE',  # 变压器铁损率
                    'COPP_IRON_RATIO',  # 铜铁损比
                    'TRAN_LOSS',  # 变压器总损耗
                    'TRAN_LOSSRATE',  # 变压器损耗率
                    'OTHER_LOSS',  # 其他损耗
                    'FEEDER_ACTI_LOSS',  # 馈线总有功损耗
                    'FEEDER_REAC_LOSS',  # 馈线总无功损耗
                    'FEEDER_LOSSRATE',  # 馈线损耗率
                    'FEEDER_ELEC_SALES',  # 馈线售电量
                    'THEO_POWER_SUPPLY',  # 馈线理论供电量
                    'FEEDER_THEO_LOSSRATE',  # 馈线理论线损率
                    'LOSSRATE_WITHOUT_PRIVATE',  # 剔除用户侧损耗率
                    # 行政区划
                    'PROVINCIAL_ID',  # 省份ID
                    'CITY_ID',  # 城市ID
                    'COUNTY_ID',  # 区县ID
                    # 时间维度
                    'DATA_TIME',  # 数据时间戳
                    'TIME_INDEX',  # 时间索引
                    'CALC_TIME',  # 计算时间
                    # 计算信息
                    'CALC_METHOD',  # 计算方法
                ]
            ),
        )

        ### 台区

        # 台区能量输入输出
        self.electricity_output_and_input = pd.DataFrame(
            {},
            columns=pd.Index(
                [
                    'idx',
                    'data_time',
                    'companyid',
                    'companyname',
                    'distributionlineid',
                    'distributionlinename',
                    'disttransformerid',
                    'disttransformername',
                    'districtid',
                    'districtname',
                    'psrid',
                    'psrname',
                    'psrtype',
                    'datatype',
                    'datasource',
                    'energytype',
                    'actiener',
                    'reacener',
                ]
            ),
        )

        self.drop_linesegment = pd.DataFrame(
            {},
            columns=pd.Index(
                [
                    'idx',
                    'linesegmentid',
                    'linesegmentname',
                    'wiresystem',
                    'wiretype',
                    'length',
                    'i',
                    'r',
                    'pq_p_a',
                    'losspq',
                    'losspercent',
                    'customernum',
                    'headvolt',
                    'endvolt',
                    'lossrate',
                    'ia',
                    'ib',
                    'ic',
                    'i0',
                    'losspqA',
                    'losspqB',
                    'losspqC',
                    'losspq0',
                    'loss0rate',
                    'headterminalid',
                    'endterminalid',
                    'headvoltA',
                    'endvoltA',
                    'headvoltB',
                    'endvoltB',
                    'headvoltC',
                    'endvoltC',
                    'actitrendA',
                    'actitrendB',
                    'actitrendC',
                    'reactrendA',
                    'reactrendB',
                    'reactrendC',
                    'actitrendstrA',
                    'actitrendstrB',
                    'actitrendstrC',
                    'reactrendstrA',
                    'reactrendstrB',
                    'reactrendstrC',
                    'id',
                    'companyid',
                    'companyname',
                    'distributionlineid',
                    'distributionlinename',
                    'districtid',
                    'districtname',
                    'disttransformerid',
                    'disttransformername',
                    'yearmonth',
                    'data_time',
                    'calcmethod',
                    'dftypical',
                    'phaseImbalance',
                ]
            ),
        )
        self.customer_meterbox = pd.DataFrame(
            {},
            columns=pd.Index(
                [
                    'idx',
                    'data_time',
                    'companyid',
                    'companyname',
                    'distgeneratingunitid',
                    'distgeneratingunitname',
                    'currentA',
                    'currentB',
                    'currentC',
                    'voltageA',
                    'voltageB',
                    'voltageC',
                    'pqPA',
                    'pqRA',
                    'voltage',
                    'i',
                    'yearmonth',
                    'substationid',
                    'substationname',
                    'distributionlineid',
                    'distributionlinename',
                    'districtid',
                    'districtname',
                    'disttransformerid',
                    'disttransformername',
                    'customerid',
                    'customername',
                    'customerno',
                    'phase',
                ]
            ),
        )

        # 新定义台区用户表
        self.taiqu_loss_customer_result = pd.DataFrame(
            columns=pd.Index(
                [
                    'METER_ID',
                    'METER_NAME',
                    'METER_RDFID',
                    'RELATED_CUSTOMER_ID',
                    'RELATED_CUSTOMER_NAME',
                    'RELATED_CUSTOMER_RDFID',
                    'DISTRICT_ID',
                    'DISTRICT_NAME',
                    'DISTRICT_RDFID',
                    'DISTRANSFORMER_ID',
                    'DISTRANSFORMER_NAME',
                    'DISTRANSFORMER_RDFID',
                    'FEEDER_ID',
                    'FEEDER_NAME',
                    'FEEDER_RDFID',
                    'SUBSTATION_ID',
                    'SUBSTATION_NAME',
                    'SUBSTATION_RDFID',
                    'COMPANY_ID',
                    'COMPANY_NAME',
                    'COMPANY_RDFID',
                    'METER_TYPE',
                    'METER_CURRENT_TOTAL',
                    'METER_CURRENT_A',
                    'METER_CURRENT_B',
                    'METER_CURRENT_C',
                    'METER_VOLTAGE_TOTAL',
                    'METER_VOLTAGE_A',
                    'METER_VOLTAGE_B',
                    'METER_VOLTAGE_C',
                    'METER_ACTI_POWER_TOTAL',
                    'METER_ACTI_POWER_A',
                    'METER_ACTI_POWER_B',
                    'METER_ACTI_POWER_C',
                    'METER_REAC_POWER_TOTAL',
                    'METER_REAC_POWER_A',
                    'METER_REAC_POWER_B',
                    'METER_REAC_POWER_C',
                    'METER_ACTI_LOSS_TOTAL',
                    'METER_ACTI_LOSS_A',
                    'METER_ACTI_LOSS_B',
                    'METER_ACTI_LOSS_C',
                    'METER_REAC_LOSS_TOTAL',
                    'METER_REAC_LOSS_A',
                    'METER_REAC_LOSS_B',
                    'METER_REAC_LOSS_C',
                    'METER_ACTI_LOSSRATE',
                    'METER_LOSS_OF_TOTAL',
                    'PROVINCIAL_ID',
                    'CITY_ID',
                    'COUNTY_ID',
                    'DATA_TIME',
                    'TIME_INDEX',
                    'CALC_TIME',
                    'CALC_METHOD',
                ]
            )
        )
        # 新定义台区线路表
        self.taiqu_loss_lnseg_result = pd.DataFrame(
            columns=pd.Index(
                [
                    'LNSEG_ID',
                    'LNSEG_NAME',
                    'LNSEG_RDFID',
                    'DISTRICT_ID',
                    'DISTRICT_NAME',
                    'DISTRICT_RDFID',
                    'DISTRANSFORMER_ID',
                    'DISTRANSFORMER_NAME',
                    'DISTRANSFORMER_RDFID',
                    'FEEDER_ID',
                    'FEEDER_NAME',
                    'FEEDER_RDFID',
                    'SUBSTATION_ID',
                    'SUBSTATION_NAME',
                    'SUBSTATION_RDFID',
                    'COMPANY_ID',
                    'COMPANY_NAME',
                    'COMPANY_RDFID',
                    'LNSEG_SPEC',
                    'LNSEG_RAA',
                    'LNSEG_XAA',
                    'LNSEG_LENGTH',
                    'LNSEG_CURRENT_TOTAL',
                    'LNSEG_CURRENT_A',
                    'LNSEG_CURRENT_B',
                    'LNSEG_CURRENT_C',
                    'HEAD_TERMINAL_ID',
                    'END_TERMINAL_ID',
                    'LNSEG_HEAD_VOLTAGE_TOTAL',
                    'LNSEG_HEAD_VOLTAGE_A',
                    'LNSEG_HEAD_VOLTAGE_B',
                    'LNSEG_HEAD_VOLTAGE_C',
                    'LNSEG_END_VOLTAGE_TOTAL',
                    'LNSEG_END_VOLTAGE_A',
                    'LNSEG_END_VOLTAGE_B',
                    'LNSEG_END_VOLTAGE_C',
                    'LNSEG_HEAD_ACTI_POWER_TOTAL',
                    'LNSEG_HEAD_ACTI_POWER_A',
                    'LNSEG_HEAD_ACTI_POWER_B',
                    'LNSEG_HEAD_ACTI_POWER_C',
                    'LNSEG_END_ACTI_POWER_TOTAL',
                    'LNSEG_END_ACTI_POWER_A',
                    'LNSEG_END_ACTI_POWER_B',
                    'LNSEG_END_ACTI_POWER_C',
                    'LNSEG_ACTI_LOSS_TOTAL',
                    'LNSEG_ACTI_LOSS_A',
                    'LNSEG_ACTI_LOSS_B',
                    'LNSEG_ACTI_LOSS_C',
                    'LNSEG_ACTI_LOSSRATE',
                    'LNSEG_LOSS_OF_TOTAL',
                    'LNSEG_HEAD_REAC_POWER_TOTAL',
                    'LNSEG_HEAD_REAC_POWER_A',
                    'LNSEG_HEAD_REAC_POWER_B',
                    'LNSEG_HEAD_REAC_POWER_C',
                    'LNSEG_END_REAC_POWER_TOTAL',
                    'LNSEG_END_REAC_POWER_A',
                    'LNSEG_END_REAC_POWER_B',
                    'LNSEG_END_REAC_POWER_C',
                    'LNSEG_REAC_LOSS_TOTAL',
                    'LNSEG_REAC_LOSS_A',
                    'LNSEG_REAC_LOSS_B',
                    'LNSEG_REAC_LOSS_C',
                    'LNSEG_ACTI_TREND_A',
                    'LNSEG_ACTI_TREND_B',
                    'LNSEG_ACTI_TREND_C',
                    'LNSEG_REAC_TREND_A',
                    'LNSEG_REAC_TREND_B',
                    'LNSEG_REAC_TREND_C',
                    'LNSEG_ACTI_TREND_STR_A',
                    'LNSEG_ACTI_TREND_STR_B',
                    'LNSEG_ACTI_TREND_STR_C',
                    'LNSEG_REAC_TREND_STR_A',
                    'LNSEG_REAC_TREND_STR_B',
                    'LNSEG_REAC_TREND_STR_C',
                    'PROVINCIAL_ID',
                    'CITY_ID',
                    'COUNTY_ID',
                    'DATA_TIME',
                    'TIME_INDEX',
                    'CALC_TIME',
                    'CALC_METHOD',
                ]
            )
        )
        # 新定台区分布式电源表
        self.taiqu_loss_dg_result = pd.DataFrame(
            columns=pd.Index(
                [
                    'DISGEN_ID',
                    'DISGEN_NAME',
                    'DISGEN_RDFID',
                    'DISTRICT_ID',
                    'DISTRICT_NAME',
                    'DISTRICT_RDFID',
                    'DISTRANSFORMER_ID',
                    'DISTRANSFORMER_NAME',
                    'DISTRANSFORMER_RDFID',
                    'FEEDER_ID',
                    'FEEDER_NAME',
                    'FEEDER_RDFID',
                    'SUBSTATION_ID',
                    'SUBSTATION_NAME',
                    'SUBSTATION_RDFID',
                    'COMPANY_ID',
                    'COMPANY_NAME',
                    'COMPANY_RDFID',
                    'RELATED_CUSTOMER_ID',
                    'RELATED_CUSTOMER_NAME',
                    'RELATED_CUSTOMER_RDFID',
                    'DISGEN_CURRENT_TOTAL',
                    'DISGEN_CURRENT_A',
                    'DISGEN_CURRENT_B',
                    'DISGEN_CURRENT_C',
                    'DISGEN_VOLTAGE_TOTAL',
                    'DISGEN_VOLTAGE_A',
                    'DISGEN_VOLTAGE_B',
                    'DISGEN_VOLTAGE_C',
                    'DISGEN_POSITIVE_ACTI_POWER_TOTAL',
                    'DISGEN_POSITIVE_ACTI_POWER_A',
                    'DISGEN_POSITIVE_ACTI_POWER_B',
                    'DISGEN_POSITIVE_ACTI_POWER_C',
                    'DISGEN_POSITIVE_REAC_POWER_TOTAL',
                    'DISGEN_POSITIVE_REAC_POWER_A',
                    'DISGEN_POSITIVE_REAC_POWER_B',
                    'DISGEN_POSITIVE_REAC_POWER_C',
                    'DISGEN_REVERSE_ACTI_POWER_TOTAL',
                    'DISGEN_REVERSE_ACTI_POWER_A',
                    'DISGEN_REVERSE_ACTI_POWER_B',
                    'DISGEN_REVERSE_ACTI_POWER_C',
                    'DISGEN_REVERSE_REAC_POWER_TOTAL',
                    'DISGEN_REVERSE_REAC_POWER_A',
                    'DISGEN_REVERSE_REAC_POWER_B',
                    'DISGEN_REVERSE_REAC_POWER_C',
                    'PROVINCIAL_ID',
                    'CITY_ID',
                    'COUNTY_ID',
                    'DATA_TIME',
                    'TIME_INDEX',
                    'CALC_TIME',
                    'CALC_METHOD',
                ]
            )
        )
        # 新定义台区结果表
        self.taiqu_loss_district_result = pd.DataFrame(
            columns=pd.Index(
                [
                    # 区域基本信息
                    'DISTRICT_ID',
                    'DISTRICT_NAME',
                    'DISTRICT_RDFID',
                    # 变压器信息
                    'DISTRANSFORMER_ID',
                    'DISTRANSFORMER_NAME',
                    'DISTRANSFORMER_RDFID',
                    # 馈线信息
                    'FEEDER_ID',
                    'FEEDER_NAME',
                    'FEEDER_RDFID',
                    # 变电站信息
                    'SUBSTATION_ID',
                    'SUBSTATION_NAME',
                    'SUBSTATION_RDFID',
                    # 供电公司信息
                    'COMPANY_ID',
                    'COMPANY_NAME',
                    'COMPANY_RDFID',
                    # 电气量测数据
                    'DISTRICT_CURRENT_TOTAL',
                    'DISTRICT_CURRENT_A',
                    'DISTRICT_CURRENT_B',
                    'DISTRICT_CURRENT_C',
                    'DISTRICT_VOLTAGE_TOTAL',
                    'DISTRICT_VOLTAGE_A',
                    'DISTRICT_VOLTAGE_B',
                    'DISTRICT_VOLTAGE_C',
                    'ACTI_POWER_TOTAL',
                    'ACTI_POWER_A',
                    'ACTI_POWER_B',
                    'ACTI_POWER_C',
                    'REAC_POWER_TOTAL',
                    'REAC_POWER_A',
                    'REAC_POWER_B',
                    'REAC_POWER_C',
                    'DISTRICT_POWER_FACTOR',
                    'OUTPUT_ACTI_POWER',
                    'OUTPUT_REAC_POWER',
                    'DISGEN_NUMB',
                    'DISGEN_ACTI_POWER',
                    'DISGEN_REAC_POWER',
                    # 损耗数据
                    'DISTRICT_LNSEG_LENGTH',
                    'LNSEG_ACTI_LOSS_TOTAL',
                    'LNSEG_ACTI_LOSS_A',
                    'LNSEG_ACTI_LOSS_B',
                    'LNSEG_ACTI_LOSS_C',
                    'LNSEG_REAC_LOSS_TOTAL',
                    'LNSEG_REAC_LOSS_A',
                    'LNSEG_REAC_LOSS_B',
                    'LNSEG_REAC_LOSS_C',
                    'LNSEG_ACTI_LOSSRATE',
                    'LNSEG_REAC_LOSSRATE',
                    'THREE_PHASE_METER_NUMB',
                    'SINGLE_PHASE_METER_NUMB',
                    'METER_NUMB',
                    'CUSTOMER_NUMB',
                    'METER_ACTI_LOSS_TOTAL',
                    'METER_ACTI_LOSS_A',
                    'METER_ACTI_LOSS_B',
                    'METER_ACTI_LOSS_C',
                    'METER_REAC_LOSS_TOTAL',
                    'METER_REAC_LOSS_A',
                    'METER_REAC_LOSS_B',
                    'METER_REAC_LOSS_C',
                    'METER_ACTI_LOSSRATE',
                    'METER_REAC_LOSSRATE',
                    'DISTRICT_ACTI_LOSS',
                    'DISTRICT_REAC_LOSS',
                    'DISTRICT_ACTI_LOSSRATE',
                    'DISTRICT_REAC_LOSSRATE',
                    'DISTRICT_ELEC_SALES',
                    'THEO_POWER_SUPPLY',
                    'DISTRICT_THEO_LOSSRATE',
                    # 行政区域信息
                    'PROVINCIAL_ID',
                    'CITY_ID',
                    'COUNTY_ID',
                    # 时间信息
                    'DATA_TIME',
                    'TIME_INDEX',
                    'CALC_TIME',
                    # 计算方法
                    'CALC_METHOD',
                ]
            )
        )
        # 设备计算日志
        self.equipment_calclog = pd.DataFrame(
            {},
            columns=pd.Index(
                [
                    'idx',
                    'calcobjid',
                    'equipmentid',
                    'equipmentname',
                    'createtimestr',
                    'level',
                    'content',
                    'sortno',
                    'psrtypecode',
                ]
            ),
        )
        # 初始化结果字典,主要是错误时使用
        self.result = {
            'tables': {
                'all_meas': self.all_meas,
                'dms_pas_se_notusemeas': self.dms_pas_se_notusemeas,
                'dms_pas_se_filtermeas': self.dms_pas_se_filtermeas,
                'dms_pas_se_badmeas': self.dms_pas_se_badmeas,
                'dms_pas_se_meas': self.dms_pas_se_meas,
                'branch_pq_se': pd.DataFrame(),
                'trwd': pd.DataFrame(),
                'load': pd.DataFrame(),
            },
            'statics': {
                'bug_feeder': True,
                'ntopo': 0,
                'ndevload': 0,
                'n_bus': 0,
                'ncount_notusemeas': 0,
                'ncount_filtermeas': 0,
                'ncount_badmeas': 0,
                'total_notuseerr': 0,
                'total_filtererr': 0,
                'total_baderr': 0,
                'total_err': 0,
            },
        }

    # 默认采用潮流计算，如果不收敛，切换到状态估计进行计算
    def calculate(self):
        self.calc_result = None

        if not self.grid_data:
            self.build_and_check_model()
        cons_para = self.grid_model_builder.cons_para
        bus_df = self.grid_model_builder.bus_df
        branch_df = self.grid_model_builder.branch_df
        branch_df['RAA'] = branch_df['RAA'].astype(float)
        branch_df['XAA'] = branch_df['XAA'].astype(float)
        logger.info('*************************************************************************')
        logger.info(f'负荷系数 :{cons_para.power_factor}')
        logger.info(f'最大有功负荷/kW {np.max(bus_df["PA_PRE"] + bus_df["PB_PRE"] + bus_df["PC_PRE"])}')
        logger.info(f'最大电阻/Ω {np.max(branch_df["RAA"])}')
        logger.info(f'最大电抗/Ω {np.max(branch_df["XAA"])}')
        logger.info('*************************************************************************')

        try:
            pf_phase_result = PowerGridModel(self.grid_data).calculate_power_flow(symmetric=False, error_tolerance=1e-3, threading=0)

            logger.success(f'{self.grid_model_builder.feeder_model["FEEDER_NAME"]} 潮流 收敛')
            pf_phase_result['node']['u_pu'] = pf_phase_result['node']['u_pu'] * np.sqrt(3)
            pf_phase_result['node']['u'] = pf_phase_result['node']['u'] * np.sqrt(3)
            pf_phase_result['line']['i_from'] = pf_phase_result['line']['i_from'] / np.sqrt(3)
            pf_phase_result['line']['i_to'] = pf_phase_result['line']['i_to'] / np.sqrt(3)
            pf_phase_result['sym_load']['i'] = pf_phase_result['sym_load']['i'] / np.sqrt(3)
            pf_phase_result['source']['i'] = pf_phase_result['source']['i'] / np.sqrt(3)
            self.calc_result = pf_phase_result

        except Exception:
            logger.error(f'{self.grid_model_builder.feeder_model["FEEDER_NAME"]} 潮流 不收敛')
            # 如果潮流计算不收敛，则尝试状态估计计算
            try:
                self.calc_result = PowerGridModel(self.grid_data).calculate_state_estimation(symmetric=False, error_tolerance=1e-3, threading=0)
                logger.success(f'{self.grid_model_builder.feeder_model["FEEDER_NAME"]} 状态估计 收敛')
            except Exception as e:
                logger.error(f'{self.grid_model_builder.feeder_model["FEEDER_NAME"]} 状态估计和潮流均不收敛')
                logger.exception(e)
                self.error_code = 3
                self.error_msg = '计算收敛失败，可能原因包括：1）有功、无功负荷太大；'

        return self.calc_result

    def validate_model(self):
        """grid_model模型校验"""
        try:
            assert_valid_input_data(
                input_data=self.grid_data,
                calculation_type=CalculationType.state_estimation,
                symmetric=False,
            )
            return True
        except Exception as e:
            logger.error(f'输入数据校验失败 {str(e)}')
            return False

    def build_and_check_model(self):
        """构建模型并校验模型是否合法，如果不合法保存error_msg"""
        if not self.grid_model_builder.feeder_model:
            self.model_error = True
            self.error_code = 1
            self.error_msg = '拓扑断连，可能原因包括：1）设备档案错误；'
            return

        self.grid_data = self.grid_model_builder.build_se()

        if len(self.grid_model_builder.bus_df) <= 2:
            self.model_error = True
            self.error_code = 1
            self.error_msg = '拓扑断连，可能原因包括：1）设备档案错误；'
            return

        if len(self.grid_model_builder.sym_load) == 0:
            self.model_error = True
            self.error_code = 2
            self.error_msg = '无负荷，可能原因包括：1）负荷档案错误；2）负荷量测为0'
            return

        if not self.validate_model():
            self.model_error = True
            self.error_msg = '模型检验失败！'
            self.error_code = 3
            return

    def calc_loss_result_static_dms(self, time_index, datatime, method_type, company_rdfid='', company_name=''):
        """统计配网计算结果"""
        # 先调用父类的calc_result_static方法，获取原始的潮流或状估结果
        se_or_pf_result = super().calc_result_static()
        branch_df = self.grid_model_builder.branch_df
        bus_df = self.grid_model_builder.bus_df
        calc_result = self.calc_result
        power_error = self.grid_model_builder.power_error_df

        branch_pq_se = se_or_pf_result['tables']['branch_pq_se'].copy()

        feeder_model = self.grid_model_builder.feeder_model
        cons_para = self.grid_model_builder.cons_para
        # yearmonth = datetime.strptime(datatime, '%Y-%m-%d %H:%M:%S').strftime('%Y%m')
        feeder_id = feeder_model['FEEDER_ID']
        feeder_rdfid = feeder_model['RDF_ID']
        feeder_name = feeder_model['FEEDER_NAME']
        substation_id = feeder_model.get('SUBSTAION_ID', '0')
        substation_rdfid = feeder_model.get('SUBSTAION_RDFID', '0')
        substation_name = feeder_model.get('SUBSTAION_NAME', '0')

        calc_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        if calc_result is None:
            return self.get_error_result(feeder_id, feeder_name, feeder_rdfid, time_index, datatime)

        feeder_statics = self.feeder_statics
        energy_input_and_output = self.energy_input_and_output

        bus_vol_results = pd.DataFrame(calc_result['node']['u'])
        # bus_angle_results = pd.DataFrame(result['node']['u_angle'])
        branch_if_results = pd.DataFrame(calc_result['line']['i_from'])
        branch_pf_results = pd.DataFrame(calc_result['line']['p_from'])
        branch_qf_results = pd.DataFrame(calc_result['line']['q_from'])
        branch_pt_results = pd.DataFrame(calc_result['line']['p_to'])
        branch_qt_results = pd.DataFrame(calc_result['line']['q_to'])

        sum_gb_trans_iron_loss = 0  # 公变铁损
        sum_gb_trans_copp_loss = 0  # 公变铜损
        sum_zb_trans_iron_loss = 0  # 专变铁损
        sum_zb_trans_copp_loss = 0  # 专变铁损
        sum_tran_capa = 0  # 变压器容量
        sum_tran_numb = 0  # 变压器个数
        sum_zb_tran_capa = 0  # 专变容量
        sum_zb_tran_numb = 0  # 专变个数
        sum_gb_tran_capa = 0  # 公变容量
        sum_gb_tran_numb = 0  # 公变个数
        sum_support_acti = 0  # 分布式电源有功供电量
        sum_support_reac = 0  # 分布式电源无功供电量
        # sum_outpower_P = 0  # 输出有功电量
        # sum_outpower_Q = 0  # 输出无功电量
        sum_other_loss = 0
        sum_line_length = 0

        # # 筛选出 bus_df中MVA 不为 0 的行
        # non_zero_mva = bus_df[bus_df['MVA'] != 0]
        # # 对 MVA 不为 0 的数值进行求和
        # sum_tran_capa = non_zero_mva['MVA'].sum()
        # # 计算 MVA 不为 0 的数值的个数
        # num_tran_numb = non_zero_mva['MVA'].count()

        # 求公变数量和容量
        for index, value in enumerate(feeder_model['load'].values()):
            sum_zb_tran_numb += 1
            if value['MVA']:
                sum_zb_tran_capa = sum_zb_tran_capa + value['MVA']
        # 求专变数量和容量
        for index, value in enumerate(feeder_model['trfm'].values()):
            sum_tran_numb += 1
            if value['MVA']:
                sum_tran_capa = sum_tran_capa + value['MVA']
        # 因为dms_def_trfm表里既有公变又有专变，所以要剔除
        sum_gb_tran_numb = sum_tran_numb - sum_zb_tran_numb
        sum_gb_tran_capa = sum_tran_capa - sum_zb_tran_capa

        # 计算表计损耗
        sum_other_loss = cons_para.loss_meter_3ph * sum_tran_numb * cons_para.time_resolution_factor

        # 馈线输入电量 = 馈线正向电量 + 小电源正向电量 + 负荷反向电量
        PA, PB, PC, QA, QB, QC = bus_df[['PA_PRE', 'PB_PRE', 'PC_PRE', 'QA_PRE', 'QB_PRE', 'QC_PRE']].to_numpy().T

        sum_P_DG = np.sum(np.where((PA + PB + PC) < 0, PA + PB + PC, 0)) * cons_para.time_resolution_factor  # 获取小电源正向电量 和 负荷反向电量
        sum_P_load = np.sum(np.where((PA + PB + PC) >= 0, PA + PB + PC, 0)) * cons_para.time_resolution_factor  # 获取小电源反向电量 和 负荷正向电量（售电量）
        sum_Q_DG = np.sum(np.where((QA + QB + QC) < 0, QA + QB + QC, 0)) * cons_para.time_resolution_factor
        sum_Q_load = np.sum(np.where((PA + PB + PC) >= 0, QA + QB + QC, 0)) * cons_para.time_resolution_factor

        if branch_pq_se.at[0, 'P_SUM'] >= 0:
            sum_PG = branch_pq_se.at[0, 'P_SUM'] / cons_para.power_factor * cons_para.time_resolution_factor - sum_P_DG + sum_other_loss  # 馈线有功注入
            sum_QG = branch_pq_se.at[0, 'Q_SUM'] / cons_para.power_factor * cons_para.time_resolution_factor - sum_Q_DG  # 馈线无功注入
            sum_outpower_P = 0
            sum_outpower_Q = 0
        else:
            print('该馈线潮流功率向10kV以上倒送!')
            sum_PG = (-1) * sum_P_DG  # 输出电量，馈线的反向电量
            sum_QG = (-1) * sum_Q_DG
            sum_outpower_P = (-1) * branch_pq_se.at[0, 'P_SUM'] / cons_para.power_factor * cons_para.time_resolution_factor
            sum_outpower_Q = (-1) * branch_pq_se.at[0, 'Q_SUM'] / cons_para.power_factor * cons_para.time_resolution_factor

        sum_support_acti = (-1.0) * sum_P_DG  # 馈线分布式电源有功
        sum_support_reac = (-1.0) * sum_Q_DG  # 馈线分布式电源无功

        for i_br in range(len(branch_df)):
            inode_id = branch_pq_se.at[i_br, 'INODE_ID'] - 1
            # Ua = bus_vol_results.at[inode_id, 0]
            # thea = bus_angle_results.at[inode_id, 0]
            # Ub = bus_vol_results.at[inode_id, 1]
            # theb = bus_angle_results.at[inode_id, 1]
            # Uc = bus_vol_results.at[inode_id, 2]
            # thec = bus_angle_results.at[inode_id, 2]

            branch_pf_row = branch_pf_results.iloc[i_br]
            branch_pt_row = branch_pt_results.iloc[i_br]
            branch_qf_row = branch_qf_results.iloc[i_br]
            branch_qt_row = branch_qt_results.iloc[i_br]

            # 提取当前行数据，避免多次访问
            branch_row = branch_df.iloc[i_br]
            branch_pq_se_row = branch_pq_se.loc[i_br]

            # 计算相关的值，避免重复计算
            br_type = branch_row['BR_TYPE']

            if br_type == 6:
                if branch_pq_se.loc[i_br, 'P_SUM'] > 0:
                    energy_input_and_output.loc[
                        len(energy_input_and_output),
                        [
                            'idx',
                            'companyid',
                            'companyname',
                            'datatime',
                            'distributionlineid',
                            'distributionlinename',
                            'psrid',
                            'psrname',
                            'psrtype',
                            'datasource',
                            'datatype',
                            'reacener',
                            'actiener',
                            'energytype',
                        ],
                    ] = [
                        time_index,  # idx
                        company_rdfid,  # companyid
                        company_name,  # companyname
                        datatime,  # datatime
                        feeder_rdfid,  # distributionlineid
                        feeder_name,  # distributionlinename
                        feeder_rdfid,  # psrid,因为配线原ID和原名称用branch_df.loc[i_br, 'RDF_ID']、branch_df.loc[i_br, 'NAME']不合适
                        feeder_name,  # psrname
                        'DistributionLine',  # psrtype
                        0,  # datasource
                        1,  # datatype
                        branch_pq_se.loc[i_br, 'P_SUM'] / cons_para.power_factor * cons_para.time_resolution_factor,  # actiener
                        branch_pq_se.loc[i_br, 'Q_SUM'] / cons_para.power_factor * cons_para.time_resolution_factor,  # reacener
                        1,  # energy_type
                    ]

            if br_type == 3 or br_type == 5:
                sum_line_length += branch_df.loc[i_br, 'LENGTH']

                pf_line = branch_pf_row.iloc[:3].sum() / cons_para.power_factor * cons_para.time_resolution_factor
                pt_line = branch_pt_row.iloc[:3].sum() / cons_para.power_factor * cons_para.time_resolution_factor
                qf_line = branch_qf_row.iloc[:3].sum() / cons_para.power_factor * cons_para.time_resolution_factor
                qt_line = branch_qt_row.iloc[:3].sum() / cons_para.power_factor * cons_para.time_resolution_factor

                if abs(pf_line) >= abs(pt_line):
                    actitrend = 0
                    actitrend_str = complex(round(pf_line, 6), round(qf_line, 6))
                else:
                    actitrend = 1
                    actitrend_str = complex(round(pt_line, 6), round(qt_line, 6))

                if abs(qf_line) >= abs(qt_line):
                    reactrend = 0
                    reactrend_str = complex(round(pf_line, 6), round(qf_line, 6))
                else:
                    reactrend = 1
                    reactrend_str = complex(round(pt_line, 6), round(qt_line, 6))

                p_loss_line = abs(branch_pf_row.iloc[:3].sum() + branch_pt_row.iloc[:3].sum()) * cons_para.loss_factor * cons_para.time_resolution_factor
                q_loss_line = abs(branch_qf_row.iloc[:3].sum() + branch_qt_row.iloc[:3].sum()) * cons_para.loss_factor * cons_para.time_resolution_factor

                PG_line = abs(max(pf_line, pt_line))
                # QG_line = abs(max(qf_line, qt_line))
                p_loss_rate = p_loss_line / PG_line * 100 if PG_line != 0 else 0
                # q_loss_rate = q_loss_line / QG_line * 100 if QG_line != 0 else 0
                # p_loss_rate_tot = p_loss_line / sum_PG if sum_PG != 0 else 0

                inode_id = branch_row['INODE_ID'] - 1
                znode_id = branch_row['ZNODE_ID'] - 1
                Ua_1 = bus_vol_results.at[inode_id, 0] / cons_para.voltage_output_factor  # 单位由V转换为kV
                # thea_1 = bus_angle_results.at[inode_id, 0]
                Ua_2 = bus_vol_results.at[znode_id, 0] / cons_para.voltage_output_factor  # 单位由V转换为kV
                # thea_2 = bus_angle_results.at[znode_id, 0]
                # 线路型号
                lnseg_spec = ''

                self.dms_loss_lnseg_result.loc[
                    i_br,
                    [
                        # 线路段基础信息
                        'LNSEG_ID',
                        'LNSEG_NAME',
                        'LNSEG_RDFID',
                        'FEEDER_ID',
                        'FEEDER_NAME',
                        'FEEDER_RDFID',
                        'SUBSTATION_ID',
                        'SUBSTATION_NAME',
                        'SUBSTATION_RDFID',
                        'LNSEG_SPEC',
                        # 线路阻抗参数
                        'LNSEG_RAA',  # 电阻（欧姆）
                        'LNSEG_XAA',  # 电抗（欧姆）
                        'LNSEG_LENGTH',  # 长度（km或m）
                        # 电流电压参数
                        'LNSEG_AVERAGE_CURRENT',
                        'HEAD_TERMINAL_ID',
                        'END_TERMINAL_ID',
                        'LNSEG_HEAD_VOLTAGE',
                        'LNSEG_END_VOLTAGE',
                        # 功率参数
                        'LNSEG_HEAD_ACTI',  # 首端有功（kW/MW）
                        'LNSEG_END_ACTI',  # 末端有功
                        'LNSEG_HEAD_REAC',  # 首端无功（kVar/MVar）
                        'LNSEG_END_REAC',  # 末端无功
                        'LNSEG_ACTI_TREND',  # 有功潮流方向
                        'LNSEG_REAC_TREND',  # 无功潮流方向
                        'LNSEG_ACTI_TREND_STR',  # 有功潮流字符串
                        'LNSEG_REAC_TREND_STR',  # 无功潮流字符串
                        # 损耗指标
                        'LNSEG_ACTI_LOSS',  # 有功损耗
                        'LNSEG_REAC_LOSS',  # 无功损耗
                        'LNSEG_LOSSRATE',  # 损耗率
                        'FEEDER_ELEC_SALES',  # 馈线售电量
                        'LNSEG_POWER_FACTOR',  # 导线段功率因数
                        'LNSEG_LOSS_OF_TOTAL',  # 损耗占比
                        # 行政区划
                        'PROVINCIAL_ID',
                        'CITY_ID',
                        'COUNTY_ID',
                        # 时间信息
                        'DATA_TIME',
                        'TIME_INDEX',
                        'CALC_TIME',
                        # 计算方法
                        'CALC_METHOD',
                    ],
                ] = [
                    branch_row['LINE_ID'],  # 'LNSEG_ID',
                    branch_row['NAME'],  # 'LNSEG_NAME',
                    branch_row['RDF_ID'],  # 'LNSEG_RDFID',
                    feeder_id,  # 'FEEDER_ID',
                    feeder_name,  # 'FEEDER_NAME',
                    feeder_rdfid,  # 'FEEDER_RDFID',
                    substation_id,  # 'SUBSTATION_ID',
                    substation_name,  # 'SUBSTATION_NAME',
                    substation_rdfid,  # 'SUBSTATION_RDFID',
                    lnseg_spec,  # 'LNSEG_SPEC',
                    # # 线路阻抗参数
                    branch_row['RAA'],  # 'LNSEG_RAA',  # 电阻（欧姆）
                    branch_row['XAA'],  # 'LNSEG_XAA',  # 电抗（欧姆）
                    branch_row['LENGTH'],  # 'LNSEG_LENGTH',  # 长度（km或m）
                    # # 电流电压参数
                    (branch_pq_se.at[i_br, 'IMA'] + branch_pq_se.at[i_br, 'IMB'] + branch_pq_se.at[i_br, 'IMC']) * cons_para.current_factor,  # 'LNSEG_AVERAGE_CURRENT',
                    # branch_row['ORI_INODE_ID'],  # 'HEAD_TERMINAL_ID',
                    str(branch_row['ORI_INODE_ID']),  # 'HEAD_TERMINAL_ID',
                    str(branch_row['ORI_ZNODE_ID']),  # 'END_TERMINAL_ID',
                    # branch_row['ORI_ZNODE_ID'],  # 'END_TERMINAL_ID',
                    Ua_1,  # 'LNSEG_HEAD_VOLTAGE',
                    Ua_2,  # 'LNSEG_END_VOLTAGE',
                    # # 功率参数
                    (branch_pf_results.at[i_br, 0] + branch_pf_results.at[i_br, 1] + branch_pf_results.at[i_br, 2])
                    / cons_para.power_factor
                    * cons_para.time_resolution_factor,  # 'LNSEG_HEAD_ACTI',  # 首端有功（kW/MW）
                    (branch_pt_results.at[i_br, 0] + branch_pt_results.at[i_br, 1] + branch_pt_results.at[i_br, 2])
                    / cons_para.power_factor
                    * cons_para.time_resolution_factor,  # 'LNSEG_END_ACTI',  # 末端有功
                    (branch_qf_results.at[i_br, 0] + branch_qf_results.at[i_br, 1] + branch_qf_results.at[i_br, 2])
                    / cons_para.power_factor
                    * cons_para.time_resolution_factor,  # 'LNSEG_HEAD_REAC',  # 首端无功（kVar/MVar）
                    (branch_qt_results.at[i_br, 0] + branch_qt_results.at[i_br, 1] + branch_qt_results.at[i_br, 2])
                    / cons_para.power_factor
                    * cons_para.time_resolution_factor,  # 'LNSEG_END_REAC',  # 末端无功
                    actitrend,  # 'LNSEG_ACTI_TREND', # 有功潮流方向
                    reactrend,  # 'LNSEG_REAC_TREND', # 无功潮流方向
                    format_complex(actitrend_str),  # 'LNSEG_ACTI_TREND_STR', # 有功潮流字符串
                    format_complex(reactrend_str),  # 'LNSEG_REAC_TREND_STR', # 无功潮流字符串
                    # # 损耗指标
                    p_loss_line,  # 'LNSEG_ACTI_LOSS',  # 有功损耗
                    q_loss_line,  # 'LNSEG_REAC_LOSS', # 无功损耗
                    p_loss_rate,  # 'LNSEG_LOSSRATE',  # 损耗率
                    sum_PG,  #'FEEDER_ELEC_SALES', # 售电量
                    division_0(
                        (branch_pf_results.at[i_br, 0] + branch_pf_results.at[i_br, 1] + branch_pf_results.at[i_br, 2]),
                        math.sqrt(
                            (branch_pf_results.at[i_br, 0] + branch_pf_results.at[i_br, 1] + branch_pf_results.at[i_br, 2]) ** 2
                            + (branch_qf_results.at[i_br, 0] + branch_qf_results.at[i_br, 1] + branch_qf_results.at[i_br, 2]) ** 2
                        ),
                    ),  #'LNSEG_POWER_FACTOR', # 线段功率因数
                    0,  # 'LNSEG_LOSS_OF_TOTAL',  # 损耗占比
                    # # 行政区划
                    0,  # 'PROVINCIAL_ID',
                    0,  # 'CITY_ID',
                    0,  # 'COUNTY_ID',
                    # # 时间信息
                    datatime,  # 'DATA_TIME',
                    time_index,  # 'TIME_INDEX',
                    calc_time,  # 'CALC_TIME',
                    # # 计算方法
                    method_type,  # 'CALC_METHOD',
                ]

            for i_bus in range(len(bus_df)):
                if bus_df.loc[i_bus, 'ID'] == branch_df.at[i_br, 'ZNODE_ID']:
                    if bus_df.loc[i_bus, 'WITH_GF'] == 0 or bus_df.loc[i_bus, 'WITH_GF'] == 1 or br_type == 4:
                        P_tr = bus_df.at[i_bus, 'PA_PRE'] + bus_df.at[i_bus, 'PB_PRE'] + bus_df.at[i_bus, 'PC_PRE']
                        Q_tr = bus_df.at[i_bus, 'QA_PRE'] + bus_df.at[i_bus, 'QB_PRE'] + bus_df.at[i_bus, 'QC_PRE']
                        S_tr = np.sqrt(P_tr**2 + Q_tr**2)

                        P_input = abs(branch_pf_row.iloc[:3].sum()) / cons_para.power_factor * cons_para.time_resolution_factor
                        Q_input = abs(branch_qf_row.iloc[:3].sum()) / cons_para.power_factor * cons_para.time_resolution_factor
                        Power_factor = division_0(P_input, math.sqrt(P_input**2 + Q_input**2))

                        if P_tr == 0:
                            copp_loss = 0
                            reac_copp_loss = 0
                            iron_loss = 0
                            reac_iron_loss = 0
                        else:
                            copp_loss = abs(branch_pf_row.iloc[:3].sum() + branch_pt_row.iloc[:3].sum()) * cons_para.loss_factor * cons_para.time_resolution_factor
                            reac_copp_loss = abs(branch_qf_row.iloc[:3].sum() + branch_qt_row.iloc[:3].sum()) * cons_para.loss_factor * cons_para.time_resolution_factor
                            iron_loss = (branch_pq_se_row['UAB'] / cons_para.Ubase_low) ** 2 * bus_df.at[i_bus, 'P0']
                            reac_iron_loss = iron_loss * abs(division_0(math.sqrt(1 - Power_factor**2), Power_factor))

                        copp_rate = division_0(copp_loss, P_input)
                        iron_rate = division_0(iron_loss, P_input)

                        sum_gb_trans_iron_loss += iron_loss
                        sum_gb_trans_copp_loss += copp_loss
                        temp_p_a = 0
                        temp_p_b = 0
                        temp_p_c = 0
                        temp_q_a = 0
                        temp_q_b = 0
                        temp_q_c = 0

                        pq_p_a = 0
                        pq_r_a = 0

                        for i_temp in range(len(branch_pf_results)):
                            if branch_df.at[i_temp, 'INODE_ID'] == bus_df.loc[i_bus, 'ID']:
                                temp_p_a += branch_pf_results.at[i_temp, 0]
                                temp_p_b += branch_pf_results.at[i_temp, 1]
                                temp_p_c += branch_pf_results.at[i_temp, 2]
                                temp_q_a += branch_qf_results.at[i_temp, 0]
                                temp_q_b += branch_qf_results.at[i_temp, 1]
                                temp_q_c += branch_qf_results.at[i_temp, 2]

                        if (bus_df.at[i_bus, 'PA_PRE'] + bus_df.at[i_bus, 'PB_PRE'] + bus_df.at[i_bus, 'PC_PRE']) > 0:
                            # if bus_df.at[i_bus, 'PA_PRE'] >= 0:
                            # if (branch_pf_results.at[i_br, 0] + branch_pf_results.at[i_br, 1] + branch_pf_results.at[i_br, 2]) - (temp_p_a + temp_p_b + temp_p_c) >= 0:
                            pq_p_a = (
                                ((branch_pf_results.at[i_br, 0] + branch_pf_results.at[i_br, 1] + branch_pf_results.at[i_br, 2]) - (temp_p_a + temp_p_b + temp_p_c))
                                / cons_para.power_factor
                                * cons_para.time_resolution_factor
                            )  # 正向功率
                            pq_r_a = 0
                        elif (bus_df.at[i_bus, 'PA_PRE'] + bus_df.at[i_bus, 'PB_PRE'] + bus_df.at[i_bus, 'PC_PRE']) < 0:
                            # elif (branch_pf_results.at[i_br, 0] + branch_pf_results.at[i_br, 1] + branch_pf_results.at[i_br, 2]) - (temp_p_a + temp_p_b + temp_p_c) < 0:
                            pq_p_a = 0
                            pq_r_a = (
                                (-(branch_pf_results.at[i_br, 0] + branch_pf_results.at[i_br, 1] + branch_pf_results.at[i_br, 2]) - (temp_p_a + temp_p_b + temp_p_c))
                                / cons_para.power_factor
                                * cons_para.time_resolution_factor
                            )  # 反向功率

                        if branch_df.at[i_br, 'BR_TYPE'] == 4:
                            tran_type = 'PUBLIC'
                        else:
                            tran_type = 'PRIVATE'  # 其实不会出线tran_type = 'PRIVATE'的情况，因为专变不纳入trfmloss的统计
                        tran_spec = ''

                        self.dms_loss_trfm_result.loc[
                            len(self.dms_loss_trfm_result),
                            [
                                # 变压器基础信息
                                'TRAN_ID',
                                'TRAN_NAME',
                                'TRAN_RDFID',
                                'FEEDER_ID',
                                'FEEDER_NAME',
                                'FEEDER_RDFID',
                                'COMPANY_ID',
                                'COMPANY_NAME',
                                'COMPANY_RDFID',
                                'SUBSTATION_ID',
                                'SUBSTATION_NAME',
                                'SUBSTATION_RDFID',
                                'TRAN_TYPE',
                                'TRAN_SPEC',
                                # 变压器电气参数
                                'TRAN_MVA',
                                'TRAN_CURRENT',
                                'TRAN_VOLTAGE',
                                'TRAN_HIGH_ACTI',
                                'TRAN_HIGH_REAC',
                                'TRAN_HIGH_TREND_STR',
                                'TRAN_POWER_FACTOR',
                                'TRAN_LOW_ACTI',
                                'TRAN_LOW_REAC',
                                'TRAN_LOW_TREND_STR',
                                'TRAN_POSITIVE_ACTI',
                                'TRAN_REVERSE_ACTI',
                                # 损耗相关指标
                                'AVG_LOAD',
                                'COPP_ACTI_LOSS',
                                'COPP_REAC_LOSS',
                                'COPP_LOSSRATE',
                                'IRON_ACTI_LOSS',
                                'IRON_REAC_LOSS',
                                'IRON_LOSSRATE',
                                'COPP_IRON_RATIO',
                                'TRAN_ACTI_LOSS',
                                'TRAN_REAC_LOSS',
                                'TRAN_LOSSRATE',
                                'TRAN_LOSS_OF_TOTAL',
                                # 行政区划
                                'PROVINCIAL_ID',
                                'CITY_ID',
                                'COUNTY_ID',
                                # 时间信息
                                'DATA_TIME',
                                'TIME_INDEX',
                                'CALC_TIME',
                                # 计算方法
                                'CALC_METHOD',
                            ],
                        ] = [
                            # # 变压器基础信息
                            bus_df.at[i_bus, 'ID'],  # 'TRAN_ID',
                            bus_df.at[i_bus, 'NAME'],  # 'TRAN_NAME',
                            bus_df.at[i_bus, 'RDF_ID'],  # 'TRAN_RDF_ID',
                            feeder_id,  # 'FEEDER_ID',
                            feeder_name,  # 'FEEDER_NAME',
                            feeder_rdfid,  # 'FEEDER_RDFID',
                            0,  # 'COMPANY_ID',
                            company_name,  # 'COMPANY_NAME',
                            company_rdfid,  # 'COMPANY_RDFID',
                            substation_id,  # 'SUBSTATION_ID',
                            substation_name,  # 'SUBSTATION_NAME',
                            substation_rdfid,  # 'SUBSTATION_RDFID',
                            tran_type,  # 'TRAN_TYPE',
                            tran_spec,  # 'TRAN_SPEC',
                            # # 变压器电气参数
                            bus_df.at[i_bus, 'MVA'],  # 'TRAN_MVA',
                            (branch_pq_se_row['IMA'] + branch_pq_se_row['IMB'] + branch_pq_se_row['IMC']) * cons_para.current_factor,  # 'TRAN_CURRENT',
                            branch_pq_se_row['UAB'] / cons_para.voltage_output_factor,  # 'TRAN_VOLTAGE',
                            abs(branch_pf_row.iloc[:3].sum()) / cons_para.power_factor * cons_para.time_resolution_factor,  # 'TRAN_HIGH_ACTI',
                            abs(branch_qf_row.iloc[:3].sum()) / cons_para.power_factor * cons_para.time_resolution_factor,  # 'TRAN_HIGH_REAC',
                            format_complex(
                                complex(
                                    round(
                                        branch_pf_row.iloc[:3].sum() / cons_para.power_factor * cons_para.time_resolution_factor,
                                        6,
                                    ),
                                    round(
                                        branch_qf_row.iloc[:3].sum() / cons_para.power_factor * cons_para.time_resolution_factor,
                                        6,
                                    ),
                                )
                            ),  # 'TRAN_HIGH_TREND_STR',
                            0,  # 'TRAN_POWER_FACTOR',
                            abs(branch_pt_row.iloc[:3].sum()) / cons_para.power_factor * cons_para.time_resolution_factor,  # 'TRAN_LOW_ACTI',
                            abs(branch_qt_row.iloc[:3].sum()) / cons_para.power_factor * cons_para.time_resolution_factor,  # 'TRAN_LOW_REAC',
                            format_complex(
                                complex(
                                    round(
                                        branch_pt_row.iloc[:3].sum() / cons_para.power_factor * cons_para.time_resolution_factor,
                                        6,
                                    ),
                                    round(
                                        branch_qt_row.iloc[:3].sum() / cons_para.power_factor * cons_para.time_resolution_factor,
                                        6,
                                    ),
                                )
                            ),  # 'TRAN_LOW_TREND_STR',
                            pq_p_a,  # 'TRAN_POSITIVE_ACTI',
                            pq_r_a,  # 'TRAN_REVERSE_ACTI',
                            # # 损耗相关指标
                            S_tr / bus_df.at[i_bus, 'MVA'] * 100,  # 'AVG_LOAD',
                            copp_loss,  # 'COPP_ACTI_LOSS',
                            reac_copp_loss,  # 'COPP_REAC_LOSS',
                            copp_rate * 100,  # 'COPP_LOSSRATE',
                            iron_loss,  # 'IRON_ACTI_LOSS',
                            reac_iron_loss,  # 'IRON_REAC_LOSS',
                            iron_rate * 100,  # 'IRON_LOSSRATE',
                            division_0(copp_loss, iron_loss),  # 'COPP_IRON_RATIO',
                            iron_loss + copp_loss,  # 'TRAN_ACTI_LOSS',
                            reac_copp_loss + reac_iron_loss,  # 'TRAN_REAC_LOSS',
                            division_0(iron_loss + copp_loss, P_input) * 100,  # 'TRAN_LOSSRATE',
                            0,  # 'TRAN_LOSS_OF_TOTAL',
                            # # 行政区划
                            0,  # 'PROVINCIAL_ID',
                            0,  # 'CITY_ID',
                            0,  # 'COUNTY_ID',
                            # # 时间信息
                            datatime,  # 'DATA_TIME',
                            time_index,  # 'TIME_INDEX',
                            calc_time,  # 'CALC_TIME',
                            # # 计算方法
                            method_type,  # 'CALC_METHOD',
                        ]

                        energy_input_and_output.loc[
                            len(energy_input_and_output),
                            [
                                'idx',
                                'companyid',
                                'companyname',
                                'datatime',
                                'distributionlineid',
                                'distributionlinename',
                                'psrid',
                                'psrname',
                                'psrtype',
                                'datasource',
                                'datatype',
                                'reacener',
                                'actiener',
                                'energytype',
                            ],
                        ] = [
                            time_index,  # idx
                            company_rdfid,  # companyid
                            company_name,  # companyname
                            datatime,  # datatime
                            feeder_rdfid,  # distributionlineid
                            feeder_name,  # distributionlinename
                            bus_df.at[i_bus, 'RDF_ID'],  # psrid
                            bus_df.at[i_bus, 'NAME'],  # psrname
                            ('DistributionTransformer' if (bus_df.at[i_bus, 'PA_PRE'] + bus_df.at[i_bus, 'PB_PRE'] + bus_df.at[i_bus, 'PC_PRE']) > 0 else 'GeneratingUnit'),
                            # psrtype
                            0,  # datasource
                            1,  # datatype
                            ((branch_pf_results.at[i_br, 0] + branch_pf_results.at[i_br, 1] + branch_pf_results.at[i_br, 2]) - (temp_p_a + temp_p_b + temp_p_c))
                            / cons_para.power_factor
                            * cons_para.time_resolution_factor,  # actiener
                            ((branch_qf_results.at[i_br, 0] + branch_qf_results.at[i_br, 1] + branch_qf_results.at[i_br, 2]) - (temp_q_a + temp_q_b + temp_q_c))
                            / cons_para.power_factor
                            * cons_para.time_resolution_factor,  # reacener
                            1,  # energytype
                        ]
                        if bus_df.loc[i_bus, 'WITH_GF'] == 1:
                            self.dms_loss_dg_result.loc[
                                len(self.dms_loss_dg_result),
                                [
                                    # 基础信息
                                    'DISGEN_ID',  # 分布式电源标识
                                    'DISGEN_NAME',  # 名称
                                    'DISGEN_RDFID',  # RDF标识
                                    # 拓扑关联
                                    'FEEDER_ID',  # 所属馈线ID
                                    'FEEDER_NAME',  # 馈线名称
                                    'FEEDER_RDFID',  # 馈线RDF标识
                                    'COMPANY_ID',  # 供电公司ID
                                    'COMPANY_NAME',  # 供电公司名称
                                    'COMPANY_RDFID',  # 供电公司源端ID
                                    'SUBSTATION_ID',  # 变电站ID
                                    'SUBSTATION_NAME',  # 变电站名称
                                    'SUBSTATION_RDFID',  # 变电站RDF标识
                                    # 关联设备
                                    'RELATED_PRIVATE_ID',  # 关联私有设备ID
                                    'RELATED_PRIVATE_NAME',  # 私有设备名称
                                    'RELATED_PRIVATE_RDFID',  # 私有设备RDF标识
                                    # 电气参数
                                    'DISGEN_CURRENT',  # 分布式电源电流
                                    'DISGEN_VOLTAGE',  # 分布式电源电压
                                    'DISGEN_ACTI_POWER',  # 有功功率
                                    'DISGEN_REAC_POWER',  # 无功功率
                                    'DISGEN_POSITIVE_ACTI',  # 正向有功功率
                                    'DISGEN_REVERSE_ACTI',  # 反向有功功率
                                    # 行政区划
                                    'PROVINCIAL_ID',  # 省份ID
                                    'CITY_ID',  # 城市ID
                                    'COUNTY_ID',  # 区县ID
                                    # 时间信息
                                    'DATA_TIME',  # 数据时间戳
                                    'TIME_INDEX',  # 时间索引
                                    'CALC_TIME',  # 计算时间
                                    # 计算信息
                                    'CALC_METHOD',  # 计算方法
                                ],
                            ] = [
                                # # 基础信息
                                bus_df.at[i_bus, 'ID'],  # 'DISGEN_ID',  # 分布式电源标识
                                bus_df.at[i_bus, 'NAME'],  # 'DISGEN_NAME',  # 名称
                                bus_df.at[i_bus, 'RDF_ID'],  # 'DISGEN_RDFID',  # RDF标识
                                # # 拓扑关联
                                feeder_id,  # 'FEEDER_ID',  # 所属馈线ID
                                feeder_name,  # 'FEEDER_NAME',  # 馈线名称
                                feeder_rdfid,  # 'FEEDER_RDFID',  # 馈线RDF标识
                                0,  # 'COMPANY_ID',  # 供电公司ID
                                company_name,  # 'COMPANY_NAME',  # 供电公司名称
                                company_rdfid,  # 'COMPANY_RDFID',  # 供电公司源端ID
                                substation_id,  # 'SUBSTATION_ID',  # 变电站ID
                                substation_name,  # 'SUBSTATION_NAME',  # 变电站名称
                                substation_rdfid,  # 'SUBSTATION_RDFID',  # 变电站RDF标识
                                # # 关联设备
                                bus_df.at[i_bus, 'ID'],  # 'RELATED_PRIVATE_ID',  # 关联私有设备ID
                                bus_df.at[i_bus, 'NAME'],  # 'RELATED_PRIVATE_NAME',  # 私有设备名称
                                bus_df.at[i_bus, 'RDF_ID'],  # 'RELATED_PRIVATE_RDFID',  # 私有设备RDF标识
                                # # 电气参数
                                (branch_if_results.at[i_br, 0] + branch_if_results.at[i_br, 1] + branch_if_results.at[i_br, 2])
                                * cons_para.current_factor,  # 'DISGEN_CURRENT',  # 分布式电源电流
                                bus_vol_results.at[inode_id, 0] / cons_para.voltage_output_factor,  # 'DISGEN_VOLTAGE',  # 分布式电源电压
                                ((branch_pf_results.at[i_br, 0] + branch_pf_results.at[i_br, 1] + branch_pf_results.at[i_br, 2]) - (temp_p_a + temp_p_b + temp_p_c))
                                / cons_para.power_factor
                                * cons_para.time_resolution_factor,
                                # 'DISGEN_ACTI_POWER',  # 有功功率
                                ((branch_qf_results.at[i_br, 0] + branch_qf_results.at[i_br, 1] + branch_qf_results.at[i_br, 2]) - (temp_q_a + temp_q_b + temp_q_c))
                                / cons_para.power_factor
                                * cons_para.time_resolution_factor,
                                # 'DISGEN_REAC_POWER',  # 无功功率
                                pq_r_a,  # 'DISGEN_POSITIVE_ACTI', # 正向有功功率
                                pq_p_a,  # 'DISGEN_REVERSE_ACTI', # 反向有功功率
                                # # 行政区划
                                0,  # 'PROVINCIAL_ID',  # 省份ID
                                0,  # 'CITY_ID',  # 城市ID
                                0,  # 'COUNTY_ID',  # 区县ID
                                # # 时间信息
                                datatime,  # 'DATA_TIME',  # 数据时间戳
                                time_index,  # 'TIME_INDEX',  # 时间索引
                                calc_time,  # 'CALC_TIME',  # 计算时间
                                # # 计算信息
                                method_type,  # 'CALC_METHOD',  # 计算方法
                            ]
        self.dms_loss_lnseg_result = self.dms_loss_lnseg_result.reset_index(drop=True)
        self.dms_loss_trfm_result = self.dms_loss_trfm_result.reset_index(drop=True)

        sum_lnseg_loss = np.abs(self.dms_loss_lnseg_result['LNSEG_ACTI_LOSS']).sum()
        sum_tran_acti_loss = np.abs(self.dms_loss_trfm_result['TRAN_ACTI_LOSS']).sum()
        sum_tran_iron_loss = sum_gb_trans_iron_loss + sum_zb_trans_iron_loss
        sum_tran_copp_loss = sum_gb_trans_copp_loss + sum_zb_trans_copp_loss

        sum_loss1 = sum_lnseg_loss + sum_tran_iron_loss + sum_tran_copp_loss + sum_other_loss  # 通过计算每段线损得到的线损+铁损
        sum_loss2 = sum_PG - sum_P_load - sum_outpower_P  # 通过计算首端减去所有负荷得到的线损+铁损
        if sum_loss1 < sum_loss2:
            delta_loss_p = sum_loss2 - sum_loss1
            # 向量化操作，更新 'P_LOSS' 列
            self.dms_loss_lnseg_result['LNSEG_ACTI_LOSS'] = (
                self.dms_loss_lnseg_result['LNSEG_ACTI_LOSS'] + np.abs(self.dms_loss_lnseg_result['LNSEG_ACTI_LOSS']) / sum_lnseg_loss * delta_loss_p
            )
            # 向量化操作，更新'LOSS_RATE'列
            self.dms_loss_lnseg_result['LNSEG_LOSSRATE'] = self.dms_loss_lnseg_result['LNSEG_ACTI_LOSS'] / self.dms_loss_lnseg_result['LNSEG_HEAD_ACTI']

            sum_lnseg_loss = np.abs(self.dms_loss_lnseg_result['LNSEG_ACTI_LOSS']).sum()

            sum_loss1 = sum_lnseg_loss + sum_tran_iron_loss + sum_tran_copp_loss + sum_other_loss

        for i in range(len(self.dms_loss_lnseg_result)):
            self.dms_loss_lnseg_result.at[i, 'LNSEG_LOSS_OF_TOTAL'] = round(
                self.dms_loss_lnseg_result.at[i, 'LNSEG_ACTI_LOSS'] / sum_lnseg_loss * 100,
                2,
            )

        for i in range(len(self.dms_loss_trfm_result)):
            self.dms_loss_trfm_result.at[i, 'TRAN_LOSS_OF_TOTAL'] = round(
                self.dms_loss_trfm_result.at[i, 'TRAN_ACTI_LOSS'] / sum_tran_acti_loss * 100,
                2,
            )

        sum_lossrate1 = division_0(sum_loss1, sum_PG)  # 更新后的馈线线损率

        if branch_pq_se.at[0, 'P_SUM'] >= 0:
            theo_power_supply = sum_loss1 + sum_P_load
        else:
            theo_power_supply = (-1) * sum_P_DG
        feeder_average_volt = bus_vol_results.iloc[:, 0].mean() / cons_para.voltage_output_factor  # V转为kV
        feeder_average_current = 3 * branch_if_results.iloc[0, 0].mean() * cons_para.current_factor
        power_factor = division_0(sum_PG, math.sqrt(sum_PG**2 + sum_QG**2))

        tran_copp_iron_ratio = division_0(sum_tran_copp_loss, sum_tran_iron_loss)
        sum_tran_loss = sum_tran_iron_loss + sum_tran_copp_loss
        distrans_rate = division_0(sum_tran_loss, sum_PG)
        tran_iron_rate = division_0(sum_tran_iron_loss, sum_PG)
        tran_copp_rate = division_0(sum_tran_copp_loss, sum_PG)
        sum_zb_tran_loss = sum_zb_trans_iron_loss + sum_zb_trans_copp_loss
        lossrate_not_privatetran = division_0(sum_loss1 - sum_zb_tran_loss, sum_PG - sum_zb_tran_loss)

        self.dms_loss_feeder_result.loc[
            0,
            [
                # 拓扑标识
                'FEEDER_ID',  # 馈线标识
                'FEEDER_NAME',  # 馈线名称
                'FEEDER_RDFID',  # RDF标识
                'COMPANY_ID',  # 供电公司ID
                'COMPANY_NAME',  # 供电公司名称
                'COMPANY_RDFID',  # 供电公司源端ID
                'SUBSTATION_ID',  # 变电站ID
                'SUBSTATION_NAME',  # 变电站名称
                'SUBSTATION_RDFID',  # 变电站RDF标识
                # 电气量测
                'FEEDER_AVERAGE_CURRENT',  # 平均电流
                'FEEDER_AVERAGE_VOLTAGE',  # 平均电压
                'ACTI_POWER',  # 有功功率
                'REAC_POWER',  # 无功功率
                'FEEDER_POWER_FACTOR',  # 功率因数
                'OUTPUT_ACTI_POWER',  # 输出有功
                'OUTPUT_REAC_POWER',  # 输出无功
                # 分布式电源
                'DISGEN_NUMB',  # 分布式电源数量
                'DISGEN_ACTI_POWER',  # 分布式电源有功
                'DISGEN_REAC_POWER',  # 分布式电源无功
                # 损耗参数
                'FEEDER_LNSEG_LENGTH',  # 馈线导线段总长度
                'LNSEG_LOSS',  # 线路损耗
                'LNSEG_LOSSRATE',  # 线路损耗率
                'PRIVATE_NUMB',  # 所有专变数量
                'PUBLIC_NUMB',  # 所有公变数量
                'TRAN_NUMB',  # 变压器整体数量
                'PRIVATE_CAPA',  # 所有专变容量
                'PUBLIC_CAPA',  # 所有公变容量
                'TRAN_CAPA',  # 变压器整体容量
                'FEEDER_LOAD_RATE',  # 馈线负载率
                'PRIVATE_COPP_LOSS',  # 用户侧铜损
                'PUBLIC_COPP_LOSS',  # 公共网络铜损
                'TRAN_COPP_LOSS',  # 变压器铜损
                'TRAN_COPP_LOSSRATE',  # 变压器铜损率
                'PRIVATE_IRON_LOSS',  # 用户侧铁损
                'PUBLIC_IRON_LOSS',  # 公共网络铁损
                'TRAN_IRON_LOSS',  # 变压器铁损
                'TRAN_IRON_LOSSRATE',  # 变压器铁损率
                'COPP_IRON_RATIO',  # 铜铁损比
                'TRAN_LOSS',  # 变压器总损耗
                'TRAN_LOSSRATE',  # 变压器损耗率
                'OTHER_LOSS',  # 其他损耗
                'FEEDER_ACTI_LOSS',  # 馈线总有功损耗
                'FEEDER_REAC_LOSS',  # 馈线总无功损耗
                'FEEDER_LOSSRATE',  # 馈线损耗率
                'FEEDER_ELEC_SALES',  # 馈线售电量
                'THEO_POWER_SUPPLY',  # 馈线理论供电量
                'FEEDER_THEO_LOSSRATE',  # 馈线理论线损率
                'LOSSRATE_WITHOUT_PRIVATE',  # 剔除用户侧损耗率
                # 行政区划
                'PROVINCIAL_ID',  # 省份ID
                'CITY_ID',  # 城市ID
                'COUNTY_ID',  # 区县ID
                # 时间维度
                'DATA_TIME',  # 数据时间戳
                'TIME_INDEX',  # 时间索引
                'CALC_TIME',  # 计算时间
                # 计算信息
                'CALC_METHOD',  # 计算方法
            ],
        ] = [
            # # 拓扑标识
            feeder_id,  # 'FEEDER_ID',  # 馈线标识
            feeder_name,  # 'FEEDER_NAME',  # 馈线名称
            feeder_rdfid,  # 'FEEDER_RDFID',  # RDF标识
            0,  # 'COMPANY_ID',  # 供电公司ID
            company_name,  #'COMPANY_NAME',  # 供电公司名称
            company_rdfid,  #'COMPANY_RDFID',  # 供电公司源端ID
            substation_id,  # 'SUBSTATION_ID',  # 变电站ID
            substation_name,  # 'SUBSTATION_NAME',  # 变电站名称
            substation_rdfid,  # 'SUBSTATION_RDFID',  # 变电站RDF标识
            # # 电气量测
            feeder_average_current,  # 'FEEDER_AVERAGE_CURRENT',  # 平均电流
            feeder_average_volt,  # 'FEEDER_AVERAGE_VOLTAGE',  # 平均电压
            sum_PG,  # 'ACTI_POWER',  # 有功功率
            sum_QG,  # 'REAC_POWER',  # 无功功率
            power_factor,  # 'FEEDER_POWER_FACTOR',  # 功率因数
            sum_outpower_P,  # 'OUTPUT_ACTI_POWER',  # 输出有功
            sum_outpower_Q,  # 'OUTPUT_REAC_POWER',  # 输出无功
            # # 分布式电源
            0,  #'DISGEN_NUMB',  # 分布式电源数量
            sum_support_acti,  # 'DISGEN_ACTI_POWER',  # 分布式电源有功
            sum_support_reac,  # 'DISGEN_REAC_POWER',  # 分布式电源无功
            # # 损耗参数
            sum_line_length,  #'FEEDER_LNSEG_LENGTH',  # 馈线导线段总长度
            sum_lnseg_loss,  # 'LNSEG_LOSS',  # 线路损耗
            division_0(sum_lnseg_loss, sum_PG),  # 'LNSEG_LOSSRATE',  # 线路损耗率
            sum_zb_tran_numb,  #'PRIVATE_NUMB',  # 所有专变数量
            sum_gb_tran_numb,  #'PUBLIC_NUMB',  # 所有公变数量
            sum_tran_numb,  #'TRAN_NUMB',  # 变压器整体数量
            sum_zb_tran_capa,  #'PRIVATE_CAPA',  # 所有专变容量
            sum_gb_tran_capa,  #'PUBLIC_CAPA',  # 所有公变容量
            sum_tran_capa,  #'TRAN_CAPA',  #变压器整体容量
            (np.sqrt((sum_PG / cons_para.time_resolution_factor) ** 2 + (sum_QG / cons_para.time_resolution_factor) ** 2) / sum_tran_capa) * 100,  #'FEEDER_LOAD_RATE', # 馈线负载率
            sum_zb_trans_copp_loss,  # 'PRIVATE_COPP_LOSS',  # 用户侧铜损
            sum_gb_trans_copp_loss,  # 'PUBLIC_COPP_LOSS',  # 公共网络铜损
            sum_tran_copp_loss,  # 'TRAN_COPP_LOSS',  # 变压器铜损
            tran_copp_rate,  # 'TRAN_COPP_LOSSRATE',  # 变压器铜损率
            sum_zb_trans_iron_loss,  # 'PRIVATE_IRON_LOSS',  # 用户侧铁损
            sum_gb_trans_iron_loss,  # 'PUBLIC_IRON_LOSS',  # 公共网络铁损
            sum_tran_iron_loss,  # 'TRAN_IRON_LOSS',  # 变压器铁损
            tran_iron_rate,  # 'TRAN_IRON_LOSSRATE',  # 变压器铁损率
            tran_copp_iron_ratio,  # 'COPP_IRON_RATIO',  # 铜铁损比
            sum_tran_loss,  # 'TRAN_LOSS',  # 变压器总损耗
            distrans_rate * 100,  # 'TRAN_LOSSRATE',  # 变压器损耗率
            sum_other_loss,  # 'OTHER_LOSS',  # 其他损耗
            sum_loss1,  # 'FEEDER_ACTI_LOSS',  # 馈线总有功损耗
            sum_QG - sum_Q_load,  # 'FEEDER_REAC_LOSS',  # 馈线总无功损耗
            sum_lossrate1 * 100,  # 'FEEDER_LOSSRATE',  # 馈线损耗率
            sum_P_load,  #'FEEDER_ELEC_SALES',  # 馈线售电量
            theo_power_supply,  #'THEO_POWER_SUPPLY',  # 馈线理论供电量
            division_0(sum_loss1, theo_power_supply) * 100,  #'FEEDER_THEO_LOSSRATE',  # 馈线理论线损率
            lossrate_not_privatetran * 100,  # 'LOSSRATE_WITHOUT_PRIVATE',  # 剔除用户侧损耗率
            # # 行政区划
            0,  # 'PROVINCIAL_ID',  # 省份ID
            0,  # 'CITY_ID',  # 城市ID
            0,  # 'COUNTY_ID',  # 区县ID
            # # 时间维度
            datatime,  # 'DATA_TIME',  # 数据时间戳
            time_index,  # 'TIME_INDEX',  # 时间索引
            calc_time,  # 'CALC_TIME',  # 计算时间
            # # 计算信息
            'ROBUST_STATE_ESTIMATION_METHOD',  # 'CALC_METHOD',  # 计算方法
        ]

        feeder_statics.loc[
            0,
            [
                'IDX',
                'FEEDER_ID',
                'FEEDER_NAME',
                'RDF_ID',
                'LOSS_RATE',
                'CODE',
                'MESSAGE',
                'DATA_TIME',
            ],
        ] = [
            time_index,
            feeder_id,
            feeder_name,
            feeder_rdfid,
            sum_lossrate1,
            0,
            '成功计算',
            datatime,
        ]
        print(f'理论线损率：{100 * round(sum_lossrate1, 6)}%')
        # print("通过计算首端减去所有负荷得到的线损率：", round(sum_lossrate2, 6))

        print(f'理论总线损：{round(sum_loss1, 6)}kW')
        # print("通过计算首端减去所有负荷得到的总线损：", round(sum_loss2, 6))

        print(f'馈线总供入有功: {round(sum_PG, 6)}kW')
        print(f'馈线总有功负荷：{round(sum_P_load, 6)}kW')
        se_or_pf_result['tables'].update(
            {
                'sum_lossrate': sum_lossrate1,
                'feeder_statics': feeder_statics,
                'dms_loss_trfm_result': self.dms_loss_trfm_result,
                'dms_loss_lnseg_result': self.dms_loss_lnseg_result,
                'dms_loss_dg_result': self.dms_loss_dg_result,
                'dms_loss_feeder_result': self.dms_loss_feeder_result,
                'energy_input_and_output': energy_input_and_output,
                'equipment_calclog': self.equipment_calclog,
                'capacitorloss': self.capacitorloss,
                'power_error': power_error,
            }
        )

        return se_or_pf_result

        # 基于这些结果计算线损结果

    def calc_loss_result_static_taiqu(self, time_index, day_time):
        """统计台区计算结果"""
        # 先调用父类的calc_result_static方法，获取原始的潮流或状估结果
        se_or_pf_result = super().calc_result_static()
        branch_df = self.grid_model_builder.branch_df
        bus_df = self.grid_model_builder.bus_df
        power_error = self.grid_model_builder.power_error_df
        calc_result = self.calc_result
        branch_pq_se = se_or_pf_result['tables']['branch_pq_se'].copy()

        sym_load = self.grid_data['sym_load']

        feeder_model = self.grid_model_builder.feeder_model
        cons_para = self.grid_model_builder.cons_para
        if day_time is None:
            day_time = get_day_begin()
            # 时间戳转日期字符串
            day_time = datetime.fromtimestamp(day_time).strftime('%Y%m%d')
        datatime = day_time
        # yearmonth = str(day_time)[:6]
        district_id = feeder_model.get('FEEDER_ID', '')
        district_name = feeder_model.get('FEEDER_NAME', '')
        district_rdfid = feeder_model.get('RDF_ID', '')

        distransformer_id = feeder_model.get('FEEDER_ID', '')
        distransformer_name = feeder_model.get('FEEDER_NAME', '')
        distransformer_rdfid = feeder_model.get('RDF_ID', '')

        feeder_id = feeder_model.get('BULK_ID', '')
        feeder_name = feeder_model.get('BULK_NAME', '')
        feeder_rdfid = feeder_model.get('BULK_RDFID', '')

        substation_id = feeder_model.get('SUBSTATION_ID', '')
        substation_name = feeder_model.get('SUBSTATION_NAME', '')
        substation_rdfid = feeder_model.get('SUBSTATION_RDFID', '')

        company_id = feeder_model.get('AREA_ID', '')
        company_name = feeder_model.get('AREA_NAME', '')
        company_rdfid = feeder_model.get('AREA_RDFID', '')

        if calc_result is None:
            return self.get_error_result(feeder_id, feeder_name, feeder_rdfid, time_index, datatime)

        calc_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

        electricity_output_and_input = self.electricity_output_and_input

        bus_vol_results = pd.DataFrame(calc_result['node']['u'])
        # bus_angle_results = pd.DataFrame(result['node']['u_angle'])
        branch_if_results = pd.DataFrame(calc_result['line']['i_from'])
        branch_pf_results = pd.DataFrame(calc_result['line']['p_from'])
        branch_qf_results = pd.DataFrame(calc_result['line']['q_from'])
        branch_pt_results = pd.DataFrame(calc_result['line']['p_to'])
        branch_qt_results = pd.DataFrame(calc_result['line']['q_to'])
        branch_it_results = pd.DataFrame(calc_result['line']['i_to'])

        singlephase_count = 0
        threephase_count = 0
        sum_line_loss_p = 0
        sum_line_loss_q = 0
        # sum_meter_loss_p = 0
        sum_line_length = 0

        for i_br in range(len(branch_df)):
            if branch_df.loc[i_br, 'BR_TYPE'] == 3 or branch_df.loc[i_br, 'BR_TYPE'] == 5:
                inode_id = branch_df.loc[i_br, 'INODE_ID'] - 1
                znode_id = branch_df.loc[i_br, 'ZNODE_ID'] - 1
                loss_p_a = (branch_pf_results.at[i_br, 0] + branch_pt_results.at[i_br, 0]) * cons_para.loss_factor * cons_para.time_resolution_factor
                loss_p_b = (branch_pf_results.at[i_br, 1] + branch_pt_results.at[i_br, 1]) * cons_para.loss_factor * cons_para.time_resolution_factor
                loss_p_c = (branch_pf_results.at[i_br, 2] + branch_pt_results.at[i_br, 2]) * cons_para.loss_factor * cons_para.time_resolution_factor
                loss_q_a = (branch_qf_results.at[i_br, 0] + branch_qt_results.at[i_br, 0]) * cons_para.loss_factor * cons_para.time_resolution_factor
                loss_q_b = (branch_qf_results.at[i_br, 1] + branch_qt_results.at[i_br, 1]) * cons_para.loss_factor * cons_para.time_resolution_factor
                loss_q_c = (branch_qf_results.at[i_br, 2] + branch_qt_results.at[i_br, 2]) * cons_para.loss_factor * cons_para.time_resolution_factor
                acti_trend_a = 0
                acti_trend_str_a = 0
                reac_trend_a = 0
                reac_trend_str_a = 0
                acti_trend_b = 0
                acti_trend_str_b = 0
                reac_trend_b = 0
                reac_trend_str_b = 0
                acti_trend_c = 0
                acti_trend_str_c = 0
                reac_trend_c = 0
                reac_trend_str_c = 0
                sum_line_length += branch_df.loc[i_br, 'LENGTH']
                # 判断A相有功首端大还是末端大
                if abs(branch_pf_results.at[i_br, 0]) >= abs(branch_pt_results.at[i_br, 0]):
                    acti_trend_a = 0
                    acti_trend_str_a = complex(
                        round(branch_pf_results.at[i_br, 0] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                        round(branch_qf_results.at[i_br, 0] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                    )
                else:
                    acti_trend_a = 1
                    acti_trend_str_a = complex(
                        round(branch_pt_results.at[i_br, 0] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                        round(branch_qt_results.at[i_br, 0] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                    )
                # 判断A相无功首端大还是末端大
                if abs(branch_qf_results.at[i_br, 0]) >= abs(branch_qt_results.at[i_br, 0]):
                    reac_trend_a = 0
                    reac_trend_str_a = complex(
                        round(branch_pf_results.at[i_br, 0] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                        round(branch_qf_results.at[i_br, 0] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                    )
                else:
                    reac_trend_a = 1
                    reac_trend_str_a = complex(
                        round(branch_pt_results.at[i_br, 0] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                        round(branch_qt_results.at[i_br, 0] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                    )

                # 判断B相有功首端大还是末端大
                if abs(branch_pf_results.at[i_br, 1]) >= abs(branch_pt_results.at[i_br, 1]):
                    acti_trend_b = 0
                    acti_trend_str_b = complex(
                        round(branch_pf_results.at[i_br, 1] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                        round(branch_qf_results.at[i_br, 1] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                    )
                else:
                    acti_trend_b = 1
                    acti_trend_str_b = complex(
                        round(branch_pt_results.at[i_br, 1] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                        round(branch_qt_results.at[i_br, 1] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                    )
                # 判断B相无功首端大还是末端大
                if abs(branch_qf_results.at[i_br, 1]) >= abs(branch_qt_results.at[i_br, 1]):
                    reac_trend_b = 0
                    reac_trend_str_b = complex(
                        round(branch_pf_results.at[i_br, 1] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                        round(branch_qf_results.at[i_br, 1] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                    )
                else:
                    reac_trend_b = 1
                    reac_trend_str_b = complex(
                        round(branch_pt_results.at[i_br, 1] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                        round(branch_qt_results.at[i_br, 1] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                    )

                # 判断C相有功首端大还是末端大
                if abs(branch_pf_results.at[i_br, 2]) >= abs(branch_pt_results.at[i_br, 2]):
                    acti_trend_c = 0
                    acti_trend_str_c = complex(
                        round(branch_pf_results.at[i_br, 2] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                        round(branch_qf_results.at[i_br, 2] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                    )
                else:
                    acti_trend_c = 1
                    acti_trend_str_c = complex(
                        round(branch_pt_results.at[i_br, 2] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                        round(branch_qt_results.at[i_br, 2] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                    )
                # 判断C相无功首端大还是末端大
                if abs(branch_qf_results.at[i_br, 2]) >= abs(branch_qt_results.at[i_br, 2]):
                    reac_trend_c = 0
                    reac_trend_str_c = complex(
                        round(branch_pf_results.at[i_br, 2] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                        round(branch_qf_results.at[i_br, 2] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                    )
                else:
                    reac_trend_c = 1
                    reac_trend_str_c = complex(
                        round(branch_pt_results.at[i_br, 2] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                        round(branch_qt_results.at[i_br, 2] / cons_para.power_factor * cons_para.time_resolution_factor, 6),
                    )

                # 线路型号
                lnseg_spec = ''

                self.taiqu_loss_lnseg_result.loc[
                    len(self.taiqu_loss_lnseg_result),
                    [
                        'LNSEG_ID',
                        'LNSEG_NAME',
                        'LNSEG_RDFID',
                        'DISTRICT_ID',
                        'DISTRICT_NAME',
                        'DISTRICT_RDFID',
                        'DISTRANSFORMER_ID',
                        'DISTRANSFORMER_NAME',
                        'DISTRANSFORMER_RDFID',
                        'FEEDER_ID',
                        'FEEDER_NAME',
                        'FEEDER_RDFID',
                        'SUBSTATION_ID',
                        'SUBSTATION_NAME',
                        'SUBSTATION_RDFID',
                        'COMPANY_ID',
                        'COMPANY_NAME',
                        'COMPANY_RDFID',
                        'LNSEG_SPEC',
                        'LNSEG_RAA',
                        'LNSEG_XAA',
                        'LNSEG_LENGTH',
                        'LNSEG_CURRENT_TOTAL',
                        'LNSEG_CURRENT_A',
                        'LNSEG_CURRENT_B',
                        'LNSEG_CURRENT_C',
                        'HEAD_TERMINAL_ID',
                        'END_TERMINAL_ID',
                        'LNSEG_HEAD_VOLTAGE_TOTAL',
                        'LNSEG_HEAD_VOLTAGE_A',
                        'LNSEG_HEAD_VOLTAGE_B',
                        'LNSEG_HEAD_VOLTAGE_C',
                        'LNSEG_END_VOLTAGE_TOTAL',
                        'LNSEG_END_VOLTAGE_A',
                        'LNSEG_END_VOLTAGE_B',
                        'LNSEG_END_VOLTAGE_C',
                        'LNSEG_HEAD_ACTI_POWER_TOTAL',
                        'LNSEG_HEAD_ACTI_POWER_A',
                        'LNSEG_HEAD_ACTI_POWER_B',
                        'LNSEG_HEAD_ACTI_POWER_C',
                        'LNSEG_END_ACTI_POWER_TOTAL',
                        'LNSEG_END_ACTI_POWER_A',
                        'LNSEG_END_ACTI_POWER_B',
                        'LNSEG_END_ACTI_POWER_C',
                        'LNSEG_ACTI_LOSS_TOTAL',
                        'LNSEG_ACTI_LOSS_A',
                        'LNSEG_ACTI_LOSS_B',
                        'LNSEG_ACTI_LOSS_C',
                        'LNSEG_ACTI_LOSSRATE',
                        'LNSEG_LOSS_OF_TOTAL',
                        'LNSEG_HEAD_REAC_POWER_TOTAL',
                        'LNSEG_HEAD_REAC_POWER_A',
                        'LNSEG_HEAD_REAC_POWER_B',
                        'LNSEG_HEAD_REAC_POWER_C',
                        'LNSEG_END_REAC_POWER_TOTAL',
                        'LNSEG_END_REAC_POWER_A',
                        'LNSEG_END_REAC_POWER_B',
                        'LNSEG_END_REAC_POWER_C',
                        'LNSEG_REAC_LOSS_TOTAL',
                        'LNSEG_REAC_LOSS_A',
                        'LNSEG_REAC_LOSS_B',
                        'LNSEG_REAC_LOSS_C',
                        'LNSEG_ACTI_TREND_A',
                        'LNSEG_ACTI_TREND_B',
                        'LNSEG_ACTI_TREND_C',
                        'LNSEG_REAC_TREND_A',
                        'LNSEG_REAC_TREND_B',
                        'LNSEG_REAC_TREND_C',
                        'LNSEG_ACTI_TREND_STR_A',
                        'LNSEG_ACTI_TREND_STR_B',
                        'LNSEG_ACTI_TREND_STR_C',
                        'LNSEG_REAC_TREND_STR_A',
                        'LNSEG_REAC_TREND_STR_B',
                        'LNSEG_REAC_TREND_STR_C',
                        'PROVINCIAL_ID',
                        'CITY_ID',
                        'COUNTY_ID',
                        'DATA_TIME',
                        'TIME_INDEX',
                        'CALC_TIME',
                        'CALC_METHOD',
                    ],
                ] = [
                    branch_df.loc[i_br, 'ID'],  # 'LNSEG_ID',
                    branch_df.loc[i_br, 'NAME'],  # 'LNSEG_NAME',
                    branch_df.loc[i_br, 'RDF_ID'],  # 'LNSEG_RDFID',
                    district_id,  # 'DISTRICT_ID',
                    district_name,  # 'DISTRICT_NAME',
                    district_rdfid,  # 'DISTRICT_RDFID',
                    distransformer_id,  # 'DISTRANSFORMER_ID',
                    distransformer_name,  # 'DISTRANSFORMER_NAME',
                    distransformer_rdfid,  # 'DISTRANSFORMER_RDFID',
                    feeder_id,  # 'FEEDER_ID',
                    feeder_name,  # 'FEEDER_NAME',
                    feeder_rdfid,  # 'FEEDER_RDFID',
                    substation_id,  # 'SUBSTATION_ID',
                    substation_name,  # 'SUBSTATION_NAME',
                    substation_rdfid,  # 'SUBSTATION_RDFID',
                    company_id,  # 'COMPANY_ID',
                    company_name,  # 'COMPANY_NAME',
                    company_rdfid,  # 'COMPANY_RDFID',
                    lnseg_spec,  # 'LNSEG_SPEC',
                    branch_df.loc[i_br, 'RAA'],  # 'LNSEG_RAA',
                    branch_df.loc[i_br, 'XAA'],  # 'LNSEG_XAA',
                    branch_df.loc[i_br, 'LENGTH'],  # 'LNSEG_LENGTH',
                    (branch_if_results.at[i_br, 0] + branch_if_results.at[i_br, 1] + branch_if_results.at[i_br, 0]) * cons_para.current_factor,  # 'LNSEG_CURRENT_TOTAL',
                    branch_if_results.at[i_br, 0] * cons_para.current_factor,  # 'LNSEG_CURRENT_A',
                    branch_if_results.at[i_br, 1] * cons_para.current_factor,  # 'LNSEG_CURRENT_B',
                    branch_if_results.at[i_br, 2] * cons_para.current_factor,  # 'LNSEG_CURRENT_C',
                    str(branch_df.loc[i_br, 'ORI_INODE_ID']),  # 'HEAD_TERMINAL_ID',
                    str(branch_df.loc[i_br, 'ORI_ZNODE_ID']),  # 'END_TERMINAL_ID',
                    bus_vol_results.iloc[inode_id, :].mean() / math.sqrt(3) / cons_para.voltage_output_factor,  # 'LNSEG_HEAD_VOLTAGE_TOTAL',
                    # (bus_vol_results.at[inode_id, 0] + bus_vol_results.at[inode_id, 1] + bus_vol_results.at[inode_id, 2]) / math.sqrt(3) / cons_para.voltage_output_factor,  # 'LNSEG_HEAD_VOLTAGE_TOTAL',
                    bus_vol_results.at[inode_id, 0] / math.sqrt(3) / cons_para.voltage_output_factor,  # 'LNSEG_HEAD_VOLTAGE_A',
                    bus_vol_results.at[inode_id, 1] / math.sqrt(3) / cons_para.voltage_output_factor,  # 'LNSEG_HEAD_VOLTAGE_B',
                    bus_vol_results.at[inode_id, 2] / math.sqrt(3) / cons_para.voltage_output_factor,  # 'LNSEG_HEAD_VOLTAGE_C',
                    bus_vol_results.iloc[znode_id, :].mean() / math.sqrt(3) / cons_para.voltage_output_factor,  # 'LNSEG_END_VOLTAGE_TOTAL',
                    # (bus_vol_results.at[znode_id, 0] + bus_vol_results.at[znode_id, 1] + bus_vol_results.at[znode_id, 2]) / math.sqrt(3) / cons_para.voltage_output_factor,  # 'LNSEG_END_VOLTAGE_TOTAL',
                    bus_vol_results.at[znode_id, 0] / math.sqrt(3) / cons_para.voltage_output_factor,  # 'LNSEG_END_VOLTAGE_A',
                    bus_vol_results.at[znode_id, 1] / math.sqrt(3) / cons_para.voltage_output_factor,  # 'LNSEG_END_VOLTAGE_B',
                    bus_vol_results.at[znode_id, 2] / math.sqrt(3) / cons_para.voltage_output_factor,  # 'LNSEG_END_VOLTAGE_C',
                    (branch_pf_results.at[i_br, 0] + branch_pf_results.at[i_br, 1] + branch_pf_results.at[i_br, 2])
                    / cons_para.power_factor
                    * cons_para.time_resolution_factor,  # 'LNSEG_HEAD_ACTI_POWER_TOTAL',
                    branch_pf_results.at[i_br, 0] / cons_para.power_factor * cons_para.time_resolution_factor,  # 'LNSEG_HEAD_ACTI_POWER_A',
                    branch_pf_results.at[i_br, 1] / cons_para.power_factor * cons_para.time_resolution_factor,  # 'LNSEG_HEAD_ACTI_POWER_B',
                    branch_pf_results.at[i_br, 2] / cons_para.power_factor * cons_para.time_resolution_factor,  # 'LNSEG_HEAD_ACTI_POWER_C',
                    (branch_pt_results.at[i_br, 0] + branch_pt_results.at[i_br, 1] + branch_pt_results.at[i_br, 2])
                    / cons_para.power_factor
                    * cons_para.time_resolution_factor,  # 'LNSEG_END_ACTI_POWER_TOTAL',
                    branch_pt_results.at[i_br, 0] / cons_para.power_factor * cons_para.time_resolution_factor,  # 'LNSEG_END_ACTI_POWER_A',
                    branch_pt_results.at[i_br, 1] / cons_para.power_factor * cons_para.time_resolution_factor,  # 'LNSEG_END_ACTI_POWER_B',
                    branch_pt_results.at[i_br, 2] / cons_para.power_factor * cons_para.time_resolution_factor,  # 'LNSEG_END_ACTI_POWER_C',
                    loss_p_a + loss_p_b + loss_p_c,  # 'LNSEG_ACTI_LOSS_TOTAL',
                    loss_p_a,  # 'LNSEG_ACTI_LOSS_A',
                    loss_p_b,  # 'LNSEG_ACTI_LOSS_B',
                    loss_p_c,  # 'LNSEG_ACTI_LOSS_C',
                    division_0(
                        loss_p_a + loss_p_b + loss_p_c,
                        (branch_pf_results.at[i_br, 0] + branch_pf_results.at[i_br, 1] + branch_pf_results.at[i_br, 2]) / cons_para.power_factor * cons_para.time_resolution_factor,
                    )
                    * 100,  # 'LNSEG_ACTI_LOSSRATE',
                    0,  # 'LNSEG_LOSS_OF_TOTAL',
                    (branch_qf_results.at[i_br, 0] + branch_qf_results.at[i_br, 1] + branch_qf_results.at[i_br, 2])
                    / cons_para.power_factor
                    * cons_para.time_resolution_factor,  # 'LNSEG_HEAD_REAC_POWER_TOTAL',
                    branch_qf_results.at[i_br, 0] / cons_para.power_factor * cons_para.time_resolution_factor,  # 'LNSEG_HEAD_REAC_POWER_A',
                    branch_qf_results.at[i_br, 1] / cons_para.power_factor * cons_para.time_resolution_factor,  # 'LNSEG_HEAD_REAC_POWER_B',
                    branch_qf_results.at[i_br, 2] / cons_para.power_factor * cons_para.time_resolution_factor,  # 'LNSEG_HEAD_REAC_POWER_C',
                    (branch_qt_results.at[i_br, 0] + branch_qt_results.at[i_br, 1] + branch_qt_results.at[i_br, 2])
                    / cons_para.power_factor
                    * cons_para.time_resolution_factor,  # 'LNSEG_END_REAC_POWER_TOTAL',
                    branch_qt_results.at[i_br, 0] / cons_para.power_factor * cons_para.time_resolution_factor,  # 'LNSEG_END_REAC_POWER_A',
                    branch_qt_results.at[i_br, 1] / cons_para.power_factor * cons_para.time_resolution_factor,  # 'LNSEG_END_REAC_POWER_B',
                    branch_qt_results.at[i_br, 2] / cons_para.power_factor * cons_para.time_resolution_factor,  # 'LNSEG_END_REAC_POWER_C',
                    loss_q_a + loss_q_b + loss_q_c,  # 'LNSEG_REAC_LOSS_TOTAL',
                    loss_q_a,  # 'LNSEG_REAC_LOSS_A',
                    loss_q_b,  # 'LNSEG_REAC_LOSS_B',
                    loss_q_c,  # 'LNSEG_REAC_LOSS_C',
                    acti_trend_a,  # 'LNSEG_ACTI_TREND_A',
                    acti_trend_b,  # 'LNSEG_ACTI_TREND_B',
                    acti_trend_c,  # 'LNSEG_ACTI_TREND_C',
                    reac_trend_a,  # 'LNSEG_REAC_TREND_A',
                    reac_trend_b,  # 'LNSEG_REAC_TREND_B',
                    reac_trend_c,  # 'LNSEG_REAC_TREND_C',
                    format_complex(acti_trend_str_a),  # 'LNSEG_ACTI_TREND_STR_A',
                    format_complex(acti_trend_str_b),  # 'LNSEG_ACTI_TREND_STR_B',
                    format_complex(acti_trend_str_c),  # 'LNSEG_ACTI_TREND_STR_C',
                    format_complex(reac_trend_str_a),  # 'LNSEG_REAC_TREND_STR_A',
                    format_complex(reac_trend_str_b),  # 'LNSEG_REAC_TREND_STR_B',
                    format_complex(reac_trend_str_c),  # 'LNSEG_REAC_TREND_STR_C',
                    0,  # 'PROVINCIAL_ID',
                    0,  # 'CITY_ID',
                    0,  # 'COUNTY_ID',
                    datatime,  # 'DATA_TIME',
                    time_index,  # 'TIME_INDEX',
                    calc_time,  # 'CALC_TIME',
                    'ROBUST_STATE_ESTIMATION_METHOD',  # 'CALC_METHOD',
                ]

            # 南网输入输出电量统计结果
            if branch_df.loc[i_br, 'BR_TYPE'] == 6:
                if branch_pq_se.loc[i_br, 'P_SUM'] > 0:
                    electricity_output_and_input.loc[
                        len(electricity_output_and_input),
                        [
                            'idx',
                            'data_time',
                            'companyid',
                            'companyname',
                            'distributionlineid',
                            'distributionlinename',
                            'disttransformerid',
                            'disttransformername',
                            'districtid',
                            'districtname',
                            'psrid',
                            'psrname',
                            'psrtype',
                            'datatype',
                            'datasource',
                            'energytype',
                            'actiener',
                            'reacener',
                        ],
                    ] = [
                        time_index,  # idx
                        datatime,  # data_time
                        company_rdfid,  # companyid
                        company_name,  # companyname
                        feeder_rdfid,  # distributionlineid
                        feeder_name,  # distributionlinename
                        feeder_rdfid,  # disttransformerid
                        feeder_name,  # disttransformername
                        feeder_rdfid,  # districtid
                        feeder_name,  # districtname
                        feeder_rdfid,  # psrid
                        feeder_name,  # psrname
                        'DistributionTransformer',  # psrtype
                        1,  # datatype
                        0,  # datasource
                        1,  # energytype
                        branch_pq_se.loc[i_br, 'P_SUM'] / cons_para.power_factor * cons_para.time_resolution_factor,  # actiener
                        branch_pq_se.loc[i_br, 'Q_SUM'] / cons_para.power_factor * cons_para.time_resolution_factor,  # reacener
                    ]
            for i_bus in range(len(bus_df)):
                if bus_df.loc[i_bus, 'ID'] == branch_df.at[i_br, 'ZNODE_ID']:
                    if int(bus_df.loc[i_bus, 'METER_TYPE']) == 1 or int(bus_df.loc[i_bus, 'METER_TYPE']) == 3:
                        temp_p_a = 0
                        temp_p_b = 0
                        temp_p_c = 0
                        temp_q_a = 0
                        temp_q_b = 0
                        temp_q_c = 0
                        for i_temp in range(len(branch_pf_results)):
                            if branch_df.at[i_temp, 'INODE_ID'] == bus_df.loc[i_bus, 'ID']:
                                temp_p_a += branch_pf_results.at[i_temp, 0]
                                temp_p_b += branch_pf_results.at[i_temp, 1]
                                temp_p_c += branch_pf_results.at[i_temp, 2]
                                temp_q_a += branch_qf_results.at[i_temp, 0]
                                temp_q_b += branch_qf_results.at[i_temp, 1]
                                temp_q_c += branch_qf_results.at[i_temp, 2]
                        actiener = (
                            (-(branch_pt_results.at[i_br, 0] + branch_pt_results.at[i_br, 1] + branch_pt_results.at[i_br, 2]) - (temp_p_a + temp_p_b + temp_p_c))
                            / cons_para.power_factor
                            * cons_para.time_resolution_factor
                        )  # 有功供入
                        reacener = (
                            (-(branch_qt_results.at[i_br, 0] + branch_qt_results.at[i_br, 1] + branch_qt_results.at[i_br, 2]) - (temp_q_a + temp_q_b + temp_q_c))
                            / cons_para.power_factor
                            * cons_para.time_resolution_factor
                        )  # 无功供入
                        electricity_output_and_input.loc[
                            len(electricity_output_and_input),
                            [
                                'idx',
                                'data_time',
                                'companyid',
                                'companyname',
                                'distributionlineid',
                                'distributionlinename',
                                'disttransformerid',
                                'disttransformername',
                                'districtid',
                                'districtname',
                                'psrid',
                                'psrname',
                                'psrtype',
                                'datatype',
                                'datasource',
                                'energytype',
                                'actiener',
                                'reacener',
                            ],
                        ] = [
                            time_index,  # idx
                            datatime,  # data_time
                            company_rdfid,  # companyid
                            company_name,  # companyname
                            feeder_rdfid,  # distributionlineid
                            feeder_name,  # distributionlinename
                            feeder_rdfid,  # disttransformerid
                            feeder_name,  # disttransformername
                            feeder_rdfid,  # districtid
                            feeder_name,  # districtname
                            bus_df.loc[i_bus, 'METER_ID'],  # psrid
                            bus_df.loc[i_bus, 'NAME'],  # psrname
                            ('Customer' if (bus_df.at[i_bus, 'PA_PRE'] + bus_df.at[i_bus, 'PB_PRE'] + bus_df.at[i_bus, 'PC_PRE']) >= 0 else 'GeneratingUnit'),  # psrtype
                            1,  # datatype
                            0,  # datasource
                            1,  # energytype
                            actiener,  # actiener
                            reacener,  # reacener
                        ]
                        loss_pq = 0
                        if int(bus_df.loc[i_bus, 'IS_GF']) == 0:
                            if int(bus_df.loc[i_bus, 'METER_TYPE']) == 3:
                                loss_pq = cons_para.loss_meter_3ph * cons_para.time_resolution_factor
                            else:
                                loss_pq = cons_para.loss_meter_1ph * cons_para.time_resolution_factor

                            self.taiqu_loss_customer_result.loc[
                                len(self.taiqu_loss_customer_result),
                                [
                                    'METER_ID',
                                    'METER_NAME',
                                    'METER_RDFID',
                                    'RELATED_CUSTOMER_ID',
                                    'RELATED_CUSTOMER_NAME',
                                    'RELATED_CUSTOMER_RDFID',
                                    'DISTRICT_ID',
                                    'DISTRICT_NAME',
                                    'DISTRICT_RDFID',
                                    'DISTRANSFORMER_ID',
                                    'DISTRANSFORMER_NAME',
                                    'DISTRANSFORMER_RDFID',
                                    'FEEDER_ID',
                                    'FEEDER_NAME',
                                    'FEEDER_RDFID',
                                    'SUBSTATION_ID',
                                    'SUBSTATION_NAME',
                                    'SUBSTATION_RDFID',
                                    'COMPANY_ID',
                                    'COMPANY_NAME',
                                    'COMPANY_RDFID',
                                    'METER_TYPE',
                                    'METER_CURRENT_TOTAL',
                                    'METER_CURRENT_A',
                                    'METER_CURRENT_B',
                                    'METER_CURRENT_C',
                                    'METER_VOLTAGE_TOTAL',
                                    'METER_VOLTAGE_A',
                                    'METER_VOLTAGE_B',
                                    'METER_VOLTAGE_C',
                                    'METER_ACTI_POWER_TOTAL',
                                    'METER_ACTI_POWER_A',
                                    'METER_ACTI_POWER_B',
                                    'METER_ACTI_POWER_C',
                                    'METER_REAC_POWER_TOTAL',
                                    'METER_REAC_POWER_A',
                                    'METER_REAC_POWER_B',
                                    'METER_REAC_POWER_C',
                                    'METER_ACTI_LOSS_TOTAL',
                                    'METER_ACTI_LOSS_A',
                                    'METER_ACTI_LOSS_B',
                                    'METER_ACTI_LOSS_C',
                                    'METER_REAC_LOSS_TOTAL',
                                    'METER_REAC_LOSS_A',
                                    'METER_REAC_LOSS_B',
                                    'METER_REAC_LOSS_C',
                                    'METER_ACTI_LOSSRATE',
                                    'METER_LOSS_OF_TOTAL',
                                    'PROVINCIAL_ID',
                                    'CITY_ID',
                                    'COUNTY_ID',
                                    'DATA_TIME',
                                    'TIME_INDEX',
                                    'CALC_TIME',
                                    'CALC_METHOD',
                                ],
                            ] = [
                                i_bus,  # 'METER_ID',
                                bus_df.loc[i_bus, 'NAME'],  # 'METER_NAME',
                                bus_df.loc[i_bus, 'METER_ID'],  # 'METER_RDFID',
                                0,  # 'RELATED_CUSTOMER_ID',
                                0,  # 'RELATED_CUSTOMER_NAME',
                                bus_df.loc[i_bus, 'RDF_ID'],  # 'RELATED_CUSTOMER_RDFID',
                                district_id,  # 'DISTRICT_ID',
                                district_name,  # 'DISTRICT_NAME',
                                district_rdfid,  # 'DISTRICT_RDFID',
                                distransformer_id,  # 'DISTRANSFORMER_ID',
                                distransformer_name,  # 'DISTRANSFORMER_NAME',
                                distransformer_rdfid,  # 'DISTRANSFORMER_RDFID',
                                feeder_id,  # 'FEEDER_ID',
                                feeder_name,  # 'FEEDER_NAME',
                                feeder_rdfid,  # 'FEEDER_RDFID',
                                substation_id,  # 'SUBSTATION_ID',
                                substation_name,  # 'SUBSTATION_NAME',
                                substation_rdfid,  # 'SUBSTATION_RDFID',
                                company_id,  # 'COMPANY_ID',
                                company_name,  # 'COMPANY_NAME',
                                company_rdfid,  # 'COMPANY_RDFID',
                                bus_df.loc[i_bus, 'METER_TYPE'],  # 'METER_TYPE',
                                (branch_if_results.at[i_br, 0] + branch_if_results.at[i_br, 1] + branch_if_results.at[i_br, 2])
                                * cons_para.current_factor,  # 'METER_CURRENT_TOTAL',
                                branch_if_results.at[i_br, 0] * cons_para.current_factor,  # 'METER_CURRENT_A',
                                branch_if_results.at[i_br, 1] * cons_para.current_factor,  # 'METER_CURRENT_B',
                                branch_if_results.at[i_br, 2] * cons_para.current_factor,  # 'METER_CURRENT_C',
                                bus_vol_results.iloc[i_bus, :].mean() / math.sqrt(3) / cons_para.voltage_output_factor,  # 'METER_VOLTAGE_TOTAL',
                                bus_vol_results.at[i_bus, 0] / math.sqrt(3) / cons_para.voltage_output_factor,  # 'METER_VOLTAGE_A',
                                bus_vol_results.at[i_bus, 1] / math.sqrt(3) / cons_para.voltage_output_factor,  # 'METER_VOLTAGE_B',
                                bus_vol_results.at[i_bus, 2] / math.sqrt(3) / cons_para.voltage_output_factor,  # 'METER_VOLTAGE_C',
                                ((-(branch_pt_results.at[i_br, 0]) + temp_p_a) + (-(branch_pt_results.at[i_br, 1]) + temp_p_b) + (-(branch_pt_results.at[i_br, 2]) + temp_p_c))
                                / cons_para.power_factor
                                * cons_para.time_resolution_factor,  # 'METER_ACTI_POWER_TOTAL',
                                (-(branch_pt_results.at[i_br, 0]) + temp_p_a) / cons_para.power_factor * cons_para.time_resolution_factor,  # 'METER_ACTI_POWER_A',
                                (-(branch_pt_results.at[i_br, 1]) + temp_p_b) / cons_para.power_factor * cons_para.time_resolution_factor,  # 'METER_ACTI_POWER_B',
                                (-(branch_pt_results.at[i_br, 2]) + temp_p_c) / cons_para.power_factor * cons_para.time_resolution_factor,  # 'METER_ACTI_POWER_C',
                                ((-(branch_qt_results.at[i_br, 0]) + temp_q_a) + (-(branch_qt_results.at[i_br, 1]) + temp_q_b) + (-(branch_qt_results.at[i_br, 2]) + temp_q_c))
                                / cons_para.power_factor
                                * cons_para.time_resolution_factor,  # 'METER_REAC_POWER_TOTAL',
                                (-(branch_qt_results.at[i_br, 0]) + temp_q_a) / cons_para.power_factor * cons_para.time_resolution_factor,  # 'METER_REAC_POWER_A',
                                (-(branch_qt_results.at[i_br, 1]) + temp_q_b) / cons_para.power_factor * cons_para.time_resolution_factor,  # 'METER_REAC_POWER_B',
                                (-(branch_qt_results.at[i_br, 2]) + temp_q_c) / cons_para.power_factor * cons_para.time_resolution_factor,  # 'METER_REAC_POWER_C',
                                loss_pq,  # 'METER_ACTI_LOSS_TOTAL',
                                loss_pq / 3,  # 'METER_ACTI_LOSS_A',
                                loss_pq / 3,  # 'METER_ACTI_LOSS_B',
                                loss_pq / 3,  # 'METER_ACTI_LOSS_C',
                                0,  # 'METER_REAC_LOSS_TOTAL',
                                0,  # 'METER_REAC_LOSS_A',
                                0,  # 'METER_REAC_LOSS_B',
                                0,  # 'METER_REAC_LOSS_C',
                                division_0(
                                    loss_pq,
                                    ((-(branch_pt_results.at[i_br, 0]) + temp_p_a) + (-(branch_pt_results.at[i_br, 1]) + temp_p_b) + (-(branch_pt_results.at[i_br, 2]) + temp_p_c))
                                    / cons_para.power_factor
                                    * cons_para.time_resolution_factor,
                                )
                                * 100,  # 'METER_ACTI_LOSSRATE',
                                0,  # 'METER_LOSS_OF_TOTAL',
                                0,  # 'PROVINCIAL_ID',
                                0,  # 'CITY_ID',
                                0,  # 'COUNTY_ID',
                                datatime,  # 'DATA_TIME',
                                time_index,  # 'TIME_INDEX',
                                calc_time,  # 'CALC_TIME',
                                'ROBUST_STATE_ESTIMATION_METHOD',  # 'CALC_METHOD',
                            ]

                        elif bus_df.loc[i_bus, 'IS_GF'] == '1':
                            if branch_pt_results.iloc[i_br, :].sum() > 0:  # 作为负荷的话pt应该为负，所以pt<、=0都是反向电量，pt>才是分布式电源的正向电量
                                positive_acti_power_total = (
                                    abs(((branch_pt_results.at[i_br, 0]) - temp_p_a) + ((branch_pt_results.at[i_br, 1]) - temp_p_b) + ((branch_pt_results.at[i_br, 2]) - temp_p_c))
                                    / cons_para.power_factor
                                    * cons_para.time_resolution_factor
                                )
                                positive_acti_power_a = abs((branch_pt_results.at[i_br, 0]) - temp_p_a) / cons_para.power_factor * cons_para.time_resolution_factor
                                positive_acti_power_b = abs((branch_pt_results.at[i_br, 1]) - temp_p_b) / cons_para.power_factor * cons_para.time_resolution_factor
                                positive_acti_power_c = abs((branch_pt_results.at[i_br, 2]) - temp_p_c) / cons_para.power_factor * cons_para.time_resolution_factor
                                positive_reac_power_total = (
                                    abs(((branch_qt_results.at[i_br, 0]) - temp_q_a) + ((branch_qt_results.at[i_br, 1]) - temp_q_b) + ((branch_qt_results.at[i_br, 2]) - temp_q_c))
                                    / cons_para.power_factor
                                    * cons_para.time_resolution_factor
                                )
                                positive_reac_power_a = abs((branch_qt_results.at[i_br, 0]) - temp_q_a) / cons_para.power_factor * cons_para.time_resolution_factor
                                positive_reac_power_b = abs((branch_qt_results.at[i_br, 1]) - temp_q_b) / cons_para.power_factor * cons_para.time_resolution_factor
                                positive_reac_power_c = abs((branch_qt_results.at[i_br, 2]) - temp_q_c) / cons_para.power_factor * cons_para.time_resolution_factor
                                reverse_acti_power_total = 0
                                reverse_acti_power_a = 0
                                reverse_acti_power_b = 0
                                reverse_acti_power_c = 0
                                reverse_reac_power_total = 0
                                reverse_reac_power_a = 0
                                reverse_reac_power_b = 0
                                reverse_reac_power_c = 0
                            else:
                                positive_acti_power_total = 0
                                positive_acti_power_a = 0
                                positive_acti_power_b = 0
                                positive_acti_power_c = 0
                                positive_reac_power_total = 0
                                positive_reac_power_a = 0
                                positive_reac_power_b = 0
                                positive_reac_power_c = 0
                                reverse_acti_power_total = (
                                    abs(
                                        (-(branch_pt_results.at[i_br, 0]) + temp_p_a)
                                        + (-(branch_pt_results.at[i_br, 1]) + temp_p_b)
                                        + (-(branch_pt_results.at[i_br, 2]) + temp_p_c)
                                    )
                                    / cons_para.power_factor
                                    * cons_para.time_resolution_factor
                                )
                                reverse_acti_power_a = abs(-(branch_pt_results.at[i_br, 0]) + temp_p_a) / cons_para.power_factor * cons_para.time_resolution_factor
                                reverse_acti_power_b = abs(-(branch_pt_results.at[i_br, 1]) + temp_p_b) / cons_para.power_factor * cons_para.time_resolution_factor
                                reverse_acti_power_c = abs(-(branch_pt_results.at[i_br, 2]) + temp_p_c) / cons_para.power_factor * cons_para.time_resolution_factor
                                reverse_reac_power_total = (
                                    abs(
                                        (-(branch_qt_results.at[i_br, 0]) + temp_q_a)
                                        + (-(branch_qt_results.at[i_br, 1]) + temp_q_b)
                                        + (-(branch_qt_results.at[i_br, 2]) + temp_q_c)
                                    )
                                    / cons_para.power_factor
                                    * cons_para.time_resolution_factor
                                )
                                reverse_reac_power_a = abs(-(branch_qt_results.at[i_br, 0]) + temp_q_a) / cons_para.power_factor * cons_para.time_resolution_factor
                                reverse_reac_power_b = abs(-(branch_qt_results.at[i_br, 1]) + temp_q_b) / cons_para.power_factor * cons_para.time_resolution_factor
                                reverse_reac_power_c = abs(-(branch_qt_results.at[i_br, 2]) + temp_q_c) / cons_para.power_factor * cons_para.time_resolution_factor

                            self.taiqu_loss_dg_result.loc[
                                len(self.taiqu_loss_dg_result),
                                [
                                    'DISGEN_ID',
                                    'DISGEN_NAME',
                                    'DISGEN_RDFID',
                                    'DISTRICT_ID',
                                    'DISTRICT_NAME',
                                    'DISTRICT_RDFID',
                                    'DISTRANSFORMER_ID',
                                    'DISTRANSFORMER_NAME',
                                    'DISTRANSFORMER_RDFID',
                                    'FEEDER_ID',
                                    'FEEDER_NAME',
                                    'FEEDER_RDFID',
                                    'SUBSTATION_ID',
                                    'SUBSTATION_NAME',
                                    'SUBSTATION_RDFID',
                                    'COMPANY_ID',
                                    'COMPANY_NAME',
                                    'COMPANY_RDFID',
                                    'RELATED_CUSTOMER_ID',
                                    'RELATED_CUSTOMER_NAME',
                                    'RELATED_CUSTOMER_RDFID',
                                    'DISGEN_CURRENT_TOTAL',
                                    'DISGEN_CURRENT_A',
                                    'DISGEN_CURRENT_B',
                                    'DISGEN_CURRENT_C',
                                    'DISGEN_VOLTAGE_TOTAL',
                                    'DISGEN_VOLTAGE_A',
                                    'DISGEN_VOLTAGE_B',
                                    'DISGEN_VOLTAGE_C',
                                    'DISGEN_POSITIVE_ACTI_POWER_TOTAL',
                                    'DISGEN_POSITIVE_ACTI_POWER_A',
                                    'DISGEN_POSITIVE_ACTI_POWER_B',
                                    'DISGEN_POSITIVE_ACTI_POWER_C',
                                    'DISGEN_POSITIVE_REAC_POWER_TOTAL',
                                    'DISGEN_POSITIVE_REAC_POWER_A',
                                    'DISGEN_POSITIVE_REAC_POWER_B',
                                    'DISGEN_POSITIVE_REAC_POWER_C',
                                    'DISGEN_REVERSE_ACTI_POWER_TOTAL',
                                    'DISGEN_REVERSE_ACTI_POWER_A',
                                    'DISGEN_REVERSE_ACTI_POWER_B',
                                    'DISGEN_REVERSE_ACTI_POWER_C',
                                    'DISGEN_REVERSE_REAC_POWER_TOTAL',
                                    'DISGEN_REVERSE_REAC_POWER_A',
                                    'DISGEN_REVERSE_REAC_POWER_B',
                                    'DISGEN_REVERSE_REAC_POWER_C',
                                    'PROVINCIAL_ID',
                                    'CITY_ID',
                                    'COUNTY_ID',
                                    'DATA_TIME',
                                    'TIME_INDEX',
                                    'CALC_TIME',
                                    'CALC_METHOD',
                                ],
                            ] = [
                                bus_df.loc[i_bus, 'METER_ID'],  # 'DISGEN_ID',
                                bus_df.loc[i_bus, 'NAME'],  # 'DISGEN_NAME',
                                bus_df.loc[i_bus, 'METER_ID'],  # 'DISGEN_RDFID',
                                district_id,  # 'DISTRICT_ID',
                                district_name,  # 'DISTRICT_NAME',
                                district_rdfid,  # 'DISTRICT_RDFID',
                                distransformer_id,  # 'DISTRANSFORMER_ID',
                                distransformer_name,  # 'DISTRANSFORMER_NAME',
                                distransformer_rdfid,  # 'DISTRANSFORMER_RDFID',
                                feeder_id,  # 'FEEDER_ID',
                                feeder_name,  # 'FEEDER_NAME',
                                feeder_rdfid,  # 'FEEDER_RDFID',
                                substation_id,  # 'SUBSTATION_ID',
                                substation_name,  # 'SUBSTATION_NAME',
                                substation_rdfid,  # 'SUBSTATION_RDFID',
                                company_id,  # 'COMPANY_ID',
                                company_name,  # 'COMPANY_NAME',
                                company_rdfid,  # 'COMPANY_RDFID',
                                bus_df.loc[i_bus, 'METER_ID'],  # 'RELATED_CUSTOMER_ID',
                                bus_df.loc[i_bus, 'NAME'],  # 'RELATED_CUSTOMER_NAME',
                                bus_df.loc[i_bus, 'RDF_ID'],  # 'RELATED_CUSTOMER_RDFID',
                                (branch_it_results.at[i_br, 0] + branch_it_results.at[i_br, 1] + branch_it_results.at[i_br, 2])
                                * cons_para.current_factor,  # 'DISGEN_CURRENT_TOTAL',
                                branch_it_results.at[i_br, 0] * cons_para.current_factor,  # 'DISGEN_CURRENT_A',
                                branch_it_results.at[i_br, 1] * cons_para.current_factor,  # 'DISGEN_CURRENT_B',
                                branch_it_results.at[i_br, 2] * cons_para.current_factor,  # 'DISGEN_CURRENT_C',
                                bus_vol_results.iloc[i_bus, :].mean() / math.sqrt(3) / cons_para.voltage_output_factor,  # 'DISGEN_VOLTAGE_TOTAL',
                                bus_vol_results.at[i_bus, 0] / math.sqrt(3) / cons_para.voltage_output_factor,  # 'DISGEN_VOLTAGE_A',
                                bus_vol_results.at[i_bus, 1] / math.sqrt(3) / cons_para.voltage_output_factor,  # 'DISGEN_VOLTAGE_B',
                                bus_vol_results.at[i_bus, 2] / math.sqrt(3) / cons_para.voltage_output_factor,  # 'DISGEN_VOLTAGE_C',
                                positive_acti_power_total,  # 'DISGEN_POSITIVE_ACTI_POWER_TOTAL',
                                positive_acti_power_a,  # 'DISGEN_POSITIVE_ACTI_POWER_A',
                                positive_acti_power_b,  # 'DISGEN_POSITIVE_ACTI_POWER_B',
                                positive_acti_power_c,  # 'DISGEN_POSITIVE_ACTI_POWER_C',
                                positive_reac_power_total,  # 'DISGEN_POSITIVE_REAC_POWER_TOTAL',
                                positive_reac_power_a,  # 'DISGEN_POSITIVE_REAC_POWER_A',
                                positive_reac_power_b,  # 'DISGEN_POSITIVE_REAC_POWER_B',
                                positive_reac_power_c,  # 'DISGEN_POSITIVE_REAC_POWER_C',
                                reverse_acti_power_total,  # 'DISGEN_REVERSE_ACTI_POWER_TOTAL',
                                reverse_acti_power_a,  # 'DISGEN_REVERSE_ACTI_POWER_A',
                                reverse_acti_power_b,  # 'DISGEN_REVERSE_ACTI_POWER_B',
                                reverse_acti_power_c,  # 'DISGEN_REVERSE_ACTI_POWER_C',
                                reverse_reac_power_total,  # 'DISGEN_REVERSE_REAC_POWER_TOTAL',
                                reverse_reac_power_a,  # 'DISGEN_REVERSE_REAC_POWER_A',
                                reverse_reac_power_b,  # 'DISGEN_REVERSE_REAC_POWER_B',
                                reverse_reac_power_c,  # 'DISGEN_REVERSE_REAC_POWER_C',
                                0,  # 'PROVINCIAL_ID',
                                0,  # 'CITY_ID',
                                0,  # 'COUNTY_ID',
                                datatime,  # 'DATA_TIME',
                                time_index,  # 'TIME_INDEX',
                                calc_time,  # 'CALC_TIME',
                                'ROBUST_STATE_ESTIMATION_METHOD',  # 'CALC_METHOD',
                            ]

        self.taiqu_loss_lnseg_result = self.taiqu_loss_lnseg_result.reset_index(drop=True)
        self.taiqu_loss_customer_result = self.taiqu_loss_customer_result.reset_index(drop=True)
        electricity_output_and_input = electricity_output_and_input.reset_index(drop=True)

        # 计算表计损耗
        for key, value in feeder_model['load'].items():
            if 'METER_TYPE' in value:
                if int(value['METER_TYPE']) == 3:  # 区分单相电表、三相电表
                    threephase_count += 1
                else:
                    singlephase_count += 1
            else:
                if str(value['PHA']) == '0':
                    singlephase_count += 1
                else:
                    threephase_count += 1

        singlephase_meter_loss = singlephase_count * cons_para.loss_meter_1ph * cons_para.time_resolution_factor
        threephase_meter_loss = threephase_count * cons_para.loss_meter_3ph * cons_para.time_resolution_factor
        sum_meter_loss_p = singlephase_meter_loss + threephase_meter_loss

        # 台区输入电量 = 台区正向电量 + 小电源正向电量 + 用户反向电量
        PA, PB, PC, QA, QB, QC = bus_df[['PA_PRE', 'PB_PRE', 'PC_PRE', 'QA_PRE', 'QB_PRE', 'QC_PRE']].to_numpy().T
        sum_P_DG = np.sum(np.where((PA + PB + PC) < 0, PA + PB + PC, 0)) * cons_para.time_resolution_factor  # 获取小电源正向电量 和 用户反向电量
        sum_Q_DG = np.sum(np.where((QA + QB + QC) < 0, QA + QB + QC, 0)) * cons_para.time_resolution_factor
        sum_P_load = np.sum(np.where((PA + PB + PC) >= 0, PA + PB + PC, 0)) * cons_para.time_resolution_factor  # 获取小电源反向电量 和 用户正向电量（售电量）
        sum_Q_load = np.sum(np.where((QA + QB + QC) >= 0, QA + QB + QC, 0)) * cons_para.time_resolution_factor

        if branch_pq_se.at[0, 'P_SUM'] > 0:
            sum_PG = branch_pq_se.at[0, 'P_SUM'] / cons_para.power_factor * cons_para.time_resolution_factor - sum_P_DG + sum_meter_loss_p  # 馈线有功注入
            sum_QG = branch_pq_se.at[0, 'Q_SUM'] / cons_para.power_factor * cons_para.time_resolution_factor - sum_Q_DG  # 馈线无功注入
            sum_outpower_P = 0
            sum_outpower_Q = 0
        else:
            print('该台区潮流功率向中压以上倒送!')
            sum_PG = (-1) * sum_P_DG  # 输出电量，馈线的反向电量
            sum_QG = (-1) * sum_Q_DG
            sum_outpower_P = (-1) * branch_pq_se.at[0, 'P_SUM'] / cons_para.power_factor * cons_para.time_resolution_factor
            sum_outpower_Q = (-1) * branch_pq_se.at[0, 'Q_SUM'] / cons_para.power_factor * cons_para.time_resolution_factor

        ###后续待删
        # for i in range(len(lineloss)):
        #     sum_line_loss_p = sum_line_loss_p + np.abs(lineloss.at[i, 'P_LOSS'])
        #     sum_line_loss_q = sum_line_loss_q + np.abs(lineloss.at[i, 'Q_LOSS'])

        for i in range(len(self.taiqu_loss_lnseg_result)):
            sum_line_loss_p = sum_line_loss_p + np.abs(self.taiqu_loss_lnseg_result.at[i, 'LNSEG_ACTI_LOSS_TOTAL'])
            sum_line_loss_q = sum_line_loss_q + np.abs(self.taiqu_loss_lnseg_result.at[i, 'LNSEG_REAC_LOSS_TOTAL'])

        sum_loss1 = sum_line_loss_p + sum_meter_loss_p  # 通过计算每段线损得到的线损+铁损
        sum_loss2 = sum_PG - sum_P_load - sum_outpower_P  # 通过计算首端减去所有负荷得到的线损+铁损

        if sum_loss1 < sum_loss2:
            delta_loss_p = sum_loss2 - sum_loss1

            ###后续待删
            # # 由于线段损耗更新，在此更新lineloss
            # for i in range(len(lineloss)):
            #     lineloss.at[i, 'P_LOSS'] = division_0(lineloss.at[i, 'P_LOSS'] + np.abs(lineloss.at[i, 'P_LOSS']), sum_line_loss_p) * delta_loss_p

            # # 由于线段损耗更新，在此更新lineloss_zh
            # for i in range(len(lineloss_zh)):
            #     lineloss_zh.at[i, 'loss_pq'] = division_0(lineloss_zh.at[i, 'loss_pq'] + np.abs(lineloss_zh.at[i, 'loss_pq']), sum_line_loss_p) * delta_loss_p
            #     lineloss_zh.at[i, 'losspq_a'] = lineloss_zh.at[i, 'loss_pq'] / 3
            #     lineloss_zh.at[i, 'losspq_b'] = lineloss_zh.at[i, 'loss_pq'] / 3
            #     lineloss_zh.at[i, 'losspq_c'] = lineloss_zh.at[i, 'loss_pq'] / 3
            #     lineloss_zh.at[i, 'loss_rate'] = division_0(lineloss_zh.at[i, 'loss_pq'], lineloss_zh.at[i, 'pq_p_a']) * 100

            # 由于线段损耗更新，在此更新self.taiqu_loss_lnseg_result
            for i in range(len(self.taiqu_loss_lnseg_result)):
                self.taiqu_loss_lnseg_result.at[i, 'LNSEG_ACTI_LOSS_TOTAL'] = (
                    self.taiqu_loss_lnseg_result.at[i, 'LNSEG_ACTI_LOSS_TOTAL']
                    + division_0(
                        np.abs(self.taiqu_loss_lnseg_result.at[i, 'LNSEG_ACTI_LOSS_TOTAL']),
                        sum_line_loss_p,
                    )
                    * delta_loss_p
                )
                self.taiqu_loss_lnseg_result.at[i, 'LNSEG_ACTI_LOSS_A'] = self.taiqu_loss_lnseg_result.at[i, 'LNSEG_ACTI_LOSS_TOTAL'] / 3
                self.taiqu_loss_lnseg_result.at[i, 'LNSEG_ACTI_LOSS_B'] = self.taiqu_loss_lnseg_result.at[i, 'LNSEG_ACTI_LOSS_TOTAL'] / 3
                self.taiqu_loss_lnseg_result.at[i, 'LNSEG_ACTI_LOSS_C'] = self.taiqu_loss_lnseg_result.at[i, 'LNSEG_ACTI_LOSS_TOTAL'] / 3
                self.taiqu_loss_lnseg_result.at[i, 'LNSEG_ACTI_LOSSRATE'] = (
                    division_0(
                        self.taiqu_loss_lnseg_result.at[i, 'LNSEG_ACTI_LOSS_TOTAL'],
                        self.taiqu_loss_lnseg_result.at[i, 'LNSEG_HEAD_ACTI_POWER_TOTAL'],
                    )
                    * 100
                )

        ###后续待删
        # for i in range(len(customerloss_zh)):
        #     total_customer_loss = total_customer_loss + np.abs(customerloss_zh.at[i, 'loss_pq'])
        # for i in range(len(customerloss_zh)):
        #     customerloss_zh.at[i, 'loss_percent'] = round(customerloss_zh.at[i, 'loss_pq'] / total_customer_loss * 100, 2)

        sum_meter_loss = 0
        sum_line_loss_p = 0
        sum_line_loss_q = 0

        for i in range(len(self.taiqu_loss_customer_result)):
            sum_meter_loss = sum_meter_loss + np.abs(self.taiqu_loss_customer_result.at[i, 'METER_ACTI_LOSS_TOTAL'])
        for i in range(len(self.taiqu_loss_customer_result)):
            self.taiqu_loss_customer_result.at[i, 'METER_LOSS_OF_TOTAL'] = round(
                self.taiqu_loss_customer_result.at[i, 'METER_ACTI_LOSS_TOTAL'] / sum_meter_loss * 100,
                2,
            )

        ###后续待删
        # for i in range(len(lineloss_zh)):
        #     total_lnsegment_loss = total_lnsegment_loss + np.abs(lineloss_zh.at[i, 'loss_pq'])
        # for i in range(len(lineloss_zh)):
        #     lineloss_zh.at[i, 'loss_percent'] = round(division_0(lineloss_zh.at[i, 'loss_pq'], total_lnsegment_loss) * 100, 2)

        for i in range(len(self.taiqu_loss_lnseg_result)):
            sum_line_loss_p = sum_line_loss_p + np.abs(self.taiqu_loss_lnseg_result.at[i, 'LNSEG_ACTI_LOSS_TOTAL'])
            sum_line_loss_q = sum_line_loss_q + np.abs(self.taiqu_loss_lnseg_result.at[i, 'LNSEG_REAC_LOSS_TOTAL'])
        for i in range(len(self.taiqu_loss_lnseg_result)):
            self.taiqu_loss_lnseg_result.at[i, 'LNSEG_LOSS_OF_TOTAL'] = round(
                division_0(
                    self.taiqu_loss_lnseg_result.at[i, 'LNSEG_ACTI_LOSS_TOTAL'],
                    sum_line_loss_p,
                )
                * 100,
                2,
            )

        ###后续待删
        # for i in range(len(lineloss)):
        #     sum_line_loss_p = sum_line_loss_p + np.abs(lineloss.at[i, 'P_LOSS'])
        #     sum_line_loss_q = sum_line_loss_q + np.abs(lineloss.at[i, 'Q_LOSS'])

        sum_loss1 = sum_line_loss_p + sum_meter_loss_p  # 通过计算每段线损得到的线损+铁损
        # sum_loss2 = sum_PG - sum_P_load - sum_outpower_P  # 通过计算首端减去所有负荷得到的线损+铁损
        sum_lossrate1 = sum_loss1 / sum_PG * 100  # 通过计算每段线损得到的线损率

        if branch_pq_se.at[0, 'P_SUM'] >= 0:
            theo_power_supply = sum_loss1 + sum_P_load
        else:
            theo_power_supply = (-1) * sum_P_DG

        self.feederloss.loc[
            0,
            [
                'IDX',
                'FEEDER_ID',
                'FEEDER_NAME',
                'LOSS_RATE',
                'P_LOSS',
                'Q_LOSS',
                'PG',
                'QG',
            ],
        ] = [
            time_index,
            branch_df.loc[0, 'FEEDER_ID'],
            feeder_name,
            sum_lossrate1,
            sum_loss1,
            sum_QG - np.sum(sym_load['q_specified']) / cons_para.power_factor * cons_para.time_resolution_factor,
            sum_PG,
            sum_QG,
        ]
        self.taiqu_loss_district_result.loc[
            len(self.taiqu_loss_district_result),
            [
                # 区域基本信息
                'DISTRICT_ID',
                'DISTRICT_NAME',
                'DISTRICT_RDFID',
                # 变压器信息
                'DISTRANSFORMER_ID',
                'DISTRANSFORMER_NAME',
                'DISTRANSFORMER_RDFID',
                # 馈线信息
                'FEEDER_ID',
                'FEEDER_NAME',
                'FEEDER_RDFID',
                # 变电站信息
                'SUBSTATION_ID',
                'SUBSTATION_NAME',
                'SUBSTATION_RDFID',
                # 供电公司信息
                'COMPANY_ID',
                'COMPANY_NAME',
                'COMPANY_RDFID',
                # 电气量测数据
                'DISTRICT_CURRENT_TOTAL',
                'DISTRICT_CURRENT_A',
                'DISTRICT_CURRENT_B',
                'DISTRICT_CURRENT_C',
                'DISTRICT_VOLTAGE_TOTAL',
                'DISTRICT_VOLTAGE_A',
                'DISTRICT_VOLTAGE_B',
                'DISTRICT_VOLTAGE_C',
                'ACTI_POWER_TOTAL',
                'ACTI_POWER_A',
                'ACTI_POWER_B',
                'ACTI_POWER_C',
                'REAC_POWER_TOTAL',
                'REAC_POWER_A',
                'REAC_POWER_B',
                'REAC_POWER_C',
                'DISTRICT_POWER_FACTOR',
                'OUTPUT_ACTI_POWER',
                'OUTPUT_REAC_POWER',
                'DISGEN_NUMB',
                'DISGEN_ACTI_POWER',
                'DISGEN_REAC_POWER',
                # 损耗数据
                'DISTRICT_LNSEG_LENGTH',
                'LNSEG_ACTI_LOSS_TOTAL',
                'LNSEG_ACTI_LOSS_A',
                'LNSEG_ACTI_LOSS_B',
                'LNSEG_ACTI_LOSS_C',
                'LNSEG_REAC_LOSS_TOTAL',
                'LNSEG_REAC_LOSS_A',
                'LNSEG_REAC_LOSS_B',
                'LNSEG_REAC_LOSS_C',
                'LNSEG_ACTI_LOSSRATE',
                'LNSEG_REAC_LOSSRATE',
                'THREE_PHASE_METER_NUMB',
                'SINGLE_PHASE_METER_NUMB',
                'METER_NUMB',
                'CUSTOMER_NUMB',
                'METER_ACTI_LOSS_TOTAL',
                'METER_ACTI_LOSS_A',
                'METER_ACTI_LOSS_B',
                'METER_ACTI_LOSS_C',
                'METER_REAC_LOSS_TOTAL',
                'METER_REAC_LOSS_A',
                'METER_REAC_LOSS_B',
                'METER_REAC_LOSS_C',
                'METER_ACTI_LOSSRATE',
                'METER_REAC_LOSSRATE',
                'DISTRICT_ACTI_LOSS',
                'DISTRICT_REAC_LOSS',
                'DISTRICT_ACTI_LOSSRATE',
                'DISTRICT_REAC_LOSSRATE',
                'DISTRICT_ELEC_SALES',
                'THEO_POWER_SUPPLY',
                'DISTRICT_THEO_LOSSRATE',
                # 行政区域信息
                'PROVINCIAL_ID',
                'CITY_ID',
                'COUNTY_ID',
                # 时间信息
                'DATA_TIME',
                'TIME_INDEX',
                'CALC_TIME',
                # 计算方法
                'CALC_METHOD',
            ],
        ] = [
            # # 区域基本信息
            district_id,  # 'DISTRICT_ID',
            district_name,  # 'DISTRICT_NAME',
            district_rdfid,  # 'DISTRICT_RDFID',
            # # 变压器信息
            distransformer_id,  # 'DISTRANSFORMER_ID',
            distransformer_name,  # 'DISTRANSFORMER_NAME',
            distransformer_rdfid,  # 'DISTRANSFORMER_RDFID',
            # # 馈线信息
            feeder_id,  # 'FEEDER_ID',
            feeder_name,  # 'FEEDER_NAME',
            feeder_rdfid,  # 'FEEDER_RDFID',
            # # 变电站信息
            substation_id,  # 'SUBSTATION_ID',
            substation_name,  # 'SUBSTATION_NAME',
            substation_rdfid,  # 'SUBSTATION_RDFID',
            # # 供电公司信息
            company_id,  # 'COMPANY_ID',
            company_name,  # 'COMPANY_NAME',
            company_rdfid,  # 'COMPANY_RDFID',
            # # 电气量测数据
            branch_if_results.iloc[0, :].sum() * cons_para.current_factor,  # 'DISTRICT_CURRENT_TOTAL',
            branch_if_results.at[0, 0] * cons_para.current_factor,  # 'DISTRICT_CURRENT_A',
            branch_if_results.at[0, 1] * cons_para.current_factor,  # 'DISTRICT_CURRENT_B',
            branch_if_results.at[0, 2] * cons_para.current_factor,  # 'DISTRICT_CURRENT_C',
            bus_vol_results.iloc[0, :].mean() / math.sqrt(3) / cons_para.voltage_output_factor,  # 'DISTRICT_VOLTAGE_TOTAL',
            bus_vol_results.at[0, 0] / math.sqrt(3) / cons_para.voltage_output_factor,  # 'DISTRICT_VOLTAGE_A',
            bus_vol_results.at[0, 1] / math.sqrt(3) / cons_para.voltage_output_factor,  # 'DISTRICT_VOLTAGE_B',
            bus_vol_results.at[0, 2] / math.sqrt(3) / cons_para.voltage_output_factor,  # 'DISTRICT_VOLTAGE_C',
            sum_PG,  # 'ACTI_POWER_TOTAL',
            sum_PG / 3,  # 'ACTI_POWER_A',
            sum_PG / 3,  # 'ACTI_POWER_B',
            sum_PG / 3,  # 'ACTI_POWER_C',
            sum_QG,  # 'REAC_POWER_TOTAL',
            sum_QG / 3,  # 'REAC_POWER_A',
            sum_QG / 3,  # 'REAC_POWER_B',
            sum_QG / 3,  # 'REAC_POWER_C',
            division_0(sum_PG, math.sqrt(sum_PG**2 + sum_QG**2)),  # 'DISTRICT_POWER_FACTOR',
            sum_outpower_P,  # 'OUTPUT_ACTI_POWER',
            sum_outpower_Q,  # 'OUTPUT_REAC_POWER',
            0,  # 'DISGEN_NUMB',
            0,  # 'DISGEN_ACTI_POWER',
            0,  # 'DISGEN_REAC_POWER',
            # # 损耗数据
            sum_line_length,  # 'DISTRICT_LNSEG_LENGTH',
            sum_line_loss_p,  # 'LNSEG_ACTI_LOSS_TOTAL',
            sum_line_loss_p / 3,  # 'LNSEG_ACTI_LOSS_A',
            sum_line_loss_p / 3,  # 'LNSEG_ACTI_LOSS_B',
            sum_line_loss_p / 3,  # 'LNSEG_ACTI_LOSS_C',
            sum_line_loss_q,  # 'LNSEG_REAC_LOSS_TOTAL',
            sum_line_loss_q / 3,  # 'LNSEG_REAC_LOSS_A',
            sum_line_loss_q / 3,  # 'LNSEG_REAC_LOSS_B',
            sum_line_loss_q / 3,  # 'LNSEG_REAC_LOSS_C',
            division_0(sum_line_loss_p, sum_PG),  # 'LNSEG_ACTI_LOSSRATE',
            division_0(sum_line_loss_q, sum_QG),  # 'LNSEG_REAC_LOSSRATE',
            threephase_count,  # 'THREE_PHASE_METER_NUMB',
            singlephase_count,  # 'SINGLE_PHASE_METER_NUMB',
            threephase_count + threephase_count,  # 'METER_NUMB',
            0,  # 'CUSTOMER_NUMB',
            sum_meter_loss_p,  # 'METER_ACTI_LOSS_TOTAL',
            0,  # 'METER_ACTI_LOSS_A',
            0,  # 'METER_ACTI_LOSS_B',
            0,  # 'METER_ACTI_LOSS_C',
            0,  # 'METER_REAC_LOSS_TOTAL',
            0,  # 'METER_REAC_LOSS_A',
            0,  # 'METER_REAC_LOSS_B',
            0,  # 'METER_REAC_LOSS_C',
            division_0(sum_meter_loss_p, sum_PG),  # 'METER_ACTI_LOSSRATE',
            0,  # 'METER_REAC_LOSSRATE',
            sum_loss1,  # 'DISTRICT_ACTI_LOSS',
            sum_QG - sum_Q_load,  # 'DISTRICT_REAC_LOSS',
            division_0(sum_loss1, sum_loss1 + sum_P_load) * 100,  # 'DISTRICT_ACTI_LOSSRATE',
            0,  # 'DISTRICT_REAC_LOSSRATE',
            sum_P_load,  # 'DISTRICT_ELEC_SALES',
            theo_power_supply,  # 'THEO_POWER_SUPPLY',
            division_0(sum_loss1, theo_power_supply) * 100,  # 'DISTRICT_THEO_LOSSRATE',
            # # 行政区域信息
            0,  # 'PROVINCIAL_ID',
            0,  # 'CITY_ID',
            0,  # 'COUNTY_ID',
            # # 时间信息
            datatime,  # 'DATA_TIME',
            time_index,  # 'TIME_INDEX',
            calc_time,  # 'CALC_TIME',
            # # 计算方法
            'ROBUST_STATE_ESTIMATION_METHOD',  # 'CALC_METHOD',
        ]

        logger.info(f'理论线损率：{round(sum_lossrate1, 6)}%')
        # logger.info("通过计算首端减去所有负荷得到的线损率：", round(sum_lossrate2, 6))

        logger.info(f'理论总线损：{round(sum_loss1, 6)}kW')
        # logger.info("通过计算首端减去所有负荷得到的总线损：", round(sum_loss2, 6))

        logger.info(f'台区总供入有功: {round(sum_PG, 6)}kW')
        logger.info(f'台区总有功负荷：{round(sum_P_load, 6)}kW')

        ################################################---线损统计结束---######################################################

        # columns_lowers = {col: col.lower() for col in dms_pas_se_badmeas.columns}
        # dms_pas_se_badmeas = dms_pas_se_badmeas.rename(columns=columns_lowers)
        #                 pd_df_to_odps(dms_pas_se_badmeas, f'tmp_dms_dms_pas_se_badmeas_{tmp_table_index}')
        logger.info(f'{feeder_model["FEEDER_NAME"]}台区成功计算')
        logger.info('*********************************************')
        self.feeder_statics.loc[
            0,
            [
                'IDX',
                'FEEDER_ID',
                'FEEDER_NAME',
                'RDF_ID',
                'LOSS_RATE',
                'CODE',
                'MESSAGE',
                'DATA_TIME',
            ],
        ] = [
            time_index,
            district_id,
            district_name,
            district_rdfid,
            sum_lossrate1,
            0,
            '成功计算',
            datatime,
        ]
        se_or_pf_result['tables'].update(
            {
                'sum_lossrate': sum_lossrate1,
                'feederloss': self.feederloss,
                'feeder_statics': self.feeder_statics,
                'taiqu_loss_lnseg_result': self.taiqu_loss_lnseg_result,
                'taiqu_loss_district_result': self.taiqu_loss_district_result,
                'taiqu_loss_customer_result': self.taiqu_loss_customer_result,
                'taiqu_loss_dg_result': self.taiqu_loss_dg_result,
                'electricity_output_and_input': electricity_output_and_input,
                'drop_linesegment': self.drop_linesegment,
                'customer_meterbox': self.customer_meterbox,
                'equipment_calclog': self.equipment_calclog,
                'power_error': power_error,
            }
        )
        return se_or_pf_result

    def calc_loss_result_static_ier(self, time_index, datatime, dms_tables):
        """配网改进等值电阻法结果统计"""
        se_or_pf_result = super().calc_result_static()
        branch_df = self.grid_model_builder.branch_df
        bus_df = self.grid_model_builder.bus_df

        feeder_model = self.grid_model_builder.feeder_model

        feederloss = self.feederloss
        feeder_name = feeder_model['FEEDER_NAME']
        feeder_rdfid = feeder_model['FEEDER_RDFID']
        feeder_id = feeder_model['FEEDER_ID']

        feeder_statics = self.feeder_statics

        node = self.grid_model_builder.node
        line = self.grid_model_builder.line

        trfm = dms_tables['dms_dms_def_trfm']
        unit = dms_tables['dms_dms_def_unit']
        source = dms_tables['dms_dms_def_source']
        trwd = dms_tables['dms_dms_def_trwd']
        # 使用 map 进行列名大写处理，性能上更快
        trfm.columns = trfm.columns.map(str.upper)
        unit.columns = unit.columns.map(str.upper)
        source.columns = source.columns.map(str.upper)
        trwd.columns = trwd.columns.map(str.upper)

        # 重置索引的操作可以在后续处理时考虑是否必须
        trfm = trfm.reset_index(drop=True)
        unit = unit.reset_index(drop=True)
        source = source.reset_index(drop=True)
        trwd = trwd.reset_index(drop=True)

        ids_to_drop = unit['ID']
        trfm = trfm[~trfm['ID'].isin(ids_to_drop)]

        UkV = 10
        node = pd.DataFrame(node)
        branch = pd.DataFrame(line)
        bus = pd.DataFrame(bus_df)
        tr = trwd

        nnode = len(node)
        ntr = len(tr)
        # nbus = len(bus)
        # nloss = len(trfm)
        nunit = len(unit)
        allS = [0] * nnode
        tr['ORI_ID'] = 0
        # 将 bus 中的 ORI_ID 和 ID 映射为字典
        bus_id_map = dict(zip(bus['ORI_ID'], bus['ID']))

        # 使用字典加速查找
        for i in range(ntr):
            node_id = tr.at[i, 'NODE_ID']
            if node_id in bus_id_map:
                tr.at[i, 'ORI_ID'] = bus_id_map[node_id]

        node['MVA'] = 0
        node['Ploss'] = 0
        node['TRFM_ID'] = 0
        node['P0'] = 0
        node['MVA'] = node['MVA'].astype('float64')
        node['P0'] = node['P0'].astype('float64')
        node['Ploss'] = node['Ploss'].astype('float64')

        # 为 trfm 创建通过 ID 查找的字典，先取需要的列再去重
        trfm_dedup = trfm[['ID', 'PK', 'P0']].drop_duplicates(subset=['ID'], keep='last')
        trfm_id_map = dict(zip(trfm_dedup['ID'], trfm_dedup[['PK', 'P0']].to_dict('records')))

        # 为 unit 创建通过 NODE_ID 查找的字典，先取需要的列再去重
        # 直接获取去重后的 NODE_ID 值
        unit_id_map = unit['NODE_ID'].drop_duplicates().values

        # Step 2: 更新 node 的 MVA 和 TRFM_ID
        for i in range(0, nnode):
            for j in range(0, ntr // 2):
                if node.at[i, 'id'] == tr.at[2 * j, 'ORI_ID']:
                    node.at[i, 'MVA'] = tr.at[2 * j, 'MVA']
                    node.at[i, 'TRFM_ID'] = tr.at[2 * j, 'TRFM_ID']

        # Step 3: 更新 node 的 Ploss 和 P0
        for i in range(nnode):
            trfm_id = node.at[i, 'TRFM_ID']
            if trfm_id in trfm_id_map and trfm_id_map[trfm_id]['PK'] != 'NaN':
                node.at[i, 'Ploss'] = trfm_id_map[trfm_id]['PK']
                node.at[i, 'P0'] = trfm_id_map[trfm_id]['P0']

        # Step 4: 更新小电源配变的损耗和容量
        for i in range(ntr):
            ori_id = tr.at[i, 'ORI_ID']
            unit_idx = ori_id - 1  # tr.at[i, 'ORI_ID'] 和 node.at[i, 'id'] 的对应关系
            if unit_idx in unit_id_map:
                node.at[unit_idx, 'MVA'] = 0
                node.at[unit_idx, 'Ploss'] = 0
                node.at[unit_idx, 'P0'] = 0
        ################################################求解方程组，得到小电源配变等效容量############################################
        node['MVA'] = node['MVA'].astype('float64')
        node['P0'] = node['P0'].astype('float64')
        node['Ploss'] = node['Ploss'].astype('float64')

        I0 = source.at[0, 'I_AVERAGE'] * 1.1
        unit_IkA = [0.0] * nunit
        for i in range(nunit):
            unit_IkA[i] = float(unit.at[i, 'E']) * 1.1 * 0.001 / (10 * 24 * (3**0.5))
        # print("unit_IkA:",unit_IkA)
        Ii = np.array(unit_IkA)
        S0 = node['MVA'].sum()
        # print("node['MVA']:",node['MVA'])
        A0 = I0 * np.eye(nunit)
        A1 = np.eye(nunit)

        if nunit != 0:
            # Step 1: 使用字典提前创建 NODE_ID 到 unit 索引的映射
            unit_id_map = {unit.at[i, 'NODE_ID']: i for i in range(nunit)}

            # Step 2: 填充 A1 矩阵
            A1[:, :] = Ii  # 用 Ii 填充 A1 矩阵

            # Step 3: 计算 A 和 b，并求解 Si
            A = A0 + A1
            b = -S0 * Ii
            Si = np.linalg.solve(A, b)

            # Step 4: 更新 node 中的 MVA 值
            m = 0
            for i in range(ntr):
                node_id = tr.at[i, 'NODE_ID']
                if node_id in unit_id_map:
                    node.at[tr.at[i, 'ORI_ID'] - 1, 'MVA'] = Si[m]
                    m += 1

        ###############################################计算配线等值电阻RL和配变等值电阻RT#############################################
        def getS(node, branch, i, allS):
            if allS[i - 1] == 0:
                S = node.at[i - 1, 'MVA']
                nbranch = len(branch)
                for m in range(0, nbranch):
                    if branch.at[m, 'from_node'] == i:
                        S0, a = getS(node, branch, branch.at[m, 'to_node'], allS)
                        S = S + S0
                allS[i - 1] = S
            else:
                S = allS[i - 1]
            return S, allS

        def getRL(node, branch, allS):
            RL = 0
            nbranch = len(branch)
            for i in range(0, nbranch):
                # try:
                S0, a = getS(node, branch, branch.at[i, 'to_node'], allS)
                RL = RL + branch.at[i, 'r1'] * S0**2 / node['MVA'].sum() ** 2
            return RL

        for i in range(1, nnode + 1):
            S, allS = getS(node, branch, i, allS)

        RL = getRL(node, branch, allS)
        RT = (UkV / node['MVA'].sum()) ** 2 * node['Ploss'].sum() * 1e3
        ###########################################计算空载损耗P0、额定负载损耗PK、首端功率P#########################################
        total_Pk = 3 * I0**2 * (RT + RL)
        total_P0 = node['P0'].sum() * 1e-3
        total_P = total_Pk + total_P0
        P = source.at[0, 'U'] * source.at[0, 'I_AVERAGE'] * 0.95

        logger.info('*********************************************')
        logger.info('{} 馈线线损率: {:.2f}'.format(feeder_model['FEEDER_NAME'], (total_P / P)))
        #########################################################################################################################
        feederloss.loc[0, ['IDX', 'FEEDER_ID', 'FEEDER_NAME', 'LOSS_RATE', 'P_LOSS', 'Q_LOSS']] = [
            time_index,
            branch_df.loc[0, 'FEEDER_ID'],
            feeder_name,
            float(total_P / P),
            total_P,
            0,
        ]
        feeder_statics.loc[
            0,
            [
                'IDX',
                'FEEDER_ID',
                'FEEDER_NAME',
                'RDF_ID',
                'LOSS_RATE',
                'CODE',
                'MESSAGE',
                'DATA_TIME',
            ],
        ] = [
            time_index,
            feeder_id,
            feeder_name,
            feeder_rdfid,
            total_P / P,
            0,
            '成功计算',
            datatime,
        ]
        se_or_pf_result['tables'].update(
            {
                'sum_lossrate': total_P / P,
                'lineloss': self.lineloss,
                'feederloss': feederloss,
                'trfmloss': self.trfmloss,
                'feeder_statics': feeder_statics,
                'energy_input_and_output': self.energy_input_and_output,
                'distributed_generation': self.distributed_generation,
            }
        )
        return se_or_pf_result

    def get_error_result(self, feeder_id, feeder_name, feeder_rdfid, time_index, datatime):
        """获取计算失败时的结果，除了统计表其他都默认返回初始化后的df"""
        logger.info(f'{feeder_name}{self.error_msg}')
        logger.info('*********************************************')
        self.feeder_statics.loc[
            0,
            [
                'IDX',
                'FEEDER_ID',
                'FEEDER_NAME',
                'RDF_ID',
                'LOSS_RATE',
                'CODE',
                'MESSAGE',
                'DATA_TIME',
            ],
        ] = [
            time_index,
            feeder_id,
            feeder_name,
            feeder_rdfid,
            None,
            self.error_code,
            self.error_msg,
            datatime,
        ]

        self.result['statics']['bug_feeder'] = True
        self.result['tables'].update({'feeder_statics': self.feeder_statics})

        return self.result
