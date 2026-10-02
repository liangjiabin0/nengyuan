#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
南网理论线损计算主脚本

功能：
1. 加载配置参数
2. 调用数据解析器
3. 执行并行线损计算
4. 处理计算结果
5. 调用可视化和Excel生成模块

"""

import argparse
import concurrent.futures
import json
import os
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

# 添加lib库路径
SCRIPT_DIR = Path(__file__).parent.absolute()
SKILL_ROOT = SCRIPT_DIR.parent  # skill根目录
sys.path.insert(0, str(SKILL_ROOT))
sys.path.insert(0, str(SCRIPT_DIR / 'lib'))

import pandas as pd

# 导入内部模块
from lib.dms.dms_model import DMSModelBase
from lib.loss.dms.dmsse_lineloss_base import start_calc_one_feeder
from lib.helper.log import logger

# 导入配置
try:
    from config.cons_para import *
except ImportError:
    # 如果config导入失败，使用默认参数
    logger.warning('无法导入config.cons_para，使用默认参数')
    Volbase = 10
    Sbase = 100
    Zbase = 5.77
    Ra_disline = 0.01
    Xa_disline = 0.012
    Ra_distrfm = 15
    Xa_distrfm = 0.5
    Mva_distrfm = 630
    p0 = 0.28
    pk = 0.3
    time_resolution_factor = 0.25


def parse_arguments():
    """解析命令行参数"""
    parser = argparse.ArgumentParser(
        description='南网理论线损计算程序',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument(
        '-i', '--input',
        type=str,
        default='test_data/sample.json',  # 默认输入文件
        help='输入JSON文件路径（默认：test_data/sample.json）'
    )

    parser.add_argument(
        '-o', '--output',
        type=str,
        default='./output',
        help='输出目录路径（默认：./output）'
    )

    parser.add_argument(
        '-m', '--method',
        type=str,
        default='04',
        choices=['04'],
        help='计算方法代码（默认：04，理论线损计算）'
    )

    parser.add_argument(
        '-f', '--format',
        type=str,
        default='full',
        choices=['full', 'json_only', 'summary'],
        help='输出格式（默认：full - 完整输出）'
    )

    parser.add_argument(
        '-w', '--workers',
        type=int,
        default=None,
        help='并行工作进程数（默认：自动检测CPU核心数）'
    )

    return parser.parse_args()


def load_json_data(json_path):
    """加载JSON数据文件"""
    logger.info(f'加载JSON数据：{json_path}')

    if not os.path.exists(json_path):
        raise FileNotFoundError(f'JSON文件不存在：{json_path}')

    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    return data


def validate_input_data(json_data):
    """验证输入数据完整性"""
    logger.info('验证输入数据完整性')

    # 检查必需字段
    required_fields = ['calTime', 'mtime', 'tables']
    for field in required_fields:
        if field not in json_data:
            raise ValueError(f'缺少必需字段：{field}')

    # 检查必需设备表（核心）
    required_tables = [
        'dms_def_feeder',    # 馈线定义
        'dms_def_source',    # 电源定义
        'dms_def_lnseg',     # 导线段定义
        'dms_def_trfm',      # 变压器定义
        'dms_def_trwd',      # 变压器绕组
        'dms_def_load',      # 负荷定义
    ]

    tables = json_data.get('tables', {})
    missing_tables = [t for t in required_tables if t not in tables]

    if missing_tables:
        raise ValueError(f'缺少必需设备表：{", ".join(missing_tables)}')

    logger.success('输入数据验证通过')
    return True


def parse_time_points(mtime_str):
    """解析时间点字符串"""
    if not mtime_str:
        return [0]

    time_points = [int(t) for t in mtime_str.split('-') if t.strip().isdigit()]
    return time_points if time_points else [0]


def calculate_one_day(
    json_data,
    output_dir,
    calc_method='04',
    output_format='full',
    max_workers=None
):
    """
    执行一天的线损计算

    Args:
        json_data: JSON数据字典
        output_dir: 输出目录
        calc_method: 计算方法
        output_format: 输出格式
        max_workers: 最大并行进程数

    Returns:
        dict: 计算结果字典
    """
    start_time = time.perf_counter()

    # 解析日期
    cal_time = json_data.get('calTime')
    ds = datetime.strptime(cal_time, '%Y-%m-%d').strftime('%Y%m%d')

    # 解析时间点
    mtime_str = json_data.get('mtime', '0')
    all_times = parse_time_points(mtime_str)
    time_point_count = len(all_times)

    logger.info(f'计算日期：{cal_time}，时间点数量：{time_point_count}')

    # 获取馈线数据
    feeders_data = json_data['tables']

    # 设置并行进程数
    if max_workers is None:
        max_workers = min(os.cpu_count(), 61)

    logger.info(f'并行进程数：{max_workers}')

    # 初始化结果收集器
    all_results = {
        'feeder_statics': [],
        'distribution_line': [],
        'distribution_energy': [],
        'distribution_aclinesegment': [],
        'distribution_transformer': [],
        'distribution_generatingunit': [],
        'power_error': [],
        'calc_errors': []
    }

    # 多进程并行计算
    with concurrent.futures.ProcessPoolExecutor(max_workers=max_workers) as executor:
        future_tasks = []

        for time_index in all_times:
            # 解析单个时间点的数据
            from scripts.data_parser import parse_single_timepoint_data
            feeder_tables_dict = parse_single_timepoint_data(
                feeders_data,
                time_index
            )

            # 提取第一个馈线的数据（单馈线场景）
            if not feeder_tables_dict:
                logger.error(f'时间点 {time_index} 无有效馈线数据')
                continue

            feeder_id = list(feeder_tables_dict.keys())[0]
            table_dataframes_dict = feeder_tables_dict[feeder_id]

            # 构建DMS模型
            dms_model = DMSModelBase()
            dms_model.set_source('dataframe', data=table_dataframes_dict)
            dms_model.set_prefix('dms_')
            dms_model.set_source_field_lower()
            dms_model.set_calc_model('dms')
            dms_model.read_model()

            # 提交计算任务
            future = executor.submit(
                start_calc_one_feeder,
                dms_tables=table_dataframes_dict,
                day_time=ds,
                time_index=time_index,
                feeder_index=0,
                cons_para='config.cons_para',
                method_type=calc_method,
                dms_model=dms_model
            )
            future_tasks.append(future)

        # 收集计算结果
        completed_count = 0
        for future in concurrent.futures.as_completed(future_tasks):
            try:
                result = future.result()
                completed_count += 1

                # 收集各类结果（完全按照原始程序逻辑）
                if result and 'tables' in result:
                    feeder_statics = result['tables'].get('feeder_statics')
                    distribution_line = result['tables'].get('dms_loss_feeder_result')
                    distribution_aclinesegment = result['tables'].get('dms_loss_lnseg_result')
                    distribution_transformer = result['tables'].get('dms_loss_trfm_result')
                    distribution_generatingunit = result['tables'].get('dms_loss_dg_result')
                    power_error = result['tables'].get('power_error')

                    # 构造distribution_energy表（完全按照原始程序逻辑）
                    distribution_energy = pd.DataFrame(
                        {},
                        columns=[
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
                    )

                    if distribution_line is not None and len(distribution_line) > 0:
                        power_error['TIME_INDEX'] = distribution_line.loc[0, 'TIME_INDEX']

                        # 添加馈线电量记录
                        distribution_energy.loc[0, [
                            'idx', 'companyid', 'companyname', 'datatime',
                            'distributionlineid', 'distributionlinename',
                            'psrid', 'psrname', 'psrtype', 'datasource',
                            'datatype', 'reacener', 'actiener', 'energytype',
                        ]] = [
                            distribution_line.loc[0, 'TIME_INDEX'],
                            distribution_line.loc[0, 'COMPANY_RDFID'],
                            distribution_line.loc[0, 'COMPANY_NAME'],
                            distribution_line.loc[0, 'DATA_TIME'],
                            distribution_line.loc[0, 'FEEDER_RDFID'],
                            distribution_line.loc[0, 'FEEDER_NAME'],
                            distribution_line.loc[0, 'FEEDER_RDFID'],
                            distribution_line.loc[0, 'FEEDER_NAME'],
                            'DistributionLine',
                            0,
                            1,
                            distribution_line.loc[0, 'ACTI_POWER'],
                            distribution_line.loc[0, 'REAC_POWER'],
                            1,
                        ]

                        # 添加变压器电量记录
                        if distribution_transformer is not None:
                            for i in range(len(distribution_transformer)):
                                distribution_energy.loc[len(distribution_energy), [
                                    'idx', 'companyid', 'companyname', 'datatime',
                                    'distributionlineid', 'distributionlinename',
                                    'psrid', 'psrname', 'psrtype', 'datasource',
                                    'datatype', 'reacener', 'actiener', 'energytype',
                                ]] = [
                                    distribution_transformer.loc[0, 'TIME_INDEX'],
                                    distribution_transformer.loc[i, 'COMPANY_RDFID'],
                                    distribution_transformer.loc[i, 'COMPANY_NAME'],
                                    distribution_transformer.loc[i, 'DATA_TIME'],
                                    distribution_transformer.loc[i, 'FEEDER_RDFID'],
                                    distribution_transformer.loc[i, 'FEEDER_NAME'],
                                    distribution_transformer.loc[i, 'TRAN_RDFID'],
                                    distribution_transformer.loc[i, 'TRAN_NAME'],
                                    'DistributionTransformer' if distribution_transformer.loc[i, 'TRAN_HIGH_ACTI'] >= 0 else 'GeneratingUnit',
                                    0,
                                    1,
                                    distribution_transformer.loc[i, 'TRAN_HIGH_ACTI'],
                                    distribution_transformer.loc[i, 'TRAN_HIGH_REAC'],
                                    1,
                                ]

                    # 收集结果
                    all_results['feeder_statics'].append(feeder_statics)
                    all_results['distribution_line'].append(distribution_line)
                    all_results['distribution_energy'].append(distribution_energy)
                    all_results['distribution_aclinesegment'].append(distribution_aclinesegment)
                    all_results['distribution_transformer'].append(distribution_transformer)
                    all_results['distribution_generatingunit'].append(distribution_generatingunit)
                    all_results['power_error'].append(power_error)

                # 显示进度
                progress = (completed_count / time_point_count) * 100
                logger.info(f'计算进度：{progress:.1f}% ({completed_count}/{time_point_count})')

            except Exception as e:
                logger.error(f'计算任务执行失败：{e}')
                all_results['calc_errors'].append(str(e))
                traceback.print_exc()

    calculation_time = time.perf_counter() - start_time
    logger.success(f'并行计算完成，耗时：{calculation_time:.2f}秒')

    # 处理结果
    from scripts.result_processor import process_calculation_results
    final_results = process_calculation_results(
        all_results,
        output_dir,
        ds,
        calc_method,
        output_format
    )

    # 返回统计信息
    final_results['statistics'] = {
        'feederName': '待补充',  # 从数据中提取
        'calcDate': cal_time,
        'timePointCount': time_point_count,
        'calculationTime': round(calculation_time, 2),
        'successRate': f'{completed_count}/{time_point_count}'
    }

    return final_results


def main():
    """主函数"""
    args = parse_arguments()

    try:
        # 加载数据
        json_data = load_json_data(args.input)

        # 验证数据
        validate_input_data(json_data)

        # 创建输出目录
        output_dir = Path(args.output)
        output_dir.mkdir(parents=True, exist_ok=True)

        # 执行计算
        results = calculate_one_day(
            json_data=json_data,
            output_dir=str(output_dir),
            calc_method=args.method,
            output_format=args.format,
            max_workers=args.workers
        )

        # 输出结果
        logger.success('计算完成')
        logger.info(f'结果文件：{json.dumps(results["results"], indent=2)}')

        # 返回状态
        print(json.dumps({
            'success': True,
            'message': results.get('message', '计算完成'),
            'results': results.get('results', {}),
            'statistics': results.get('statistics', {})
        }, indent=2, ensure_ascii=False))

        return 0

    except FileNotFoundError as e:
        logger.error(f'文件未找到：{e}')
        print(json.dumps({
            'success': False,
            'message': '输入文件未找到',
            'errorDetail': str(e)
        }, indent=2, ensure_ascii=False))
        return 1

    except ValueError as e:
        logger.error(f'数据验证失败：{e}')
        print(json.dumps({
            'success': False,
            'message': '输入数据不完整',
            'errorDetail': str(e)
        }, indent=2, ensure_ascii=False))
        return 1

    except Exception as e:
        logger.exception('计算过程发生异常')
        print(json.dumps({
            'success': False,
            'message': '计算失败',
            'errorDetail': str(e)
        }, indent=2, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    sys.exit(main())