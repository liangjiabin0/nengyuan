#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
数据解析脚本

功能：
1. 解析JSON数据为DataFrame
2. 处理时间点功率数据
3. 修复数据完整性
4. 按馈线分组数据

"""

import copy
import json
import os
import sys
from pathlib import Path

import pandas as pd

# 添加lib库路径
SCRIPT_DIR = Path(__file__).parent.absolute()
LIB_DIR = SCRIPT_DIR / 'lib'
sys.path.insert(0, str(LIB_DIR))

from lib.helper.log import logger
from lib.mparser.efile_parser.efile import EFile
from lib.mparser.efile_parser.id_convert import id_to_long


def _fillna_compatible(df, value=0):
    """pandas 3 的 str 列不能 fillna(0)，按列类型分别填充。"""
    for col in df.columns:
        series = df[col]
        if pd.api.types.is_numeric_dtype(series):
            df[col] = series.fillna(0)
        elif pd.api.types.is_bool_dtype(series):
            df[col] = series.fillna(False)
        else:
            try:
                df[col] = series.fillna(value)
            except (TypeError, ValueError):
                df[col] = series.fillna('')
    return df


def get_itime_power_data(source_json_object, itime_index):
    """
    提取特定时间点的功率数据

    Args:
        source_json_object: 源JSON对象
        itime_index: 时间点索引

    Returns:
        dict: 该时间点的功率数据
    """
    source_json_object_copy = copy.deepcopy(source_json_object)

    for table_name, table_data in source_json_object_copy.items():
        if isinstance(table_data, dict):
            data = table_data.get('rows', [])
            for row in data:
                for key, value in row.items():
                    if isinstance(value, list):
                        if len(value) > itime_index:
                            row[key] = value[itime_index]
                        else:
                            logger.warning(
                                f'{key} in {table_name} has less than {itime_index + 1} elements'
                            )
                            row[key] = value[0] if len(value) > 0 else 0

    return source_json_object_copy


def fix_tables_data(tables_df_dict):
    """
    修复数据完整性

    Args:
        tables_df_dict: 表数据字典

    Returns:
        dict: 修复后的数据字典
    """
    bv_ids = set()
    source_ids = []
    bulk_ids = []
    source_bulk_id = 0
    source_node_id = 0

    for table_name, table_df in tables_df_dict.items():
        # 列名转小写
        table_df.columns = table_df.columns.str.lower()

        # 修复node_id为空
        node_columns = ['node_id', 'znode_id', 'inode_id']
        for col in node_columns:
            if col in table_df.columns:
                table_df[col] = table_df[col].fillna(0)

        _fillna_compatible(table_df, 0)

        # 提取bulk_id
        if table_name == 'dms_def_bulk':
            bulk_ids = table_df['id'].tolist()
            source_bulk_id = bulk_ids[0] if len(bulk_ids) > 0 else 0

        # 添加source_id
        if table_name == 'dms_def_feeder':
            if 'source_id' not in table_df.columns:
                table_df['source_id'] = table_df['id']
                source_ids.extend(table_df['source_id'].unique())
            else:
                source_ids.extend(table_df['source_id'].unique())

        # 提取bv_id
        if 'bv_id' in table_df.columns:
            bv_ids.update(table_df['bv_id'].unique())

        # 设置rdf_id
        table_df['rdf_id'] = table_df['id']

        # 提取source_node_id
        if table_name == 'dms_def_trwd':
            if len(table_df) > 0:
                source_node_id = table_df['node_id'].unique()[0]
            else:
                source_node_id = 0

        # 重新编号id
        table_df['id'] = range(1, len(table_df) + 1)

        tables_df_dict[table_name] = table_df

    # 补充basevoltage表
    if 'basevoltage' not in tables_df_dict:
        tables_df_dict['basevoltage'] = pd.DataFrame(columns=['id', 'nomvol', 'rdf_id'])

    new_bv_rows = []
    idx = len(tables_df_dict['basevoltage']) + 1
    for bv_id in bv_ids:
        if bv_id not in tables_df_dict['basevoltage']['rdf_id'].values:
            new_bv_rows.append({'id': idx, 'rdf_id': bv_id, 'nomvol': 10})
            idx += 1

    if new_bv_rows:
        new_bv_df = pd.DataFrame(new_bv_rows)
        tables_df_dict['basevoltage'] = pd.concat(
            [tables_df_dict['basevoltage'], new_bv_df],
            ignore_index=True
        )

    # 补充dms_def_source表
    if 'dms_def_source' not in tables_df_dict:
        tables_df_dict['dms_def_source'] = pd.DataFrame(
            columns=['id', 'rdf_id', 'bv_id', 'node_id', 'bulk_id']
        )

    source_df = tables_df_dict['dms_def_source']

    # 修复bulk_id
    mask = ~source_df['bulk_id'].isin(bulk_ids)
    if mask.any():
        source_df.loc[mask, 'bulk_id'] = source_bulk_id

    # 补充source记录
    new_source_rows = []
    idx = len(tables_df_dict['dms_def_source']) + 1
    for source_id in source_ids:
        if str(source_id) not in tables_df_dict['dms_def_source']['rdf_id'].astype(str).values:
            new_source_rows.append({
                'id': idx,
                'rdf_id': source_id,
                'node_id': source_node_id,
                'bv_id': list(bv_ids)[0] if bv_ids else 0,
                'bulk_id': source_bulk_id
            })
            idx += 1

    if new_source_rows:
        new_source_df = pd.DataFrame(new_source_rows)
        source_df = pd.concat([source_df, new_source_df], ignore_index=True)

    tables_df_dict['dms_def_source'] = source_df

    # 补充dms_def_bulk表
    if 'dms_def_bulk' not in tables_df_dict or len(bulk_ids) == 0:
        tables_df_dict['dms_def_bulk'] = pd.DataFrame({
            'id': [1],
            'rdf_id': [source_bulk_id]
        })

    return tables_df_dict


def parse_single_timepoint_data(json_data, time_index):
    """
    解析单个时间点的数据

    Args:
        json_data: JSON数据（tables字段）
        time_index: 时间点索引

    Returns:
        dict: DataFrame字典（按馈线分组）
    """
    logger.info(f'解析时间点 {time_index} 的数据')

    # 提取该时间点的功率数据
    json_with_one_time_power_data = get_itime_power_data(json_data, time_index)

    # 使用EFile解析
    efile = EFile()
    efile.read_from_json(json_obj=json_with_one_time_power_data, is_data_dict=True)

    all_feeders_tables_df = efile.get_table_dataframe_dict()

    # 修复数据
    all_feeders_tables_df = fix_tables_data(all_feeders_tables_df)

    # ID转换
    all_feeders_tables_df = id_to_long(all_feeders_tables_df, id_or_rdfid=False)

    # 添加dms前缀
    keys_to_update = list(all_feeders_tables_df.keys())
    for table_name in keys_to_update:
        all_feeders_tables_df['dms_' + table_name] = all_feeders_tables_df.pop(table_name)

    # 加载表结构schema
    schema_file = SCRIPT_DIR.parent / 'assets' / 'templates' / 'tables_schema_for_json_parser.json'

    if not schema_file.exists():
        logger.warning(f'Schema文件不存在：{schema_file}，跳过字段补全')
        feeder_ids = all_feeders_tables_df.get('dms_dms_def_feeder', pd.DataFrame())

        if len(feeder_ids) == 1:
            feeder_id = feeder_ids.iloc[0]['id']
            return {feeder_id: all_feeders_tables_df}

        # 按feeder_id分组
        feeder_tables_df_dict = {}
        for feeder_id in feeder_ids['id'].unique():
            new_tables_df_dict = {}
            for table_name, table_df in all_feeders_tables_df.items():
                if table_name == 'dms_dms_def_feeder':
                    new_tables_df_dict[table_name] = table_df[table_df['id'] == feeder_id]
                elif 'feeder_id' not in table_df.columns:
                    new_tables_df_dict[table_name] = table_df.copy()
                else:
                    new_tables_df_dict[table_name] = table_df[table_df['feeder_id'] == feeder_id]

            feeder_tables_df_dict[feeder_id] = new_tables_df_dict

        return feeder_tables_df_dict

    with open(schema_file, 'r', encoding='utf-8') as f:
        tables_schema = json.load(f)

    # 根据schema补全字段
    for table_name, table_schema in tables_schema.items():
        if not table_name.startswith('dms_'):
            continue

        if table_name in all_feeders_tables_df:
            table_df = all_feeders_tables_df[table_name]

            # 添加缺失列
            missing_columns = [col for col in table_schema.keys() if col not in table_df.columns]

            if missing_columns:
                default_values = {
                    col: (
                        112871465660973057 if col == 'bv_id'
                        else 0.02 if col == 'raa'
                        else 0.03 if col == 'xaa'
                        else 0
                    )
                    for col in missing_columns
                }
                new_cols_df = pd.DataFrame({
                    col: [val] * len(table_df)
                    for col, val in default_values.items()
                })
                table_df = pd.concat([table_df, new_cols_df], axis=1)
        else:
            # 创建空表
            table_df = pd.DataFrame(columns=table_schema.keys())

        table_df.replace('None', 0, inplace=True)
        _fillna_compatible(table_df, 0)
        table_df = table_df.astype(table_schema)
        all_feeders_tables_df[table_name] = table_df

    # 按feeder_id分组
    feeder_ids = all_feeders_tables_df['dms_dms_def_feeder']['id'].tolist()
    feeder_tables_df_dict = {}

    if len(feeder_ids) == 1:
        feeder_tables_df_dict[feeder_ids[0]] = all_feeders_tables_df
        return feeder_tables_df_dict

    for feeder_id in feeder_ids:
        new_tables_df_dict = {}
        for table_name, table_df in all_feeders_tables_df.items():
            if table_name == 'dms_dms_def_feeder':
                new_tables_df_dict[table_name] = table_df[table_df['id'] == feeder_id]
            elif 'feeder_id' not in table_df.columns:
                new_tables_df_dict[table_name] = table_df.copy()
            else:
                new_tables_df_dict[table_name] = table_df[table_df['feeder_id'] == feeder_id]

        feeder_tables_df_dict[feeder_id] = new_tables_df_dict

    logger.info(f'数据解析完成，共{len(feeder_tables_df_dict)}条馈线')
    return feeder_tables_df_dict


def main():
    """测试函数"""
    import sys

    if len(sys.argv) < 2:
        print('Usage: python data_parser.py <json_file> [time_index]')
        return 1

    json_file = sys.argv[1]
    time_index = int(sys.argv[2]) if len(sys.argv) > 2 else 0

    with open(json_file, 'r', encoding='utf-8') as f:
        json_data = json.load(f)['tables']

    feeder_tables_df_dict = parse_single_timepoint_data(json_data, time_index)

    print(f'解析成功，共{len(feeder_tables_df_dict)}条馈线')
    for feeder_id, tables_dict in feeder_tables_df_dict.items():
        print(f'馈线 {feeder_id}: {len(tables_dict)} 张表')

    return 0


if __name__ == '__main__':
    sys.exit(main())