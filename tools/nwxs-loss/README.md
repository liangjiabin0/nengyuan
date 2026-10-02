# 南网理论线损计算skill

基于南网理论线损计算代码提取整理的独立skill，可部署至"电力科学基础大模型"。

## 项目简介

本skill用于计算配电网馈线的理论线损，支持：
- 基于潮流计算或状态估计的线损计算
- 多时间点并行计算
- 生成17个标准化结果表
- 输出JSON格式结果

## 功能特性

### 核心功能
- ✅ 数据解析：支持JSON格式输入数据
- ✅ 线损计算：导线损耗、变压器损耗、其他损耗
- ✅ 并行计算：多时间点并行处理
- ✅ 结果输出：17个标准化结果表

### 计算方法
- 方法代码：04（理论线损计算）
- 计算算法：鲁棒状态估计法
- 时间分辨率：支持15分钟、1小时、1分钟分辨率

### 输出结果（17个表）

#### 时刻级结果（9个）
1. DistributionLine - 馈线线损时刻级结果
2. DistributionEnergy - 电量输入输出时刻级结果
3. DistributionACLineSegment - 导线段线损时刻级结果
4. DistributionTransformer - 变压器线损时刻级结果
5. DistributionGeneratingUnit - 分布式电源时刻级结果
6. DistributionCapacitorBank - 电容器组（空表）
7. TheoCalcLog - 计算日志（空表）
8. InstanceResult - 计算实例结果
9. CalculateLog - 计算日志副本

#### 日汇总结果（8个）
- DistributionLine_Day - 馈线线损日汇总
- DistributionEnergy_Day - 电量输入输出日汇总
- DistributionACLineSegment_Day - 导线段线损日汇总
- DistributionTransformer_Day - 变压器线损日汇总
- DistributionGeneratingUnit_Day - 分布式电源日汇总
- DistributionCapacitorBank_Day - 电容器组日汇总（空表）
- TheoCalcLog_Day - 计算日志日汇总（空表）
- InstanceResult_Day - 计算实例日汇总

## 安装说明

### 环境要求
- Python: 3.11+
- 操作系统: Windows / Linux / macOS

### 依赖库
```bash
pip install pandas numpy networkx power-grid-model loguru matplotlib openpyxl jinja2
```

或使用requirements.txt:
```bash
pip install -r requirements.txt
```

### 安装步骤
1. 克隆或下载本项目
2. 安装依赖库
3. 准备输入数据（JSON格式）

## 使用方法

### 命令行运行

```bash
cd nwxs-loss-calculation-skill

# 基本用法（默认完整输出：JSON + Excel + 图表 + HTML）
python scripts/main_calculation.py

# 完整参数
python scripts/main_calculation.py \
  -i test_data/sample.json \    # 输入JSON文件
  -o output \                    # 输出目录
  -m 04 \                        # 计算方法（默认04）
  -f full \                      # 输出格式（默认full）
  -w 2                           # 并行进程数（可选）
```

### 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-i, --input` | 输入JSON文件路径（必需） | - |
| `-o, --output` | 输出目录路径 | `./output` |
| `-m, --method` | 计算方法代码 | `04` |
| `-f, --format` | 输出格式 | `full` |
| `-w, --workers` | 并行进程数 | 自动检测 |

### 输出格式

| 格式 | 说明 | 输出内容 |
|------|------|---------|
| `full` (默认) | 完整输出 | JSON + Excel + 图表 + HTML |
| `summary` | 汇总输出 | JSON + Excel汇总 |
| `json_only` | 简洁输出 | 仅JSON结果文件 |

## 输入数据要求

### JSON文件结构
```json
{
  "calTime": "2025-08-15",
  "mtime": "0-1-2-3-4-5-6-7-8-9-10-11-12-13-14-15-16-17-18-19-20-21-22-23",
  "tables": {
    "dms_def_feeder": { ... },
    "dms_def_source": { ... },
    "dms_def_lnseg": { ... },
    "dms_def_trfm": { ... },
    "dms_def_trwd": { ... },
    "dms_def_load": { ... },
    ...
  }
}
```

