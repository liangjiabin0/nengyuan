#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
结果处理脚本

功能：
1. 合并计算结果
2. 生成日汇总数据
3. 输出17个JSON文件
4. 调用可视化和Excel生成

"""

import gc
import json
import math
import os
import sys
import time
from pathlib import Path

import pandas as pd

# 添加lib库路径
SCRIPT_DIR = Path(__file__).parent.absolute()
LIB_DIR = SCRIPT_DIR / 'lib'
sys.path.insert(0, str(LIB_DIR))

from lib.helper.log import logger
from lib.loss.tools import division_0


def process_series(series_groupby, method='sum'):
    """处理分组聚合"""
    def aggregated_func(x):
        numeric_x = pd.to_numeric(x, errors='coerce').fillna(0)
        if method == 'sum':
            return numeric_x.sum()
        elif method == 'mean':
            return numeric_x.mean()
        else:
            raise ValueError("Method must be either 'sum' or 'mean'")

    return series_groupby.apply(aggregated_func)


def calc_feeder_day_result(loss_feeder_hour):
    """计算馈线日线损结果（完全按照原始程序）"""
    grouped_feederloss = loss_feeder_hour.groupby('feeder_rdfid').agg({
        'company_rdfid': 'first',
        'company_name': 'first',
        'feeder_name': 'first',
        'calc_method': 'first',
        'feeder_lnseg_length': 'first',
        'tran_capa': 'first',
        'tran_numb': 'first',
        'public_numb': 'first',
        'public_capa': 'first',
        'private_numb': 'first',
        'private_capa': 'first',
        'disgen_numb': 'first',
    })

    column_to_process = {
        'feeder_average_voltage': 'mean',
        'acti_power': 'sum',
        'reac_power': 'sum',
        'lnseg_loss': 'sum',
        'tran_copp_loss': 'sum',
        'tran_iron_loss': 'sum',
        'other_loss': 'sum',
        'feeder_acti_loss': 'sum',
        'theo_power_supply': 'sum',
        'private_copp_loss': 'sum',
        'private_iron_loss': 'sum',
        'public_copp_loss': 'sum',
        'public_iron_loss': 'sum',
        'feeder_average_current': 'mean',
        'output_acti_power': 'sum',
        'output_reac_power': 'sum',
        'feeder_elec_sales': 'sum',
        'feeder_load_rate': 'mean',
    }

    for col_name, method in column_to_process.items():
        grouped_feederloss[col_name] = process_series(
            loss_feeder_hour.groupby('feeder_rdfid')[col_name],
            method=method
        )

    grouped_feederloss['feeder_power_factor'] = grouped_feederloss.apply(
        lambda row: division_0(
            row['acti_power'],
            math.sqrt(row['acti_power'] ** 2 + row['reac_power'] ** 2)
        ),
        axis=1
    )

    grouped_feederloss['copp_iron_ratio'] = grouped_feederloss.apply(
        lambda row: division_0(row['tran_copp_loss'], row['tran_iron_loss']),
        axis=1
    )

    grouped_feederloss['feeder_lossrate'] = grouped_feederloss.apply(
        lambda row: division_0(row['feeder_acti_loss'], row['acti_power']) * 100,
        axis=1
    )

    grouped_feederloss['lossrate_without_private'] = grouped_feederloss.apply(
        lambda row: division_0(
            row['feeder_acti_loss'] - row['private_copp_loss'] - row['private_iron_loss'],
            row['acti_power']
        ) * 100,
        axis=1
    )

    grouped_feederloss['feeder_theo_lossrate'] = grouped_feederloss.apply(
        lambda row: division_0(row['feeder_acti_loss'], row['theo_power_supply']) * 100,
        axis=1
    )

    return grouped_feederloss


def calc_energy_day_result(energy_input_and_output_all):
    """计算电量日线损结果"""
    # 统一列名为小写
    energy_input_and_output_all.columns = energy_input_and_output_all.columns.str.lower()

    grouped_energy = energy_input_and_output_all.groupby('psrid').agg({
        'companyid': 'first',
        'companyname': 'first',
        'distributionlineid': 'first',
        'distributionlinename': 'first',
        'psrid': 'first',
        'psrname': 'first',
        'psrtype': 'first',
        'datasource': 'first',
        'datatype': 'first',
        'energytype': 'first',
    })

    column_to_process = {'actiener': 'sum', 'reacener': 'sum'}
    for col_name, method in column_to_process.items():
        grouped_energy[col_name] = process_series(
            energy_input_and_output_all.groupby('psrid')[col_name],
            method=method
        )

    # 删除重复的psrid列（保留索引），避免reset_index冲突
    if 'psrid' in grouped_energy.columns:
        grouped_energy = grouped_energy.drop(columns=['psrid'])

    return grouped_energy


def calc_generation_day_result(distributed_generation_all):
    """计算分布式电源日线损结果"""
    # 统一列名为小写
    distributed_generation_all.columns = distributed_generation_all.columns.str.lower()

    # 检查必需列是否存在
    if 'disgen_rdfid' not in distributed_generation_all.columns:
        logger.warning('分布式电源结果表中缺少disgen_rdfid列')
        return pd.DataFrame()

    grouped_generation = distributed_generation_all.groupby('disgen_rdfid').agg({
        'disgen_name': 'first',
    })

    # 只聚合存在的列
    agg_columns = {
        'disgen_positive_acti': 'sum',
        'disgen_reverse_acti': 'sum',
        'disgen_current': 'mean',
        'disgen_voltage': 'mean'
    }

    for col_name, method in agg_columns.items():
        if col_name in distributed_generation_all.columns:
            grouped_generation[col_name] = process_series(
                distributed_generation_all.groupby('disgen_rdfid')[col_name],
                method=method,
            )

    # 删除重复的disgen_rdfid列（保留索引），避免reset_index冲突
    if 'disgen_rdfid' in grouped_generation.columns:
        grouped_generation = grouped_generation.drop(columns=['disgen_rdfid'])

    return grouped_generation


def calc_line_day_result(loss_line_hour):
    """计算导线日线损结果"""
    # 统一列名为小写
    loss_line_hour.columns = loss_line_hour.columns.str.lower()

    total_lineloss = pd.to_numeric(loss_line_hour['lnseg_acti_loss'], errors='coerce').sum()

    # 完全按照原始程序，不使用as_index=False
    grouped_lineloss = loss_line_hour.groupby('lnseg_rdfid').agg({
        'lnseg_name': 'first',
        'feeder_rdfid': 'first',
        'feeder_name': 'first',
        'lnseg_length': 'first',
        'lnseg_raa': 'first',
        'head_terminal_id': 'first',
        'end_terminal_id': 'first',
    })

    column_to_process = {
        'lnseg_head_acti': 'sum',
        'lnseg_average_current': 'mean',
        'lnseg_acti_loss': 'sum',
        'lnseg_head_voltage': 'mean',
        'lnseg_end_voltage': 'mean',
        'feeder_elec_sales': 'sum',
        'lnseg_head_reac': 'sum',
    }

    for col_name, method in column_to_process.items():
        grouped_lineloss[col_name] = process_series(
            loss_line_hour.groupby('lnseg_rdfid')[col_name],
            method=method
        )

    grouped_lineloss['lnseg_loss_of_total'] = grouped_lineloss.apply(
        lambda row: division_0(row['lnseg_acti_loss'], total_lineloss) * 100,
        axis=1
    )

    grouped_lineloss['lnseg_lossrate'] = grouped_lineloss.apply(
        lambda row: division_0(row['lnseg_acti_loss'], row['lnseg_head_acti']) * 100,
        axis=1
    )

    grouped_lineloss['lnseg_power_factor'] = grouped_lineloss.apply(
        lambda row: division_0(
            row['lnseg_head_acti'],
            math.sqrt(row['lnseg_head_acti'] ** 2 + row['lnseg_head_reac'] ** 2)
        ),
        axis=1
    )

    # 删除重复的lnseg_rdfid列（保留索引），避免reset_index冲突
    if 'lnseg_rdfid' in grouped_lineloss.columns:
        grouped_lineloss = grouped_lineloss.drop(columns=['lnseg_rdfid'])

    return grouped_lineloss


def calc_trfm_day_result(loss_trfm_hour):
    """计算变压器日线损结果"""
    # 统一列名为小写
    loss_trfm_hour.columns = loss_trfm_hour.columns.str.lower()

    total_trfmloss = pd.to_numeric(loss_trfm_hour['tran_acti_loss'], errors='coerce').sum()

    grouped_trfmloss = loss_trfm_hour.groupby('tran_rdfid').agg({
        'tran_name': 'first',
        'feeder_rdfid': 'first',
        'feeder_name': 'first',
        'tran_type': 'first',
    })

    column_to_process = {
        'tran_current': 'mean',
        'copp_acti_loss': 'sum',
        'iron_acti_loss': 'sum',
        'tran_acti_loss': 'sum',
        'tran_voltage': 'mean',
        'avg_load': 'mean',
        'tran_high_acti': 'sum',
        'tran_high_reac': 'sum',
        'copp_reac_loss': 'sum',
        'iron_reac_loss': 'sum',
        'tran_reac_loss': 'sum',
        'tran_low_acti': 'sum',
        'tran_low_reac': 'sum',
        'tran_positive_acti': 'sum',
        'tran_reverse_acti': 'sum',
    }

    for col_name, method in column_to_process.items():
        grouped_trfmloss[col_name] = process_series(
            loss_trfm_hour.groupby('tran_rdfid')[col_name],
            method=method
        )

    grouped_trfmloss['copp_iron_ratio'] = grouped_trfmloss.apply(
        lambda row: division_0(row['copp_acti_loss'], row['iron_acti_loss']),
        axis=1
    )

    grouped_trfmloss['tran_loss_of_total'] = grouped_trfmloss.apply(
        lambda row: division_0(row['tran_acti_loss'], total_trfmloss) * 100,
        axis=1
    )

    grouped_trfmloss['tran_lossrate'] = grouped_trfmloss.apply(
        lambda row: division_0(row['tran_acti_loss'], row['tran_high_acti']) * 100,
        axis=1
    )

    # 删除重复的tran_rdfid列（保留索引），避免reset_index冲突
    if 'tran_rdfid' in grouped_trfmloss.columns:
        grouped_trfmloss = grouped_trfmloss.drop(columns=['tran_rdfid'])

    return grouped_trfmloss


def calc_feederstatics_day_result(feeder_statics_all):
    """计算馈线统计日结果（完全按照原始程序）"""
    # 一天当中只要有一次成功计算就把当日计算信息统计为成功计算，如果全部时刻计算失败，就取最后一次的计算信息作为当日计算信息
    # 注意：原始程序中agg({'rdf_id': 'first'})会在索引rdf_id的基础上再创建一个rdf_id列
    grouped_feederstatics = feeder_statics_all.groupby('rdf_id').agg({'rdf_id': 'first'})
    grouped_feederstatics['code'] = None

    for idx in grouped_feederstatics.index:
        group_feeder_statics = feeder_statics_all[feeder_statics_all['rdf_id'] == idx]
        if (group_feeder_statics['code'] == 0).any():
            grouped_feederstatics.loc[idx, 'code'] = 0
        else:
            if len(group_feeder_statics) > 0:
                grouped_feederstatics.loc[idx, 'code'] = group_feeder_statics['code'].iloc[-1]

    # 删除重复的rdf_id列（保留索引），然后重置索引
    if 'rdf_id' in grouped_feederstatics.columns:
        grouped_feederstatics = grouped_feederstatics.drop(columns=['rdf_id'])
    grouped_feederstatics = grouped_feederstatics.reset_index()

    return grouped_feederstatics


def save_json_files(result_data, output_dir):
    """保存JSON结果文件"""
    json_dir = Path(output_dir) / 'json_results'
    json_dir.mkdir(parents=True, exist_ok=True)

    json_files = {}

    for table_name, df in result_data.items():
        # 保存所有表，包括空表（按照原始程序要求，必须生成17个表）
        if df is None:
            df = pd.DataFrame()

        file_path = json_dir / f'{table_name}.json'

        # 转换为JSON格式
        if isinstance(df, pd.DataFrame):
            data = df.reset_index().to_dict(orient='records')
        else:
            data = df

        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        json_files[table_name] = str(file_path)
        if df.empty:
            logger.info(f'保存 {table_name}.json（空表）')
        else:
            logger.info(f'保存 {table_name}.json')

    return json_files


def process_calculation_results(all_results, output_dir, ds, calc_method, output_format):
    """
    处理计算结果

    Args:
        all_results: 所有时间点的计算结果
        output_dir: 输出目录
        ds: 日期字符串（YYYYMMDD）
        calc_method: 计算方法
        output_format: 输出格式

    Returns:
        dict: 处理结果
    """
    logger.info('开始处理计算结果')

    # 合并所有时间点的结果
    feeder_statics_df = []
    distribution_line_df = []
    distribution_energy_df = []
    distribution_aclinesegment_df = []
    distribution_transformer_df = []
    distribution_generatingunit_df = []
    power_error_df = []

    for result in all_results['feeder_statics']:
        if result is not None:
            feeder_statics_df.append(result)

    for result in all_results['distribution_line']:
        if result is not None:
            distribution_line_df.append(result)

    for result in all_results['distribution_energy']:
        if result is not None:
            distribution_energy_df.append(result)

    for result in all_results['distribution_aclinesegment']:
        if result is not None:
            distribution_aclinesegment_df.append(result)

    for result in all_results['distribution_transformer']:
        if result is not None:
            distribution_transformer_df.append(result)

    for result in all_results['distribution_generatingunit']:
        if result is not None:
            distribution_generatingunit_df.append(result)

    for result in all_results['power_error']:
        if result is not None:
            power_error_df.append(result)

    logger.info('合并时刻级结果')

    # 合并DataFrame（完全按照原始程序）
    feeder_statics_hour = pd.concat(feeder_statics_df, ignore_index=True).copy()
    distribution_line_hour = pd.concat(distribution_line_df, ignore_index=True).copy()
    distribution_energy_hour = pd.concat(distribution_energy_df, ignore_index=True).copy()
    distribution_aclinesegment_hour = pd.concat(distribution_aclinesegment_df, ignore_index=True).copy()
    distribution_transformer_hour = pd.concat(distribution_transformer_df, ignore_index=True).copy()
    distribution_generatingunit_hour = pd.concat(distribution_generatingunit_df, ignore_index=True).copy()
    power_error_hour = pd.concat(power_error_df, ignore_index=True).copy()

    # 保存power_error到CSV（写入本次输出目录，避免依赖进程 cwd 下的 output/）
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    power_error_hour.to_csv(str(Path(output_dir) / 'dms_power_error_info.csv'), index=False)

    # 空表（完全按照原始程序）
    distribution_capacitorbank_hour = pd.DataFrame()
    distribution_theocalclog_hour = pd.DataFrame()

    gc.collect()

    # 添加公共字段到时刻级结果（完全按照原始程序）
    for df in [
        feeder_statics_hour,
        distribution_line_hour,
        distribution_energy_hour,
        distribution_aclinesegment_hour,
        distribution_transformer_hour,
        distribution_generatingunit_hour,
    ]:
        df.columns = [col.lower() for col in df.columns]
        df['id'] = range(1, len(df) + 1)
        df['method_type'] = calc_method
        df['calctime'] = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())

    distribution_generatingunit_hour['year_month'] = f'{ds[:6]}'

    # 保存JSON文件（17个表，完全按照原始程序）
    logger.info('保存JSON结果文件')

    # 先保存时刻级结果（在del之前）
    result_tables_hour = {
        'DistributionLine': distribution_line_hour,
        'DistributionEnergy': distribution_energy_hour,
        'DistributionACLineSegment': distribution_aclinesegment_hour,
        'DistributionTransformer': distribution_transformer_hour,
        'DistributionGeneratingUnit': distribution_generatingunit_hour,
        'DistributionCapacitorBank': distribution_capacitorbank_hour,
        'TheoCalcLog': distribution_theocalclog_hour,
        'InstanceResult': feeder_statics_hour,
        'CalculateLog': feeder_statics_hour,
    }

    # 计算日汇总（完全按照原始程序）
    logger.info('计算日汇总结果')

    distribution_line_day = calc_feeder_day_result(distribution_line_hour)
    distribution_line_day = distribution_line_day.reset_index()
    distribution_energy_day = calc_energy_day_result(distribution_energy_hour)
    distribution_energy_day = distribution_energy_day.reset_index()
    distribution_aclinesegment_day = calc_line_day_result(distribution_aclinesegment_hour)
    distribution_aclinesegment_day = distribution_aclinesegment_day.reset_index()
    distribution_transformer_day = calc_trfm_day_result(distribution_transformer_hour)
    distribution_transformer_day = distribution_transformer_day.reset_index()
    distribution_generatingunit_day = calc_generation_day_result(distribution_generatingunit_hour)
    distribution_generatingunit_day = distribution_generatingunit_day.reset_index()
    distribution_capacitorbank_day = pd.DataFrame()
    distribution_theocalclog_day = pd.DataFrame()
    feeder_statics_day = calc_feederstatics_day_result(feeder_statics_hour)
    # feeder_statics_day已经在函数内部reset_index了

    # 释放内存（完全按照原始程序）
    del distribution_line_hour
    del distribution_energy_hour
    del distribution_aclinesegment_hour
    del distribution_transformer_hour
    del distribution_generatingunit_hour
    del feeder_statics_hour

    gc.collect()

    # 添加公共字段到日汇总结果（完全按照原始程序）
    for df in [
        distribution_line_day,
        distribution_energy_day,
        distribution_aclinesegment_day,
        distribution_transformer_day,
        distribution_generatingunit_day,
        feeder_statics_day,
    ]:
        df['id'] = range(1, len(df) + 1)
        df['calctime'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.localtime())
        df['data_time'] = f'{ds[:4]}-{ds[4:6]}-{ds[6:]}'

    # 合并所有结果表（17个表，完全按照原始程序）
    result_tables = {
        **result_tables_hour,
        'DistributionLine_Day': distribution_line_day,
        'DistributionEnergy_Day': distribution_energy_day,
        'DistributionACLineSegment_Day': distribution_aclinesegment_day,
        'DistributionTransformer_Day': distribution_transformer_day,
        'DistributionGeneratingUnit_Day': distribution_generatingunit_day,
        'DistributionCapacitorBank_Day': distribution_capacitorbank_day,
        'TheoCalcLog_Day': distribution_theocalclog_day,
        'InstanceResult_Day': feeder_statics_day,
    }

    json_files = save_json_files(result_tables, output_dir)

    # 生成Excel和可视化（如果需要）
    excel_file = None
    chart_files = []
    html_file = None

    if output_format in ['full', 'summary']:
        from scripts.excel_summary import generate_excel_summary
        excel_file = generate_excel_summary(result_tables, output_dir)

    if output_format == 'full':
        from scripts.visualization import generate_visualization
        chart_files, html_file = generate_visualization(result_tables, output_dir)

    logger.success('结果处理完成')

    return {
        'message': '计算完成',
        'results': {
            'jsonFiles': json_files,
            'excelSummary': excel_file,
            'charts': chart_files,
            'htmlReport': html_file
        }
    }


if __name__ == '__main__':
    print('Result processor module loaded')