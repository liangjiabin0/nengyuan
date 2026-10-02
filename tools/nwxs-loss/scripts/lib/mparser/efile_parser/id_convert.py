import json
import os
import sys

import pandas as pd

# 设置路径
CUR_PATH = os.path.abspath(os.path.dirname(__file__))
lib_dir = os.path.dirname(os.path.dirname(CUR_PATH))
if lib_dir not in sys.path:
    sys.path.insert(0, lib_dir)

from lib.helper.log import logger


id_map = {}


def generate_long_id(table_id, col_id, index, area_id=0):
    """
    生成长整型ID（64位）：
    """
    return int((int(table_id) << 48) + (int(col_id) << 32) + (int(area_id) << 24) + int(index))


def id_to_long(table_dict, id_or_rdfid=True):
    """
    将给定字典中的所有表的ID（id列或rdf_id列）转换为长ID，并更新引用这些ID的字段。
    流程：
    1. 加载或获取表名到(table_id, col_id)的映射（id_map）。
    2. 遍历每个表，如果存在需要转换的ID列，则生成对应的长ID，并建立旧ID->长ID的映射表（long_id_map）。
    3. 同时将当前表的ID列替换为长ID。
    4. 根据预定义的字段映射表（fields_need_tran），将其他表中引用这些ID的字段值替换为对应的长ID。

    参数：
        table_dict: 字典，键为表名，值为pandas DataFrame。
        id_or_rdfid: True表示转换id列，False表示转换rdf_id列。
    返回：
        更新后的table_dict（DataFrame中的ID列已被修改，引用字段也被替换）。
    """
    long_id_map = {}  # 用于存储每个表的旧ID到长ID的映射，键为表名，值为字典{旧ID: 长ID}

    global id_map
    if not id_map:
        # 如果id_map.json文件存在，则读取文件，如果不存在，则调用get_table_col_id返回id_map
        current_dir = os.path.dirname(os.path.abspath(__file__))  # 当前脚本所在目录
        file_path = os.path.join(current_dir, 'id_map.json')
        if os.path.exists(file_path):
            with open(file_path) as f:
                id_map = json.load(f)
                logger.success('Loaded id_map.json for id_convert')
        else:
            logger.warning('id_map.json is not exists, please run get_table_col_id() first')

    # 第一步：为每个表生成长ID，并构建映射字典
    for table_name, table_df in table_dict.items():
        if len(table_df) == 0:
            # print("empty table: ", table_name)
            long_id_map[table_name] = {}
            continue
        long_id_map[table_name] = {}

        # 获取该表的 table_id 和 col_id（用于生成长ID）
        if table_name in id_map:
            table_id, col_id = id_map[table_name]
        else:
            # 如果不在id_map中，则尝试用get_tableid_col_id函数获取（可能动态生成）
            table_id, col_id = get_tableid_col_id(table_name)
            # table_id, col_id = id_map[table_name]

        if 'id' in table_df.columns:
            table_df['id'] = table_df['id'].astype('int64')

        # 根据参数检查需要转换的ID列是否存在
        if id_or_rdfid is True and 'id' not in table_df.columns:
            logger.error(f"id not in {table_name}'s columns, skip id convert!")
            continue
        elif id_or_rdfid is False and 'rdf_id' not in table_df.columns:
            logger.error(f"rdf_id not in {table_name}'s columns, skip id convert!")
            continue

        # 遍历每一行，生成长ID并记录映射
        for row in table_df.itertuples():
            long_id = generate_long_id(table_id, col_id, row.id)

            if id_or_rdfid:
                long_id_map[table_name][str(row.id)] = long_id
            else:
                if 'org_id' in table_df.columns:
                    long_id_map[table_name][str(row.org_id)] = long_id
                if table_name == 'dms_def_load' in 'meter_id' in table_df.columns:
                    long_id_map[table_name][str(row.meter_id)] = long_id
                else:
                    if 'rdf_id' in table_df.columns:
                        long_id_map[table_name][str(row.rdf_id)] = long_id
                    # elif 'rdf_id' in table_df.columns:
                    #     long_id_map[table_name][str(row['rdf_id'])] = long_id

            table_df.at[row.Index, 'id'] = long_id

    fields_need_tran = {
        'feeder_id': 'dms_def_feeder',
        'bv_id': 'basevoltage',
        'subarea_id': 'subcontrolarea',
        'st_id': 'substation',
        'ist_id': 'substation',
        'jst_id': 'substation',
        'aclnseg_id': ['aclinesegment', 'dms_def_lnseg'],
        'tr_id': ['powertransformer', 'dms_def_trfm'],
        'trfm_id': 'dms_def_trfm',
        'node_id': 'dms_def_node',
        'iterminal_id': 'dms_def_lnseg_dot',
        'zterminal_id': 'dms_def_lnseg_dot',
        'inode_id': 'dms_def_node',
        'znode_id': 'dms_def_node',
        'tpnd': 'tpnode',
        'source_id': 'dms_def_source',
        'bulk_id': 'dms_def_bulk',
        'taptype_id': 'taptype',
        'area_id': 'dms_def_area',
    }

    # 第二步：遍历所有表，将需要转换的字段的值替换为对应的长ID
    for table_name, table in table_dict.items():
        # 找出当前表中在fields_need_tran中定义的字段
        fields = [field for field in table.columns if field in fields_need_tran]
        for field in fields:
            mapped_table = fields_need_tran[field]  # 该字段对应的目标表名
            if isinstance(mapped_table, list):
                # 如果配置为列表，则从列表中选择一个在table_dict中存在的表
                mapped_table = [table for table in mapped_table if table in table_dict]
                if len(mapped_table) == 0:  # 如果没有匹配的表，则跳过该字段的转换
                    logger.warning(f"{fields_need_tran[field]} not found in table_dict, field '{field}' won't be converted")
                    continue
                mapped_table = mapped_table[0]

            if mapped_table not in table_dict:
                logger.warning(f"{mapped_table} not found in table_dict, field '{field}' won't be converted")
                continue

            # 获取目标表的长ID映射字典
            id_maps = long_id_map[mapped_table]

            if len(id_maps) == 0:
                # print(f"Warning: {field} 匹配的 {mapped_table}表 has no data")
                continue

            # 定义映射函数：给定旧ID，返回对应的长ID；若未找到则返回原值（并打印警告）
            def map_id(old_id):
                if pd.isnull(old_id):
                    return '0'
                old_id = str(old_id)
                if old_id not in id_maps.keys():
                    if old_id != '0':
                        logger.warning(f'{old_id} not found in id_maps for {mapped_table}')
                    return old_id
                else:
                    return id_maps[old_id]

            # 应用映射函数到该字段的每个值
            table[field] = table[field].apply(map_id)

    return table_dict


def get_table_col_id():
    """获取表ID映射"""
    global id_map
    if id_map:
        return id_map

    # 优先从id_map.json文件加载
    id_map_path = os.path.join(CUR_PATH, 'id_map.json')
    if os.path.exists(id_map_path):
        with open(id_map_path) as f:
            id_map = json.load(f)
            logger.success('Loaded id_map.json')
            return id_map

    logger.warning('id_map.json not found')
    return id_map


def get_tableid_col_id(table):
    if not id_map:
        get_table_col_id()

    if table in id_map:
        return id_map[table]
    else:
        return (0, 0)


if __name__ == '__main__':
    pass
    print(get_tableid_col_id('dms_def_node'))
    # efile = EFile()
    # efile.load_from_file('changed.efile','gb18030')
    # dms_def_trwd = efile.table_dict['dms_def_trwd']
    # id_convert('dms_def_trwd',dms_def_trwd.header, dms_def_trwd.data)
    # efile.write_to_efile('chenged2.efile')