### 必需表（核心）
- `dms_def_feeder` - 馈线定义
- `dms_def_source` - 电源定义
- `dms_def_lnseg` - 导线段定义
- `dms_def_trfm` - 变压器定义
- `dms_def_trwd` - 变压器绕组
- `dms_def_load` - 负荷定义

## 输出结果说明

### 输出目录结构
```
output/
├── json_results/                 # JSON结果文件目录
│   ├── DistributionLine.json
│   ├── DistributionEnergy.json
│   ├── DistributionACLineSegment.json
│   ├── DistributionTransformer.json
│   ├── DistributionGeneratingUnit.json
│   ├── InstanceResult.json
│   ├── CalculateLog.json
│   ├── DistributionLine_Day.json
│   ├── DistributionEnergy_Day.json
│   ├── DistributionACLineSegment_Day.json
│   ├── DistributionTransformer_Day.json
│   ├── DistributionGeneratingUnit_Day.json
│   └── InstanceResult_Day.json
├── charts/                       # 4张PNG图表
│   ├── chart_01_loss_distribution.png
│   ├── chart_02_time_series.png
│   ├── chart_03_ranking.png
│   └── chart_04_voltage_current.png
├── 线损统计汇总.xlsx
└── 线损分析报告.html
```

### 关键指标说明

#### DistributionLine_Day（馈线日线损汇总）
- `acti_power`: 供电量（kW）
- `feeder_acti_loss`: 总有功损耗（kW）
- `feeder_lossrate`: 线损率（%）
- `lnseg_loss`: 导线损耗（kW）
- `tran_copp_loss`: 变压器铜损（kW）
- `tran_iron_loss`: 变压器铁损（kW）
- `feeder_average_voltage`: 平均电压（kV）
- `feeder_average_current`: 平均电流（A）

## 技术架构

### 目录结构
```
nwxs-loss-calculation-skill/
├── SKILL.md                      # skill说明文档
├── README.md                     # 本文档
├── requirements.txt              # 依赖清单
├── scripts/                      # 脚本目录
│   ├── main_calculation.py       # 主计算脚本
│   ├── data_parser.py            # 数据解析脚本
│   ├── result_processor.py       # 结果处理脚本
│   ├── visualization.py          # 可视化脚本
│   ├── excel_summary.py          # Excel汇总脚本
├── lib/                          # 核心库目录
│   ├── dms/                      # DMS模型模块
│   ├── mparser/                  # 数据解析模块
│   ├── helper/                   # 辅助工具模块
│   └── loss/                     # 损耗计算模块
├── config/                       # 配置文件目录
│   └── cons_para.py              # 参数配置
├── assets/                       # 资源文件目录
│   └── templates/                # 模板文件
├── test_data/                    # 测试数据目录
│   └── sample.json               # 示例数据
└── output/                       # 输出结果目录
```

### 核心模块
- **main_calculation**: 主计算流程、并行调度
- **data_parser**: JSON解析、数据修复、分组
- **result_processor**: 结果合并、日汇总、JSON输出
- **lib**: 完整提取的原始计算逻辑

## 注意事项

### 重要说明
1. **完整保留原始逻辑**：本skill完整保留了原始南网理论线损计算程序的所有计算逻辑，未做简化或删减
2. **结果表数量**：必须生成17个结果表（包括空表），不能删减
3. **表名一致性**：表名必须与原始程序完全一致（如DistributionACLineSegment）
4. **数据格式**：输入数据必须符合JSON格式规范

### 性能优化
- 并行计算：使用多进程并行处理多个时间点
- 内存管理：及时释放中间结果，避免内存溢出
- 计算时间：单馈线24时间点约10秒

### 故障排除
1. **导入错误**：检查lib目录下的所有import路径
2. **数据为空**：检查输入JSON文件格式和必需表
3. **计算失败**：检查数据完整性和参数配置

## 许可证

内部使用，仅供南网理论线损研究项目使用。

---

