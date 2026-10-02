import os
import sys
import time

# 设置路径
CUR_PATH = os.path.abspath(os.path.dirname(__file__))
lib_dir = os.path.dirname(os.path.dirname(CUR_PATH))
if lib_dir not in sys.path:
    sys.path.insert(0, lib_dir)

import networkx as nx
import numpy as np
import pandas as pd
from power_grid_model import MeasuredTerminalType, initialize_array

from lib.helper.data_utils import module_to_obj, tof
from lib.helper.log import logger


class ModelBuilder:
    def __init__(self, feeder_model, cons_para=None):
        self.feeder_model = feeder_model

        if cons_para is None:
            if self.feeder_model.calc_model == 'dms':
                from dms.dms_cons_para import cons_para
            elif self.feeder_model.calc_model == 'taiqu':
                from dms.taiqu_cons_para import cons_para

        self.cons_para = module_to_obj(cons_para)
        self.vectorized_complex = np.vectorize(complex)
        self._initialize_dataframes()

    def _initialize_dataframes(self):
        """初始化数据框结构"""
        bus_df_fields = [
            'ID',
            'ORI_ID',
            'BV_ID',
            'P0',
            'PK',
            'MVA',
            'INIT_TYPE',
            'NAME',
            'VMA_PRE',
            'VMA_WEIGHT',
            'VMB_PRE',
            'VMB_WEIGHT',
            'VMC_PRE',
            'VMC_WEIGHT',
            'PA_PRE',
            'PA_WEIGHT',
            'PB_PRE',
            'PB_WEIGHT',
            'PC_PRE',
            'PC_WEIGHT',
            'QA_PRE',
            'QA_WEIGHT',
            'QB_PRE',
            'QB_WEIGHT',
            'QC_PRE',
            'QC_WEIGHT',
            'PA_SET',
            'PB_SET',
            'PC_SET',
            'QA_SET',
            'QB_SET',
            'QC_SET',
            'VMA',
            'VMB',
            'VMC',
            'VAA',
            'VAB',
            'VAC',
            'RDF_ID',
            'METER_TYPE',
            'P_PRE',
            'Q_PRE',
            'IS_GF',
            'WITH_GF',
            'METER_ID',
        ]
        self.bus_df = pd.DataFrame({}, columns=bus_df_fields)

        # branch_df,用来存重新编号之后的支路信息：编号，电压等级，馈线，首末节点，阻抗参数
        branch_df_fields = [
            'ID',
            'DEV_ID',
            'DEV_NAME',
            'BV_ID',
            'FEEDER_ID',
            'BULK_ID',
            'ST_ID',
            'TYPE',
            'BR_TYPE',
            'RDF_ID',
            'NAME',
            'MVA',
            'LENGTH',
            'RAA',
            'XAA',
            'INODE_ID',
            'ZNODE_ID',
            'ORI_INODE_ID',
            'ORI_ZNODE_ID',
            'ITERMINAL_ID',
            'ZTERMINAL_ID',
            'PHA',
            'PHB',
            'PHC',
            'GAA',
            'GAB',
            'GAC',
            'GBA',
            'GBB',
            'GBC',
            'GCA',
            'GCB',
            'GCC',
            'BAA',
            'BAB',
            'BAC',
            'BBA',
            'BBB',
            'BBC',
            'BCA',
            'BCB',
            'BCC',
            'PA',
            'PB',
            'PC',
            'P_SUM',
            'PA_PRE',
            'PB_PRE',
            'PC_PRE',
            'QA',
            'QB',
            'QC',
            'Q_SUM',
            'QA_PRE',
            'QB_PRE',
            'QC_PRE',
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
            'P_PRE',
            'Q_PRE',
            'LINE_ID',
        ]
        self.branch_df = pd.DataFrame({}, columns=branch_df_fields)

        power_error_df_fields = [
            'ID',
            'ORI_ID',
            'NAME',
            'MESSAGE',
            'PA_PRE_ORIGINAL',
            'PA_PRE_REPAIRED',
            'PB_PRE_ORIGINAL',
            'PB_PRE_REPAIRED',
            'PC_PRE_ORIGINAL',
            'PC_PRE_REPAIRED',
            'P_PRE_ORIGINAL',
            'P_PRE_REPAIRED',
            'QA_PRE_ORIGINAL',
            'QA_PRE_REPAIRED',
            'QB_PRE_ORIGINAL',
            'QB_PRE_REPAIRED',
            'QC_PRE_ORIGINAL',
            'QC_PRE_REPAIRED',
            'Q_PRE_ORIGINAL',
            'Q_PRE_REPAIRED',
            'RDF_ID',
            'METER_TYPE',
            'IS_GF',
            'WITH_GF',
            'METER_ID',
            'TIME_INDEX',
        ]
        self.power_error_df = pd.DataFrame({}, columns=power_error_df_fields)
        self.power_error_df_fields = power_error_df_fields

    def get_dev_param_data_df(
        self,
        dev_param_line_df=None,
        dev_param_transformer_df=None,
        dev_param_data_path=None,
    ):
        if dev_param_data_path is None:
            dev_param_data_path = CUR_PATH  # 取当前文件同路径

        dev_param_line_df_cols = ['model_name', 'resistance', 'reactivity']
        dev_param_transformer_df_cols = [
            'model_name',
            'resistance',
            'reactivity',
            'no_load_loss',
            'max_short_circuit_loss',
        ]

        if dev_param_line_df is None:  # 如果未传入df则读取文件
            dev_param_distribution_line_path = os.path.join(dev_param_data_path, 'dev_param_distribution_line.csv')
            if not os.path.exists(dev_param_distribution_line_path):
                logger.error(f'{dev_param_distribution_line_path} 路径不存在')
                dev_param_line_df = pd.DataFrame(columns=dev_param_line_df_cols)
            else:
                try:
                    dev_param_line_df = pd.read_csv(dev_param_distribution_line_path)
                except Exception as e:
                    logger.error(f'读取dev_param_distribution_line.csv失败:{e}')
                    dev_param_line_df = pd.DataFrame(columns=dev_param_line_df_cols)

        if dev_param_transformer_df is None:
            dev_param_distribution_transformer_path = os.path.join(dev_param_data_path, 'dev_param_distribution_transformer.csv')
            if not os.path.exists(dev_param_distribution_transformer_path):
                logger.error(f'{dev_param_distribution_transformer_path} 路径不存在')
                dev_param_transformer_df = pd.DataFrame(columns=dev_param_transformer_df_cols)
            else:
                try:
                    dev_param_transformer_df = pd.read_csv(dev_param_distribution_transformer_path)
                except Exception as e:
                    logger.error(f'读取dev_param_distribution_transformer.csv失败:{e}')
                    dev_param_transformer_df = pd.DataFrame(columns=dev_param_transformer_df_cols)

        # 统一处理df
        if [col for col in dev_param_line_df_cols if col not in dev_param_line_df.columns]:
            logger.error("col of ['model_name', 'resistance', 'reactivity'] not in dev_param_line_df.columns")
            dev_param_line_df = pd.DataFrame(columns=dev_param_line_df_cols)

        if [col for col in dev_param_transformer_df_cols if col not in dev_param_transformer_df.columns]:
            logger.error("col of ['model_name','resistance','reactivity','no_load_loss','max_short_circuit_loss'] not in dev_param_transformer_df.columns")
            dev_param_transformer_df = pd.DataFrame(columns=dev_param_transformer_df_cols)

        dev_param_line_df = dev_param_line_df[dev_param_line_df_cols]
        dev_param_transformer_df = dev_param_transformer_df[dev_param_transformer_df_cols]
        dev_param_data_df = pd.concat([dev_param_line_df, dev_param_transformer_df], ignore_index=True)

        if dev_param_data_df.empty:
            return dev_param_data_df

        column_mapping = {
            'resistance': 'RAA',
            'reactivity': 'XAA',
            'no_load_loss': 'P0',
            'max_short_circuit_loss': 'PK',
        }

        # 转换数值类型
        for col in column_mapping.keys():
            dev_param_data_df[col] = pd.to_numeric(dev_param_data_df[col], errors='coerce')

        # 重命名列
        dev_param_data_df = dev_param_data_df.rename(columns=column_mapping)
        dev_param_data_df = dev_param_data_df.set_index('model_name')

        return dev_param_data_df

    # 校验并修复数据
    def check_and_repair_value(
        self,
        dev_param_line_df=None,
        dev_param_transformer_df=None,
        dev_param_data_path=None,
    ):
        # 铭牌表数据可以传入dataframe或者dev_param_distribution_line.csv和dev_param_distribution_transformer.csv的存放路径
        dev_param_data_df = self.get_dev_param_data_df(dev_param_line_df, dev_param_transformer_df, dev_param_data_path)

        bus_cons_para_dict = {
            'default': {'P0': self.cons_para.p0, 'PK': self.cons_para.pk},
            'boundary': {
                'P0': self.cons_para.p0_boundary,
                'PK': self.cons_para.pk_boundary,
            },
        }

        branch_cons_para_dict = {
            '4': {
                'default': {
                    'RAA': self.cons_para.Ra_distrfm,
                    'XAA': self.cons_para.Xa_distrfm,
                },
                'boundary': {
                    'RAA': self.cons_para.Ra_distrfm_boundary,
                    'XAA': self.cons_para.Xa_distrfm_boundary,
                },
            },
            'other': {
                'default': {
                    'RAA': self.cons_para.Ra_disline,
                    'XAA': self.cons_para.Xa_disline,
                    'LENGTH': self.cons_para.linelength_default,
                },
                'boundary': {
                    'RAA': self.cons_para.Ra_disline_boundary,
                    'XAA': self.cons_para.Xa_disline_boundary,
                },
            },
        }

        # 对bus_df每行进行校验的函数
        def check_bus_p0_pk_value(row):
            # 给每一行添加一个error_info字段记录校验错误信息
            row['error_info'] = []

            for col_name in ['P0', 'PK']:
                row[col_name] = pd.to_numeric(row[col_name], errors='coerce')

                change_reason = 0
                # 如果为0或为空替换为默认值
                if pd.isna(row[col_name]) or row[col_name] == 0.0:
                    if row['INIT_TYPE'] == 3 or row['PA_PRE'] != 0 or row['VMA_PRE'] != 0:
                        change_reason = 1
                elif row[col_name] > bus_cons_para_dict['boundary'][col_name]:
                    change_reason = 2

                if change_reason == 0:
                    continue

                model = str(row['MODEL'])  # 替换为模型数据
                if model in dev_param_data_df.index and col_name in dev_param_data_df.columns:
                    prop_new_value = dev_param_data_df.at[model, col_name]
                    new_value_source = 2
                else:
                    prop_new_value = bus_cons_para_dict['default'][col_name]
                    new_value_source = 1

                row['error_info'].append(
                    {
                        'prop_name': col_name,
                        'prop_original_value': row[col_name],
                        'prop_new_value': prop_new_value,
                        'change_reason': change_reason,
                        'new_value_source': new_value_source,
                    }
                )
                row[col_name] = prop_new_value

            return row

        def check_branch_raa_xaa_value(row):
            br_type = int(row['BR_TYPE'])
            row['error_info'] = []

            if br_type == 4:
                cons_para_dict = branch_cons_para_dict['4']
                check_cols = ['RAA', 'XAA']
            elif br_type == 5 or br_type == 3:
                cons_para_dict = branch_cons_para_dict['other']
                check_cols = ['RAA', 'XAA', 'LENGTH']
            else:
                return row

            for col_name in check_cols:
                row[col_name] = pd.to_numeric(row[col_name], errors='coerce')
                change_reason = 0

                if pd.isna(row[col_name]):
                    change_reason = 1
                elif row[col_name] <= 0 or (col_name in cons_para_dict['boundary'] and row[col_name] >= cons_para_dict['boundary'][col_name]):
                    change_reason = 2

                if change_reason == 0:
                    continue

                model = str(row['MODEL'])
                if model in dev_param_data_df.index and col_name in dev_param_data_df.columns:
                    prop_new_value = dev_param_data_df.at[model, col_name]
                    new_value_source = 2
                else:
                    prop_new_value = cons_para_dict['default'][col_name]
                    new_value_source = 1

                row['error_info'].append(
                    {
                        'prop_name': col_name,
                        'prop_original_value': row[col_name],
                        'prop_new_value': prop_new_value,
                        'change_reason': change_reason,
                        'new_value_source': new_value_source,
                    }
                )
                row[col_name] = prop_new_value

            return row

        self.bus_df = self.bus_df.apply(check_bus_p0_pk_value, axis=1)
        self.branch_df = self.branch_df.apply(check_branch_raa_xaa_value, axis=1)

        # 统计error_info
        bus_errors = []
        bus_error_info_df = self.bus_df[self.bus_df['error_info'].astype(bool)]
        for row in bus_error_info_df.itertuples():
            bus_info = {
                'ID': row.ID,
                'ORI_ID': row.ORI_ID,
                'NAME': row.NAME,
            }

            for error in row.error_info:
                bus_errors.append({**error, **bus_info})

        branch_errors = []
        branch_error_info_df = self.branch_df[self.branch_df['error_info'].astype(bool)]
        for row in branch_error_info_df.itertuples():
            branch_info = {
                'ID': row.ID,
                'DEV_ID': row.DEV_ID,
                'DEV_NAME': row.DEV_NAME,
                'RDF_ID': row.RDF_ID,
                'NAME': row.NAME,
            }

            for error in row.error_info:
                branch_errors.append({**error, **branch_info})

        bus_columns = [
            'ID',
            'ORI_ID',
            'NAME',
            'prop_name',
            'prop_original_value',
            'prop_new_value',
            'change_reason',
            'new_value_source',
        ]

        branch_columns = [
            'ID',
            'DEV_ID',
            'DEV_NAME',
            'RDF_ID',
            'NAME',
            'prop_name',
            'prop_original_value',
            'prop_new_value',
            'change_reason',
            'new_value_source',
        ]

        bus_errors_df = pd.DataFrame(bus_errors)[bus_columns] if bus_errors else pd.DataFrame(columns=bus_columns)
        branch_errors_df = pd.DataFrame(branch_errors)[branch_columns] if branch_errors else pd.DataFrame(columns=branch_columns)

        return bus_errors_df, branch_errors_df

    def build_base_network(self, method='se'):
        """构建基础网络模型"""

        self._create_trwd()
        self._create_load()
        # 解析拓扑数据
        self._parse_topo()

        # 处理self.bus_df和self.branch_df,数据校验和修复
        # logger.info('check and repair value for bus and branch df')
        # bus_errors_df, branch_errors_df = self.check_and_repair_value()

        # 节点创建逻辑
        self._create_nodes()

        # 支路创建逻辑
        self._create_lines()

        # 功率和电压量测创建逻辑
        self._create_sym_load()

        # 电源源创建逻辑
        self._create_source()

        # 状态估计需要，潮流不需要
        if method == 'se':
            self._create_asym_voltage_sensor()
            self._create_sym_power_sensor()

    def _create_trwd(self):
        # 获取各个dataframe的行数，即获取各个元件的个数
        # ntrwd = len(self.feeder_model['trwd'])

        # from json to  DataFrame
        trwd = pd.DataFrame(self.feeder_model['trwd'].values())

        if len(trwd) > 0:
            # 对trwd中的所有空功率量测量测赋值0
            # 填充所有指定列的NaN值为0，避免重复调用isna和赋值操作
            fill_zero_cols = [
                'P_PRE',
                'PA_PRE',
                'PB_PRE',
                'PC_PRE',
                'Q_PRE',
                'QA_PRE',
                'QB_PRE',
                'QC_PRE',
                'VMA_PRE',
                'VMB_PRE',
                'VMC_PRE',
            ]

            trwd[fill_zero_cols] = trwd[fill_zero_cols].apply(lambda x: pd.to_numeric(x, errors='coerce').fillna(0))

        self.trwd = trwd

    def _create_load(self):
        # 获取各个dataframe的行数，即获取各个元件的个数
        # nload = len(self.feeder_model['load'])

        # from json to  DataFrame
        load = pd.DataFrame(self.feeder_model['load'].values())

        if len(load) > 0:
            # 对trwd中的所有空功率量测量测赋值0
            # 填充所有指定列的NaN值为0，避免重复调用isna和赋值操作
            fill_zero_cols = [
                'P_PRE',
                'PA_PRE',
                'PB_PRE',
                'PC_PRE',
                'Q_PRE',
                'QA_PRE',
                'QB_PRE',
                'QC_PRE',
                'VMA_PRE',
                'VMB_PRE',
                'VMC_PRE',
            ]

            load[fill_zero_cols] = load[fill_zero_cols].apply(lambda x: pd.to_numeric(x, errors='coerce').fillna(0))

        self.load = load

    def _parse_topo(self):
        """解析拓扑创建节点和支路数据"""

        vectorized_complex = np.vectorize(complex)

        feeder_model = self.feeder_model
        bus_df = self.bus_df
        branch_df = self.branch_df
        cons_para = self.cons_para

        feeder_id = feeder_model['FEEDER_ID']

        # 解析拓扑开始###################################################
        knode = 1
        kbr = 0

        node_index = {}

        # 深度遍历馈线DiGraph
        net = feeder_model['net']

        skip_nodes = set()
        temp_trfm = 0  # 用来判断功率量测是存到trwd里还是load里，如果存到trwd里，那么在type=load时，不执行功率和电压量测赋值
        _t0 = time.perf_counter()

        _t0 = time.perf_counter()
        for i in nx.dfs_tree(net):
            if i in skip_nodes:
                continue

            type = net.nodes[i]['type']

            if type == 'so':
                so_dev = feeder_model['so']

                bus_df.loc[
                    knode - 1,
                    [
                        'ID',
                        'ORI_ID',
                        'BV_ID',
                        'VMA_PRE',
                        'VMA_WEIGHT',
                        'VMB_PRE',
                        'VMB_WEIGHT',
                        'VMC_PRE',
                        'VMC_WEIGHT',
                        'PA_PRE',
                        'PA_WEIGHT',
                        'PB_PRE',
                        'PB_WEIGHT',
                        'PC_PRE',
                        'PC_WEIGHT',
                        'QA_PRE',
                        'QA_WEIGHT',
                        'QB_PRE',
                        'QB_WEIGHT',
                        'QC_PRE',
                        'QC_WEIGHT',
                        'PA_SET',
                        'PB_SET',
                        'PC_SET',
                        'QA_SET',
                        'QB_SET',
                        'QC_SET',
                        'INIT_TYPE',
                        'NAME',
                        'P0',
                        'PK',
                        'MVA',
                    ],
                ] = [
                    knode,
                    0,
                    so_dev.get('BV_ID', 0),
                    so_dev.get('VMA_PRE', 0),
                    so_dev.get('VMA_WEIGHT', 0),
                    so_dev.get('VMB_PRE', 0),
                    so_dev.get('VMB_WEIGHT', 0),
                    so_dev.get('VMC_PRE', 0),
                    so_dev.get('VMC_WEIGHT', 0),
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    1,
                    str(so_dev['NAME']) + '-母线',
                    0,
                    0,
                    0,
                ]

                knode += 1

                bus_df.loc[
                    knode - 1,
                    [
                        'ID',
                        'ORI_ID',
                        'BV_ID',
                        'VMA_PRE',
                        'VMA_WEIGHT',
                        'VMB_PRE',
                        'VMB_WEIGHT',
                        'VMC_PRE',
                        'VMC_WEIGHT',
                        'PA_PRE',
                        'PA_WEIGHT',
                        'PB_PRE',
                        'PB_WEIGHT',
                        'PC_PRE',
                        'PC_WEIGHT',
                        'QA_PRE',
                        'QA_WEIGHT',
                        'QB_PRE',
                        'QB_WEIGHT',
                        'QC_PRE',
                        'QC_WEIGHT',
                        'PA_SET',
                        'PB_SET',
                        'PC_SET',
                        'QA_SET',
                        'QB_SET',
                        'QC_SET',
                        'INIT_TYPE',
                        'NAME',
                        'P0',
                        'PK',
                        'MVA',
                    ],
                ] = [
                    knode,
                    so_dev['NODE_ID'],
                    so_dev['BV_ID'],
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    0,
                    str(so_dev['NAME']) + '（新增虚拟节点）',
                    0,
                    0,
                    0,
                ]

                node_index[so_dev['NODE_ID']] = knode

                branch_df.loc[
                    kbr,
                    [
                        'ID',
                        'ORI_INODE_ID',
                        'ORI_ZNODE_ID',
                        'INODE_ID',
                        'ZNODE_ID',
                        'BR_TYPE',
                        'BV_ID',
                        'FEEDER_ID',
                        'LINE_ID',
                        'ITERMINAL_ID',
                        'ZTERMINAL_ID',
                        'PHA',
                        'PHB',
                        'PHC',
                        'RDF_ID',
                        'NAME',
                        'GAA',
                        'GAB',
                        'GAC',
                        'GBA',
                        'GBB',
                        'GBC',
                        'GCA',
                        'GCB',
                        'GCC',
                        'BAA',
                        'BAB',
                        'BAC',
                        'BBA',
                        'BBB',
                        'BBC',
                        'BCA',
                        'BCB',
                        'BCC',
                        'P_PRE',
                        'Q_PRE',
                        'PA_PRE',
                        'PB_PRE',
                        'PC_PRE',
                        'QA_PRE',
                        'QB_PRE',
                        'QC_PRE',
                        'RAA',
                        'XAA',
                        'LENGTH',
                        'DEV_ID',
                        'DEV_NAME',
                        'BULK_ID',
                        'ST_ID',
                        'TYPE',
                    ],
                ] = [
                    kbr + 1,
                    0,
                    so_dev['NODE_ID'],
                    knode - 1,
                    knode,
                    6,
                    so_dev['BV_ID'],
                    feeder_id,
                    0,
                    knode - 1,
                    knode,
                    1,
                    1,
                    1,
                    0,
                    str(so_dev['NAME']) + '-馈线出口',
                    1e4,
                    0,
                    0,
                    0,
                    1e4,
                    0,
                    0,
                    0,
                    1e4,
                    1e4,
                    0,
                    0,
                    0,
                    1e4,
                    0,
                    0,
                    0,
                    1e4,
                    so_dev.get('P_PRE', 0),
                    so_dev.get('Q_PRE', 0),
                    so_dev.get('PA_PRE', 0),
                    so_dev.get('PB_PRE', 0),
                    so_dev.get('PC_PRE', 0),
                    so_dev.get('QA_PRE', 0),
                    so_dev.get('QB_PRE', 0),
                    so_dev.get('QC_PRE', 0),
                    0.0025,
                    0.002,
                    0,
                    so_dev['ID'],
                    so_dev['NAME'],
                    so_dev['BULK_ID'],
                    feeder_model['ST_ID'],
                    so_dev['TYPE'],
                ]

                if so_dev.get('PA_PRE', 0) == 0 and so_dev.get('P_PRE', 0) != 0:
                    branch_df.loc[
                        kbr,
                        ['PA_PRE', 'PB_PRE', 'PC_PRE', 'QA_PRE', 'QB_PRE', 'QC_PRE'],
                    ] = [
                        so_dev.get('P_PRE', 0) / 3,
                        so_dev.get('P_PRE', 0) / 3,
                        so_dev.get('P_PRE', 0) / 3,
                        so_dev.get('Q_PRE', 0) / 3,
                        so_dev.get('Q_PRE', 0) / 3,
                        so_dev.get('Q_PRE', 0) / 3,
                    ]

                kbr += 1
                knode += 1
            elif type == 'qs' or type == 'cb':
                dev = feeder_model[type][i]

                if str(dev['RUN_STATE']) == '1':
                    # 将隔离开关的末端节点添加至bus_node_id（原始编号）,bus_rename（重新编号），temp_node(中间变量，用来存储本轮遍历查找末端节点，作为下一轮遍历查找的首端节点)中
                    # 寻找支路首端节点的新编号，判断末端节点的相位初值类型
                    phase_init = 1

                    bus_df.loc[
                        knode - 1,
                        [
                            'ID',
                            'ORI_ID',
                            'BV_ID',
                            'VMA_PRE',
                            'VMA_WEIGHT',
                            'VMB_PRE',
                            'VMB_WEIGHT',
                            'VMC_PRE',
                            'VMC_WEIGHT',
                            'PA_PRE',
                            'PA_WEIGHT',
                            'PB_PRE',
                            'PB_WEIGHT',
                            'PC_PRE',
                            'PC_WEIGHT',
                            'QA_PRE',
                            'QA_WEIGHT',
                            'QB_PRE',
                            'QB_WEIGHT',
                            'QC_PRE',
                            'QC_WEIGHT',
                            'PA_SET',
                            'PB_SET',
                            'PC_SET',
                            'QA_SET',
                            'QB_SET',
                            'QC_SET',
                            'INIT_TYPE',
                            'NAME',
                            'P0',
                            'PK',
                            'MVA',
                        ],
                    ] = [
                        knode,
                        dev['ZNODE_ID'],
                        dev['BV_ID'],
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        phase_init,
                        dev['NAME'] + '-首端',
                        0,
                        0,
                        0,
                    ]

                    node_index[dev['ZNODE_ID']] = knode

                    branch_df.loc[
                        kbr,
                        [
                            'ID',
                            'ORI_INODE_ID',
                            'ORI_ZNODE_ID',
                            'INODE_ID',
                            'ZNODE_ID',
                            'BV_ID',
                            'FEEDER_ID',
                            'LINE_ID',
                            'ITERMINAL_ID',
                            'ZTERMINAL_ID',
                            'PHA',
                            'PHB',
                            'PHC',
                            'RDF_ID',
                            'NAME',
                            'GAA',
                            'GAB',
                            'GAC',
                            'GBA',
                            'GBB',
                            'GBC',
                            'GCA',
                            'GCB',
                            'GCC',
                            'BAA',
                            'BAB',
                            'BAC',
                            'BBA',
                            'BBB',
                            'BBC',
                            'BCA',
                            'BCB',
                            'BCC',
                            'P_PRE',
                            'Q_PRE',
                            'PA_PRE',
                            'PB_PRE',
                            'PC_PRE',
                            'QA_PRE',
                            'QB_PRE',
                            'QC_PRE',
                            'BR_TYPE',
                            'RAA',
                            'XAA',
                            'MVA',
                            'LENGTH',
                            'DEV_ID',
                            'DEV_NAME',
                            'BULK_ID',
                            'ST_ID',
                            'TYPE',
                        ],
                    ] = [
                        kbr + 1,
                        dev['INODE_ID'],
                        dev['ZNODE_ID'],
                        node_index[dev['INODE_ID']],
                        knode,
                        dev['BV_ID'],
                        dev['FEEDER_ID'],
                        dev['ID'],
                        dev.get('ITERMINAL_ID', 0),
                        dev.get('ZTERMINAL_ID', 0),
                        dev['PHA'],
                        dev['PHB'],
                        dev['PHC'],
                        dev['RDF_ID'],
                        dev['NAME'],
                        1e4,
                        0,
                        0,
                        0,
                        1e4,
                        0,
                        0,
                        0,
                        1e4,
                        1e4,
                        0,
                        0,
                        0,
                        1e4,
                        0,
                        0,
                        0,
                        1e4,
                        dev.get('P_PRE', 0),
                        dev.get('Q_PRE', 0),
                        dev.get('PA_PRE', 0),
                        dev.get('PB_PRE', 0),
                        dev.get('PC_PRE', 0),
                        dev.get('QA_PRE', 0),
                        dev.get('QB_PRE', 0),
                        dev.get('QC_PRE', 0),
                        2 if type == 'qs' else 1,
                        0.0025,
                        0.002,
                        0,
                        0,
                        dev['ID'],
                        dev['NAME'],
                        feeder_model['BULK_ID'],
                        feeder_model['ST_ID'],
                        dev['TYPE'],
                    ]

                    knode += 1
                    kbr += 1
                else:
                    for j in nx.dfs_tree(net, i):
                        skip_nodes.add(j)
            elif type == 'lnseg':
                dev = feeder_model[type][i]

                if net.degree(i) == 2:
                    branch_df.at[kbr, 'BR_TYPE'] = 5
                else:
                    branch_df.at[kbr, 'BR_TYPE'] = 3

                if dev['BV_ID'] in feeder_model['bvs']:
                    if float(feeder_model['bvs'][dev['BV_ID']]) > 0:
                        Ubase = float(feeder_model['bvs'][dev['BV_ID']])
                    else:
                        Ubase = cons_para.Volbase
                else:
                    Ubase = cons_para.Volbase

                Zbase = (Ubase * Ubase * cons_para.voltage_input_factor) / cons_para.Sbase

                # lnseg_dot = feeder_model['lnseg_dot'][dev['ZTERMINAL_ID']]
                bus_df.loc[
                    knode - 1,
                    [
                        'ID',
                        'ORI_ID',
                        'BV_ID',
                        'VMA_PRE',
                        'VMA_WEIGHT',
                        'VMB_PRE',
                        'VMB_WEIGHT',
                        'VMC_PRE',
                        'VMC_WEIGHT',
                        'PA_PRE',
                        'PA_WEIGHT',
                        'PB_PRE',
                        'PB_WEIGHT',
                        'PC_PRE',
                        'PC_WEIGHT',
                        'QA_PRE',
                        'QA_WEIGHT',
                        'QB_PRE',
                        'QB_WEIGHT',
                        'QC_PRE',
                        'QC_WEIGHT',
                        'PA_SET',
                        'PB_SET',
                        'PC_SET',
                        'QA_SET',
                        'QB_SET',
                        'QC_SET',
                        'INIT_TYPE',
                        'NAME',
                        'P0',
                        'PK',
                        'MVA',
                    ],
                ] = [
                    knode,
                    dev['ZNODE_ID'],
                    dev['BV_ID'],
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    1,
                    dev['NAME'] + '-首端',
                    0,
                    0,
                    0,
                ]

                node_index[dev['ZNODE_ID']] = knode

                Amat = vectorized_complex(
                    [[1.0, 1.0, 1.0], [-0.5, -0.5, 1.0], [-0.5, -0.5, 1.0]],
                    [[0.0, 0.0, 0.0], [-0.866, 0.866, 0.0], [0.866, -0.866, 0.0]],
                )

                if tof(dev['LENGTH']) > 0:
                    lnlength = float(dev['LENGTH']) * cons_para.linelength_unitfactor
                else:
                    lnlength = cons_para.linelength_default

                r0 = tof(dev['RAA'], cons_para.Ra_disline) * lnlength
                x0 = tof(dev['XAA'], cons_para.Xa_disline) * lnlength
                Z_012s = vectorized_complex([r0, r0, 3 * r0], [x0, x0, 3 * x0])
                Z_012 = np.diag(Z_012s)
                Z_br_per = np.dot(np.dot(Amat, Z_012), np.linalg.inv(Amat))
                Z_br = Z_br_per * lnlength / (Zbase)  # 单位长度阻抗*长度/阻抗基准值
                Y_br = np.linalg.inv(Z_br)
                gaa = Y_br[0, 0].real
                gab = Y_br[0, 1].real
                gac = Y_br[0, 2].real
                gba = Y_br[1, 0].real
                gbb = Y_br[1, 1].real
                gbc = Y_br[1, 2].real
                gca = Y_br[2, 0].real
                gcb = Y_br[2, 1].real
                gcc = Y_br[2, 2].real

                baa = Y_br[0, 0].imag
                bab = Y_br[0, 1].imag
                bac = Y_br[0, 2].imag
                bba = Y_br[1, 0].imag
                bbb = Y_br[1, 1].imag
                bbc = Y_br[1, 2].imag
                bca = Y_br[2, 0].imag
                bcb = Y_br[2, 1].imag
                bcc = Y_br[2, 2].imag

                branch_df.loc[
                    kbr,
                    [
                        'ID',
                        'ORI_INODE_ID',
                        'ORI_ZNODE_ID',
                        'INODE_ID',
                        'ZNODE_ID',
                        'BV_ID',
                        'FEEDER_ID',
                        'LINE_ID',
                        'ITERMINAL_ID',
                        'ZTERMINAL_ID',
                        'PHA',
                        'PHB',
                        'PHC',
                        'RDF_ID',
                        'NAME',
                        'GAA',
                        'GAB',
                        'GAC',
                        'GBA',
                        'GBB',
                        'GBC',
                        'GCA',
                        'GCB',
                        'GCC',
                        'BAA',
                        'BAB',
                        'BAC',
                        'BBA',
                        'BBB',
                        'BBC',
                        'BCA',
                        'BCB',
                        'BCC',
                        'MVA',
                        'RAA',
                        'XAA',
                        'LENGTH',
                        'DEV_ID',
                        'DEV_NAME',
                        'BULK_ID',
                        'ST_ID',
                        'TYPE',
                    ],
                ] = [
                    kbr + 1,
                    dev['INODE_ID'],
                    dev['ZNODE_ID'],
                    node_index[dev['INODE_ID']],
                    knode,
                    dev['BV_ID'],
                    dev['FEEDER_ID'],
                    dev['ID'],
                    dev['ITERMINAL_ID'],
                    dev['ZTERMINAL_ID'],
                    dev['PHA'],
                    dev['PHB'],
                    dev['PHC'],
                    dev['RDF_ID'],
                    dev['NAME'],
                    gaa,
                    gab,
                    gac,
                    gba,
                    gbb,
                    gbc,
                    gca,
                    gcb,
                    gcc,
                    baa,
                    bab,
                    bac,
                    bba,
                    bbb,
                    bbc,
                    bca,
                    bcb,
                    bcc,
                    dev['MVA'],
                    r0,
                    x0,
                    lnlength,
                    dev['ID'],
                    dev['NAME'],
                    feeder_model['BULK_ID'],
                    feeder_model['ST_ID'],
                    dev['TYPE'],
                ]

                knode += 1
                kbr += 1
            elif type == 'trfm':
                dev = feeder_model[type][i]
                itrwd = feeder_model['trwd'][dev['ITERMINAL_ID']]
                ztrwd = feeder_model['trwd'][dev['ZTERMINAL_ID']]

                ztrwd['P_PRE'] = p_pre = tof(ztrwd['P_PRE'])
                ztrwd['Q_PRE'] = q_pre = tof(ztrwd['Q_PRE'])
                ztrwd['PA_PRE'] = pa_pre = tof(ztrwd['PA_PRE'])
                ztrwd['QA_PRE'] = qa_pre = tof(ztrwd['QA_PRE'])
                ztrwd['PB_PRE'] = pb_pre = tof(ztrwd['PB_PRE'])
                ztrwd['QB_PRE'] = qb_pre = tof(ztrwd['QB_PRE'])
                ztrwd['PC_PRE'] = pc_pre = tof(ztrwd['PC_PRE'])
                ztrwd['QC_PRE'] = qc_pre = tof(ztrwd['QC_PRE'])

                if p_pre != 0 and pa_pre == 0 and pb_pre == 0 and pc_pre == 0:
                    ztrwd['PA_PRE'] = ztrwd['PB_PRE'] = ztrwd['PC_PRE'] = p_pre / 3

                if q_pre != 0 and qa_pre == 0 and qb_pre == 0 and qc_pre == 0:
                    ztrwd['QA_PRE'] = ztrwd['QB_PRE'] = ztrwd['QC_PRE'] = q_pre / 3

                p0 = tof(dev['P0'])
                pk = tof(dev['PK'])

                if str(dev['RUN_STATE']) == '1':
                    bus_df.loc[
                        knode - 1,
                        [
                            'ID',
                            'ORI_ID',
                            'BV_ID',
                            'VMA_PRE',
                            'VMA_WEIGHT',
                            'VMB_PRE',
                            'VMB_WEIGHT',
                            'VMC_PRE',
                            'VMC_WEIGHT',
                            'PA_PRE',
                            'PA_WEIGHT',
                            'PB_PRE',
                            'PB_WEIGHT',
                            'PC_PRE',
                            'PC_WEIGHT',
                            'QA_PRE',
                            'QA_WEIGHT',
                            'QB_PRE',
                            'QB_WEIGHT',
                            'QC_PRE',
                            'QC_WEIGHT',
                            'PA_SET',
                            'PB_SET',
                            'PC_SET',
                            'QA_SET',
                            'QB_SET',
                            'QC_SET',
                            'INIT_TYPE',
                            'NAME',
                            'P0',
                            'PK',
                            'MVA',
                            'RDF_ID',
                            'WITH_GF',
                            'P_PRE',
                            'Q_PRE',
                        ],
                    ] = [
                        knode,
                        ztrwd['NODE_ID'],
                        ztrwd['BV_ID'],
                        ztrwd['VMA_PRE'],
                        ztrwd['VMA_WEIGHT'],
                        ztrwd['VMB_PRE'],
                        ztrwd['VMB_WEIGHT'],
                        ztrwd['VMC_PRE'],
                        ztrwd['VMC_WEIGHT'],
                        ztrwd['PA_PRE'],
                        ztrwd['PA_WEIGHT'],
                        ztrwd['PB_PRE'],
                        ztrwd['PB_WEIGHT'],
                        ztrwd['PC_PRE'],
                        ztrwd['PC_WEIGHT'],
                        ztrwd['QA_PRE'],
                        ztrwd['QA_WEIGHT'],
                        ztrwd['QB_PRE'],
                        ztrwd['QB_WEIGHT'],
                        ztrwd['QC_PRE'],
                        ztrwd['QC_WEIGHT'],
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        1,
                        dev['NAME'],
                        p0,
                        pk,
                        dev['MVA'],
                        dev['RDF_ID'],
                        1 if dev.get('WITH_GF') == '1' else 0,
                        # dev.get('WITH_GF','0')
                        ztrwd.get('P_PRE', '0'),
                        ztrwd.get('Q_PRE', '0'),
                    ]

                    node_index[ztrwd['NODE_ID']] = knode

                    branch_df.loc[
                        kbr,
                        [
                            'ID',
                            'ORI_INODE_ID',
                            'ORI_ZNODE_ID',
                            'INODE_ID',
                            'ZNODE_ID',
                            'BR_TYPE',
                            'BV_ID',
                            'FEEDER_ID',
                            'LINE_ID',
                            'ITERMINAL_ID',
                            'ZTERMINAL_ID',
                            'PHA',
                            'PHB',
                            'PHC',
                            'RDF_ID',
                            'NAME',
                            'GAA',
                            'GAB',
                            'GAC',
                            'GBA',
                            'GBB',
                            'GBC',
                            'GCA',
                            'GCB',
                            'GCC',
                            'BAA',
                            'BAB',
                            'BAC',
                            'BBA',
                            'BBB',
                            'BBC',
                            'BCA',
                            'BCB',
                            'BCC',
                            'P_PRE',
                            'Q_PRE',
                            'PA_PRE',
                            'PB_PRE',
                            'PC_PRE',
                            'QA_PRE',
                            'QB_PRE',
                            'QC_PRE',
                            'DEV_ID',
                            'DEV_NAME',
                            'BULK_ID',
                            'ST_ID',
                            'TYPE',
                        ],
                    ] = [
                        kbr + 1,
                        itrwd['NODE_ID'],
                        ztrwd['NODE_ID'],
                        node_index[itrwd['NODE_ID']],
                        knode,
                        4,
                        0,
                        itrwd['FEEDER_ID'],
                        dev['ID'],
                        dev['ITERMINAL_ID'],
                        dev['ZTERMINAL_ID'],
                        ztrwd['PHA'],
                        ztrwd['PHB'],
                        ztrwd['PHC'],
                        ztrwd['RDF_ID'],
                        ztrwd['NAME'],
                        1e4,
                        0,
                        0,
                        0,
                        1e4,
                        0,
                        0,
                        0,
                        1e4,
                        1e4,
                        0,
                        0,
                        0,
                        1e4,
                        0,
                        0,
                        0,
                        1e4,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        ztrwd['ID'],
                        ztrwd['NAME'],
                        feeder_model['BULK_ID'],
                        feeder_model['ST_ID'],
                        ztrwd['TYPE'],
                    ]

                    gaa = 0
                    gbb = 0
                    gcc = 0
                    baa = 0
                    bbb = 0
                    bcc = 0

                    branch_df.loc[kbr, ['GAA', 'GBB', 'GCC', 'BAA', 'BBB', 'BCC', 'RAA', 'XAA']] = (gaa, gbb, gcc, baa, bbb, bcc, itrwd['RAA'], itrwd['XAA'])

                    if (
                        ztrwd['VMA_PRE'] != 0
                        or ztrwd['VMB_PRE'] != 0
                        or ztrwd['VMC_PRE'] != 0
                        or ztrwd['PA_PRE'] != 0
                        or ztrwd['PB_PRE'] != 0
                        or ztrwd['PC_PRE']
                        or ztrwd['QA_PRE'] != 0
                        or ztrwd['QB_PRE'] != 0
                        or ztrwd['QC_PRE'] != 0
                    ):
                        temp_trfm += 1

                    knode += 1
                    kbr += 1

            # mod by yan 2024-07-8
            elif type == 'load':
                dev = feeder_model[type][i]

                dev['P_PRE'] = p_pre = tof(dev['P_PRE'])
                dev['Q_PRE'] = q_pre = tof(dev['Q_PRE'])
                dev['PA_PRE'] = pa_pre = tof(dev['PA_PRE'])
                dev['QA_PRE'] = qa_pre = tof(dev['QA_PRE'])
                dev['PB_PRE'] = pb_pre = tof(dev['PB_PRE'])
                dev['QB_PRE'] = qb_pre = tof(dev['QB_PRE'])
                dev['PC_PRE'] = pc_pre = tof(dev['PC_PRE'])
                dev['QC_PRE'] = qc_pre = tof(dev['QC_PRE'])

                if p_pre != 0 and pa_pre == 0 and pb_pre == 0 and pc_pre == 0:
                    dev['PA_PRE'] = dev['PB_PRE'] = dev['PC_PRE'] = p_pre / 3

                if q_pre != 0 and qa_pre == 0 and qb_pre == 0 and qc_pre == 0:
                    dev['QA_PRE'] = dev['QB_PRE'] = dev['QC_PRE'] = q_pre / 3

                for iload in range(len(bus_df)):
                    if dev['NODE_ID'] == bus_df.at[iload, 'ORI_ID']:
                        # 防止与trwd重复添加负荷, 如果这个bus 已经有量测，就不从load 取量测了
                        if (tof(bus_df.at[iload, 'PA_PRE']) + tof(bus_df.at[iload, 'PB_PRE']) + tof(bus_df.at[iload, 'PC_PRE']) + tof(bus_df.at[iload, 'P_PRE'])) == 0:
                            bus_df.loc[
                                iload,
                                [
                                    'VMA_PRE',
                                    'VMA_WEIGHT',
                                    'VMB_PRE',
                                    'VMB_WEIGHT',
                                    'VMC_PRE',
                                    'VMC_WEIGHT',
                                    'PA_PRE',
                                    'PB_PRE',
                                    'PC_PRE',
                                    'QA_PRE',
                                    'QB_PRE',
                                    'QC_PRE',
                                    'P_PRE',
                                    'Q_PRE',
                                    'NAME',
                                    'P0',
                                    'PK',
                                    'MVA',
                                    'RDF_ID',
                                    'METER_TYPE',
                                    'IS_GF',
                                    'WITH_GF',
                                    'METER_ID',
                                ],
                            ] = [
                                dev['VMA_PRE'],
                                dev['VMA_WEIGHT'],
                                dev['VMB_PRE'],
                                dev['VMB_WEIGHT'],
                                dev['VMC_PRE'],
                                dev['VMC_WEIGHT'],
                                dev['PA_PRE'],
                                dev['PB_PRE'],
                                dev['PC_PRE'],
                                dev['QA_PRE'],
                                dev['QB_PRE'],
                                dev['QC_PRE'],
                                dev['P_PRE'],
                                dev['Q_PRE'],
                                dev['NAME'],
                                0,
                                0,
                                dev['MVA'] or self.cons_para.Mva_distrfm,
                                dev['RDF_ID'],
                                dev.get('METER_TYPE', '0'),
                                dev.get('IS_GF', 0),
                                1 if dev.get('WITH_GF') == '1' else 0,
                                # dev.get('WITH_GF','0'),
                                dev.get('METER_ID', dev.get('ID')),
                            ]
            else:
                pass

        self.ndevload = np.max((len(self.feeder_model['trwd']), len(self.feeder_model['load'])))

        self.bus_df['METER_TYPE'] = pd.to_numeric(self.bus_df['METER_TYPE'], errors='coerce').fillna(0)

        self.nbus_df = len(self.bus_df)
        self.nbr_df = len(self.branch_df)

        # 填充branch_df中所有功率量测列的NaN值为0
        power_cols = [
            'P_PRE',
            'PA_PRE',
            'PB_PRE',
            'PC_PRE',
            'Q_PRE',
            'QA_PRE',
            'QB_PRE',
            'QC_PRE',
        ]
        self.branch_df[power_cols] = self.branch_df[power_cols].apply(lambda x: pd.to_numeric(x, errors='coerce').fillna(0))

        # 填充bus_df中所有电压和功率量测列的NaN值为0
        voltage_power_cols = [
            'VMA_PRE',
            'VMB_PRE',
            'VMC_PRE',
            'PA_PRE',
            'PB_PRE',
            'PC_PRE',
            'QA_PRE',
            'QB_PRE',
            'QC_PRE',
            'P_PRE',
            'Q_PRE',
        ]
        self.bus_df[voltage_power_cols] = self.bus_df[voltage_power_cols].apply(lambda x: pd.to_numeric(x, errors='coerce').fillna(0))

    def _create_nodes(self):
        """创建节点数据"""
        self.node = initialize_array('input', 'node', self.nbus_df)
        self.node['id'] = self.bus_df.loc[:, 'ID']

        self.node['u_rated'] = [self.cons_para.Ubase_low] * self.nbus_df

    def _create_lines(self):
        """创建支路数据"""
        nbr_df = self.nbr_df
        branch_df = self.branch_df
        nbus_df = self.nbus_df
        cons_para = self.cons_para

        # line
        L_r1 = list()
        L_x1 = list()
        L_r0 = list()
        L_x0 = list()

        for i_br in range(nbr_df):
            if str(branch_df.loc[i_br, 'BR_TYPE']).strip() == '1' or str(branch_df.loc[i_br, 'BR_TYPE']).strip() == '2' or str(branch_df.loc[i_br, 'BR_TYPE']).strip() == '6':
                L_r1.append(branch_df.loc[i_br, 'RAA'])
                L_r0.append(3 * branch_df.loc[i_br, 'RAA'])
                L_x1.append(branch_df.loc[i_br, 'XAA'])
                L_x0.append(3 * branch_df.loc[i_br, 'XAA'])
                continue

            if str(branch_df.loc[i_br, 'BR_TYPE']).strip() == '3' or str(branch_df.loc[i_br, 'BR_TYPE']).strip() == '5':
                if branch_df.loc[i_br, 'RAA'] < cons_para.Ra_disline_boundary:
                    L_r1.append(branch_df.loc[i_br, 'RAA'])
                    L_r0.append(3 * branch_df.loc[i_br, 'RAA'])
                if branch_df.loc[i_br, 'RAA'] >= cons_para.Ra_disline_boundary:
                    L_r1.append(cons_para.Ra_disline)
                    L_r0.append(3 * cons_para.Ra_disline)
                if branch_df.loc[i_br, 'XAA'] < cons_para.Xa_disline_boundary:
                    L_x1.append(branch_df.loc[i_br, 'XAA'])
                    L_x0.append(3 * branch_df.loc[i_br, 'XAA'])
                if branch_df.loc[i_br, 'XAA'] >= cons_para.Xa_disline_boundary:
                    L_x1.append(cons_para.Xa_disline)
                    L_x0.append(3 * cons_para.Xa_disline)
                continue

            if str(branch_df.loc[i_br, 'BR_TYPE']).strip() == '4':
                raa = float(branch_df.loc[i_br, 'RAA'])
                xaa = float(branch_df.loc[i_br, 'XAA'])
                if raa < cons_para.Ra_distrfm_boundary:
                    L_r1.append(raa)
                    L_r0.append(3 * raa)
                if raa >= cons_para.Ra_distrfm_boundary:
                    L_r1.append(cons_para.Ra_distrfm)
                    L_r0.append(3 * cons_para.Ra_distrfm)
                if xaa < cons_para.Xa_distrfm_boundary:
                    L_x1.append(xaa)
                    L_x0.append(3 * xaa)
                if xaa >= cons_para.Xa_distrfm_boundary:
                    L_x1.append(cons_para.Xa_distrfm)
                    L_x0.append(3 * cons_para.Xa_distrfm)
                continue

        line = initialize_array('input', 'line', nbr_df)
        line['id'] = list(range(nbus_df + 1, nbr_df + nbus_df + 1))
        line['from_node'] = branch_df.loc[:, 'INODE_ID']
        line['to_node'] = branch_df.loc[:, 'ZNODE_ID']
        line['from_status'] = [1] * nbr_df
        line['to_status'] = [1] * nbr_df
        line['r1'] = L_r1
        line['x1'] = L_x1
        line['c1'] = [0.0] * nbr_df
        line['tan1'] = [0.0] * nbr_df
        line['i_n'] = [1000] * nbr_df
        line['r0'] = L_r0
        line['x0'] = L_x0
        line['c0'] = [0.0] * nbr_df
        line['tan0'] = [0.0] * nbr_df

        self.line = line

    def _create_sym_load(self):
        """创建对称负载数据"""
        bus_df = self.bus_df
        nbus_df = self.nbus_df
        nbr_df = self.nbr_df
        power_error_df = self.power_error_df

        L_node = list()
        L_status = list()
        L_type = list()
        L_p_specified = list()
        L_q_specified = list()
        power_error_list = list()
        sum_feederload = np.sum(bus_df[['PA_PRE', 'PB_PRE', 'PC_PRE']].sum())

        if sum_feederload > self.cons_para.load_boundary:
            power_factor = 1
        else:
            power_factor = self.cons_para.power_factor

        self.cons_para.power_factor = power_factor

        for i_bus_df in range(nbus_df):
            pa_pre = float(bus_df.at[i_bus_df, 'PA_PRE'])
            pb_pre = float(bus_df.at[i_bus_df, 'PB_PRE'])
            pc_pre = float(bus_df.at[i_bus_df, 'PC_PRE'])
            p_pre = float(bus_df.at[i_bus_df, 'P_PRE'])
            p0 = float(bus_df.at[i_bus_df, 'P0'])
            qa_pre = float(bus_df.at[i_bus_df, 'QA_PRE'])
            qb_pre = float(bus_df.at[i_bus_df, 'QB_PRE'])
            qc_pre = float(bus_df.at[i_bus_df, 'QC_PRE'])
            q_pre = float(bus_df.at[i_bus_df, 'Q_PRE'])
            mva = float(bus_df.at[i_bus_df, 'MVA'])

            if (pa_pre + pb_pre + pc_pre) != 0:
                if abs(pa_pre + pb_pre + pc_pre) <= mva:
                    L_node.append(bus_df.at[i_bus_df, 'ID'])
                    L_status.append(1)
                    L_type.append(0)
                    L_p_specified.append((pa_pre + pb_pre + pc_pre + p0) * power_factor)
                    L_q_specified.append((qa_pre + qb_pre + qc_pre) * power_factor)
                if abs(pa_pre + pb_pre + pc_pre) > mva:
                    print(f'{bus_df.at[i_bus_df, "NAME"]}功率量测有误，超容量限值，已进行智能修复；')
                    L_node.append(bus_df.at[i_bus_df, 'ID'])
                    L_status.append(1)
                    L_type.append(0)
                    L_p_specified.append((mva * 0.75 * 0.95 + p0) * power_factor)
                    L_q_specified.append((mva * 0.3122 * 0.75) * power_factor)

                    ###根据功率超容修复同步更新bus_df
                    p_total_corrected = mva * 0.75 * 0.95
                    q_total_corrected = mva * 0.3122 * 0.75
                    non_zero_phases = sum([pa_pre != 0, pb_pre != 0, pc_pre != 0])
                    active_power_fields = ['PA_PRE', 'PB_PRE', 'PC_PRE']
                    reactive_power_fields = ['QA_PRE', 'QB_PRE', 'QC_PRE']
                    bus_df[active_power_fields] = bus_df[active_power_fields].astype(float)
                    bus_df[reactive_power_fields] = bus_df[reactive_power_fields].astype(float)

                    for i, phase_non_zero in enumerate([pa_pre != 0, pb_pre != 0, pc_pre != 0]):
                        if phase_non_zero:
                            bus_df.at[i_bus_df, active_power_fields[i]] = p_total_corrected / non_zero_phases
                            bus_df.at[i_bus_df, reactive_power_fields[i]] = q_total_corrected / non_zero_phases
                    bus_df.at[i_bus_df, 'P_PRE'] = p_total_corrected
                    bus_df.at[i_bus_df, 'Q_PRE'] = q_total_corrected

                    power_error_dict = {
                        'ID': bus_df.at[i_bus_df, 'ID'],
                        'ORI_ID': bus_df.at[i_bus_df, 'ORI_ID'],
                        'NAME': bus_df.at[i_bus_df, 'NAME'],
                        'MESSAGE': '功率量测有误，超容量限值，已进行智能修复',
                        'PA_PRE_ORIGINAL': pa_pre,
                        'PA_PRE_REPAIRED': bus_df.at[i_bus_df, 'PA_PRE'],
                        'PB_PRE_ORIGINAL': pb_pre,
                        'PB_PRE_REPAIRED': bus_df.at[i_bus_df, 'PB_PRE'],
                        'PC_PRE_ORIGINAL': pc_pre,
                        'PC_PRE_REPAIRED': bus_df.at[i_bus_df, 'PC_PRE'],
                        'P_PRE_ORIGINAL': p_pre,
                        'P_PRE_REPAIRED': bus_df.at[i_bus_df, 'P_PRE'],
                        'QA_PRE_ORIGINAL': qa_pre,
                        'QA_PRE_REPAIRED': bus_df.at[i_bus_df, 'QA_PRE'],
                        'QB_PRE_ORIGINAL': qb_pre,
                        'QB_PRE_REPAIRED': bus_df.at[i_bus_df, 'QB_PRE'],
                        'QC_PRE_ORIGINAL': qc_pre,
                        'QC_PRE_REPAIRED': bus_df.at[i_bus_df, 'QC_PRE'],
                        'Q_PRE_ORIGINAL': q_pre,
                        'Q_PRE_REPAIRED': bus_df.at[i_bus_df, 'Q_PRE'],
                        'RDF_ID': bus_df.at[i_bus_df, 'RDF_ID'],
                        'METER_TYPE': bus_df.at[i_bus_df, 'METER_TYPE'],
                        'IS_GF': bus_df.at[i_bus_df, 'IS_GF'],
                        'WITH_GF': bus_df.at[i_bus_df, 'WITH_GF'],
                        'METER_ID': bus_df.at[i_bus_df, 'METER_ID'],
                    }
                    power_error_list.append(power_error_dict)
                if abs(pa_pre + pb_pre + pc_pre) < 0.85 * abs(p_pre) or abs(pa_pre + pb_pre + pc_pre) > 1.15 * abs(p_pre):
                    power_error_dict = {
                        'ID': bus_df.at[i_bus_df, 'ID'],
                        'ORI_ID': bus_df.at[i_bus_df, 'ORI_ID'],
                        'NAME': bus_df.at[i_bus_df, 'NAME'],
                        'MESSAGE': '三相功率之和与总功率差值过大，以各相功率数值为准',
                        'PA_PRE_ORIGINAL': pa_pre,
                        'PA_PRE_REPAIRED': bus_df.at[i_bus_df, 'PA_PRE'],
                        'PB_PRE_ORIGINAL': pb_pre,
                        'PB_PRE_REPAIRED': bus_df.at[i_bus_df, 'PB_PRE'],
                        'PC_PRE_ORIGINAL': pc_pre,
                        'PC_PRE_REPAIRED': bus_df.at[i_bus_df, 'PC_PRE'],
                        'P_PRE_ORIGINAL': p_pre,
                        'P_PRE_REPAIRED': bus_df.at[i_bus_df, 'P_PRE'],
                        'QA_PRE_ORIGINAL': qa_pre,
                        'QA_PRE_REPAIRED': bus_df.at[i_bus_df, 'QA_PRE'],
                        'QB_PRE_ORIGINAL': qb_pre,
                        'QB_PRE_REPAIRED': bus_df.at[i_bus_df, 'QB_PRE'],
                        'QC_PRE_ORIGINAL': qc_pre,
                        'QC_PRE_REPAIRED': bus_df.at[i_bus_df, 'QC_PRE'],
                        'Q_PRE_ORIGINAL': q_pre,
                        'Q_PRE_REPAIRED': bus_df.at[i_bus_df, 'Q_PRE'],
                        'RDF_ID': bus_df.at[i_bus_df, 'RDF_ID'],
                        'METER_TYPE': bus_df.at[i_bus_df, 'METER_TYPE'],
                        'IS_GF': bus_df.at[i_bus_df, 'IS_GF'],
                        'WITH_GF': bus_df.at[i_bus_df, 'WITH_GF'],
                        'METER_ID': bus_df.at[i_bus_df, 'METER_ID'],
                    }
                    power_error_list.append(power_error_dict)

        power_error_df = pd.DataFrame(power_error_list, columns=self.power_error_df_fields)

        sym_load = initialize_array('input', 'sym_load', len(L_node))
        sym_load['id'] = list(range(nbr_df + nbus_df + 1, nbr_df + nbus_df + len(L_node) + 1))
        sym_load['node'] = L_node
        sym_load['status'] = L_status
        sym_load['type'] = L_type
        sym_load['p_specified'] = L_p_specified
        sym_load['q_specified'] = L_q_specified

        self.L_node = L_node
        self.L_p_specified = L_p_specified
        self.L_q_specified = L_q_specified
        self.sym_load = sym_load
        self.power_error_df = power_error_df

    def _create_source(self):
        """创建电源源数据"""
        #########################################################---获取平衡节点电压幅值start---######################################################
        cons_para = self.cons_para
        bus_df = self.bus_df
        nbr_df = self.nbr_df
        nbus_df = self.nbus_df
        L_node = self.L_node

        vma0 = cons_para.Ubase_low
        for ibus in range(1, len(bus_df)):
            if (
                bus_df.at[ibus, 'VMA_PRE'] * cons_para.voltage_input_factor >= 0.7 * cons_para.Ubase_low
                and bus_df.at[ibus, 'VMA_PRE'] * cons_para.voltage_input_factor <= 1.3 * cons_para.Ubase_low
                and bus_df.at[ibus, 'VMB_PRE'] * cons_para.voltage_input_factor >= 0.7 * cons_para.Ubase_low
                and bus_df.at[ibus, 'VMB_PRE'] * cons_para.voltage_input_factor <= 1.3 * cons_para.Ubase_low
                and bus_df.at[ibus, 'VMC_PRE'] * cons_para.voltage_input_factor >= 0.7 * cons_para.Ubase_low
                and bus_df.at[ibus, 'VMC_PRE'] * cons_para.voltage_input_factor <= 1.3 * cons_para.Ubase_low
            ):
                vma0 = bus_df.at[ibus, 'VMA_PRE'] * cons_para.voltage_input_factor
                break

        #########################################################---获取平衡节点电压幅值end---######################################################

        nsource = 1
        source = initialize_array('input', 'source', 1)
        source['id'] = [nbr_df + nbus_df + len(L_node) + nsource]
        source['node'] = [1]
        source['status'] = [1]
        source['u_ref'] = [vma0 / cons_para.Ubase_low]
        source['u_ref_angle'] = [0]

        self.source = source
        self.nsource = nsource

    def _create_asym_voltage_sensor(self):
        """创建不对称电压传感器数据"""
        cons_para = self.cons_para
        nbus_df = self.nbus_df
        nbr_df = self.nbr_df
        count_sym_vol_sen = 0
        A_sys_voltage_sensor_measured_object = list()
        A_sys_voltage_sensor_u_sigmma = list()
        A_sys_voltage_sensor_u_measured = list()
        for ibus in range(len(self.bus_df)):
            if (
                self.bus_df.at[ibus, 'VMA_PRE'] * cons_para.voltage_input_factor >= 0.7 * cons_para.Ubase_low
                and self.bus_df.at[ibus, 'VMA_PRE'] * cons_para.voltage_input_factor <= 1.3 * cons_para.Ubase_low
                and self.bus_df.at[ibus, 'VMB_PRE'] * cons_para.voltage_input_factor >= 0.7 * cons_para.Ubase_low
                and self.bus_df.at[ibus, 'VMB_PRE'] * cons_para.voltage_input_factor <= 1.3 * cons_para.Ubase_low
                and self.bus_df.at[ibus, 'VMC_PRE'] * cons_para.voltage_input_factor >= 0.7 * cons_para.Ubase_low
                and self.bus_df.at[ibus, 'VMC_PRE'] * cons_para.voltage_input_factor <= 1.3 * cons_para.Ubase_low
            ):
                A_sys_voltage_sensor_measured_object.append(self.bus_df.at[ibus, 'ID'])
                A_sys_voltage_sensor_u_sigmma.append(10)
                A_sys_voltage_sensor_u_measured.append(
                    [
                        self.bus_df.at[ibus, 'VMA_PRE'] * cons_para.voltage_input_factor,
                        self.bus_df.at[ibus, 'VMB_PRE'] * cons_para.voltage_input_factor,
                        self.bus_df.at[ibus, 'VMC_PRE'] * cons_para.voltage_input_factor,
                    ]
                )
                count_sym_vol_sen += 1

        if count_sym_vol_sen == 0:
            A_sys_voltage_sensor_measured_object.append(self.bus_df.at[0, 'ID'])
            A_sys_voltage_sensor_u_sigmma.append(10)
            A_sys_voltage_sensor_u_measured.append([self.cons_para.Ubase_low] * 3)
            count_sym_vol_sen += 1

        id_sym_vol_sen_fr = nbr_df + nbus_df + len(self.L_node) + self.nsource + 1
        id_sym_vol_sen_to = nbr_df + nbus_df + len(self.L_node) + self.nsource + count_sym_vol_sen + 1

        asym_voltage_sensor = initialize_array('input', 'asym_voltage_sensor', count_sym_vol_sen)
        asym_voltage_sensor['id'] = list(range(id_sym_vol_sen_fr, id_sym_vol_sen_to))
        asym_voltage_sensor['measured_object'] = A_sys_voltage_sensor_measured_object
        asym_voltage_sensor['u_sigma'] = A_sys_voltage_sensor_u_sigmma
        asym_voltage_sensor['u_measured'] = A_sys_voltage_sensor_u_measured

        self.count_sym_vol_sen = count_sym_vol_sen
        self.asym_voltage_sensor = asym_voltage_sensor

    def _create_sym_power_sensor(self):
        """创建对称功率传感器数据"""
        nbus_df = self.nbus_df
        nbr_df = self.nbr_df
        branch_df = self.branch_df
        L_node = self.L_node
        L_p_specified = self.L_p_specified
        L_q_specified = self.L_q_specified
        count_sym_vol_sen = self.count_sym_vol_sen

        nbr_meas = 0
        for ibr in range(nbr_df):
            if branch_df.at[ibr, 'PA_PRE'] != 0:
                nbr_meas += 1

        count_sym_power_sen = len(L_node) + nbr_meas  # 这里nbr_meas是支路功率量测，主要是电源点支路功率量测，即首端支路功率量测
        id_sym_power_sen_fr = nbr_df + nbus_df + len(L_node) + self.nsource + count_sym_vol_sen + 1
        id_sym_power_sen_to = nbr_df + nbus_df + len(L_node) + self.nsource + count_sym_vol_sen + 1 + count_sym_power_sen
        sym_power_sensor = initialize_array('input', 'sym_power_sensor', count_sym_power_sen)
        sym_power_sensor['id'] = list(range(id_sym_power_sen_fr, id_sym_power_sen_to))

        A_sym_power_sensor_measured_terminal_type = list()
        A_sym_power_sensor_power_sigma = list()

        A_sym_power_sensor_measured_object = list(
            range(
                nbr_df + nbus_df + 1,
                nbr_df + nbus_df + 1 + count_sym_power_sen - nbr_meas,
            )
        )

        for ibus in range(count_sym_power_sen - nbr_meas):
            A_sym_power_sensor_measured_terminal_type.append(MeasuredTerminalType.load)  # MeasuredTerminalType.load
            A_sym_power_sensor_power_sigma.append(self.cons_para.sensor_power_sigma)

        # 添加支路功率量测 line
        nbr_meas_count = 0
        line = self.line
        for ibr in range(nbr_df):
            if branch_df.at[ibr, 'PA_PRE'] != 0:
                A_sym_power_sensor_measured_object.append(line[ibr][0])
                L_p_specified.append(
                    (branch_df.at[ibr, 'PA_PRE'] + branch_df.at[ibr, 'PB_PRE'] + branch_df.at[ibr, 'PC_PRE']) * self.cons_para.power_factor
                )  # 支路有功功率量测值,kW转成W
                L_q_specified.append(
                    (branch_df.at[ibr, 'QA_PRE'] + branch_df.at[ibr, 'QB_PRE'] + branch_df.at[ibr, 'QC_PRE']) * self.cons_para.power_factor
                )  # 支路无功功率量测值，kVar转成Var
                A_sym_power_sensor_measured_terminal_type.append(MeasuredTerminalType.branch_from)
                A_sym_power_sensor_power_sigma.append(self.cons_para.sensor_branch_power_sigma)
                nbr_meas_count += 1

            if nbr_meas_count == nbr_meas:
                break

        sym_power_sensor['measured_object'] = A_sym_power_sensor_measured_object
        sym_power_sensor['measured_terminal_type'] = A_sym_power_sensor_measured_terminal_type
        sym_power_sensor['power_sigma'] = A_sym_power_sensor_power_sigma
        sym_power_sensor['p_measured'] = L_p_specified
        sym_power_sensor['q_measured'] = L_q_specified

        self.sym_power_sensor = sym_power_sensor

    def build_se(self):
        """构建完整模型"""
        self.build_base_network('se')

        return {
            'node': self.node,
            'line': self.line,
            'sym_load': self.sym_load,
            'source': self.source,
            'asym_voltage_sensor': self.asym_voltage_sensor,
            'sym_power_sensor': self.sym_power_sensor,
        }

    def build_olf(self):
        self.build_base_network('olf')
        return {
            'node': self.node,
            'line': self.line,
            'sym_load': self.sym_load,
            'source': self.source,
        }
