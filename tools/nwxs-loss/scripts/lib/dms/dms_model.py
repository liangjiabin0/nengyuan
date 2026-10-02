import os
import sys

# 设置路径
CUR_PATH = os.path.abspath(os.path.dirname(__file__))
lib_dir = os.path.dirname(CUR_PATH)
if lib_dir not in sys.path:
    sys.path.insert(0, lib_dir)

import pickle
from copy import deepcopy

import networkx as nx
import pandas as pd

from lib.helper.basic_utils import PicklableModule
from lib.helper.data_utils import is_number
from lib.helper.log import logger
from lib.mparser.efile_parser.efile import EFile


class DMSModelBase:
    def __init__(self):
        self.feeders = {}
        self.bvs = {}
        self.areas = {}
        self.sos = {}
        self.bulks = {}
        self.feeder_count = 0
        self.error_source = 0

        """
            topo_status:
                0：拓扑正常
                1: 馈线source_id在 dms_def_source中不存在
                2: 拓扑断连（节点数小于2）
                3：没有包含任何负荷
        """

        self.topo_status = {}
        self.table_prefix = ''
        self.tables_model_fields = {
            'basevoltage': {'model': ['ID', 'NOMVOL', 'RDF_ID'], 'meas': []},
            'dms_def_area': {'model': ['ID', 'NAME', 'RDF_ID'], 'meas': []},
            'dms_def_bulk': {
                'model': ['ID', 'AREA_ID', 'NAME', 'RDF_ID', 'ST_ID'],
                'meas': [],
            },
            'dms_def_feeder': {
                'model': ['ID', 'NAME', 'SOURCE_ID', 'RDF_ID', 'BULK_ID'],
                'meas': ['P_PRE', 'Q_PRE'],
            },
            'dms_def_source': {
                'model': ['ID', 'NAME', 'BULK_ID', 'BV_ID', 'NODE_ID'],
                'meas': [
                    'ID',
                    'VMA_PRE',
                    'VMB_PRE',
                    'VMC_PRE',
                    'VMA_WEIGHT',
                    'VMB_WEIGHT',
                    'VMC_WEIGHT',
                    'PA_PRE',
                    'PB_PRE',
                    'PC_PRE',
                    'PA_WEIGHT',
                    'PB_WEIGHT',
                    'PC_WEIGHT',
                    'QA_PRE',
                    'QB_PRE',
                    'QC_PRE',
                    'QA_WEIGHT',
                    'QB_WEIGHT',
                    'QC_WEIGHT',
                    'P_PRE',
                    'Q_PRE',
                ],
            },
            'dms_def_node': {
                'model': ['ID', 'NAME', 'BV_ID', 'FEEDER_ID', 'SG_ID'],
                'meas': [
                    'ID',
                    'FEEDER_ID',
                    'VMA_PRE',
                    'VMB_PRE',
                    'VMC_PRE',
                    'VMA_WEIGHT',
                    'VMB_WEIGHT',
                    'VMC_WEIGHT',
                ],
            },
            'dms_def_lnseg': {
                'model': [
                    'ID',
                    'NAME',
                    'BV_ID',
                    'FEEDER_ID',
                    'MVA',
                    'LENGTH',
                    'RUN_STATE',
                    'PHA',
                    'PHB',
                    'PHC',
                    'RDF_ID',
                    'RAA',
                    'XAA',
                    'ITERMINAL_ID',
                    'ZTERMINAL_ID',
                    'INODE_ID',
                    'ZNODE_ID',
                ],
                'meas': ['ID', 'FEEDER_ID', 'ITERMINAL_ID', 'ZTERMINAL_ID'],
            },
            'dms_def_lnseg_dot': {
                'model': ['ID', 'NAME', 'NODE_ID'],
                'meas': [
                    'ID',
                    'PA_PRE',
                    'PB_PRE',
                    'PC_PRE',
                    'PA_WEIGHT',
                    'PB_WEIGHT',
                    'PC_WEIGHT',
                    'QA_PRE',
                    'QB_PRE',
                    'QC_PRE',
                    'QA_WEIGHT',
                    'QB_WEIGHT',
                    'QC_WEIGHT',
                    'P_PRE',
                    'Q_PRE',
                    'IMA_PRE',
                    'IMB_PRE',
                    'IMC_PRE',
                    'IMA_WEIGHT',
                    'IMB_WEIGHT',
                    'IMC_WEIGHT',
                    'VMA_PRE',
                    'VMB_PRE',
                    'VMC_PRE',
                    'VMA_WEIGHT',
                    'VMB_WEIGHT',
                    'VMC_WEIGHT',
                ],
            },
            'dms_def_trfm': {
                'model': [
                    'ID',
                    'NAME',
                    'FEEDER_ID',
                    'MVA',
                    'RUN_STATE',
                    'PHA',
                    'PHB',
                    'PHC',
                    'RDF_ID',
                    'P0',
                    'PK',
                    'WITH_GF',
                ],
                'meas': [],
            },
            'dms_def_trwd': {
                'model': [
                    'ID',
                    'NAME',
                    'TRFM_ID',
                    'FEEDER_ID',
                    'MVA',
                    'BV_ID',
                    'NODE_ID',
                    'RAA',
                    'XAA',
                    'PHA',
                    'PHB',
                    'PHC',
                    'RDF_ID',
                ],
                'meas': [
                    'ID',
                    'FEEDER_ID',
                    'PA',
                    'PB',
                    'PC',
                    'QA',
                    'QB',
                    'QC',
                    'PA_PRE',
                    'PB_PRE',
                    'PC_PRE',
                    'PA_WEIGHT',
                    'PB_WEIGHT',
                    'PC_WEIGHT',
                    'QA_PRE',
                    'QB_PRE',
                    'QC_PRE',
                    'QA_WEIGHT',
                    'QB_WEIGHT',
                    'QC_WEIGHT',
                    'IMA_PRE',
                    'IMB_PRE',
                    'IMC_PRE',
                    'IMA_WEIGHT',
                    'IMB_WEIGHT',
                    'IMC_WEIGHT',
                    'VMA_PRE',
                    'VMB_PRE',
                    'VMC_PRE',
                    'VMA_WEIGHT',
                    'VMB_WEIGHT',
                    'VMC_WEIGHT',
                    'P_PRE',
                    'Q_PRE',
                    'P_WEIGHT',
                    'Q_WEIGHT',
                ],
            },
            'dms_def_load': {
                'model': [
                    'ID',
                    'NAME',
                    'BV_ID',
                    'FEEDER_ID',
                    'NODE_ID',
                    'ITERMINAL_ID',
                    'MVA',
                    'BV_ID',
                    'RDF_ID',
                    'PHA',
                    'PHB',
                    'PHC',
                    'METER_TYPE',
                    'IS_GF',
                    'METER_ID',
                    'WITH_GF',
                ],
                'meas': [
                    'ID',
                    'FEEDER_ID',
                    'PA_PRE',
                    'PB_PRE',
                    'PC_PRE',
                    'PA_WEIGHT',
                    'PB_WEIGHT',
                    'PC_WEIGHT',
                    'QA_PRE',
                    'QB_PRE',
                    'QC_PRE',
                    'QA_WEIGHT',
                    'QB_WEIGHT',
                    'QC_WEIGHT',
                    'PA_SET',
                    'PB_SET',
                    'PC_SET',
                    'QA_SET',
                    'QB_SET',
                    'QC_SET',
                    'P_PRE',
                    'Q_PRE',
                    'VMA_PRE',
                    'VMB_PRE',
                    'VMC_PRE',
                    'VMA_WEIGHT',
                    'VMB_WEIGHT',
                    'VMC_WEIGHT',
                ],
            },
            'dms_def_cb': {
                'model': [
                    'ID',
                    'NAME',
                    'BV_ID',
                    'FEEDER_ID',
                    'RUN_STATE',
                    'RDF_ID',
                    'INODE_ID',
                    'ZNODE_ID',
                    'ITERMINAL_ID',
                    'ZTERMINAL_ID',
                ],
                'meas': [
                    'ID',
                    'FEEDER_ID',
                    'PHA',
                    'PHB',
                    'PHC',
                    'IMA_PRE',
                    'IMB_PRE',
                    'IMC_PRE',
                    'IMA_WEIGHT',
                    'IMB_WEIGHT',
                    'IMC_WEIGHT',
                    'P',
                    'P_PRE',
                    'Q',
                    'Q_PRE',
                    'PA',
                    'PB',
                    'PC',
                    'PA_PRE',
                    'PB_PRE',
                    'PC_PRE',
                    'QA',
                    'QA_PRE',
                    'QB',
                    'QB_PRE',
                    'QC',
                    'QC_PRE',
                ],
            },
            'dms_def_qs': {
                'model': [
                    'ID',
                    'NAME',
                    'BV_ID',
                    'FEEDER_ID',
                    'INODE_ID',
                    'ZNODE_ID',
                    'ITERMINAL_ID',
                    'ZTERMINAL_ID',
                    'RUN_STATE',
                    'RDF_ID',
                ],
                'meas': [
                    'ID',
                    'FEEDER_ID',
                    'PHA',
                    'PHB',
                    'PHC',
                    'IMA_PRE',
                    'IMB_PRE',
                    'IMC_PRE',
                    'IMA_WEIGHT',
                    'IMB_WEIGHT',
                    'IMC_WEIGHT',
                ],
            },
            'dms_def_switchgear': {'model': ['ID', 'NAME', 'FEEDER_ID'], 'meas': []},
            'dms_def_unit': {
                'model': ['ID', 'NAME', 'FEEDER_ID', 'NODE_ID', 'GN_TYPE'],
                'meas': ['ACTIVE_E', 'REACTIVE_E', 'P', 'Q'],
            },
            'dms_def_es': {
                'model': [
                    'ID',
                    'NAME',
                    'RDF_ID',
                    'FEEDER_ID',
                    'BULK_ID',
                    'NODE_ID',
                    'DEV_TYPE',
                ],
                'meas': [],
            },
        }
        self.source_type = None
        self.source_field_lower = False
        self.calc_target = 'se'  # se olf loss
        self.calc_model = 'dms'  # dms taiqu
        self.has_cycle = {}
        self.error_devs = {}
        self.tables_model = {}
        self.default_bv_id = 0

        self.feeder_errors = {'p0_pk_raa_xaa_mva': []}

        self.cons_para = None

        self.island = {}

    # 设置计算目标，可选项： se olf loss
    def set_calc_target(self, target):
        self.calc_target = target

    # 设置计算模型，可选项： dms taiqu
    def set_calc_model(self, model):
        self.calc_model = model

        if self.cons_para is None:
            self.set_cons_para()

    def set_cons_para(self, cons_para=None):
        if cons_para is None:
            if self.calc_model == 'dms':
                self.cons_para = PicklableModule('dms.dms_cons_para')
            elif self.calc_model == 'taiqu':
                self.cons_para = PicklableModule('dms.taiqu_cons_para')
            else:
                raise Exception(f'[ERROR] calc model {self.calc_model} is not supported')
        else:
            try:
                self.cons_para = PicklableModule(cons_para)
            except Exception as e:
                raise Exception(f'[ERROR] failed to import cons_para module {cons_para}: {e}')

    # 设置表名前缀，相对于 self.tables_model_fields 的表名
    def set_prefix(self, prefix):
        self.table_prefix = prefix

    # 数据源的字段是小写
    def set_source_field_lower(self):
        self.source_field_lower = True

    """
    该方法用于配置模型的数据源，支持多种数据源类型：
        * Dict:  source_type = dict , data
        * DataFrame（Pandas）:  source_type = dataframe , data
        * 实时数据库（RTDB）:  source_type = rtdb , schema, app, ctx
        * SQLAlchemy 数据库:  source_type = db, db = url 或 engine
        * 金仓 V7 数据库:  source_type = kingbase_v7, url, user, password, driver_class, jar_file
        * 阿里云 ODPS:  source_type = odps , odps = o
    """

    def set_source(self, source_type=None, **kwargs):
        self.source_type = source_type

        if source_type == 'efile':
            from mparser.efile_parser.efile import EFile

            if 'file' in kwargs:
                file = kwargs['file']
                if type(file) is str:
                    self.source_data = EFile()
                    if 'encoding' in kwargs:
                        self.source_data.read_from_file(file, encoding=kwargs['encoding'])
                    else:
                        self.source_data.read_from_file(file)
                elif type(file) is EFile:
                    self.source_data = file
                else:
                    raise Exception(f'[ERROR] source data is not a dict: {file}')
            else:
                raise Exception(f'[ERROR] source data is not provided: {kwargs}')

        # 数据源是 dataframe， 例如: 线损项目
        elif source_type == 'dict':
            if 'data' in kwargs:
                data = kwargs['data']
                if type(data) is dict:
                    self.source_data = deepcopy(data)
                else:
                    raise Exception(f'[ERROR] source data is not a dict: {data}')
            else:
                raise Exception(f'[ERROR] source data is not provided: {kwargs}')

        # 数据源是 dataframe， 例如: 线损项目
        elif source_type == 'dataframe':
            if 'data' in kwargs:
                data = kwargs['data']
                if type(data) is dict:
                    self.source_data = deepcopy(data)
                else:
                    raise Exception(f'[ERROR] source data is not a dict: {data}')
            else:
                raise Exception(f'[ERROR] source data is not provided: {kwargs}')

        # 数据源是 实时库，例如: 拓扑成图
        elif source_type == 'rtdb':
            from rtdb.rtdb import RTDB

            if 'schema' in kwargs and 'app' in kwargs and 'ctx' in kwargs:
                self.schema = kwargs['schema']
                self.app = kwargs['app']
                self.ctx = kwargs['ctx']

                if self.schema and self.app and self.ctx:
                    from rtdb.rtdb import RTDB

                    rtdb = RTDB()
                    rtdb.init(self.schema, self.app, self.ctx)
                    self.source_data = rtdb
                else:
                    raise Exception(f'[ERROR] schema, app, ctx 要求非空: {self.schema} {self.app} {self.ctx}')
            else:
                raise Exception(f'[ERROR] schema, app, ctx are not provided: {kwargs}')

        # 数据源是支持 sqlalchemy 的商用数据库
        elif source_type == 'db':
            if 'db' in kwargs:
                db = kwargs['db']
                from sqlalchemy import Engine

                if type(db) is str:
                    self.db_url = db
                    from sqlalchemy import create_engine

                    self.source_data = create_engine(self.db_url)
                elif isinstance(db, Engine):
                    url = db.url
                    engine_url = f'{url.drivername}://{url.username}:{url.password}@{url.host}:{url.port}/{url.database}'
                    self.db_url = engine_url
                    self.source_data = db
                else:
                    raise Exception(f'[ERROR] db is not a sqlalchemy.Engine: {self.db_url}')

        # 数据库是 金仓V7 版本
        # url = 'jdbc:kingbase://192.167.1.5:54321/DEMS_REAL'
        # user = 'DEMS'
        # password = "YOUR_PASSWORD"
        # driver_class = 'com.kingbase.Driver'
        # jar_file = '/opt/tsysmart/Kingbase/ES/V7/jdbc/kingbasejdbc4.jar'
        # engine_real = jaydebeapi.connect(driver_class, url, [user, password], jar_file)
        elif source_type == 'kingbase_v7':
            import jaydebeapi

            if 'url' in kwargs and 'user' in kwargs and 'password' in kwargs and 'driver_class' in kwargs and 'jar_file' in kwargs:
                self.url = kwargs['url']
                self.user = kwargs['user']
                self.password = kwargs['password']
                self.driver_class = kwargs['driver_class']
                self.jar_file = kwargs['jar_file']

                if self.url and self.user and self.password and self.driver_class and self.jar_file:
                    self.source_data = jaydebeapi.connect(
                        kwargs['driver_class'],
                        kwargs['url'],
                        [kwargs['user'], kwargs['password']],
                        kwargs['jar_file'],
                    )
                else:
                    raise Exception(f'[ERROR] url, user, password, driver_class, jar_file are not provided: {kwargs}')
            else:
                raise Exception(f'[ERROR] url, user, password, driver_class, jar_file are not provided: {kwargs}')

        # 数据源是 阿里云 odps
        elif source_type == 'odps':
            if 'odps' in kwargs:
                odps = kwargs['odps']
                if odps:
                    self.source_data = odps
                else:
                    raise Exception(f'[ERROR] odps is not provided: {kwargs}')

        else:
            raise Exception(f'[ERROR] source type is not supported: {source_type}')

    def get_model_fields(self, table):
        fields = []
        for i in self.tables_model_fields[table]['model'] + self.tables_model_fields[table]['meas']:
            if i not in fields:
                fields.append(i)

        return fields

    def get_meas_fields(self, table):
        fields = []
        for i in self.tables_model_fields[table]['meas']:
            if i not in fields:
                fields.append(i)

        if self.source_field_lower:
            return [f.lower() for f in fields]
        else:
            return fields

    # 补全缺失字段
    def table_fields_complete_check_repair(self):
        default_value = {
            'Line': {
                'RAA': self.cons_para.Ra_disline,
                'XAA': self.cons_para.Xa_disline,
            },
            'Transformer': {'P0': self.cons_para.p0, 'PK': self.cons_para.pk, 'MVA': self.cons_para.Mva_distrfm},
            'Transformerwinding': {
                'RAA': self.cons_para.Ra_distrfm,
                'XAA': self.cons_para.Xa_distrfm,
            },
        }

        boundary_value = {
            'Line': {
                'RAA': self.cons_para.Ra_disline_boundary,
                'XAA': self.cons_para.Xa_disline_boundary,
            },
            'Transformer': {'P0': self.cons_para.p0_boundary, 'PK': self.cons_para.pk_boundary, 'MVA': self.cons_para.Mva_distrfm_boundary},
            'Transformerwinding': {
                'RAA': self.cons_para.Ra_distrfm_boundary,
                'XAA': self.cons_para.Xa_distrfm_boundary,
            },
        }

        for table_name in self.tables_model:
            table_data_list = self.tables_model[table_name]

            fields = self.get_model_fields(table_name)

            # 补全缺失字段，默认值0
            if table_name.endswith('_lnseg'):
                equip_type = 'Line'
            elif table_name.endswith('_trfm'):
                equip_type = 'Transformer'
            elif table_name.endswith('_trwd'):
                equip_type = 'Transformerwinding'
            else:
                equip_type = None

            for row in table_data_list:
                for field in fields:
                    if field not in row:
                        if equip_type and field in ['RAA', 'XAA', 'P0', 'PK', 'MVA'] and field in default_value[equip_type]:
                            self.feeder_errors['p0_pk_raa_xaa_mva'].append(
                                {
                                    'equip_type': equip_type,
                                    'equip_id': row['ID'],
                                    'equip_name': row.get('NAME', row['ID']),
                                    'feeder_id': row['FEEDER_ID'],
                                    'prop_name': field,
                                    'prop_original_value': None,
                                    'prop_new_value': default_value[equip_type][field],
                                    'prop_change_reason': '数据缺失',
                                }
                            )
                            row[field] = default_value[equip_type][field]
                        else:
                            row[field] = 0
                    else:
                        if equip_type and field in ['RAA', 'XAA', 'P0', 'PK', 'MVA'] and field in default_value[equip_type]:
                            error_dict = {
                                'equip_type': equip_type,
                                'equip_id': row['ID'],
                                'equip_name': row.get('NAME', row['ID']),
                                'feeder_id': row['FEEDER_ID'],
                                'prop_name': field,
                                'prop_original_value': row[field],
                            }

                            prop_new_value = default_value[equip_type][field]

                            if not row[field] or float(row[field]) == 0:
                                error_dict['prop_new_value'] = prop_new_value
                                error_dict['prop_change_reason'] = '数据不合理'
                                self.feeder_errors['p0_pk_raa_xaa_mva'].append(error_dict)

                                row[field] = prop_new_value

                            elif float(row[field]) > boundary_value[equip_type][field]:
                                error_dict['prop_new_value'] = prop_new_value
                                error_dict['prop_change_reason'] = '数据不合理'
                                self.feeder_errors['p0_pk_raa_xaa_mva'].append(error_dict)

                                row[field] = prop_new_value

            self.tables_model[table_name] = table_data_list

    def get_table_model(self, table, feeder_ids=None):
        fields = self.get_model_fields(table)
        table = self.table_prefix + table

        if self.source_field_lower:
            source_fields = [f.lower() for f in fields]
        else:
            source_fields = [f.upper() for f in fields]

        # 此时 res 的字段已经都转换为大写了
        res = self.get_table_data(table, source_fields, feeder_ids=feeder_ids)

        return res

    def get_table_meas(self, table, fields=None):
        fields = fields or self.get_meas_fields(table)
        table = self.table_prefix + table
        return self.get_table_data(table, fields)

    def get_table_data(self, table, fields, feeder_ids=None):
        # 如果指定了 feeder_ids，只返回这些 feeder_id 的数据
        if self.source_field_lower:
            key_func = str.upper
        else:

            def key_func(x):
                return x

        if table == f'{self.table_prefix}dms_def_feeder':
            candidates = 'id'
        else:
            candidates = 'feeder_id'

        if not self.source_field_lower:
            candidates = str.upper(candidates)

        if feeder_ids is not None:
            feeder_ids = [str(i) for i in feeder_ids]

        # 从不同数据源中获取表数据
        if self.source_type == 'efile':
            table_data = self.source_data.get_table(table)
            if table_data is None:
                logger.warning(f'表 {table} 不存在')
                return []

            feeder_id_field = candidates if candidates in table_data.fields else None
            res = []
            for i in table_data:
                if (feeder_ids and feeder_id_field and i[feeder_id_field] in feeder_ids) or (not feeder_ids or not feeder_id_field):
                    res.append({key_func(k): v for k, v in i.items() if k in fields})
            return res
        elif self.source_type == 'dict':
            if table not in self.source_data:
                logger.warning(f'表 {table} 不存在')
                return []
            table_data = self.source_data[table]
            if len(table_data) == 0:
                logger.warning(f'表 {table} 为空')
                return []

            feeder_id_field = candidates if candidates in table_data[0] else None
            res = []
            for i in table_data:
                if (feeder_ids and feeder_id_field and i[feeder_id_field] in feeder_ids) or (not feeder_ids or not feeder_id_field):
                    res.append({key_func(k): v for k, v in i.items() if k in fields})
            return res

        elif self.source_type == 'dataframe':
            if table not in self.source_data:
                logger.warning(f'表 {table} 不存在')
                return []

            feeder_id_field = candidates if candidates in self.source_data[table].columns else None

            if feeder_ids is not None and feeder_id_field is not None:
                source_table = self.source_data[table][self.source_data[table][feeder_id_field].isin(feeder_ids)]
            else:
                source_table = self.source_data[table]
            cols = [col for col in source_table.columns if col in fields]
            table_data = source_table[cols]

            if self.source_field_lower:
                table_data.columns = [k.upper() for k in table_data.columns]

            return table_data.to_dict('records')
        else:
            # 先查找数据库这个表有哪些字段
            common_sql = f'select {",".join(fields)} from {table}'
            if ('feeder_id' in fields or 'FEEDER_ID' in fields) and feeder_ids is not None:
                common_sql = common_sql + f' where feeder_id in ({",".join(map(str, feeder_ids))})'
            elif table == f'{self.table_prefix}dms_def_feeder' and feeder_ids is not None:
                common_sql = common_sql + f' where id in ({",".join(map(str, feeder_ids))})'
            if self.source_type == 'rtdb':

                def query_table_fields_in_rtdb(table_name):
                    from rtdb.rtdb import RTDB

                    rtdb_main = RTDB()
                    rtdb_main.init('main', 'public', 'real')
                    table_id = rtdb_main.select_one('sys_table_info', 'table_id', f"table_name_eng='{table_name}'")
                    if table_id is None:
                        return []
                    table_id = table_id['table_id']
                    db_fields = rtdb_main.select('sys_column_info', 'column_name_eng', f'table_id={table_id}')
                    db_fields = [f['column_name_eng'] for f in db_fields]
                    return db_fields

                db_fields = query_table_fields_in_rtdb(table)
                query_fields = [f for f in fields if f in db_fields]
                common_sql = f'select {",".join(query_fields)} from {table}'
                # 实时库sql语句长度限制，如果需要指定一些馈线计算，采取分批量查询的方式
                if ('feeder_id' in fields or 'FEEDER_ID' in fields or table == f'{self.table_prefix}dms_def_feeder') and feeder_ids is not None:
                    batch_size = 50
                    id_filed = 'id' if table == f'{self.table_prefix}dms_def_feeder' else 'feeder_id'
                    table_data = []
                    for i in range(0, len(feeder_ids), batch_size):
                        batch_ids = feeder_ids[i : i + batch_size]
                        batch_sql = common_sql + f' where {id_filed} in ({",".join(map(str, batch_ids))})'
                        # print(batch_sql)
                        batch_data = self.source_data.query(batch_sql)
                        table_data.extend(batch_data)
                else:
                    table_data = self.source_data.query(common_sql)
            elif self.source_type == 'db':
                from sqlalchemy import text

                def table_exists(connection, table_name):
                    check_sql = f"SELECT COUNT(*) FROM information_schema.tables WHERE table_name = '{table_name}'"
                    result = connection.execute(text(check_sql)).scalar()
                    return result > 0

                with self.source_data.connect() as conn:
                    if not table_exists(conn, table):
                        logger.warning(f'表 {table} 不存在')
                        table_data = []
                    else:
                        fields_sql = f'SHOW COLUMNS FROM {table}'

                        result = conn.execute(text(fields_sql)).fetchall()
                        fields_from_db = [row[0] for row in result]
                        fields = [field for field in fields if field in fields_from_db]
                        common_sql = f'select {",".join(fields)} from {table}'
                        if ('feeder_id' in fields or 'FEEDER_ID' in fields) and feeder_ids is not None:
                            common_sql = common_sql + f' where feeder_id in ({",".join(map(str, feeder_ids))})'
                        elif table == f'{self.table_prefix}dms_def_feeder' and feeder_ids is not None:
                            common_sql = common_sql + f' where id in ({",".join(map(str, feeder_ids))})'
                        try:
                            result = conn.execute(text(common_sql)).mappings().fetchall()
                            table_data = [dict(row) for row in result]
                        except Exception as e:
                            logger.error(f'{e}')
                            table_data = []
            elif self.source_type == 'kingbase_v7':
                cursor = self.source_data.cursor()
                data = cursor.execute(common_sql).fetchall()
                columns = [column[0] for column in cursor.description]
                data = dict(zip(columns, data))
                cursor.close()
                table_data = data
            elif self.source_type == 'odps':
                global o
                table_data = o.execute_sql(common_sql).open_reader()
            else:
                raise Exception(f'[ERROR] 不支持该数据源: {self.source_type}')
            table_data = [{k: i.get(k) if k in i else i.get(k.lower()) for k in fields} for i in table_data]
            if self.source_field_lower:
                res = []
                for i in table_data:
                    res.append({k.upper(): v for k, v in i.items()})
                return res
            else:
                return table_data

    def get_all_table_model(self, force=False, feeder_ids=None):
        for table in self.tables_model_fields:
            if force or table not in self.tables_model:
                self.tables_model[table] = self.get_table_model(table, feeder_ids=feeder_ids)
                if len(self.tables_model[table]) == 0:
                    logger.warning(f'{table} 为空，请检查是否缺失数据！')

    def read_model(self, feeder_ids=None):
        if self.cons_para is None:
            self.set_cons_para()

        # 读取所有表的数据
        self.get_all_table_model(force=False, feeder_ids=feeder_ids)

        self.table_fields_complete_check_repair()

        # ======================================================================================================================
        # =========== 对于配网：  area=省/市/公司，bulk=变电站, feeder=馈线, source=10kV母线，名称通常和feeder相同
        # =========== 对于台区：  area=省/市/公司，bulk=馈线,   feeder=台区, source=虚拟节点，后面接配变高压端，名称通常和配变相同
        # ======================================================================================================================

        # ===================================== dms_def_area ===========================================
        if len(self.tables_model['dms_def_area']) == 0:
            logger.warning('dms_def_area 为空，填充默认值！')
            self.areas[0] = {'RDF_ID': '0', 'NAME': '默认区域'}
        else:
            for area in self.tables_model['dms_def_area']:
                self.areas[area['ID']] = {'RDF_ID': area['RDF_ID'], 'NAME': area['NAME']}

        # ===================================== basevoltage ===========================================
        if len(self.tables_model['basevoltage']) == 0:
            # 如果没有提供 basevoltage 表，则根据 calc_model 填充一条默认数据
            logger.warning('basevoltage 为空，填充默认值！')
            if self.calc_model == 'taiqu':
                self.bvs[0] = 0.38
            else:
                self.bvs[0] = 10.5
        else:
            for bv in self.tables_model['basevoltage']:
                self.bvs[bv['ID']] = bv['NOMVOL']

        # ===================================== dms_def_bulk ===========================================
        if len(self.tables_model['dms_def_bulk']) == 0:
            logger.warning('dms_def_bulk 为空，填充默认值！')
            self.bulks[0] = {'RDF_ID': '0', 'NAME': '默认变电站', 'AREA_ID': 0, 'ST_ID': 0}
        else:
            for bulk in self.tables_model['dms_def_bulk']:
                if 'AREA_ID' not in bulk or bulk['AREA_ID'] is None:
                    if len(self.areas) == 1:
                        bulk['AREA_ID'] = list(self.areas.keys())[0]

                self.bulks[bulk['ID']] = {
                    'RDF_ID': bulk['RDF_ID'],
                    'NAME': bulk['NAME'],
                    'AREA_ID': bulk['AREA_ID'],
                    'ST_ID': bulk['ST_ID'],
                }

        # ===================================== dms_def_source ===========================================
        if len(self.tables_model['dms_def_source']) == 0:
            if self.calc_model == 'taiqu':
                logger.warning('dms_def_source 为空，填充默认值！')
                for i, feeder in enumerate(self.tables_model['dms_def_feeder']):
                    so = {}
                    for field in self.get_model_fields('dms_def_source'):
                        so[field] = 0

                    so['FEEDER_ID'] = feeder['ID']
                    so['ID'] = i
                    feeder['SOURCE_ID'] = so['ID']

                    self.sos[so['ID']] = {
                        'ST_ID': 0,
                        'FEEDER_ID': feeder['ID'],
                        'BV_ID': 0,
                        'BULK_ID': feeder['BULK_ID'],
                        'SO': dict(so),
                        'IS_VIRTUAL': True,
                    }

            elif self.calc_model == 'dms':
                logger.error('dms_def_source 为空，且 calc_model 为配网！')
        else:
            for so in self.tables_model['dms_def_source']:
                if int(so['BV_ID']) > 0 and so['BULK_ID'] in self.bulks:
                    self.sos[so['ID']] = {
                        'ST_ID': self.bulks[so['BULK_ID']]['ST_ID'],
                        'FEEDER_ID': 0,
                        'BV_ID': so['BV_ID'],
                        'BULK_ID': so['BULK_ID'],
                        'SO': dict(so),
                        'IS_VIRTUAL': False,
                    }

        for feeder in self.tables_model['dms_def_feeder']:
            self.feeder_count += 1
            if feeder['SOURCE_ID'] in self.sos:
                # if feeder['SOURCE_ID'] in self.sos:
                self.sos[feeder['SOURCE_ID']]['FEEDER_ID'] = feeder['ID']
                so = dict(self.sos[feeder['SOURCE_ID']]['SO'])
                self.feeders[feeder['ID']] = {
                    'FEEDER_ID': feeder['ID'],
                    'FEEDER_NAME': feeder['NAME'],
                    'SOURCE_ID': feeder['SOURCE_ID'],
                    'RDF_ID': feeder['RDF_ID'],
                    'ST_ID': self.sos[feeder['SOURCE_ID']]['ST_ID'],
                    'BULK_ID': self.sos[feeder['SOURCE_ID']]['BULK_ID'],
                    'BULK_NAME': self.bulks[self.sos[feeder['SOURCE_ID']]['BULK_ID']]['NAME'],
                    'BULK_RDFID': self.bulks[self.sos[feeder['SOURCE_ID']]['BULK_ID']]['RDF_ID'],
                    'AREA_NAME': self.areas[self.bulks[self.sos[feeder['SOURCE_ID']]['BULK_ID']]['AREA_ID']]['NAME'],
                    'AREA_RDFID': self.areas[self.bulks[self.sos[feeder['SOURCE_ID']]['BULK_ID']]['AREA_ID']]['RDF_ID'],
                    'BV_ID': self.sos[feeder['SOURCE_ID']]['BV_ID'],
                    'so': so,
                    'node': {},
                    'lnseg': {},
                    'lnseg_dot': {},
                    'trfm': {},
                    'trwd': {},
                    'load': {},
                    'cb': {},
                    'qs': {},
                    'links': {},
                    'sg': {},
                    'unit': {},
                    'es': {},
                    'net': None,
                    'invalid': False,
                    'subcount': 0,
                    'bvs': self.bvs,
                    'bulks': self.bulks,
                    'calc_model': self.calc_model,
                }
                so['TYPE'] = 'so'
                self.feeders[feeder['ID']]['links'][so['NODE_ID']] = {so['ID']: so}
                self.topo_status[feeder['ID']] = 0
            else:
                logger.error(f'feeder source_id not in sos : {feeder["SOURCE_ID"]}')
                self.topo_status[feeder['ID']] = 1
        # print('\t[FINISH] dms_dms_def_feeder')

        node_new_id = 0
        for node in self.tables_model['dms_def_node']:
            node['TYPE'] = 'node'
            if is_number(node['ID']):
                node_new_id = max(node_new_id, int(node['ID']))
            if node['FEEDER_ID'] in self.feeders:
                self.feeders[node['FEEDER_ID']]['node'][node['ID']] = dict(node)

                if node['ID'] not in self.feeders[node['FEEDER_ID']]['links']:
                    self.feeders[node['FEEDER_ID']]['links'][node['ID']] = {}
        node_new_id += 1
        # print('\t[FINISH] dms_dms_def_node')

        lnseg_dots = {}
        inode_and_znode = {}
        for lnseg in self.tables_model['dms_def_lnseg']:
            if lnseg['INODE_ID'] == lnseg['ZNODE_ID']:
                continue

            if lnseg['FEEDER_ID'] in self.feeders:
                lnseg = dict(lnseg)
                lnseg['TYPE'] = 'lnseg'

                if (lnseg['INODE_ID'], lnseg['ZNODE_ID']) not in inode_and_znode:
                    inode_and_znode[(lnseg['INODE_ID'], lnseg['ZNODE_ID'])] = {}
                else:
                    continue

                self.feeders[lnseg['FEEDER_ID']]['lnseg'][lnseg['ID']] = lnseg
                if 'ITERMINAL_ID' in lnseg and 'ZTERMINAL_ID' in lnseg:
                    lnseg_dots[lnseg['ITERMINAL_ID']] = self.feeders[lnseg['FEEDER_ID']]['lnseg_dot']
                    lnseg_dots[lnseg['ZTERMINAL_ID']] = self.feeders[lnseg['FEEDER_ID']]['lnseg_dot']

                if lnseg['INODE_ID'] not in self.feeders[lnseg['FEEDER_ID']]['links']:
                    self.feeders[lnseg['FEEDER_ID']]['links'][lnseg['INODE_ID']] = {}
                self.feeders[lnseg['FEEDER_ID']]['links'][lnseg['INODE_ID']][lnseg['ID']] = lnseg

                if lnseg['ZNODE_ID'] not in self.feeders[lnseg['FEEDER_ID']]['links']:
                    self.feeders[lnseg['FEEDER_ID']]['links'][lnseg['ZNODE_ID']] = {}
                self.feeders[lnseg['FEEDER_ID']]['links'][lnseg['ZNODE_ID']][lnseg['ID']] = lnseg

        for lnseg_dot in self.tables_model['dms_def_lnseg_dot']:
            if lnseg_dot['ID'] in lnseg_dots:
                lnseg_dot = dict(lnseg_dot)
                lnseg_dot['TYPE'] = 'lnseg_dot'
                lnseg_dots[lnseg_dot['ID']][lnseg_dot['ID']] = lnseg_dot
        # print('\t[FINISH] dms_dms_def_lnseg_dot')

        # 台区不读取变压器相关表
        for trfm in self.tables_model['dms_def_trfm']:
            if trfm['FEEDER_ID'] in self.feeders:
                trfm = dict(trfm)
                trfm['TYPE'] = 'trfm'
                self.feeders[trfm['FEEDER_ID']]['trfm'][trfm['ID']] = trfm
        # print('\t[FINISH] dms_dms_def_trfm')

        for trwd in self.tables_model['dms_def_trwd']:
            if trwd['FEEDER_ID'] in self.feeders:
                trwd = dict(trwd)
                trwd['TYPE'] = 'trwd'
                feeder = self.feeders[trwd['FEEDER_ID']]
                feeder['trwd'][trwd['ID']] = trwd
                if trwd['TRFM_ID'] not in feeder['trfm']:
                    print(
                        '馈线id',
                        trwd['FEEDER_ID'],
                        '存在trwd的trfm_id找不到',
                        trwd['TRFM_ID'],
                    )
                    continue

                trfm = feeder['trfm'][trwd['TRFM_ID']]

                if '首端' in trwd['NAME']:
                    trfm['ITERMINAL_ID'] = trwd['ID']
                    trfm['INODE_ID'] = trwd['NODE_ID']
                elif '末端' in trwd['NAME']:
                    trfm['ZTERMINAL_ID'] = trwd['ID']
                    trfm['ZNODE_ID'] = trwd['NODE_ID']
                else:
                    if 'INODE_ID' not in feeder['trfm'][trwd['TRFM_ID']]:
                        trfm['ITERMINAL_ID'] = trwd['ID']
                        feeder['trfm'][trwd['TRFM_ID']]['INODE_ID'] = trwd['NODE_ID']
                    else:
                        trfm['ZTERMINAL_ID'] = trwd['ID']
                        trfm['ZNODE_ID'] = trwd['NODE_ID']

        for feeder_id in self.feeders:
            feeder = self.feeders[feeder_id]
            for trfm_id in self.feeders[feeder_id]['trfm']:
                trfm = feeder['trfm'][trfm_id]

                if 'INODE_ID' in trfm and 'ZNODE_ID' in trfm:
                    if trfm['INODE_ID'] not in feeder['links']:
                        feeder['links'][trfm['INODE_ID']] = {}
                    feeder['links'][trfm['INODE_ID']][trfm['ID']] = trfm

                    if self.calc_model == 'taiqu':
                        feeder['so']['NODE_ID'] = trfm['INODE_ID']
                        feeder['so']['BV_ID'] = feeder['trwd'][trfm['ITERMINAL_ID']]['BV_ID']
                        feeder['so']['NAME'] = trfm['NAME'] + '_虚拟电源'
                        feeder['links'][feeder['so']['NODE_ID']][feeder['so']['ID']] = feeder['so']

                    if trfm['ZNODE_ID'] not in feeder['links']:
                        feeder['links'][trfm['ZNODE_ID']] = {}
                    feeder['links'][trfm['ZNODE_ID']][trfm['ID']] = trfm

        qs_new_id = 0
        for qs in self.tables_model['dms_def_qs']:
            if qs['INODE_ID'] == qs['ZNODE_ID']:
                continue
            if is_number(qs['ID']):
                qs_new_id = max(qs_new_id, int(qs['ID']))

            if qs['FEEDER_ID'] in self.feeders:
                qs = dict(qs)
                qs['TYPE'] = 'qs'

                self.feeders[qs['FEEDER_ID']]['qs'][qs['ID']] = qs

                if qs['INODE_ID'] not in self.feeders[qs['FEEDER_ID']]['links']:
                    self.feeders[qs['FEEDER_ID']]['links'][qs['INODE_ID']] = {}
                self.feeders[qs['FEEDER_ID']]['links'][qs['INODE_ID']][qs['ID']] = qs

                if qs['ZNODE_ID'] not in self.feeders[qs['FEEDER_ID']]['links']:
                    self.feeders[qs['FEEDER_ID']]['links'][qs['ZNODE_ID']] = {}
                self.feeders[qs['FEEDER_ID']]['links'][qs['ZNODE_ID']][qs['ID']] = qs

        qs_new_id = qs_new_id + 1 if len(self.tables_model['dms_def_qs']) > 0 else 3387269869736034305

        load_data = self.tables_model['dms_def_load']
        if load_data:
            load_df = pd.DataFrame(load_data)
            fields = [field for field in self.get_model_fields('dms_def_load') if field not in load_df.columns]
            for field in fields:
                load_df[field] = 0
            node_stats = load_df.groupby('NODE_ID')['ID'].agg(list).reset_index()
            node_stats['count'] = node_stats['ID'].apply(len)

            # 只保留 count > 1 的节点
            filtered_nodes = node_stats[node_stats['count'] > 1]
            node_load_dict = dict(zip(filtered_nodes['NODE_ID'], filtered_nodes['ID']))

            for load in load_data:
                if load['FEEDER_ID'] in self.feeders:
                    load = dict(load)
                    load['TYPE'] = 'load'

                    node_id = load['NODE_ID']
                    if node_id not in node_load_dict:
                        self.feeders[load['FEEDER_ID']]['load'][load['ID']] = load
                        if load['NODE_ID'] not in self.feeders[load['FEEDER_ID']]['links']:
                            self.feeders[load['FEEDER_ID']]['links'][load['NODE_ID']] = {}
                        self.feeders[load['FEEDER_ID']]['links'][load['NODE_ID']][load['ID']] = load
                    else:
                        new_node = {
                            'ID': node_new_id,
                            'NAME': f'added_node_{node_new_id}',
                            'FEEDER_ID': load['FEEDER_ID'],
                            'SG_ID': 0,
                        }
                        self.feeders[load['FEEDER_ID']]['node'][node_new_id] = new_node
                        self.feeders[load['FEEDER_ID']]['links'][node_new_id] = {}

                        load['NODE_ID'] = node_new_id
                        self.feeders[load['FEEDER_ID']]['load'][load['ID']] = load

                        # 增加load和新node的连接
                        self.feeders[load['FEEDER_ID']]['links'][node_new_id][load['ID']] = load
                        # 增加一条线段的inode_id和znode_id分别是node_index和node_id
                        new_qs = {
                            'ID': qs_new_id,
                            'NAME': f'added_qs_for_{node_id}_{node_new_id}',
                            'INODE_ID': node_id,
                            'ZNODE_ID': node_new_id,
                            'TYPE': 'qs',
                            'FEEDER_ID': load['FEEDER_ID'],
                            'RUN_STATE': 1,
                            'PHA': 1,
                            'PHB': 1,
                            'PHC': 1,
                            'BV_ID': load.get('BV_ID', self.default_bv_id),
                            'ITERMINAL_ID': 0,
                            'ZTERMINAL_ID': 0,
                            'RDF_ID': '0',
                        }

                        self.feeders[new_qs['FEEDER_ID']]['qs'][new_qs['ID']] = new_qs
                        # 增加
                        self.feeders[load['FEEDER_ID']]['links'][node_new_id][new_qs['ID']] = new_qs
                        if node_id not in self.feeders[load['FEEDER_ID']]['links']:
                            self.feeders[load['FEEDER_ID']]['links'][node_id] = {}
                        self.feeders[load['FEEDER_ID']]['links'][node_id][new_qs['ID']] = new_qs
                        node_new_id += 1
                        qs_new_id += 1

        for unit in self.tables_model['dms_def_unit']:
            if unit['FEEDER_ID'] in self.feeders:
                unit = dict(unit)
                unit['TYPE'] = 'unit'
                self.feeders[unit['FEEDER_ID']]['unit'][unit['ID']] = unit

                if unit['NODE_ID'] not in self.feeders[unit['FEEDER_ID']]['links']:
                    self.feeders[unit['FEEDER_ID']]['links'][unit['NODE_ID']] = {}
                self.feeders[unit['FEEDER_ID']]['links'][unit['NODE_ID']][unit['ID']] = unit

        for es in self.tables_model['dms_def_es']:
            if es['FEEDER_ID'] in self.feeders:
                es = dict(es)
                es['TYPE'] = 'es'
                self.feeders[es['FEEDER_ID']]['es'][es['ID']] = es

                if es['NODE_ID'] not in self.feeders[es['FEEDER_ID']]['links']:
                    self.feeders[es['FEEDER_ID']]['links'][es['NODE_ID']] = {}
                self.feeders[es['FEEDER_ID']]['links'][es['NODE_ID']][es['ID']] = es

        for cb in self.tables_model['dms_def_cb']:
            if cb['INODE_ID'] == cb['ZNODE_ID']:
                continue

            if cb['FEEDER_ID'] in self.feeders:
                feeder = self.feeders[cb['FEEDER_ID']]
                cb = dict(cb)
                cb['TYPE'] = 'cb'
                feeder['cb'][cb['ID']] = cb

                if cb['INODE_ID'] not in feeder['links']:
                    feeder['links'][cb['INODE_ID']] = {}
                feeder['links'][cb['INODE_ID']][cb['ID']] = cb

                if cb['ZNODE_ID'] not in feeder['links']:
                    feeder['links'][cb['ZNODE_ID']] = {}
                feeder['links'][cb['ZNODE_ID']][cb['ID']] = cb

        for sg in self.tables_model['dms_def_switchgear']:
            if sg['FEEDER_ID'] in self.feeders:
                sg = dict(sg)
                sg['TYPE'] = 'sg'

                self.feeders[sg['FEEDER_ID']]['sg'][sg['ID']] = {
                    'sg': sg,
                    'graph': nx.DiGraph(),
                    'nodes': [],
                    'devs': [],
                }

        # 生成各馈线的networkx图
        invalid_count = 0
        for feeder_id in self.feeders:
            if '0' in self.feeders[feeder_id]['links']:
                del self.feeders[feeder_id]['links']['0']
            if 0 in self.feeders[feeder_id]['links']:
                del self.feeders[feeder_id]['links'][0]

            topo_status = self.topo_status[feeder_id]
            if topo_status != 0:
                invalid_count += 1
                continue
            G = nx.DiGraph()
            feeder = self.feeders[feeder_id]
            so = feeder['so']
            root = so['ID']
            G.add_node(root, type='so', inode=so['NODE_ID'])

            # 使用BFS从根节点开始遍历图
            visited = set()
            visited.add(root)

            cycle_edge = set()
            self.has_cycle[feeder_id] = False

            self.island[feeder_id] = []

            def iter_dev(parent_id, node_id):
                if node_id in feeder['links']:
                    # 优先遍历 已经在图形中的设备的下游分支
                    for dev_id in feeder['links'][node_id]:
                        if dev_id != parent_id and G.has_node(dev_id) and dev_id not in visited:
                            dev = feeder['links'][node_id][dev_id]
                            visited.add(dev_id)
                            if 'INODE_ID' in dev and 'ZNODE_ID' in dev:
                                iter_dev(dev_id, node_id)

                    next_devs = []
                    for dev_id in feeder['links'][node_id]:
                        if dev_id != parent_id:
                            if not G.has_node(dev_id):  # 如果图中还没有包含这个设备，则添加到图中
                                G.nodes[parent_id]['znode'] = node_id
                                G.add_node(
                                    dev_id,
                                    type=feeder['links'][node_id][dev_id]['TYPE'],
                                    inode=node_id,
                                )

                                # print(f"[ADD] nd:{node_id} {feeder['links'][node_id][parent_id]['TYPE']}:{parent_id} -> {feeder['links'][node_id][dev_id]['TYPE']}:{dev_id}")
                                G.add_edge(parent_id, dev_id)
                                # print(f'[DEBUG] add edge {parent_id} -> {dev_id}')

                                # 修正末端节点的 inode 和 znode
                                dev = feeder['links'][node_id][dev_id]
                                if 'ZNODE_ID' in dev and node_id == dev['ZNODE_ID']:
                                    inode_id = dev['INODE_ID']
                                    znode_id = dev['ZNODE_ID']

                                    # print(f'[WARN] {dev["NAME"]} error : \n \t \tinode: {inode_id} , znode: {znode_id}')

                                    dev['INODE_ID'] = znode_id
                                    dev['ZNODE_ID'] = inode_id
                                    feeder[dev['TYPE']][dev_id]['INODE_ID'] = znode_id
                                    feeder[dev['TYPE']][dev_id]['ZNODE_ID'] = inode_id

                                    if 'ITERMINAL_ID' in dev and 'ZTERMINAL_ID' in dev:
                                        iterm_id = dev['ITERMINAL_ID']
                                        zterm_id = dev['ZTERMINAL_ID']
                                        dev['ITERMINAL_ID'] = zterm_id
                                        dev['ZTERMINAL_ID'] = iterm_id
                                next_devs.append(dev_id)
                            elif dev_id in visited:  # 如果图中已经包含这个设备，但是这个设备没有被作为 parent 访问过，说明被另一个parent作为子节点已经添加到了G中，说明存在环路
                                logger.debug(f'ignore edge {parent_id} -> {dev_id}')
                                self.has_cycle[feeder_id] = True
                                cycle_edge.add((parent_id, dev_id))

                    # 如果某个node有多个连接设备，但是这些设备 都触发了环路判断，最有可能是父节点在环路中。
                    if len(next_devs) == 0 and len(feeder['links'][node_id]) > 2 and len(G.edges(parent_id)) == 0:
                        self.error_devs[parent_id] = {
                            'dev': feeder['links'][node_id][parent_id],
                            'error_type': 1,
                            'error_reason': '可疑环路设备',
                        }
                        # print(f'[WARN] 可疑环路设备：{parent_id}')
                        error_dev = self.error_devs[parent_id]['dev']
                        logger.warning(f'可疑环路设备：{error_dev["RDF_ID"]}')

                    # 构造环网柜拓扑
                    for dev_id in feeder['links'][node_id]:
                        if parent_id != dev_id and node_id in feeder['node'] and feeder['node'][node_id]['SG_ID'] in feeder['sg']:
                            sg = feeder['sg'][feeder['node'][node_id]['SG_ID']]
                            sg['nodes'].append(node_id)
                            sg['devs'].append(dev_id)
                            sg['graph'].add_node(node_id, type='node', inode=node_id)
                            sg['graph'].add_node(
                                dev_id,
                                type=feeder['links'][node_id][dev_id]['TYPE'],
                                inode=node_id,
                            )
                            if parent_id in sg['devs']:
                                sg['graph'].add_edge(parent_id, node_id)

                            sg['graph'].add_edge(node_id, dev_id)

                    for dev_id in next_devs:
                        dev = feeder['links'][node_id][dev_id]
                        visited.add(dev_id)
                        if 'INODE_ID' in dev and 'ZNODE_ID' in dev and node_id == dev['INODE_ID']:
                            iter_dev(dev_id, dev['ZNODE_ID'])

            iter_dev(root, so['NODE_ID'])

            # draw_digraph_to_svg(G, f'svg/{feeder["FEEDER_NAME"]}.svg')
            feeder['net'] = G

            if G.number_of_nodes() < 2:
                logger.error(f'feeder {feeder_id}has wrong topo!')
                self.topo_status[feeder['FEEDER_ID']] = 2  # 拓扑断联

            for sub_g in nx.weakly_connected_components(G):
                island = {
                    'devs': [{'id': i, 'type': G.nodes[i]['type']} for i in sub_g],
                    'live': feeder['SOURCE_ID'] in sub_g,
                    'cycles': [],
                }

                if self.has_cycle[feeder_id]:
                    SUBG = G.subgraph(sub_g).copy()
                    for i in cycle_edge:
                        SUBG.add_edge(i[0], i[1])

                    cycles = nx.cycle_basis(SUBG.to_undirected())
                    island['cycles'] = cycles

                self.island[feeder_id].append(island)

                if feeder['SOURCE_ID'] in sub_g:
                    include_cb = False
                    include_load = False

                    for i in sub_g:
                        if G.nodes[i]['type'] in ['qs', 'cb']:
                            include_cb = True
                        if G.nodes[i]['type'] in ['load', 'trfm', 'trwd']:
                            include_load = True

                    if not include_load:
                        logger.error(f'馈线 {feeder_id} 没有包含任何负荷')
                        self.topo_status[feeder['FEEDER_ID']] = 3

                    if not include_cb or not include_load:
                        feeder['invalid'] = True
                        invalid_count += 1

            # 构造全图
            all_G = nx.Graph()
            for node_id in feeder['links']:
                for dev_id in feeder['links'][node_id]:
                    try:
                        all_G.add_node(node_id, type='node')
                        all_G.add_node(dev_id, type=feeder['links'][node_id][dev_id]['TYPE'], name=feeder['links'][node_id][dev_id]['NAME'])
                        all_G.add_edge(
                            node_id,
                            dev_id,
                            dev_id=feeder['links'][node_id][dev_id]['ID'],
                            dev_name=feeder['links'][node_id][dev_id]['NAME'],
                            dev_type=feeder['links'][node_id][dev_id]['TYPE'],
                        )
                    except:
                        pass

            sub_gs = list(nx.connected_components(all_G))
            feeder['subcount'] = len(sub_gs)
            logger.info(f'拓扑分析 {feeder_id} 总岛数: {feeder["subcount"]}')

            for sub_g in sub_gs:
                if feeder['SOURCE_ID'] not in sub_g:
                    island = {
                        'devs': [{'id': i, 'type': all_G.nodes[i]['type']} for i in sub_g if i not in feeder['links']],
                        'live': False,
                        'cycles': [],
                    }

                    self.island[feeder_id].append(island)

        logger.info(f'self_feeders_count: {len(self.feeders)}')
        logger.info(f'invalid_count: {invalid_count}')

    def get_island_dev_df(self):
        island_df = pd.DataFrame({}, columns=['FEEDER_ID', 'ISLAND_INDEX', 'DEV_ID', 'DEV_NAME', 'DEV_TYPE', 'LIVE'])

        for feeder_id in self.island:
            for island_index, island_dict in enumerate(self.island[feeder_id]):
                for dev_dict in island_dict['devs']:
                    dev_id = dev_dict['id']
                    dev_type = dev_dict['type']
                    if dev_type == 'so':
                        dev_name = self.feeders[feeder_id]['so']['NAME']
                    else:
                        dev_name = self.feeders[feeder_id][dev_type][dev_id]['NAME']
                    live = island_dict['live']
                    island_df = pd.concat(
                        [
                            island_df,
                            pd.DataFrame(
                                {
                                    'FEEDER_ID': feeder_id,
                                    'ISLAND_INDEX': island_index,
                                    'DEV_ID': dev_id,
                                    'DEV_NAME': dev_name,
                                    'DEV_TYPE': dev_type,
                                    'LIVE': live,
                                },
                                index=[0],
                            ),
                        ],
                        ignore_index=True,
                    )
        return island_df

    def get_island_cycle_df(self):
        cycle_df = pd.DataFrame({}, columns=['FEEDER_ID', 'ISLAND_INDEX', 'CYCLE_INDEX', 'DEV_ID', 'DEV_NAME', 'DEV_TYPE', 'SUSPICIOUS'])

        for feeder_id in self.island:
            for island_index, island_dict in enumerate(self.island[feeder_id]):
                for cycle_index, cycle in enumerate(island_dict['cycles']):
                    for dev_id in cycle:
                        dev_type = self.feeders[feeder_id]['net'].nodes[dev_id]['type']
                        if dev_type == 'so':
                            dev_name = self.feeders[feeder_id]['so']['NAME']
                        else:
                            dev_name = self.feeders[feeder_id][dev_type][dev_id]['NAME']
                        cycle_df = pd.concat(
                            [
                                cycle_df,
                                pd.DataFrame(
                                    {
                                        'FEEDER_ID': feeder_id,
                                        'ISLAND_INDEX': island_index,
                                        'CYCLE_INDEX': cycle_index,
                                        'DEV_ID': dev_id,
                                        'DEV_NAME': dev_name,
                                        'DEV_TYPE': dev_type,
                                        'SUSPICIOUS': False,
                                    },
                                    index=[0],
                                ),
                            ],
                            ignore_index=True,
                        )

        # 如果 cycle_df 的 DEV_ID 在 self.error_devs 字典内，且 self.error_devs[suspicious_dev_id]['error_type'] == 1, 则标记 SUSPICIOUS 为 True
        for suspicious_dev_id in self.error_devs:
            if self.error_devs[suspicious_dev_id]['error_type'] == 1:
                cycle_df.loc[cycle_df['DEV_ID'] == suspicious_dev_id, 'SUSPICIOUS'] = True

        return cycle_df

    def refresh_model(self, data=None):
        logger.info('update model with pq_data')

        if self.source_type in ['dataframe', 'dict'] and data is not None:
            self.source_data = deepcopy(data)

        # 更新dms_def_source
        for so in self.get_table_meas('dms_def_source'):
            if so['ID'] in self.sos and self.sos[so['ID']]['FEEDER_ID']:
                self.feeders[self.sos[so['ID']]['FEEDER_ID']]['so'].update(so)

        # 更新dms_dms_def_node
        for node in self.get_table_meas('dms_def_node'):
            if node['FEEDER_ID'] in self.feeders:
                self.feeders[node['FEEDER_ID']]['node'][node['ID']].update(node)

        # 更新dms_dms_def_lnseg
        lnseg_dots = {}
        for lnseg in self.get_table_meas('dms_def_lnseg'):
            if lnseg['FEEDER_ID'] in self.feeders:
                lnseg_dots[lnseg['ITERMINAL_ID']] = self.feeders[lnseg['FEEDER_ID']]['lnseg_dot']
                lnseg_dots[lnseg['ZTERMINAL_ID']] = self.feeders[lnseg['FEEDER_ID']]['lnseg_dot']

        # 更新dms_dms_def_lnseg_dot
        for lnseg_dot in self.get_table_meas('dms_def_lnseg_dot'):
            if lnseg_dot['ID'] in lnseg_dots:
                lnseg_dots[lnseg_dot['ID']][lnseg_dot['ID']].update(lnseg_dot)

        # 台区不读取变压器相关表
        for trwd in self.get_table_meas('dms_def_trwd'):
            if trwd['FEEDER_ID'] in self.feeders:
                self.feeders[trwd['FEEDER_ID']]['trwd'][trwd['ID']].update(trwd)

        for load in self.get_table_meas('dms_def_load'):
            if load['FEEDER_ID'] in self.feeders:
                self.feeders[load['FEEDER_ID']]['load'][load['ID']].update(load)

        for cb in self.get_table_meas('dms_def_cb'):
            if cb['FEEDER_ID'] in self.feeders:
                self.feeders[cb['FEEDER_ID']]['cb'][cb['ID']].update(cb)

        for qs in self.get_table_meas('dms_def_qs'):
            if qs['FEEDER_ID'] in self.feeders:
                self.feeders[qs['FEEDER_ID']]['qs'][qs['ID']].update(qs)

        self.get_all_table_model()

    def get_feeder_model(self, feeder_id):
        if feeder_id in self.feeders:
            return self.feeders[feeder_id]
        else:
            return None

    def save_model_to_efile(self, filepath, encoding='gb18030', exclude_tables=[]):
        out = EFile()
        for table_name in self.tables_model_fields:
            if table_name in exclude_tables:
                continue
            table = out.add_table(table_name)
            table_df = pd.DataFrame(self.tables_model[table_name]) if self.tables_model[table_name] else pd.DataFrame(columns=self.get_model_fields(table_name))
            table_df.columns = [str(col).upper() for col in table_df.columns]
            table.add_data_from_df(table_df)

        out.write_to_efile(filepath, encoding=encoding)

    def save_model_to_file(self, filepath):
        with open(filepath, 'wb') as f:
            if self.source_type in ['rtdb', 'db', 'kingbase_v7']:
                self.source_data = None
            pickle.dump(self, f)

    @staticmethod
    def load_model_from_file(filepath):
        with open(filepath, 'rb') as f:
            dms_model = pickle.load(f)
            if dms_model.source_type == 'rtdb':
                dms_model.set_source(
                    source_type='rtdb',
                    schema=dms_model.schema,
                    app=dms_model.app,
                    ctx=dms_model.ctx,
                )
            if dms_model.source_type == 'db':
                if dms_model.db_url:
                    dms_model.set_source(source_type='db', db=dms_model.db_url)
            if dms_model.source_type == 'kingbase_v7':
                dms_model.set_source(
                    source_type='kingbase_v7',
                    url=dms_model.url,
                    user=dms_model.user,
                    password=dms_model.password,
                    driver_class=dms_model.driver_class,
                    jar_file=dms_model.jar_file,
                )
            return dms_model

    def draw_svg(self, output_path):
        from dms.gen_topo.draw_svg import draw

        for feeder_id in self.feeders:
            draw(
                feeder_model=self.get_feeder_model(feeder_id),
                theme='white',
                draw_meas=True,
                output_path=output_path,
            )


if __name__ == '__main__':
    dms_model = DMSModelBase()
    #
    # dms_model.set_source(source_type='efile', file=r'D:\rtdbpy\dms\标准算例-配网-线路环路.e')
    dms_model.set_source(source_type='efile', file=r'D:\rtdbpy\东里村.e')
    dms_model.set_prefix('taiqu_')
    dms_model.set_source_field_lower()
    dms_model.read_model()

    logger.info(dms_model.get_island_dev_df())
    logger.info(dms_model.get_island_cycle_df())

    # dms_model.save_model_to_efile('output/test.e')
    # dms_model.save_model_to_file('dms_model.pkl')
    # dms_model.draw_svg(os.path.join(CUR_PATH, 'output'))
    # dms_model = dms_model.load_model_from_file('dms_model.pkl')
    # dms_model.read_model()

    # tmp_dms_model = DMSModel.load_model_from_file('dms_model.pkl')
    # tmp_dms_model.refresh_model()

    # nwxs
    # dms_model = DMSModelBase.load_model_from_file('nwxs.pkl')
    dms_model.save_model_to_efile('nwxs.e', encoding='utf-8')
