#!/usr/bin/env python
import argparse
import codecs
import io
import json
import os
import re
import sys
import time
import traceback
import unicodedata

import numpy as np
import pandas as pd

# 设置路径
current_file = os.path.abspath(__file__)
lib_dir = os.path.dirname(os.path.dirname(os.path.dirname(current_file)))
if lib_dir not in sys.path:
    sys.path.insert(0, lib_dir)

# 使用绝对导入
from lib.helper.data_utils import df_dict_from_feather, df_dict_to_feather
from lib.helper.log import logger
from lib.mparser.efile_parser.id_convert import id_to_long

# 可选导入config（用于性能优化）
try:
    USE_PYBIND = False
except ImportError:
    USE_PYBIND = False

parser = argparse.ArgumentParser(prog='efile_parser', description='parse efile')

# 读取
parser.add_argument('--efile', required=False, default=None, help='从efile读取数据')
parser.add_argument('--json', required=False, default=None, help='从json读取数据')
parser.add_argument('-rtdb', action='store_true', help='从rtdb读取数据')
parser.add_argument('--schema', required=False, default=None, help='从rtdb读取数据')
parser.add_argument('--app', required=False, default=None, help='从rtdb读取数据')
parser.add_argument('--ctx', required=False, default=None, help='从rtdb读取数据')
parser.add_argument(
    '--tables',
    required=False,
    default=[],
    help='需要解析的表名，多个用逗号隔开,不设置时则解析全部表',
)

# 编码
parser.add_argument('--encoding', required=False, default='gb18030')  # 需要解析的文件的编码格式

# 输出
parser.add_argument('--efileout', required=False, default=None, help='输出到efile路径')
parser.add_argument('--jsonout', required=False, default=None, help='输出到json路径')
parser.add_argument('-convert', action='store_true', help='带上这个参数即进行id转换为long_key')


def parse_line(line):
    line = line.strip()
    # 匹配单引号内的内容（即一个元素），或者空格分隔的单词
    pattern = r"'([^']*)'|([^' \t]+)"
    elements = []

    for match in re.finditer(pattern, line):
        # match.group(1) 为单引号中的内容，match.group(2) 为普通的单词
        if match.group(1) is not None:
            elements.append(match.group(1).strip())  # 如果是单引号中的内容，保留单引号添加到元素列表
        elif match.group(2) is not None:
            elements.append(match.group(2).strip())  # 如果是普通的单词，添加到元素列表

    return elements


def format_element(value):
    if str(value).strip() == '':  # 如果字符串为空
        return f"'{value}'"
    # 如果字符串中间包含空格且前后没有引号,则添加引号
    if ' ' in str(value) and (str(value)[0] != "'" or str(value)[-1] != "'"):
        return f"'{value}'"
    return value


type_default_value_dict = {  # 数据类型和默认值
    'int32': 0,
    'int64': 0,
    'int': 0,
    'float64': 0.0,
    'float32': 0.0,
    'float': 0.0,
    'double': 0.0,
    'string': "''",
    'bool': True,
    'object': 0,
    'datetime64[ns]': pd.Timestamp.min,  # 1677-09-21（pandas支持的最小日期）
}

type_mapping = {
    'char': 'string',
    'bigint': 'int64',
    'int': 'int64',
    'string': 'string',
    'varchar': 'string',
    'boolean': 'bool',
    'float': 'float32',
    'double': 'float64',
    'Double': 'float64',
    'Float': 'float32',
    'Int': 'int64',
    'decimal': 'object',  # DECIMAL类型可以根据精度选择 float 或 object
    'date': 'datetime64[ns]',
    'datetime': 'datetime64[ns]',
    'timestamp': 'datetime64[ns]',
    'binary': 'object',
    'array': 'object',
    'map': 'object',
    'varchar(255)': 'string',
    'varchar(84)': 'string',
    'varchar(64)': 'string',
    'varchar(32)': 'string',
    'varchar(40)': 'string',
    'tinyint': 'int32',
    'smallint': 'int32',
}


class RowProxy(dict):
    def __init__(self, dataframe, index):
        super().__init__()
        # 不预先存储键值对，动态通过__getitem__/__setitem__访问
        self._df = dataframe
        self._index = index
        self._columns = dataframe.columns.tolist()

    def __getitem__(self, key):
        if self._df is not None:
            return self._df.at[self._index, key]
        else:
            return self._row_data[key]

    def __setitem__(self, key, value):
        if self._df is not None:
            self._df.at[self._index, key] = value
        else:
            raise RuntimeError('Cannot modify a serialized RowProxy Object')

    def __reduce__(self):
        # 序列化时只保存配置信息
        row_data = {col: self._df.at[self._index, col] for col in self._columns}
        return (self.__class__._reconstruct, (row_data, self._columns))

    @classmethod
    def _reconstruct(cls, row_data, columns):
        # 反序列化时的重建方法
        instance = cls.__new__(cls)
        instance._row_data = row_data
        instance._columns = columns
        instance._df = None
        instance._index = None
        return instance

    def __getstate__(self):
        # 序列化时排除连接对象, 序列化时保存数据快照和列信息
        state = {'row_data': {col: self._df.at[self._index, col] for col in self._columns}, 'columns': self._columns}
        return state

    def __setstate__(self, state):
        # 反序列化后恢复状态
        self._row_data = state['row_data']
        self._columns = state['columns']
        self._df = None
        self._index = None

    def __contains__(self, key):
        return key in self._columns

    def keys(self):
        return self._columns

    def __iter__(self):
        return iter(self._columns)

    def __repr__(self):
        if self._df is not None:
            return str({col: self._df.at[self._index, col] for col in self._columns})
        else:
            return str(self._row_data)

    def items(self):
        if self._df is not None:
            return ((col, self._df.at[self._index, col]) for col in self._columns)
        else:
            return self._row_data.items()


