#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Excel统计汇总脚本

功能：
1. 生成5个Sheet的Excel文件
2. 应用样式和格式

"""

import math
import os
import sys
from pathlib import Path

import pandas as pd
from openpyxl import load_workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

# 添加lib库路径
SCRIPT_DIR = Path(__file__).parent.absolute()
sys.path.insert(0, str(SCRIPT_DIR / 'lib'))


def apply_excel_style(file_path):
    """应用Excel样式"""
    wb = load_workbook(file_path)

    # 定义样式
    header_font = Font(name='微软雅黑', size=11, bold=True, color='FFFFFF')
    header_fill = PatternFill(start_color='4472C4', end_color='4472C4', fill_type='solid')
    header_alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)

    border = Border(
        left=Side(style='thin', color='000000'),
        right=Side(style='thin', color='000000'),
        top=Side(style='thin', color='000000'),
        bottom=Side(style='thin', color='000000')
    )

    # 应用样式到所有Sheet
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]

        # 设置列宽
        for column in ws.columns:
            max_length = 0
            column_letter = column[0].column_letter

            for cell in column:
                try:
                    if len(str(cell.value)) > max_length:
                        max_length = len(str(cell.value))
                except:
                    pass

            adjusted_width = min(max_length + 2, 50)
            ws.column_dimensions[column_letter].width = adjusted_width

        # 应用表头样式
        for cell in ws[1]:
            cell.font = header_font
            cell.fill = header_fill
            cell.alignment = header_alignment
            cell.border = border

        # 应用数据行样式
        for row in ws.iter_rows(min_row=2):
            for cell in row:
                cell.alignment = Alignment(horizontal='left', vertical='center')
                cell.border = border

    wb.save(file_path)


def create_summary_sheet(result_data, writer):
    """创建关键指标汇总Sheet"""
    line_day = result_data.get('DistributionLine_Day', pd.DataFrame())

    if line_day.empty:
        return

    # 提取关键指标
    summary_data = {
        '指标名称': [],
        '数值': [],
        '单位': [],
        '状态': [],
        '备注': []
    }

    # 基本信息
    if not line_day.empty:
        feeder_name = line_day['feeder_name'].iloc[0] if 'feeder_name' in line_day.columns else '未知'
        calc_date = line_day['data_time'].iloc[0] if 'data_time' in line_day.columns else '未知'

        summary_data['指标名称'].extend(['馈线名称', '计算日期', '', '供电量指标', '总供电量', '售电量', '', '损耗指标', '总损耗'])
        summary_data['数值'].extend([feeder_name, calc_date, '', '', '', '', '', '', ''])
        summary_data['单位'].extend(['-', '-', '', '', 'kWh', 'kWh', '', 'kWh', 'kWh'])
        summary_data['状态'].extend(['-', '-', '', '', '-', '-', '', '-', '-'])
        summary_data['备注'].extend(['-', '-', '', '-', '-', '-', '', '-', '-'])

        # 添加具体数值
        if 'acti_power' in line_day.columns:
            summary_data['数值'][4] = round(line_day['acti_power'].sum(), 2)

        if 'feeder_elec_sales' in line_day.columns:
            summary_data['数值'][5] = round(line_day['feeder_elec_sales'].sum(), 2)

        if 'feeder_acti_loss' in line_day.columns:
            summary_data['数值'][8] = round(line_day['feeder_acti_loss'].sum(), 2)

    summary_df = pd.DataFrame(summary_data)
    summary_df.to_excel(writer, sheet_name='关键指标汇总', index=False)


def create_distribution_sheet(result_data, writer):
    """创建损耗分布统计Sheet"""
    line_day = result_data.get('DistributionLine_Day', pd.DataFrame())

    if line_day.empty:
        return

    distribution_data = {
        '损耗类型': ['线路损耗', '变压器铜损', '变压器铁损', '其他损耗', '合计'],
        '损耗值(kWh)': [],
        '占比(%)': [],
        '设备数量': [],
        '平均损耗(kWh)': [],
        '状态': []
    }

    # 计算损耗值
    total_loss = line_day['feeder_acti_loss'].sum() if 'feeder_acti_loss' in line_day.columns else 0
    lnseg_loss = line_day['lnseg_loss'].sum() if 'lnseg_loss' in line_day.columns else 0
    copp_loss = line_day['tran_copp_loss'].sum() if 'tran_copp_loss' in line_day.columns else 0
    iron_loss = line_day['tran_iron_loss'].sum() if 'tran_iron_loss' in line_day.columns else 0
    other_loss = line_day['other_loss'].sum() if 'other_loss' in line_day.columns else 0

    distribution_data['损耗值(kWh)'] = [
        round(lnseg_loss, 2),
        round(copp_loss, 2),
        round(iron_loss, 2),
        round(other_loss, 2),
        round(total_loss, 2)
    ]

    # 计算占比
    if total_loss > 0:
        distribution_data['占比(%)'] = [
            round(lnseg_loss / total_loss * 100, 1),
            round(copp_loss / total_loss * 100, 1),
            round(iron_loss / total_loss * 100, 1),
            round(other_loss / total_loss * 100, 1),
            100.0
        ]
    else:
        distribution_data['占比(%)'] = [0, 0, 0, 0, 0]

    # 设备数量和平均损耗
    distribution_data['设备数量'] = ['-', '-', '-', '-', '-']
    distribution_data['平均损耗(kWh)'] = ['-', '-', '-', '-', '-']
    distribution_data['状态'] = ['正常', '正常', '正常', '正常', '-']

    distribution_df = pd.DataFrame(distribution_data)
    distribution_df.to_excel(writer, sheet_name='损耗分布统计', index=False)


def create_ranking_sheet(result_data, writer):
    """创建设备损耗排名Sheet"""
    lnseg_day = result_data.get('DistributionACLineSegment_Day', pd.DataFrame())

    if lnseg_day.empty or 'lnseg_acti_loss' not in lnseg_day.columns:
        return

    # Top 10高损耗导线段
    top_10 = lnseg_day.nlargest(10, 'lnseg_acti_loss')

    ranking_data = {
        '排名': range(1, len(top_10) + 1),
        '设备ID': top_10['lnseg_rdfid'].tolist() if 'lnseg_rdfid' in top_10.columns else ['-'] * len(top_10),
        '设备名称': top_10['lnseg_name'].tolist() if 'lnseg_name' in top_10.columns else ['-'] * len(top_10),
        '损耗值(kWh)': [round(x, 2) for x in top_10['lnseg_acti_loss'].tolist()],
        '损耗率(%)': [round(x * 100, 2) if x < 100 else round(x, 2) for x in top_10.get('lnseg_lossrate', [0] * len(top_10)).tolist()],
        '状态': ['偏高' if x > 3 else '正常' for x in top_10.get('lnseg_lossrate', [0] * len(top_10)).tolist()]
    }

    ranking_df = pd.DataFrame(ranking_data)
    ranking_df.to_excel(writer, sheet_name='设备损耗排名', index=False)


def create_timeseries_sheet(result_data, writer):
    """创建时序分析数据Sheet"""
    line_data = result_data.get('DistributionLine', pd.DataFrame())

    if line_data.empty:
        return

    timeseries_data = {
        '时间点': list(range(len(line_data))),
        '供电量(kWh)': [],
        '损耗(kWh)': [],
        '线损率(%)': [],
        '负载率(%)': []
    }

    if 'acti_power' in line_data.columns:
        timeseries_data['供电量(kWh)'] = [round(x, 2) for x in line_data['acti_power'].tolist()]

    if 'feeder_acti_loss' in line_data.columns:
        timeseries_data['损耗(kWh)'] = [round(x, 2) for x in line_data['feeder_acti_loss'].tolist()]

    if 'feeder_lossrate' in line_data.columns:
        timeseries_data['线损率(%)'] = [round(x, 2) for x in line_data['feeder_lossrate'].tolist()]

    if 'feeder_load_rate' in line_data.columns:
        timeseries_data['负载率(%)'] = [round(x, 2) for x in line_data['feeder_load_rate'].tolist()]

    # 确保所有列长度一致
    max_len = max(len(v) for v in timeseries_data.values() if isinstance(v, list))
    for key in timeseries_data:
        if len(timeseries_data[key]) < max_len:
            timeseries_data[key].extend(['-'] * (max_len - len(timeseries_data[key])))

    timeseries_df = pd.DataFrame(timeseries_data)
    timeseries_df.to_excel(writer, sheet_name='时序分析数据', index=False)


def create_anomaly_sheet(result_data, writer):
    """创建异常提示与建议Sheet"""
    anomaly_data = {
        '序号': [],
        '异常等级': [],
        '设备类型': [],
        '设备名称': [],
        '异常类型': [],
        '详细描述': [],
        '建议措施': []
    }

    # 简化版：添加几条示例
    anomaly_data['序号'] = [1]
    anomaly_data['异常等级'] = ['提示']
    anomaly_data['设备类型'] = ['馈线']
    anomaly_data['设备名称'] = ['整体']
    anomaly_data['异常类型'] = ['计算完成']
    anomaly_data['详细描述'] = ['线损计算已完成，请查看详细结果']
    anomaly_data['建议措施'] = ['建议结合实际线损数据进行对比分析']

    anomaly_df = pd.DataFrame(anomaly_data)
    anomaly_df.to_excel(writer, sheet_name='异常提示与建议', index=False)


def generate_excel_summary(result_data, output_dir):
    """
    生成Excel统计汇总文件

    Args:
        result_data: 计算结果数据
        output_dir: 输出目录

    Returns:
        str: Excel文件路径
    """
    print('开始生成Excel统计汇总')

    output_path = Path(output_dir) / '线损统计汇总.xlsx'

    with pd.ExcelWriter(output_path, engine='openpyxl') as writer:
        create_summary_sheet(result_data, writer)
        create_distribution_sheet(result_data, writer)
        create_ranking_sheet(result_data, writer)
        create_timeseries_sheet(result_data, writer)
        create_anomaly_sheet(result_data, writer)

    # 应用样式
    apply_excel_style(output_path)

    print(f'Excel文件已生成：{output_path}')

    return str(output_path)


if __name__ == '__main__':
    print('Excel summary module loaded')