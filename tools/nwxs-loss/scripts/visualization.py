#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
可视化脚本

功能：
1. 生成5张PNG图表
2. 生成交互式HTML报告

"""

import json
import math
import os
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import pandas as pd

# 设置中文字体
plt.rcParams['font.sans-serif'] = ['SimHei', 'Arial Unicode MS']
plt.rcParams['axes.unicode_minus'] = False

# 设置样式
plt.rcParams['figure.dpi'] = 300
plt.rcParams['axes.grid'] = True
plt.rcParams['grid.alpha'] = 0.3


def create_loss_distribution_pie(result_data, output_path):
    """生成损耗分布饼图"""
    # 提取损耗数据
    line_loss = result_data.get('DistributionLine_Day', pd.DataFrame())

    if line_loss.empty:
        print(f'警告：无数据，跳过饼图生成')
        return None

    # 汇总损耗
    total_lnseg_loss = line_loss['lnseg_loss'].sum() if 'lnseg_loss' in line_loss.columns else 0
    total_copp_loss = line_loss['tran_copp_loss'].sum() if 'tran_copp_loss' in line_loss.columns else 0
    total_iron_loss = line_loss['tran_iron_loss'].sum() if 'tran_iron_loss' in line_loss.columns else 0
    total_other_loss = line_loss['other_loss'].sum() if 'other_loss' in line_loss.columns else 0

    # 饼图数据
    labels = ['线路损耗', '变压器铜损', '变压器铁损', '其他损耗']
    sizes = [total_lnseg_loss, total_copp_loss, total_iron_loss, total_other_loss]
    colors = ['#3498db', '#e74c3c', '#f39c12', '#95a5a6']

    # 过滤零值
    non_zero_data = [(l, s, c) for l, s, c in zip(labels, sizes, colors) if s > 0]
    if not non_zero_data:
        return None

    labels, sizes, colors = zip(*non_zero_data)

    # 绘制饼图
    fig, ax = plt.subplots(figsize=(10, 8))
    wedges, texts, autotexts = ax.pie(
        sizes,
        labels=labels,
        colors=colors,
        autopct='%1.1f%%',
        startangle=90,
        pctdistance=0.85
    )

    # 设置文字样式
    for text in texts:
        text.set_fontsize(12)
    for autotext in autotexts:
        autotext.set_fontsize(11)
        autotext.set_color('white')
        autotext.set_weight('bold')

    ax.set_title('损耗分布图', fontsize=16, weight='bold', pad=20)

    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    plt.close()

    return output_path


def create_time_series_chart(result_data, output_path):
    """生成时序损耗趋势图"""
    line_data = result_data.get('DistributionLine', pd.DataFrame())

    if line_data.empty:
        return None

    fig, ax1 = plt.subplots(figsize=(14, 6))

    # 损耗曲线
    if 'feeder_acti_loss' in line_data.columns:
        ax1.plot(line_data.index, line_data['feeder_acti_loss'],
                color='#3498db', linewidth=2, label='损耗值 (kWh)')
        ax1.set_ylabel('损耗值 (kWh)', color='#3498db', fontsize=12)
        ax1.tick_params(axis='y', labelcolor='#3498db')

    # 标注峰值和谷值
    if 'feeder_acti_loss' in line_data.columns:
        max_idx = line_data['feeder_acti_loss'].idxmax()
        min_idx = line_data['feeder_acti_loss'].idxmin()

        ax1.annotate(f'峰值: {line_data.loc[max_idx, "feeder_acti_loss"]:.2f}',
                    xy=(max_idx, line_data.loc[max_idx, 'feeder_acti_loss']),
                    xytext=(10, 10), textcoords='offset points',
                    fontsize=10, color='red',
                    arrowprops=dict(arrowstyle='->', color='red'))

        ax1.annotate(f'谷值: {line_data.loc[min_idx, "feeder_acti_loss"]:.2f}',
                    xy=(min_idx, line_data.loc[min_idx, 'feeder_acti_loss']),
                    xytext=(10, -10), textcoords='offset points',
                    fontsize=10, color='green',
                    arrowprops=dict(arrowstyle='->', color='green'))

    ax1.set_xlabel('时间点', fontsize=12)
    ax1.set_title('24小时损耗变化趋势', fontsize=16, weight='bold', pad=15)
    ax1.grid(True, alpha=0.3)
    ax1.legend(loc='upper left')

    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    plt.close()

    return output_path


def create_ranking_chart(result_data, output_path):
    """生成设备损耗排名柱状图"""
    lnseg_data = result_data.get('DistributionACLineSegment_Day', pd.DataFrame())

    if lnseg_data.empty:
        return None

    # 排序取Top 10
    if 'lnseg_acti_loss' in lnseg_data.columns:
        top_10 = lnseg_data.nlargest(10, 'lnseg_acti_loss')

        fig, ax = plt.subplots(figsize=(12, 8))

        y_pos = range(len(top_10))
        ax.barh(y_pos, top_10['lnseg_acti_loss'], color='#3498db', alpha=0.8)

        ax.set_yticks(y_pos)
        ax.set_yticklabels(top_10['lnseg_name'] if 'lnseg_name' in top_10.columns else top_10['lnseg_rdfid'])

        ax.set_xlabel('损耗值 (kWh)', fontsize=12)
        ax.set_title('设备损耗排名 Top 10', fontsize=16, weight='bold', pad=15)

        # 添加数值标注
        for i, v in enumerate(top_10['lnseg_acti_loss']):
            ax.text(v + 0.5, i, f'{v:.2f}', va='center', fontsize=10)

        plt.tight_layout()
        plt.savefig(output_path, dpi=300, bbox_inches='tight')
        plt.close()

        return output_path

    return None




def create_voltage_current_chart(result_data, output_path):
    """生成电压电流趋势图"""
    line_data = result_data.get('DistributionLine', pd.DataFrame())

    if line_data.empty:
        return None

    fig, ax1 = plt.subplots(figsize=(14, 6))

    # 电压曲线
    if 'feeder_average_voltage' in line_data.columns:
        color1 = '#3498db'
        ax1.plot(line_data.index, line_data['feeder_average_voltage'],
                color=color1, linewidth=2, label='电压 (kV)')
        ax1.set_xlabel('时间点', fontsize=12)
        ax1.set_ylabel('电压 (kV)', color=color1, fontsize=12)
        ax1.tick_params(axis='y', labelcolor=color1)

    # 电流曲线（双Y轴）
    if 'feeder_average_current' in line_data.columns:
        ax2 = ax1.twinx()
        color2 = '#e74c3c'
        ax2.plot(line_data.index, line_data['feeder_average_current'],
                color=color2, linewidth=2, linestyle='--', label='电流 (A)')
        ax2.set_ylabel('电流 (A)', color=color2, fontsize=12)
        ax2.tick_params(axis='y', labelcolor=color2)

    ax1.set_title('电压电流24小时变化趋势', fontsize=16, weight='bold', pad=15)
    ax1.grid(True, alpha=0.3)

    # 合并图例
    lines1, labels1 = ax1.get_legend_handles_labels()
    if 'ax2' in locals():
        lines2, labels2 = ax2.get_legend_handles_labels()
        ax1.legend(lines1 + lines2, labels1 + labels2, loc='upper left')
    else:
        ax1.legend(loc='upper left')

    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    plt.close()

    return output_path


def generate_visualization(result_data, output_dir):
    """
    生成所有可视化内容

    Args:
        result_data: 计算结果数据
        output_dir: 输出目录

    Returns:
        tuple: (图表文件列表, HTML文件路径)
    """
    print('开始生成可视化内容')

    charts_dir = Path(output_dir) / 'charts'
    charts_dir.mkdir(parents=True, exist_ok=True)

    # 生成5张图表
    chart_files = []

    print('生成损耗分布饼图...')
    chart1 = create_loss_distribution_pie(result_data, charts_dir / 'chart_01_loss_distribution.png')
    if chart1:
        chart_files.append(str(chart1))

    print('生成时序损耗趋势图...')
    chart2 = create_time_series_chart(result_data, charts_dir / 'chart_02_time_series.png')
    if chart2:
        chart_files.append(str(chart2))

    print('生成设备损耗排名图...')
    chart3 = create_ranking_chart(result_data, charts_dir / 'chart_03_ranking.png')
    if chart3:
        chart_files.append(str(chart3))

    print('生成电压电流趋势图...')
    chart4 = create_voltage_current_chart(result_data, charts_dir / 'chart_04_voltage_current.png')
    if chart4:
        chart_files.append(str(chart4))

    # 生成HTML报告（简化版）
    print('生成HTML报告...')
    html_file = charts_dir.parent / '线损分析报告.html'

    # 生成简单HTML
    html_content = f"""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>南网理论线损分析报告</title>
    <style>
        body {{ font-family: "Microsoft YaHei", Arial, sans-serif; margin: 20px; }}
        h1 {{ color: #2c3e50; }}
        .chart {{ margin: 20px 0; }}
        img {{ max-width: 100%; height: auto; }}
    </style>
</head>
<body>
    <h1>南网理论线损分析报告</h1>
    <div class="chart">
        <h2>1. 损耗分布图</h2>
        <img src="charts/chart_01_loss_distribution.png" alt="损耗分布">
    </div>
    <div class="chart">
        <h2>2. 时序损耗趋势</h2>
        <img src="charts/chart_02_time_series.png" alt="时序趋势">
    </div>
    <div class="chart">
        <h2>3. 设备损耗排名</h2>
        <img src="charts/chart_03_ranking.png" alt="设备排名">
    </div>
    <div class="chart">
        <h2>4. 电压电流趋势</h2>
        <img src="charts/chart_04_voltage_current.png" alt="电压电流">
    </div>
</body>
</html>
"""

    with open(html_file, 'w', encoding='utf-8') as f:
        f.write(html_content)

    print('可视化生成完成')

    return chart_files, str(html_file)


if __name__ == '__main__':
    print('Visualization module loaded')