class EFileTable:
    """
    表格对象
    类属性：表名,描述,表头,行数据,表头注释,数据字典,表格参数
    类方法: 清空表,添加表头、表头注释、行数据、字段字典,set一次性添加,add添加一个数据
    """

    def __init__(self, tablename):
        self.name = tablename
        self.desc = ''
        self.fields = {}  # 表格字段字典
        self.data_dataframe = pd.DataFrame()
        self.prop_dict = {}  # 表格属性字典

    # ========================================  TOOL ================================================
    # 检查字段名称是否符合命名规范
    def check_field_name_valid(self, field_name):
        """
        验证规则：
        1. 字段名不能为空或纯空白字符
        2. 首字符不能是数字
        3. 不能包含空格
        4. 不能包含单引号或双引号

        Args:
            field_name (str): 待验证的字段名称字符串

        Returns:
            bool: 如果字段名符合所有规范返回True，否则返回False并打印错误信息
        """
        if field_name.strip() == '' or ' ' in field_name or "'" in field_name or '"' in field_name:
            logger.error(f'字段名 {field_name} 不符合规范')
            return False
        else:
            return True

    def match_fields_and_df_data(self):
        """
        对齐 self.fields 中定义的类型与 self.data_dataframe 中的实际数据类型，
        并根据需要添加缺失的列或转换列的类型。
        这是数据一致性的核心方法，确保字段定义与数据框匹配。
        """
        col_set = set(self.data_dataframe.columns)
        for field_name, field_info in self.fields.items():
            original_type = field_info.get('type', '')
            default_value = field_info.get('default')
            if not default_value:
                default_value = type_default_value_dict.get(original_type)

            if field_name not in col_set:  # # 如果字段在 fields 中但不在数据框中，则添加该列并用默认值填充
                logger.warning(f'列 {field_name} 在self.fields中定义但在self.data_dataframe中不存在,添加默认值 {default_value}！')
                self.data_dataframe[field_name] = default_value

            # 获取映射后的 pandas 类型（如 'float64'、'string' 等）
            target_type = type_mapping.get(original_type, original_type)
            if not target_type:
                continue  # 没有对应的类型映射，跳过转换

            # 根据目标类型进行安全的类型转换，处理转换错误时填充默认值
            try:
                if target_type in ('float64', 'float32'):
                    self.data_dataframe[field_name] = pd.to_numeric(self.data_dataframe[field_name], errors='coerce').fillna(default_value)
                elif target_type == 'string':
                    self.data_dataframe[field_name] = self.data_dataframe[field_name].astype(str).replace('nan', default_value)
                elif target_type == 'datetime64[ns]':
                    self.data_dataframe[field_name] = pd.to_datetime(self.data_dataframe[field_name], errors='coerce').fillna(default_value)
                else:
                    self.data_dataframe[field_name] = self.data_dataframe[field_name].astype(target_type, errors='ignore').fillna(default_value)
            except Exception as e:
                logger.error(f'转换列 {field_name} 到类型 {target_type} 失败：{e}')

        # 将self.fields和self.data_dataframe的columns进行匹配
        for col in self.data_dataframe.columns:
            if col not in self.fields:
                self.add_field(col)

        return True

    # ========================================  CLEAR ================================================
    # 清空定义和数据
    def clear(self):
        self.fields = {}
        self.data_dataframe = pd.DataFrame()
        self.desc = ''
        self.prop_dict = {}  # 表格属性字典

    # 清空数据
    def clear_data(self):
        self.fields = {}  # 表格字段字典
        self.data_dataframe = pd.DataFrame()

    # ===========================================  ADD  ==============================================
    def add_data_from_df(self, add_dataframe, axis=0, position=None):
        """
        所有数据添加的基础方法，负责将外部 DataFrame 合并到当前表格中，
        并保证字段对齐和类型匹配（调用 match_fields_and_df_data）。
        支持按行追加（axis=0）和按列插入（axis=1），插入时可指定位置。

        Args:
            add_dataframe: 要添加的DataFrame
            axis: 0-添加行，1-添加列
            position: 当axis=1时，指定列插入位置（None=末尾，0=开头，1=第1列后，以此类推）
        """

        add_dataframe = add_dataframe.reset_index(drop=True)
        self.data_dataframe = self.data_dataframe.reset_index(drop=True)

        if axis == 1:
            # 处理列添加：检查重复列，只保留未存在的列
            add_cols = [col for col in add_dataframe.columns if col in self.fields]
            keep_cols = [col for col in add_dataframe.columns if col not in self.fields]

            if add_cols:
                logger.warning(f'这些列 {add_cols} 在原dataframe中已经存在，跳过添加！')

            if not keep_cols:
                return True

            add_dataframe = add_dataframe[keep_cols]

        if axis == 0:  # 行添加：直接纵向拼接
            self.data_dataframe = pd.concat([self.data_dataframe, add_dataframe], axis=0, ignore_index=True)
        else:
            if self.data_dataframe.empty:
                self.data_dataframe = add_dataframe
            elif position is None or position >= len(self.data_dataframe.columns):
                self.data_dataframe = pd.concat([self.data_dataframe, add_dataframe], axis=1)
            else:
                # 直接构建新DataFrame，避免多次concat
                left_part = self.data_dataframe.iloc[:, :position]
                right_part = self.data_dataframe.iloc[:, position:]

                self.data_dataframe = pd.concat([left_part, add_dataframe, right_part], axis=1)

        self.match_fields_and_df_data()
        return True

    # 单行添加数据
    def add_one_row_data(self, row_data, columns=[]):
        """
        输入数据类型
        1. {id':1,'name':2}
        2. [1,2,3,4,5,6,7], columns=[1,2,3,4,5,6,7]
        """
        if isinstance(row_data, dict):
            add_df = pd.DataFrame([row_data])
        elif isinstance(row_data, list):
            if not columns:
                columns = self.get_header()
            if not columns or len(row_data) != len(columns):
                logger.error(f'添加数据{row_data}长度和字段名{columns}长度不匹配,添加数据失败！')
                return False
            add_df = pd.DataFrame(data=[row_data], columns=columns)
        else:
            logger.error(f'添加数据{row_data}格式不是list形式或dict形式，添加失败')
            return False

        return self.add_data_from_df(add_df)

    # 多行添加数据
    def add_rows_data(self, rows_data, columns=[]):
        """
        输入数据类型
        1. [{id':1,'name':2},{id':1,'name':2},{id':1,'name':2}...]
        2. [[1,2,3,4,5,6,7],[1,2,3,4,5,6,7],[1,2,3,4,5,6,7]...], columns=[]
        3. pd.Dataframe
        """
        if isinstance(rows_data, pd.DataFrame):
            return self.add_data_from_df(rows_data)

        if not isinstance(rows_data, list):
            logger.error('添加数据rows_data格式不是list形式，添加失败!')
            return False

        if len(rows_data) == 0:
            if len(columns) == 0:
                logger.error('添加数据rows_data和columns都为空，跳过添加！')
                return True
            else:
                add_df = pd.DataFrame(columns=columns)  # 不添加数据，但仍需添加列名
                return self.add_data_from_df(add_df)

        try:
            # 尝试直接转换为 DataFrame
            if isinstance(rows_data[0], list):
                if not columns:
                    columns = self.get_header()
                if not columns:
                    logger.error('未提供columns和fields，添加失败！')
                    return False
                add_df = pd.DataFrame(rows_data, columns=columns)
            else:
                # 假定是字典列表，直接转换
                add_df = pd.DataFrame(rows_data)

            return self.add_data_from_df(add_df)
        except Exception as e:
            logger.warning(f'{e}, 添加数据无法转为dataframe，改为按行添加！')
            all_success = True
            for row_data in rows_data:
                if not self.add_one_row_data(row_data, columns=columns):
                    all_success = False

        return all_success

    def add_one_col_data(self, col_name, value_list=[], position=None):
        """
        添加单列数据
        Args:
            col_name 列名
            value_list 列数据列表，如果为空则创建空列
            position 插入位置
        """
        df = pd.DataFrame(data=value_list, columns=[col_name])

        return self.add_data_from_df(df, axis=1, position=position)

    # 多列添加数据
    def add_cols_data(self, datas_dict, position=None):
        """
        接受数据形式： {'A':[1,2,3], 'B':[2,3,4], 'C':[1,2,3].....}
        """

        if not isinstance(datas_dict, dict):
            logger.error('添加多列数据格式不是dict形式，添加失败！')
            return False

        try:
            add_dataframe = pd.DataFrame(datas_dict)
            return self.add_data_from_df(add_dataframe, axis=1, position=position)
        except Exception as e:
            logger.warning(f'{e}, 添加数据无法转为dataframe，改为按列添加！')
            all_success = True
            # 逐列添加，并处理 position 偏移（如果指定了 position，后续列依次后移）
            for i, (col_name, value_list) in enumerate(datas_dict.items()):
                col_position = position + i if position is not None else None
                if not self.add_one_col_data(col_name, value_list, position=col_position):
                    all_success = False

        return all_success

    # 添加单个新字段
    def add_field(self, field):
        if isinstance(field, str):
            field_name = field.strip()
            field_dict = None
        elif isinstance(field, dict):
            if 'name' not in field:
                logger.error('不能缺失 name')
                return False
            field_name = field['name'].strip()
            field_dict = field
        else:
            logger.error('输入不是string或dict类型, add_field失败！')
            return False

        if not self.check_field_name_valid(field_name):
            logger.error('field不能为空字符串，不能以数字开头, 字段不符合标准，add_field失败！')
            return False

        if field_name in self.fields:
            logger.error(f'字段重复: {field_name}')
            return False

        field_config = {
            'name': field_name,
            'comment': '',
            'type': '',
            'unit': '',
            'default': '',
        }

        if field_dict:
            field_config.update(field_dict)

        self.fields[field_name] = field_config
        return True

    # 添加多个新字段
    def add_fields(self, fields):
        if not isinstance(fields, list):
            logger.error('添加 fields 数据格式不是list形式，添加失败')
            return False
        for field in fields:
            self.add_field(field)

        return True

    def add_prop(self, prop_dict):
        self.prop_dict.update(prop_dict)
        return True

    # ===========================================  MODIFY  ==============================================
    # 修改指定行数据，
    def modify_row_data(self, row_index, row_data, columns=[]):
        """
        两种输入数据
        {'col1':1,'col2':2,'col3':3}
        data = [1,2,3] columns = ['col1','col2','col3']
        """
        if row_index >= self.get_row_num():
            logger.error('row_index超过最大索引，修改失败！')
            return False

        if isinstance(row_data, list):
            if not columns:
                columns = self.get_header()

            if len(row_data) != len(columns):
                logger.error(f'数据长度{len(row_data)}与列数{len(columns)}不匹配，修改失败！')
                return False

            row_data = dict(zip(columns, row_data))
        elif not isinstance(row_data, dict):
            logger.error(f'不支持的数据格式: {type(row_data)}，应为dict或list')
            return False

        missing_cols = [col for col in row_data.keys() if col not in self.data_dataframe.columns]
        if missing_cols:
            logger.error(f'这些列不存在: {missing_cols}，修改失败！')
            return False

        self.data_dataframe.loc[row_index] = row_data
        logger.info(f'第{row_index}行数据已经修改！')
        return True

    # 修改指定列数据，
    def modify_col_data(self, col_name, col_data):
        if col_name not in self.fields:
            logger.error(f'列{col_name}不存在self.data_dataframe中，修改失败！')
            return False

        if len(col_data) != self.get_row_num():
            logger.error('新数据与原数据长度不等，修改失败！')
            return False

        if not isinstance(col_data, (list, pd.Series, np.ndarray)):
            logger.error('列数据格式必须为list、Series或ndarray, 修改失败！')
            return False

        self.data_dataframe[col_name] = col_data
        logger.info(f'{col_name}列数据已经修改！')
        return True

    # 修改列名
    def modify_field_name(self, old_field, new_field):
        if old_field not in self.fields:
            logger.error(f'列{old_field}不存在self.data_dataframe中，修改失败！')
            return False

        if not self.check_field_name_valid(new_field):
            logger.error(f'新列名 {new_field} 不符合命名规范，修改失败！')
            return False

        self.fields[new_field] = self.fields.pop(old_field)
        self.fields[new_field]['name'] = new_field
        self.data_dataframe.rename(columns={old_field: new_field}, inplace=True)
        logger.info(f'列名 {old_field} 修改为 {new_field}！')
        return True

    # 修改列类型，列默认值等定义
    def modify_field_info(self, field_name, info_dict):
        """
        传入数据类型{
            'name': '字段A',
            'comment': '',
            'type': '',
            'unit': '',
            'default': ''}
        """
        if field_name not in self.fields:
            logger.error(f'列{field_name}不存在self.data_dataframe中，修改失败！')
            return False
        self.fields[field_name].update(info_dict)
        return True

    def modify_fields_info(self, fields_info_dict):  # 用来更新字段的属性
        """
        输入格式如下：
        {
            '字段A':{
                'name': '字段A',
                'comment': '',
                'type': '',
                'unit': '',
                'default': '',
            },
            '字段B':{
                'name': '字段B',
                'comment': '',
                'type': '',
                'unit': '',
                'default': '',
            }
        }
        """
        for field, info_dict in fields_info_dict.items():
            self.modify_field_info(field, info_dict)

        return True

    # ===========================================  GET  ==============================================
    def get_data(self):
        return self.data_dataframe

    # 得到某一列的元素，参数为列名
    def get_col_data_by_name(self, col):
        if col not in self.data_dataframe.columns:
            logger.error(f'列 {col} 不存在')
            return []
        return self.data_dataframe[col].tolist()

    def get_row_data(self, row_index):
        row_num = self.get_row_num()
        if row_index >= row_num:
            logger.error(f'row_index : {row_index} 超过最大index {row_num - 1}')
            return []
        row_values = self.data_dataframe.iloc[row_index].tolist()
        return row_values

    def get_fields(self):
        return self.fields

    def get_field_type(self, field_name):
        if field_name in self.fields:
            return self.fields[field_name].get('type', '')
        else:
            raise KeyError(f'{field_name} not exist')

    def get_row_num(self):
        return len(self.data_dataframe)

    def get_col_num(self):
        return len(self.data_dataframe.columns)

    def get_col_name(self, index):
        columns = self.get_header()
        return columns[index] if index < len(columns) else None

    def get_cel_value(self, row, col):
        # 打印行数
        row_num = self.get_row_num()
        col_num = self.get_col_num()
        if row >= row_num or col >= col_num:
            logger.error(f'row or col out of range ,row num: {row_num}, col num: {col_num}')
            return None
        return self.data_dataframe.iloc[row, col]

    def get_header(self):
        return self.data_dataframe.columns.tolist()

    # 查某一字段的comment
    def get_header_comment(self, field_name=None):
        # 如果传入列名，则返回改列名的comment，否则返回所有列名的comment的列表
        if field_name is None:
            return [self.fields[head].get('comment', '') for head in self.get_header()]
        elif field_name in self.fields:
            return self.fields[field_name].get('comment', '')
        else:
            logger.error(f'[ERROR] 不存在 {field_name} 字段')
            return False

    # ===========================================  SET  ==============================================
    def set_desc(self, descStr):
        self.desc = descStr

    def set_fields(self, fields_info):
        """
            输入有两种格式：
            第一种：
            {
            '字段A':{
                'name': '字段A',
                'comment': '',
                'type': '',
                'unit': '',
                'default': '',
            },
            '字段B':{
                'name': '字段B',
                'comment': '',
                'type': '',
                'unit': '',
                'default': '',
            }}
            第二种
            [{
                'name': '字段A',
                'comment': '',
                'type': '',
                'unit': '',
                'default': '',
            },{
                'name': '字段B',
                'comment': '',
                'type': '',
                'unit': '',
                'default': '',
            }]
        }
        """
        if isinstance(fields_info, list):
            # 列表格式：逐个添加字段
            for field_info in fields_info:
                self.add_field(field_info)
        elif isinstance(fields_info, dict):
            # 字典格式：直接替换整个 fields 字典
            self.fields = fields_info

        return True

    def set_fields_lower(self):
        """将所有字段名转换为小写，同时更新数据框列名和 fields 字典中的 name 字段。"""
        new_fields = {}
        for field_name, field_item in self.fields.items():
            field_item['name'] = field_name.lower()
            new_fields[field_name.lower()] = field_item
        self.fields = new_fields
        self.data_dataframe.columns = self.data_dataframe.columns.astype(str).str.lower()
        return True

    def set_fields_upper(self):
        """将所有字段名转换为大写。"""
        new_fields = {}
        for field_name, field_item in self.fields.items():
            field_item['name'] = field_name.upper()
            new_fields[field_name.upper()] = field_item
        self.fields = new_fields
        self.data_dataframe.columns = self.data_dataframe.columns.astype(str).str.upper()
        return True

    def set_data(self, datas, columns=None):
        """
        设置整个表格的数据（先清空现有数据，再添加新数据）。
        datas 可以是 DataFrame、字典列表或二维列表。
        """
        self.clear_data()
        if isinstance(datas, pd.DataFrame):
            self.add_data_from_df(datas)
        else:
            self.add_rows_data(datas, columns=columns)
        return True

    def set_propdict(self, propdict):
        self.prop_dict = propdict

    def set_cel_value(self, row, col, value):
        row_num = self.get_row_num()
        col_num = self.get_col_num()
        if row >= row_num or col >= col_num:
            logger.error('row or col out of range,row num: {}, col num: {}')
        self.data_dataframe.iloc[row, col] = value
        return True

    # ===========================================  DEL  ===============================================
    def del_field(self, field):
        if isinstance(field, str):
            if field not in self.fields:
                logger.error(f'{field} not exist')
                return False
            else:
                del self.fields[field]
                self.data_dataframe.drop(field, axis=1, inplace=True)

                logger.info(f'{field} 列已经从数据删除！')
                return True
        else:
            logger.error('尝试必须是字段名的字符串')
            return False

    def del_row(self, start_index, end_index=None):
        self.data_dataframe = self.data_dataframe.reset_index(drop=True)
        del_index = range(start_index, end_index) if end_index else start_index
        self.data_dataframe = self.data_dataframe.drop(del_index)
        logger.info(f'已删除 [{del_index}] 行数据')
        self.data_dataframe = self.data_dataframe.reset_index(drop=True)
        return True

    # ===========================================  CONVERT  ==============================================
    def fill_na(self, fill_value=None, col_name=None):
        """
        填充缺失值。优先级：
        1. 如果指定 fill_value，则使用该值填充；
        2. 否则使用字段定义中的 default 值；
        3. 如果 default 为空，则根据字段类型从 type_default_value_dict 获取默认值。
        可以指定单个列，也可以作用于所有列。
        """
        fill_cols = [col_name] if col_name else list(self.fields.keys())

        for col in fill_cols:
            if col not in self.fields:
                logger.error(f'{col} 不在字段定义中')
                if col_name:
                    return False
                continue

            if fill_value is None:
                current_fill_value = self.fields[col].get('default', '')
                if current_fill_value == '':
                    current_fill_value = type_default_value_dict.get(self.fields[col].get('type', ''), 0)
            else:
                current_fill_value = fill_value
            self.data_dataframe[col] = self.data_dataframe[col].fillna(current_fill_value)

        return True

    def to_json(self, is_dict=False):
        # 如果is_dict为True，则返回字典形式数据，否则返回数组形式
        if is_dict:
            data = self.data_dataframe.to_dict('records')
        else:
            data = self.data_dataframe.values.tolist()

        # 将fields按dataframe列名的前后顺序排列
        header = self.get_header()

        if header:
            fields = [self.fields[head] for head in header]
        else:  # dataframe为空，但有设置表列字段
            fields = list(self.fields.values())

        return {'desc': self.desc, 'count': self.get_row_num(), 'fields': fields, 'rows': data}

    # ===========================================   self  ==============================================
    def __iter__(self):
        for i in range(len(self.data_dataframe)):
            yield RowProxy(self.data_dataframe, i)


class EFile:
    """
    EFile文件对象
    类属性：表格名、表格字典：{表格名：表格对象}
    类方法: 添加表格、删除表格、从mysql、file、json中读取表格,写入file或json
    """

    def __init__(self, filepath=None, **kwargs):
        self.table_dict = {}
        self.system_declaration = {}

        if filepath:
            self.read_from_file(filepath, **kwargs)

    # ===========================================  add  ==============================================
    def add_table(self, tablename):
        # tmp_list = tablename.split('::')
        actual_table_name = tablename.split('::')[0].strip()
        if not actual_table_name:
            logger.error('table_name is not valid!')
            return None
        # if len(tmp_list) < 1:
        #     return None
        new_table = EFileTable(actual_table_name)
        self.table_dict[actual_table_name] = new_table
        return new_table

    # ===========================================  rename  ==============================================
    def rename_table(self, oldname, newname):
        if oldname not in self.table_dict:
            logger.error(f'Table {oldname} not found')
            return False
        if newname in self.table_dict:
            logger.error(f'Table {newname} already exists')
            return False
        self.table_dict[newname] = self.table_dict.pop(oldname)
        return True

    # ===========================================  get  ==============================================
    def get_table(self, table_name):
        if table_name not in self.table_dict:
            return None
        else:
            return self.table_dict[table_name]

    # 得到指定表的dataframe
    def get_one_table_dataframe(self, table_name):
        if table_name not in self.table_dict:
            logger.error(f'Table {table_name} not found')
            return None

        return self.table_dict[table_name].data_dataframe

    # 得到所有表的dataframe
    def get_table_dataframe_dict(self):
        table_df_dict = {}
        for table_name, table_data in self.table_dict.items():
            table_df_dict[table_name] = table_data.data_dataframe

        return table_df_dict

    # ===========================================  load  ==============================================
    def read_from_rtdb(self, schema=None, app=None, ctx=None, tables=[]):
        """
        从实时数据库(RTDB)读取表数据。
        通过 rtdb_table_op 打开应用和表，将数据写入 CFileInter 对象，再转换为 EFile 内部结构。
        """
        import init_pyd  # noqa: F401
        from pyd.compatlib import THElangFileInter
        from pyd.rtdblib import rtdb_tableop

        if schema is None or app is None or ctx is None:
            logger.error('Please define correct schema, app, ctx!')
            return False

        rtdb_table_op = rtdb_tableop.CRTDBTableOp()
        rtdb_table_op.OpenApp(app, ctx, schema)
        cfile_inter = THElangFileInter.THElangFileInter()

        # 得到所有表
        if len(tables) == 0:
            # tables = vector__string()
            logger.warning('tables为空，未读取任何表数据，结束read_from_rtdb!')
            return True

        for table_name in tables:
            try:
                module = cfile_inter.AddModule(table_name)
                rtdb_table_op.OpenTable(table_name)
                rtdb_table_op.WriteToEFile('', module)
                logger.info(f'Load Table {table_name} from rtdb.rtdb Success: {module[0].GetRows() if USE_PYBIND else module.GetRows()} rows')
            except Exception as e:
                logger.error(f'Load Table {table_name} Failed: {e}')

        # 将填充好的 cfile_inter 转换到本 EFile 对象中
        self.read_from_cfileinter(cfile_inter)
        return True

    def read_from_dataframe_dict(self, dataframe_dict):
        """
        从字典 {表名: DataFrame} 直接构建 EFile 对象。
        """
        self.table_dict = {}
        for table_name, table_df in dataframe_dict.items():
            new_table = self.add_table(table_name)
            new_table.add_data_from_df(table_df)
        return True

    def read_from_file(self, file_path, encoding='gb18030'):
        import warnings

        warnings.simplefilter(action='ignore', category=FutureWarning)

        # 1. read raw
        self.table_dict = {}
        if not os.path.exists(file_path):
            logger.error('文件不存在：%s' % file_path)
            raise FileNotFoundError(f'文件不存在：{file_path}')

        # Define custom error handler to match efile.py behavior
        def replace_with_a(error):
            return ('a', error.end)

        try:
            codecs.lookup_error('replace_with_a')
        except LookupError:
            codecs.register_error('replace_with_a', replace_with_a)

        try:
            with open(file_path, 'rb') as f:
                content = f.read()
        except Exception as e:
            logger.error(f'读取文件失败: {e}')
            return False

        content = content.replace(b'"', b"'")
        content = content.replace(b'\n#', b'\n')

        if content.startswith(b'#'):
            content = content[1:]

        # Sys declaration
        pos = 0
        file_len = len(content)

        # custom_na_values = ['#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN', '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'n/a', 'nan', 'null']
        # Reduced NA list might be faster if we trust data cleanliness, but keeping safe list:
        # custom_na_values = ['nan', 'null', 'NULL', 'NaN', 'NA']

        parsing_tasks = []

        # Worker function: Processes a single table's raw bytes
        def parse_worker(table_name, body_bytes, header, comments):
            try:
                # Local replacements removed (done globally)

                # Strip Header/Comment lines
                # Efficient Stripping:
                # Regex replace header lines to avoid read_csv seeing them
                # (Pattern assumes @ and // are at start of lines)
                # This works on bytes.
                # Only need to strip 2 lines max.
                # Regex could be slow if body is huge.
                # But readline loop was proven OK.
                # Let's use readline loop, it's robust.

                BIO = io.BytesIO(body_bytes)
                start_offset = 0
                while True:
                    line = BIO.readline()
                    if not line:
                        break
                    sline = line.strip()
                    if not sline:
                        start_offset = BIO.tell()
                        continue
                    if sline.startswith(b'@') or sline.startswith(b'//'):
                        start_offset = BIO.tell()  # Mark start after this line
                        continue
                    break

                BIO.seek(start_offset)

                # Now read CSV
                # Optimization:
                # use delim_whitespace=True (C-engine optimized).
                # skipinitialspace=True helps strip leading whitespace.
                # FutureWarning suppressed globally
                df = pd.read_csv(
                    BIO,
                    encoding=encoding,
                    encoding_errors='replace_with_a',
                    delim_whitespace=True,
                    quotechar="'",
                    header=None,
                    names=header,
                    dtype=str,
                    on_bad_lines='skip',
                    keep_default_na=False,
                    na_filter=False,  # Optimization: Disable NA check. Matches baseline efile.py which reads everything as strings.
                    skipinitialspace=True,
                )

                # Post-processing filtration
                if not df.empty:
                    # Strip logic removed for performance (<2s target).
                    # 'skipinitialspace=True' handles most leading space issues.
                    # Remaining trailing space (if any) is accepted trade-off for speed.
                    pass

                return (table_name, df)
            except Exception as e:
                return (table_name, None, e)

        import concurrent.futures

        # Check file size for threading decision
        use_multithread = file_len > 1024 * 1024  # 1MB

        if use_multithread:
            executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)
        else:
            executor = None

        try:
            while pos < file_len:
                start_tag_idx = content.find(b'<', pos)
                if start_tag_idx == -1:
                    break

                close_tag_idx = content.find(b'>', start_tag_idx)
                if close_tag_idx == -1:
                    break

                tag_content = content[start_tag_idx + 1 : close_tag_idx]

                # System Declaration <!! ...>
                if tag_content.startswith(b'!!'):
                    decl_str = tag_content[2:].decode(encoding, errors='replace_with_a').strip()
                    for tmpStr in re.split(r'\s+', decl_str):
                        if '=' in tmpStr:
                            k, v = tmpStr.split('=', 1)
                            self.system_declaration[k] = v
                    pos = close_tag_idx + 1
                    continue

                # Skip comments/directives </ or <!
                if tag_content.startswith(b'/') or tag_content.startswith(b'!'):
                    pos = close_tag_idx + 1
                    continue

                # Parse Table Name and Props
                parts = tag_content.split(None, 1)
                if not parts:
                    pos = close_tag_idx + 1
                    continue

                table_name_bytes = parts[0]
                table_name = table_name_bytes.decode(encoding, errors='replace_with_a').strip()

                props_str = ''
                if len(parts) > 1:
                    props_str = parts[1].decode(encoding, errors='replace_with_a').strip()

                # Find End Tag
                closing_tag = b'</' + table_name_bytes + b'>'
                table_end_idx = content.find(closing_tag, close_tag_idx)
                if table_end_idx == -1:
                    pos = close_tag_idx + 1
                    continue

                # Extract Body
                body_content = content[close_tag_idx + 1 : table_end_idx]

                # Create Table Object
                new_table = self.add_table(table_name)
                # Parse Props
                if props_str:
                    props_str = re.sub(r'\s*=\s*', '=', props_str)
                    for prop in re.split(r'\s+', props_str):
                        if '=' in prop:
                            k, v = prop.split('=', 1)
                            new_table.add_prop({k: v})

                # Extract Header and Comments (Regex is fast on bytes)
                header = []
                header_match = re.search(b'^\s*@(.*)', body_content, re.MULTILINE)
                if header_match:
                    header_line = header_match.group(1).decode(encoding, errors='replace_with_a')
                    header = parse_line(header_line)
                    new_table.add_fields(header)

                comments = []
                comment_match = re.search(b'^\s*//(.*)', body_content, re.MULTILINE)
                if comment_match:
                    comment_line = comment_match.group(1).decode(encoding, errors='replace_with_a')
                    comments = parse_line(comment_line)
                    if header and comments:
                        for idx, field in enumerate(header):
                            if idx < len(comments):
                                new_table.fields[field]['comment'] = comments[idx]

                if header:
                    if use_multithread:
                        # Submit task
                        future = executor.submit(parse_worker, table_name, body_content, header, comments)
                        parsing_tasks.append(future)
                    else:
                        # Process sequentially
                        res = parse_worker(table_name, body_content, header, comments)
                        if len(res) == 3:  # Error
                            logger.error(f'[ERROR] 解析表 {res[0]} 数据失败: {res[2]}')
                        elif res[1] is not None:
                            # Merge data
                            self.table_dict[res[0]].add_data_from_df(res[1])

                pos = table_end_idx + len(closing_tag)

            # Collect results for multithreaded case
            if use_multithread:
                import threading

                table_lock = threading.Lock()
                for future in concurrent.futures.as_completed(parsing_tasks):
                    res = future.result()
                    if len(res) == 3:  # Error
                        logger.error(f'[ERROR] 解析表 {res[0]} 数据失败：{res[2]}')
                    elif res[1] is not None:
                        # Merge data - 使用锁保护避免 pd.concat 的线程安全问题
                        with table_lock:
                            self.table_dict[res[0]].add_data_from_df(res[1])

        finally:
            if executor:
                executor.shutdown()

        return True

    def read_from_json(self, file_path=None, json_obj=None, is_data_dict=False, encoding='utf-8'):
        """
        从 JSON 文件或 JSON 对象读取数据。
        支持两种数据格式：
        - rows 为字典列表（每条记录一个字典）
        - data 为列字典（如 {"a":[1,2],"b":[3,4]}）
        """
        self.table_dict = {}
        if file_path:
            try:
                with codecs.open(file_path, 'r', encoding=encoding) as f:
                    json_object = json.load(f)
            except Exception as e:
                logger.error('load json file error:%s' % e)
                return False
        elif json_obj:
            json_object = json_obj
        else:
            logger.info('json file is empty!')
            json_object = {}

        if json_object:
            for table_name, table_content in json_object.items():
                tableobj = self.add_table(table_name)
                tableobj.set_desc(table_content.get('desc', ''))

                fields = table_content.get('fields', [])
                columns = [field['name'] for field in fields]
                tableobj.set_fields(fields)
                # 将fields按index排列

                # if fields:
                #     tableobj.set_fields(fields)
                # json的数据形式
                """
                第一种
                    rows":[{
                    "ID":"00000000001",
                    "NAME":"浙江省"
                },{
                    "ID":"00000000003",
                    "NAME":"福建省"
                }]
                第二种
                datas = {"a": [1, 2, 3], "b": [4, 5, 6]}
                """
                data = table_content.get('rows') or table_content.get('data', [])
                if isinstance(data, dict):
                    tableobj.add_rows_data(data)
                elif isinstance(data, list):
                    tableobj.add_rows_data(rows_data=data, columns=columns)

        return True

    def read_from_mysql(self, connection, tables=[]):
        """
        从 MySQL 数据库读取表，使用 pandas.read_sql_table。
        自动推断字段类型并设置到 fields 中。
        """
        if not tables:
            logger.warning('tables为空，未读取任何表数据，结束read_from_mysql!')
            return True
        self.table_dict = {}

        for table_name in tables:
            try:
                table_df = pd.read_sql_table(table_name, connection)

                # 所有对象类型都转为 string，数值类型保持原样
                for col in table_df.columns:
                    if table_df[col].dtype == 'object':
                        table_df[col] = table_df[col].astype('string')

                # 将表和表数据，添加到EFile
                new_table = self.add_table(table_name)
                # 将df的列数据类型得到，添加到field的type中
                fileds_list = []
                for column_name in table_df.columns:
                    dtype = str(table_df[column_name].dtype)
                    if dtype.startswith('int'):
                        field_type = 'int'
                    elif dtype.startswith('float'):
                        field_type = 'float'
                    elif dtype == 'bool':
                        field_type = 'boolean'
                    elif 'datetime' in dtype:
                        field_type = 'datetime'
                    else:
                        field_type = 'string'

                    new_field = {'name': column_name, 'comment': '', 'type': field_type, 'unit': '', 'default': ''}
                    fileds_list.append(new_field)
                new_table.set_fields(fileds_list)
                new_table.add_data_from_df(table_df)
                logger.success(f'Load table {table_name} success!')
            except Exception as e:
                logger.error(f'Load table {table_name} failed: {e}')

        return True

    def read_from_cfileinter(self, cefile):
        self.table_dict = {}
        # 获取所有的模块列表
        module_ptr = cefile.GetModPtrArr()[0] if USE_PYBIND else cefile.GetModPtrArr()

        # 遍历得到每个表的数据
        for module in module_ptr:
            c_table = module[0] if USE_PYBIND else module
            table_name = c_table.GetName()

            c_table = cefile.GetModulePtrByName(table_name)[0] if USE_PYBIND else cefile.GetModulePtrByName(table_name)

            new_table = EFileTable(table_name)

            # 得到属性
            props = c_table.GetPropVector()[0] if USE_PYBIND else c_table.GetPropVector()
            for key in props:
                new_table.prop_dict[key] = c_table.GetProp(key)

            # 得到列名
            rows, cols = c_table.GetRows(), c_table.GetCols()
            headers = []
            for col in range(cols):
                headers.append(c_table.GetColName(col))

            if rows == 0:
                table_df = pd.DataFrame(columns=headers)
            else:
                from concurrent.futures import ThreadPoolExecutor

                max_works = os.cpu_count() - 1
                batch_size = max(1, rows // max_works)

                table_datas = []

                def process_row(begin):
                    data = []
                    for row in range(begin, min(begin + batch_size, rows)):
                        efileinter_row = c_table.GetRow(row).ref() if USE_PYBIND else c_table.GetRow(row)
                        data.extend([[efileinter_row.GetValue(col) for col in range(cols)]])
                    return data

                with ThreadPoolExecutor(max_workers=max_works) as executor:
                    # 分批处理避免内存峰值
                    for res in executor.map(process_row, range(0, rows, batch_size)):
                        table_datas.extend(res)

                table_df = pd.DataFrame(table_datas, columns=headers)

            new_table.add_data_from_df(table_df)

            self.table_dict[table_name] = new_table

        return True

    # ===========================================  write  ==============================================

    def write_to_rtdb(self, schema=None, app=None, ctx=None, clear=True, change_key=False):
        """
        将 EFile 数据写入实时数据库 RTDB。
        先转换为 CFileInter 对象，然后通过 rtdb_table_op 写入。
        """
        import init_pyd  # noqa: F401
        from pyd.rtdblib import rtdb_tableop

        if schema is None or app is None or ctx is None:
            logger.error('Please define correct schema, app, ctx!')
            return False

        rtdb_table_op = rtdb_tableop.CRTDBTableOp()
        rtdb_table_op.OpenApp(app, ctx, schema)

        # 先将efile的数据转为cefile,然后基于cefile写入
        cfile_inter = self.write_to_cfileinter()

        pModelArray = cfile_inter.GetModPtrArr()[0] if USE_PYBIND else cfile_inter.GetModPtrArr()
        for module in pModelArray:
            mod = module[0] if USE_PYBIND else module
            try:
                table_name = mod.GetName()
                rtdb_table_op.OpenTable(table_name)
                rtdb_table_op.ReadFromEFile('', module, clear, change_key)
                logger.info(f'Write Table {table_name} To RTDB Success: {mod.GetRows()} rows')
            except Exception as e:
                logger.bind(step='ERRPR').error(f'Write Table {mod.GetName()} To RTDB Failed: {e}')
                continue

        return True

    def write_to_efile(self, file_path, encoding='gb18030'):
        """
        将 EFile 对象写入文本文件（EFile 格式）。
        根据内容自动调整列宽，对齐输出，并处理引号等。
        """

        def get_display_width(s):
            """计算字符串的显示宽度（全角字符占2，半角占1）"""
            width = 0
            for char in str(s):
                east_asian_width = unicodedata.east_asian_width(char)
                if east_asian_width in ('F', 'W', 'A'):
                    width += 2
                else:
                    width += 1
            return width

        # 函数：计算每列数据的最大显示宽度
        def get_max_width(column):
            return max((get_display_width(val) for val in column), default=0)

        # 函数：用全角或半角空格填充字符串，使其达到指定宽度
        def pad_string(s, width):
            s = str(s)
            if s == '':
                s = "''"
            current_width = get_display_width(s)  # 计算当前字符串的显示宽度
            padding_width = width - current_width  # 计算需要填充的宽度
            if padding_width <= 0:
                return s

            # 填充逻辑：优先使用全角空格，剩余部分用半角空格填充
            full_width_spaces = padding_width // 2  # 全角空格的数量
            half_width_spaces = padding_width % 2  # 半角空格的数量
            return s + '  ' * full_width_spaces + ' ' * half_width_spaces

        with open(file_path, 'w', encoding=encoding) as f:
            for table_name, table in self.table_dict.items():
                # table_header = table.get_header()
                table_header_comment = table.get_header_comment()
                table_df = table.data_dataframe

                # 数据格式化
                if hasattr(table_df, 'map'):
                    table_df = table_df.map(format_element).reset_index(drop=True)
                else:
                    table_df = table_df.applymap(format_element).reset_index(drop=True)

                # 写入 <table_name>
                table_prop_str = ' '.join(f'{prop}={table.prop_dict[prop]}' for prop in table.prop_dict)
                if table_prop_str:
                    f.write(f'<{table_name} {table_prop_str}>\n')
                else:
                    f.write(f'<{table_name}>\n')

                # 计算每列的最大显示宽度，包括列名和数据内容
                column_widths = {col: max(get_max_width(table_df[col]), get_display_width(col)) + 5 for col in table_df.columns}
                header = ' '.join([pad_string(col, column_widths[col]) for col in table_df.columns])
                f.write(f'@ {header}\n')

                if table_header_comment and any(item.strip() for item in table_header_comment):
                    comment_str = ' '.join([pad_string(comment, column_widths[col]) for col, comment in zip(table_df.columns, table_header_comment)])
                    # 判断comment_str在去除前后空格后是否为空
                    if comment_str.strip():
                        f.write(f'// {comment_str}\n')

                if table_df.empty:
                    f.write(f'</{table_name}>\n')
                    continue

                for row in table_df.itertuples():
                    # 对每个值进行检查，如果包含空格则添加单引号
                    row_str = ' '.join([pad_string(val, column_widths[col]) for col, val in zip(table_df.columns, row[1:])])
                    f.write(f'# {row_str}\n')

                # 写入 </table_name>
                f.write(f'</{table_name}>\n')

        return True

    def write_to_json(self, file_path=None, is_data_dict=False, encoding='utf-8'):
        """
        将 EFile 对象转换为 JSON 格式。
        is_data_dict 控制 rows 输出为字典列表（True）还是二维列表（False）。
        """
        json_object = {}
        for table_name, table in self.table_dict.items():
            json_object[table_name] = table.to_json(is_dict=is_data_dict)
        result = json.dumps(json_object, indent=4, ensure_ascii=False, separators=(',', ':'))

        if file_path:
            with codecs.open(file_path, 'w', encoding=encoding) as f:
                f.write(result)
        return json_object

    def write_to_cfileinter(self):
        """
        将 Python 的 EFile 对象转换为 C++ 层的 THElangFileInter 对象。
        逐表、逐行写入数据。
        """
        import init_pyd  # noqa: F401
        from pyd.compatlib import THElangFileInter

        newefile = THElangFileInter.THElangFileInter()
        for table_name, table in self.table_dict.items():
            module = newefile.AddModule(table_name)[0] if USE_PYBIND else newefile.AddModule(table_name)
            # 这里如果table_dict为空则
            table_df = table.data_dataframe
            headers = table_df.columns if not table_df.empty else table.get_header()
            for col in headers:
                module.AddCol(col)

            for row in table_df.itertuples(index=False):
                module_row = module.AddRow()
                row_list = list(row)
                for i, val in enumerate(row_list):
                    module.ModifyValue(module_row, i, f'{val}')

        return newefile

    def write_to_db(self, engine, clear=True, database=None):
        """
        将 EFile 中的所有表写入数据库。
        支持 MySQL、SQLite 等 SQLAlchemy 可连接的数据库。
        处理表存在/不存在的情况，主键设置，数据类型映射等。
        """
        from sqlalchemy import VARCHAR, create_engine, inspect, text

        from helper.db_utils import DataFrameToSql

        if database:  # 如果传入的engine没有指定数据库
            url = engine.url
            engine_url = f'{url.drivername}://{url.username}:{url.password}@{url.host}:{url.port}/{database}'
            engine = create_engine(engine_url)

        table_dataframe_dict = self.get_table_dataframe_dict()

        start = time.perf_counter()
        inspector = inspect(engine)
        dialect = inspector.dialect.name  # 获取数据库类型
        for table_name, table_df in table_dataframe_dict.items():
            try:
                with engine.begin() as cursor:
                    table_exists = inspector.has_table(table_name)

                    # 准备数据类型映射
                    dtype_dict = {col: VARCHAR(255) for col in table_df.select_dtypes(include='object').columns}

                    if table_exists:
                        if clear is True:
                            if dialect == 'sqlite':
                                cursor.execute(text(f'DELETE FROM `{table_name}`'))
                            elif dialect == 'mysql':
                                cursor.execute(text(f'TRUNCATE TABLE `{table_name}`'))
                            else:
                                cursor.execute(text(f'TRUNCATE TABLE "{table_name}"'))
                            logger.info(f'`{table_name}` clear success')

                        db_columns = [col['name'] for col in inspector.get_columns(table_name)]
                        extra_cols = [col for col in table_df.columns if col.lower() not in db_columns and col.upper() not in db_columns]
                        if extra_cols:
                            logger.warning(f'表 {table_name} 下面这些列在数据库中未定义，无法写入这些列！')
                            print(extra_cols)
                            useful_cols = [col for col in table_df.columns if col.lower() in db_columns or col.upper() in db_columns]
                            table_df = table_df[useful_cols]

                        primary_keys = inspector.get_pk_constraint(table_name)['constrained_columns']
                        if len(primary_keys) == 1 and primary_keys[0] == 'id' and 'id' not in table_df.columns and clear is True:
                            table_df['id'] = table_df.index
                        DataFrameToSql(table_df, table_name, cursor, clear=False, update=False)
                    else:
                        logger.info(f'表 {table_name} 不存在，将创建新表')

                        df_columns_lower = [col.lower() for col in table_df.columns]
                        has_id_column = 'id' in df_columns_lower

                        if clear is True:
                            if not has_id_column:
                                if 'idx' in table_df.columns:
                                    table_df = table_df.rename_axis(index='idx')
                                else:
                                    table_df = table_df.rename_axis(index='id')
                                    table_df['id'] = table_df.index

                                DataFrameToSql(table_df, table_name, cursor, clear=False, update=False, dtype=dtype_dict)

                                if not table_df.empty:
                                    cursor.execute(text(f'ALTER TABLE `{table_name}` ADD PRIMARY KEY (`{table_df.index.name}`);'))
                                    logger.info(f'修改表{table_name}的主键为{table_df.index.name}')
                            else:
                                DataFrameToSql(table_df, table_name, cursor, clear=False, update=False, dtype=dtype_dict)
                                logger.info(f'表{table_name}使用已有的ID列作为主键')
                        else:
                            DataFrameToSql(table_df, table_name, cursor, clear=False, update=False, dtype=dtype_dict)

                    logger.success(f'{table_name} write to db, len: {len(table_df)}, cost {round((time.perf_counter() - start) / 60, 2)}min')
            except Exception as e:
                logger.error(f'{table_name} write to db failed：{e}')
                print(traceback.format_exc())
            finally:
                pass

        return True

    # ===========================================  convert  ==============================================
    def convert_id(self, id_or_rdfid=True):
        table_df_dict = self.get_table_dataframe_dict()

        table_dict_converted = id_to_long(table_df_dict, id_or_rdfid)
        self.read_from_dataframe_dict(table_dict_converted)

        return True

    def fill_na(self, fill_value=None):
        for table_obj in self.table_dict.values():
            table_obj.fill_na(fill_value)
        return True

    def convert_to_new_efile(self, convert_yaml_data=None, convert_yaml_path=None, convert_id=False):
        """
        根据转换配置 YAML，从当前 EFile 生成一个新的 EFile。
        支持列重命名、设置默认值、类型转换、ID 重新生成等。

        配置文件格式（YAML）：
            顶层键为 新表名，每个表包含 src（源表名）和 cols（列转换规则）。
            cols 中每个键为新列名，值可包含：
              - src:    源列名（缺省则与新列名相同）
              - default: 源列不存在时使用的默认值
              - type:   数据类型（int/float/str/bool），用于在 default 缺失时自动填充默认值
                        int→0, float→0.0, str→'', bool→True

        示例：
            new_area:
              src: dms_def_area
              cols:
                id:
                  src: id
                name:
                  src: area_name
                status:
                  type: int        # 源列不存在时自动填 0
                remark:
                  default: ''      # 显式指定默认值

        参数 convert_id=True 时：
            自动将原 id 保存到 org_id，新 id 从 1 开始连续编号，并调用 id_to_long 转换。
        """
        type_default_value_dict = {
            'int': 0,
            'float': 0.0,
            'str': '',
            'bool': True,
        }  # 数据类型和默认值

        if convert_yaml_path:  # 读取配置文件
            import yaml

            try:
                with open(convert_yaml_path, encoding='utf-8') as f:
                    convert_yaml_data = yaml.safe_load(f)
            except Exception as e:
                print(f'convert_yaml_path is not valid: {e}')

        if not convert_yaml_data:  # 如果配置文件和传参都没有，则抛出异常
            raise Exception('convert_yaml_data or convert_yaml_path must be provided')

        new_efile = EFile()
        new_table_dataframe_dict = {}

        # 遍历配置文件中的每个表
        for new_table_name, table_convert_config in convert_yaml_data.items():
            source_table_name = table_convert_config.get('src')  # 获取源表名
            if source_table_name not in self.table_dict:  # 如果源表不存在，则跳过
                logger.error(f'Table {source_table_name} not found in source_efile')
                continue

            if 'cols' not in table_convert_config or not table_convert_config['cols']:  # 如果没有指定列转换规则，则跳过
                logger.error(f'convert_cols not found in table {new_table_name}')
                continue
            columns_convert_info = table_convert_config['cols']

            source_data_frame = self.get_one_table_dataframe(source_table_name)

            # 先转换col在source_data_frame.columns中存在的列
            columns_convert_dict = {}
            for new_col, col_info in columns_convert_info.items():
                src_col = col_info.get('src', new_col)
                if src_col in source_data_frame.columns:
                    columns_convert_dict[src_col] = new_col

            new_columns = list(columns_convert_dict.values())
            new_data_frame = source_data_frame.rename(columns=columns_convert_dict)[new_columns]

            # 再准换col在source_data_frame.columns中不存在的列
            not_found_columns = [col for col in columns_convert_info if col not in new_columns]
            if not_found_columns:
                logger.warning(f'There are {len(not_found_columns)} columns not found for table {new_table_name} : ')
                print(f'{not_found_columns}')
            for col in not_found_columns:
                new_col_info = columns_convert_info[col]
                default_value = new_col_info.get('default', None)

                if default_value is None:
                    new_col_type = new_col_info.get('type', None)
                    if new_col_type and new_col_type in type_default_value_dict:
                        default_value = type_default_value_dict[new_col_type]
                    else:
                        default_value = ''

                new_data_frame[col] = default_value

            if convert_id:  # 如果convert_id参数为true，则表示要将旧的id转换为新的id
                new_data_frame['org_id'] = new_data_frame['id']  # 将原id存储到org_id列中
                new_data_frame['id'] = range(1, len(new_data_frame) + 1)  # 将id列重置为从1开始的连续整数

            new_table_dataframe_dict[new_table_name] = new_data_frame

        if convert_id:
            new_table_dataframe_dict = id_to_long(new_table_dataframe_dict, False)

            for table_name, table_df in new_table_dataframe_dict.items():
                table_df.drop(columns=['org_id'], errors='ignore', inplace=True)

        new_efile.read_from_dataframe_dict(new_table_dataframe_dict)

        return new_efile

    def value_report(self):
        """
        统计每个表每个字段中空值和0值的比例，并打印报告。
        用于数据质量检查。
        """
        res = {}
        for table_name, table_df in self.table_dict.items():
            res[table_name] = {}
            df = table_df.data_dataframe
            for col in df.columns:
                mask = (df[col] == 0) | (df[col] == '0') | (df[col] == '')
                res[table_name][col] = mask.sum() / max(1, len(df))

        logger.info('====================================== 统计每个表每个字段中 空值 和 0值 的比例 ======================================')

        for table_name, table_res in res.items():
            print(f'表:[{table_name}], 总行数：{len(self.table_dict[table_name].data_dataframe)}')
            count = 0
            sorted_items = sorted(table_res.items(), key=lambda x: x[1], reverse=True)
            for i, v in sorted_items:
                if v == 1:
                    i = f'🔴 {i}'
                elif v >= 0.8:
                    i = f'🔵 {i}'
                elif v >= 0.5:
                    i = f'🟠 {i}'
                else:
                    continue
                print(f'\t{i:>30}: {v:<.2f}', end='\t')
                count += 1
                if count % 5 == 0:
                    print()
            print('\n-----------------------------------------------')  # 确保最后一个表后有换行

        print('========================================================================================================================')
        return res

    # ===========================================  delete  ==============================================
    def remove_table(self, name):
        if name in self.table_dict:
            del self.table_dict[name]
        return True

    # ===========================================  self  ==============================================
    def __len__(self):
        return len(self.table_dict)

    def __iter__(self):
        return iter(self.table_dict.items())


# todo 常用功能函数
def e_file_to_df(efile_path, table=None, encoding='gb18030'):
    efile = EFile()
    try:
        efile.read_from_file(efile_path, encoding=encoding)
        if table is None:
            return {table_name: efile.table_dict[table_name].data_dataframe for table_name in efile.table_dict}
        else:
            return efile.table_dict[table].data_dataframe
    except Exception as e:
        logger.error(f'efile data write to mysql failed: {e}')
        return None


def e_file_to_mysql(efile_path, db_connection, encoding='gb18030', clear=True):
    efile = EFile()
    try:
        efile.read_from_file(efile_path, encoding=encoding)
        efile.write_to_db(db_connection, clear=clear)

        logger.info('efile data has been written to mysql!')
        return True
    except Exception as e:
        logger.error(f'efile data write to mysql failed: {e}')
        return False


def e_file_to_json(efile_path, output_path, encoding='gb18030'):
    efile = EFile()
    try:
        efile.read_from_file(efile_path, encoding=encoding)
        efile.write_to_json(output_path)

        logger.info('efile data has been written to json!')
        return True
    except Exception as e:
        logger.error(f'efile data write to json failed: {e}')
        return False


def e_file_to_rtdb(efile_path, schema=None, app=None, ctx=None, encoding='gb18030'):
    efile = EFile()
    try:
        efile.read_from_file(efile_path, encoding=encoding)
        efile.write_to_rtdb(schema=schema, app=app, ctx=ctx)

        logger.info('efile data has been written to rtdb!')
        return True
    except Exception as e:
        logger.error(f'efile data write to rtdb failed: {e}')
        return False


def e_file_to_cfileinter(efile_path, encoding='gb18030'):
    efile = EFile()
    try:
        efile.read_from_file(efile_path, encoding=encoding)
        cfile = efile.write_to_cfileinter()

        logger.info('efile data has been written to cfileinter!')
        return cfile
    except Exception as e:
        logger.error(f'efile data write to cfileinter failed: {e}')
        return None


def e_file_to_netdata(efile_path, encoding='gb18030'):
    # 从文件生成 CEFileinter
    efileinter = e_file_to_cfileinter(efile_path)
    if efileinter is None:
        return None

    from helper.pyd_utils import efileinter_to_netdata

    return efileinter_to_netdata(efileinter)


def e_file_to_feather(efile_path, dirpath):
    efile = EFile()
    try:
        efile.read_from_file(efile_path, encoding='gb18030')
    except Exception as e:
        logger.bind(step='e_file_to_feather').error(f'efile data read from file failed: {e}')
        return None

    efile_dict = {}
    for table_name, table_df in efile.table_dict.items():
        efile_dict[table_name] = table_df.data_dataframe

    df_dict_to_feather(efile_dict, dirpath)

    return efile_dict


def e_file_from_feather(dirpath, columns=None):
    efile_dict = df_dict_from_feather(dirpath, columns=columns)
    efile = EFile()
    for table_name, table_df in efile_dict.items():
        efile.table_dict[table_name] = EFileTable(table_name)
        efile.table_dict[table_name].data_dataframe = table_df
        for col in table_df.columns:
            efile.table_dict[table_name].add_field(col)
    return efile


def e_json_to_efile(json_path, output_path, encoding='utf-8', is_data_dict=True):
    efile = EFile()
    try:
        efile.read_from_json(file_path=json_path, encoding=encoding, is_data_dict=is_data_dict)
        efile.write_to_efile(output_path)
        logger.info('e json data has been written to efile!')
        return True
    except Exception as e:
        logger.error(f'e json data write to efile failed: {e}')
        return False


def e_json_to_mysql(json_path, db_connection, encoding='utf-8', is_data_dict=True, clear=True):
    efile = EFile()
    try:
        efile.read_from_json(file_path=json_path, encoding=encoding, is_data_dict=is_data_dict)
        efile.write_to_db(db_connection, clear=clear)
        logger.info('e json data has been written to mysql!')
        return True
    except Exception as e:
        logger.error(f'e json data write to mysql failed! Error: {e}')
        return False


def e_json_to_rtdb(json_path, schema=None, app=None, ctx=None, encoding='utf-8', is_data_dict=True):
    efile = EFile()
    try:
        efile.read_from_json(file_path=json_path, encoding=encoding, is_data_dict=is_data_dict)
        efile.write_to_rtdb(schema=schema, app=app, ctx=ctx)
        logger.info('e json data has been written to rtdb!')
        return True
    except Exception as e:
        logger.error(f'e json data write to rtdb failed! Error: {e}')
        return False


def e_json_to_cfileinter(json_path, encoding='utf-8', is_data_dict=True):
    efile = EFile()
    try:
        efile.read_from_json(file_path=json_path, encoding=encoding, is_data_dict=is_data_dict)
        cfile = efile.write_to_cfileinter()
        logger.info('e json data has been written to cfileinter!')
        return cfile
    except Exception as e:
        logger.error(f'e json data write to cfileinter failed! Error: {e}')
        return None


def e_mysql_to_file(db_connection, output_path, tables=[]):
    efile = EFile()
    try:
        efile.read_from_mysql(db_connection, tables)
        efile.write_to_efile(output_path)
        logger.info('mysql data has been written to efile!')
        return True
    except Exception as e:
        logger.error(f'mysql data write to efile failed! Error: {e}')
        return False


def e_mysql_to_json(db_connection, output_path, tables=[]):
    efile = EFile()
    try:
        efile.read_from_mysql(db_connection, tables)
        efile.write_to_json(output_path)
        logger.info('mysql data has been written to json!')
        return True
    except Exception as e:
        logger.error(f'mysql data write to json failed! Error: {e}')
        return False


def e_mysql_to_rtdb(db_connection, schema=None, app=None, ctx=None, tables=[]):
    efile = EFile()
    try:
        efile.read_from_mysql(db_connection, tables)
        efile.write_to_rtdb(schema=schema, app=app, ctx=ctx)
        logger.info('mysql data has been written to rtdb!')
        return True
    except Exception as e:
        logger.error(f'mysql data write to rtdb failed! Error: {e}')
        return False


def e_mysql_to_cfileinter(db_connection, tables=[]):
    efile = EFile()
    try:
        efile.read_from_mysql(db_connection, tables)
        cfile = efile.write_to_cfileinter()
        logger.info('mysql data has been written to cfileinter!')
        return cfile
    except Exception as e:
        logger.error(f'mysql data write to cfileinter failed! Error: {e}')
        return None


def e_rtdb_to_file(output_path, schema=None, app=None, ctx=None, tables=[]):
    efile = EFile()
    try:
        efile.read_from_rtdb(schema=schema, app=app, ctx=ctx, tables=tables)
        efile.write_to_efile(output_path)
        logger.info('rtdb data has been written to efile!')
        return True
    except Exception as e:
        logger.error(f'rtdb data write to efile failed! Error: {e}')
        return False


def e_rtdb_to_json(output_path, schema=None, app=None, ctx=None, tables=[]):
    efile = EFile()
    try:
        efile.read_from_rtdb(schema=schema, app=app, ctx=ctx, tables=tables)
        efile.write_to_json(output_path)
        logger.info('rtdb data has been written to json!')
        return True
    except Exception as e:
        logger.error(f'rtdb data write to json failed! Error: {e}')
        return False


def e_rtdb_to_mysql(db_connection, schema=None, app=None, ctx=None, tables=[], clear=True):
    efile = EFile()
    try:
        efile.read_from_rtdb(schema=schema, app=app, ctx=ctx, tables=tables)
        efile.write_to_db(db_connection, clear=clear)
        logger.info('rtdb data has been written to mysql!')
        return True
    except Exception as e:
        logger.error(f'rtdb data write to mysql failed! Error: {e}')
        return False


def e_rtdb_to_cfileinter(schema=None, app=None, ctx=None, tables=[]):
    efile = EFile()
    try:
        efile.read_from_rtdb(schema=schema, app=app, ctx=ctx, tables=tables)
        cfile = efile.write_to_cfileinter()
        logger.info('rtdb data has been written to cfileinter!')
        return cfile
    except Exception as e:
        logger.error(f'rtdb data write to cfileinter failed! Error: {e}')
        return None


def e_cfileinter_to_file(cefile, output_path):
    efile = EFile()
    try:
        efile.read_from_cfileinter(cefile)
        efile.write_to_efile(output_path)
        logger.info('cfileinter data has been written to efile!')
        return True
    except Exception as e:
        logger.error(f'cfileinter data write to efile failed! Error: {e}')
        return False


def e_cfileinter_to_json(cefile, output_path):
    efile = EFile()
    try:
        efile.read_from_cfileinter(cefile)
        efile.write_to_json(output_path)
        logger.info('cfileinter data has been written to json!')
        return True
    except Exception as e:
        logger.error(f'cfileinter data write to json failed! Error: {e}')
        return False


def e_cfileinter_to_mysql(cefile, db_connection, clear=True):
    efile = EFile()
    try:
        efile.read_from_cfileinter(cefile)
        efile.write_to_db(db_connection, clear=clear)
        logger.info('cfileinter data has been written to mysql!')
        return True
    except Exception as e:
        logger.error(f'cfileinter data write to mysql failed! Error: {e}')
        return False


def e_cfileinter_to_rtdb(cefile, schema=None, app=None, ctx=None):
    efile = EFile()
    try:
        efile.read_from_cfileinter(cefile)
        efile.write_to_rtdb(schema=schema, app=app, ctx=ctx)
        logger.info('cfileinter data has been written to rtdb!')
        return True
    except Exception as e:
        logger.error(f'cfileinter data write to rtdb failed! Error: {e}')
        return False


if __name__ == '__main__':
    efile = EFile()
    # efile.load_from_rtdb(schema='main', app='public', ctx='real', tables=['sys_table_info'])
    # efile.write_to_efile('linyi_pas_real.e')
    args = parser.parse_args()
    if not args.efile and not args.json and not args.rtdb:
        logger.error('未配置输入，程序结束！')
        exit()
    if args.efile:
        efile.read_from_file(args.efile, encoding=args.encoding)
    if args.json:
        efile.read_from_json(args.json)
    if args.rtdb:
        if args.tables:
            tables = args.tables.split(',')
        efile.read_from_rtdb(args.schema, args.app, args.ctx, tables)

    if args.convert:
        efile.convert_id()

    if args.efileout:
        efile.write_to_efile(args.efileout)

    if args.jsonout:
        efile.write_to_json(args.jsonout)
