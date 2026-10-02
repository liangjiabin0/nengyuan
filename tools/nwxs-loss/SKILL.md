---
name: nwxs-theoretical-loss-calculation
description: 南网理论线损计算技能。当用户需要计算配网馈线理论线损、分析损耗分布、生成线损报告时执行。支持单馈线多时间点并行计算，输出完整的线损计算结果、统计汇总和可视化报告。
---

## 1. 触发边界 (Boundaries)

**Use this skill when:**

- 用户明确要求计算配网馈线理论线损
- 用户提供了配网馈线的JSON数据文件（包含拓扑结构、设备参数、运行数据）
- 用户需要分析线路损耗、变压器损耗、线损率等指标
- 用户需要可视化展示线损分布和时序趋势
- 对话上下文涉及理论线损计算、配网损耗分析等任务

**Do NOT use this skill when:**

- 用户仅询问理论线损计算的概念或原理
- 用户要求进行实际线损计算（需用实际电量数据）
- 用户仅需要查看已有的线损计算结果
- 提供的数据不包含完整的拓扑结构或运行数据
- 用户要求进行台区线损计算（台区线损为独立技能）

## 2. 结构化输入输出 (Structured I/O)

**Input:**

- `jsonData` (string | object): 配网馈线JSON数据对象或文件路径
  - 必须包含字段：
    - `calTime`: 计算日期，格式YYYY-MM-DD
    - `mtime`: 时间点索引，格式"0-1-2-..."，用"-"分隔
    - `tables`: 包含所有设备表的数据字典
  - 数据表要求：
    - `dms_def_feeder`: 馈线定义表
    - `dms_def_source`: 电源点定义表
    - `dms_def_lnseg`: 导线段定义表（含长度、电阻、电抗）
    - `dms_def_trfm`: 变压器定义表（含容量、空载损耗、短路损耗）
    - `dms_def_trwd`: 变压器绕组定义表
    - `dms_def_load`: 负荷定义表（含功率数据）

- `calcMethod` (string): 计算方法代码，默认"04"
  - "04": 理论线损计算方法
  - 其他方法待扩展

- `outputFormat` (string): 输出格式，默认"full"
  - "full": 完整输出（JSON + Excel + 图表 + HTML）
  - "json_only": 仅输出JSON结果
  - "summary": 输出JSON + Excel汇总

**Output:**

- `success` (boolean): 计算是否成功完成

- `message` (string): 执行状态描述

- `results` (object): 计算结果数据
  - `jsonFiles`: 17个JSON结果表路径字典
    ```json
    {
      "DistributionLine": "/output/json_results/DistributionLine.json",
      "DistributionEnergy": "/output/json_results/DistributionEnergy.json",
      ...
    }
    ```

  - `excelSummary`: Excel统计汇总文件路径（可选）
    - 文件名：`线损统计汇总.xlsx`
    - 包含5个Sheet：关键指标汇总、损耗分布统计、设备损耗排名、时序分析数据、异常提示与建议

  - `charts`: 可视化图表文件路径列表（可选）
    ```json
    [
      "/output/charts/chart_01_loss_distribution.png",
      "/output/charts/chart_02_time_series.png",
      ...
    ]
    ```

  - `htmlReport`: HTML交互报告路径（可选）
    - 文件名：`线损分析报告.html`

- `errorDetail` (string): 执行失败时的具体错误信息（仅在失败时返回）

- `statistics` (object): 计算统计信息
  - `feederName`: 馈线名称
  - `calcDate`: 计算日期
  - `timePointCount`: 时间点数量
  - `calculationTime`: 计算耗时（秒）
  - `totalLoss`: 总损耗（kWh）
  - `lossRate`: 理论线损率（%）

## 3. 执行架构 (Execution Architecture)

本技能采用时间点级并行计算架构，通过子进程池并行处理多个时间点的线损计算任务。

### 3.1 计算流程

```
步骤0: 输入完整性校验（主进程，串行）
    ├─ 检查必需字段是否存在
    ├─ 验证数据格式正确性
    └─ 拦截不完整输入并追问用户
    ↓
步骤1: 数据解析与模型构建（主进程，串行）
    ├─ 解析JSON数据为DataFrame
    ├─ 构建DMS电网模型
    └─ 验证拓扑完整性
    ↓
步骤2: 并行计算（子进程池，并行）
    ├─ 为每个时间点启动独立进程
    ├─ 执行潮流计算和线损计算
    └─ 收集各时间点计算结果
    ↓
步骤3: 结果汇总与处理（主进程，串行）
    ├─ 合并所有时间点结果
    ├─ 生成日汇总数据
    └─ 输出17个JSON结果表
    ↓
步骤4: 统计分析与可视化（主进程，串行，可选）
    ├─ 生成Excel统计汇总
    ├─ 生成4张可视化图表
    └─ 生成交互式HTML报告
```

### 3.2 并行策略

**核心原则**: 时间点之间完全独立，天然适合并行计算。

- 若用户提供N个时间点数据（N通常为24或96），必须为每个时间点启动独立计算进程
- 各时间点计算完全独立，无数据依赖
- 使用ProcessPoolExecutor实现进程级并行
- 最大并行进程数 = min(CPU核心数, 61)
- 计算结果按时间点顺序收集并汇总

### 3.3 结果数据结构

**时刻级结果表（9个）**:

| 表名 | 说明 | 核心字段 |
|------|------|----------|
| DistributionLine | 配网馈线计算结果 | feeder_id, acti_power, tot_loss, loss_rate |
| DistributionEnergy | 配网电量输入输出结果 | psr_id, actiener, reacener |
| DistributionACLineSegment | 配网导线段计算结果 | lnseg_id, lnseg_loss, lnseg_current |
| DistributionTransformer | 配网变压器计算结果 | tran_id, copp_loss, iron_loss |
| DistributionGeneratingUnit | 配网分布式电源计算结果 | disgen_id, positive_acti |
| DistributionCapacitorBank | 配网电容器计算结果 | （预留） |
| TheoCalcLog | 设备日志 | equipment_id, level, content |
| InstanceResult | 计算结果状态 | calc_obj_id, is_success |
| CalculateLog | 计算日志 | distribution_line_id, code, message |

**日汇总结果表（8个）**:

对时刻级结果按日进行sum/mean汇总，表名后缀"_Day"。

## 4. 执行步骤 (Steps)

**步骤 0：前置输入完整性检查**

- 检查jsonData是否提供，若缺失则立即阻断：
  ```
  缺少执行所需的输入数据。请提供完整的配网馈线JSON数据文件。
  必需字段：calTime, mtime, tables
  ```

- 检查tables是否包含必需设备表：
  - `dms_def_feeder`（馈线定义）
  - `dms_def_source`（电源定义）
  - `dms_def_lnseg`（导线段定义）
  - `dms_def_trfm`（变压器定义）
  - `dms_def_trwd`（变压器绕组）
  - `dms_def_load`（负荷定义）

- 若缺少关键设备表，阻断并提示：
  ```
  JSON数据不完整，缺少必需的设备表：<缺失表名>
  请确保数据包含完整的电网拓扑结构。
  ```

- 识别时间点数量N（通过mtime字段），为后续并行计算做准备

**步骤 1：数据解析与模型构建**

- 调用数据解析器：`parse_dms_json_to_tables_df(json_data, time_index)`
  - 遍历所有N个时间点
  - 对每个时间点提取功率数据
  - 转换为DataFrame字典格式

- 构建DMS模型实例：
  ```python
  dms_model = DMSModelBase()
  dms_model.set_source('dataframe', data=table_dataframes_dict)
  dms_model.set_prefix('dms_')
  dms_model.set_source_field_lower()
  dms_model.set_calc_model('dms')
  dms_model.read_model()
  ```

- 验证拓扑完整性：
  - 检查馈线是否成功构建（topo_status == 0）
  - 检查是否包含负荷节点
  - 若拓扑异常，记录错误但不阻断（继续计算其他时间点）

**步骤 2：并行计算**

- 使用ProcessPoolExecutor并行执行：
  ```python
  with ProcessPoolExecutor(max_workers=min(os.cpu_count(), 61)) as executor:
      future_tasks = []
      for time_index in all_times:
          future_tasks.append(
              executor.submit(
                  start_calc_one_feeder,
                  dms_tables=table_dataframes_dict,
                  day_time=day_time,
                  time_index=time_index,
                  cons_para='config.cons_para',
                  method_type=calcMethod,
                  dms_model=dms_model
              )
          )
      
      for future in as_completed(future_tasks):
          feeder_result = future.result()
          # 收集结果
  ```

- 每个时间点的计算流程：
  1. 构建潮流模型（ModelBuilder）
  2. 执行潮流计算（Loss.calculate）
  3. 计算各设备损耗
  4. 返回结果字典

- 异常处理：
  - 若单个时间点计算失败，记录错误但继续计算其他时间点
  - 最终统计成功/失败时间点数量

**步骤 3：结果汇总与处理**

- 合并所有时间点的结果：
  - feeder_statics_df: 馈线统计结果
  - distribution_line_df: 馈线线损结果
  - distribution_energy_df: 电量输入输出结果
  - distribution_aclinesegment_df: 导线段损耗结果
  - distribution_transformer_df: 变压器损耗结果
  - distribution_generatingunit_df: 分布式电源结果
  - power_error_df: 功率误差记录

- 生成日汇总结果：
  ```python
  distribution_line_day = calc_feeder_day_result(distribution_line_hour)
  distribution_energy_day = calc_energy_day_result(distribution_energy_hour)
  distribution_aclinesegment_day = calc_line_day_result(distribution_aclinesegment_hour)
  distribution_transformer_day = calc_trfm_day_result(distribution_transformer_hour)
  distribution_generatingunit_day = calc_generation_day_result(distribution_generatingunit_hour)
  feeder_statics_day = calc_feederstatics_day_result(feeder_statics_hour)
  ```

- 输出JSON文件：
  - 17个JSON文件，每个对应一个结果表
  - 文件位置：`/output/json_results/`
  - 格式：UTF-8，非ASCII字符不转义

**步骤 4：统计分析与可视化（可选）**

若outputFormat为"full"或"summary"，执行以下步骤：

- 生成Excel统计汇总：
  - Sheet 1: 关键指标汇总（供电量、损耗、线损率、负载率等）
  - Sheet 2: 损耗分布统计（线路损耗、变压器铜损、变压器铁损占比）
  - Sheet 3: 设备损耗排名（Top 10高损耗导线段、变压器）
  - Sheet 4: 时序分析数据（96个时间点详细数据）
  - Sheet 5: 异常提示与建议（异常设备清单、优化建议）
  - 文件路径：`/output/线损统计汇总.xlsx`

若outputFormat为"full"，额外执行：

- 生成可视化图表（4张PNG，300 DPI）：
  - chart_01_loss_distribution.png: 损耗分布饼图
  - chart_02_time_series.png: 时序损耗趋势图
  - chart_03_ranking.png: 设备损耗排名柱状图
  - chart_04_voltage_current.png: 电压电流趋势图
  - 文件位置：`/output/charts/`

- 生成交互式HTML报告：
  - 响应式布局，适配PC和移动端
  - 集成动态图表（Chart.js）
  - 数据表格支持排序、搜索、导出
  - 异常设备高亮显示
  - 交互筛选功能
  - 文件路径：`/output/线损分析报告.html`

## 5. 失败策略 (Failure Strategy)

**On Input Missing (步骤 0 失败):**

- 立即挂起工作流
- 向用户精准追问缺失项：
  ```
  输入数据不完整，请补充以下内容：
  - 缺失字段：<字段名>
  - 缺失设备表：<表名>
  
  请确保JSON数据包含完整的拓扑结构和运行数据。
  ```

**On Model Build Error (步骤 1 失败):**

- 若DMS模型构建失败：
  - 记录详细错误信息（拓扑断连、缺少负荷等）
  - 返回错误详情：
    ```
    电网模型构建失败。
    错误类型：<拓扑断连/缺少负荷/参数异常>
    详细信息：<具体错误描述>
    
    请检查设备连接关系和参数完整性。
    ```

**On Calculation Error (步骤 2 失败):**

- 若单个时间点计算失败：
  - 记录该时间点的错误信息
  - 继续计算其他时间点
  - 在最终结果中标注失败的时间点

- 若所有时间点均失败：
  - 挂起工作流，返回错误：
    ```
    所有时间点计算均失败，请检查输入数据格式和参数合理性。
    错误详情：<汇总错误信息>
    ```

**On Output Error (步骤 3/4 失败):**

- 若JSON文件写入失败：
  - 记录错误但不阻断（已有内存结果）
  - 尝试重新写入或返回内存数据

- 若Excel/图表生成失败：
  - 跳过该步骤，确保JSON输出完成
  - 记录警告信息，返回部分结果：
    ```
    计算完成，但可视化生成失败。
    已成功输出JSON结果文件。
    失败原因：<具体错误>
    ```

## 6. 配置参数 (Configuration)

### 计算参数（config/cons_para.py）

```python
# 电压基准值
Volbase = 10  # kV

# 容量基准值
Sbase = 100  # kVA

# 阻抗基准值
Zbase = 5.77  # Ω

# 默认线路参数
Ra_disline = 0.01  # Ω（线路电阻默认值）
Xa_disline = 0.012  # Ω（线路电抗默认值）

# 默认变压器参数
Ra_distrfm = 15  # Ω（变压器电阻默认值）
Xa_distrfm = 0.5  # Ω（变压器电抗默认值）
Mva_distrfm = 630  # kVA（变压器容量默认值）

# 损耗参数
p0 = 0.28  # 空载损耗默认值（kW）
pk = 0.3  # 短路损耗默认值（kW）

# 时间分辨率因子
time_resolution_factor = 0.25  # 96点数据（15分钟间隔）
```

### 计算方法说明

**方法"04"：理论线损计算**
- 基于潮流计算的方法
- 输入：电网拓扑、设备参数、负荷功率
- 计算：各设备功率损耗
- 输出：理论损耗值和线损率

**适用场景**：
- 配网规划阶段的损耗预估
- 运行方式的损耗分析
- 设备参数的合理性校验

## 7. 使用示例 (Examples)

### 示例1：基础计算（仅JSON输出）

**输入**:
```json
{
  "jsonData": {
    "calTime": "2024-01-01",
    "mtime": "0-1-2-3-...-95",
    "tables": {
      "dms_def_feeder": {"rows": [...]},
      "dms_def_source": {"rows": [...]},
      ...
    }
  },
  "calcMethod": "04",
  "outputFormat": "json_only"
}
```

**输出**:
```json
{
  "success": true,
  "message": "计算完成。成功计算96个时间点。",
  "results": {
    "jsonFiles": {
      "DistributionLine": "/output/json_results/DistributionLine.json",
      "DistributionEnergy": "/output/json_results/DistributionEnergy.json",
      ...
    }
  },
  "statistics": {
    "feederName": "万顷沙F23福安乙线",
    "calcDate": "2024-01-01",
    "timePointCount": 96,
    "calculationTime": 125.6,
    "totalLoss": 246.91,
    "lossRate": 2.0
  }
}
```

### 示例2：完整输出（JSON + Excel + 图表 + HTML）

**输入**:
```json
{
  "jsonData": "/path/to/feeder_data.json",
  "calcMethod": "04",
  "outputFormat": "full"
}
```

**输出**:
```json
{
  "success": true,
  "message": "计算完成。已生成完整输出文件。",
  "results": {
    "jsonFiles": {...},
    "excelSummary": "/output/线损统计汇总.xlsx",
    "charts": [
      "/output/charts/chart_01_loss_distribution.png",
      "/output/charts/chart_02_time_series.png",
      "/output/charts/chart_03_ranking.png",
      "/output/charts/chart_04_load_rate.png",
      "/output/charts/chart_05_voltage_current.png"
    ],
    "htmlReport": "/output/线损分析报告.html"
  },
  "statistics": {...}
}
```

### 示例3：输入错误处理

**输入**:
```json
{
  "jsonData": {
    "calTime": "2024-01-01",
    "mtime": "0-1-2",
    "tables": {
      "dms_def_feeder": {"rows": [...]}
      // 缺少其他设备表
    }
  }
}
```

**输出**:
```json
{
  "success": false,
  "message": "输入数据不完整",
  "errorDetail": "缺少必需的设备表：dms_def_source, dms_def_lnseg, dms_def_trfm, dms_def_trwd, dms_def_load。请提供完整的电网拓扑数据。",
  "statistics": null
}
```

## 8. 技术说明 (Technical Notes)

### 依赖库

- **核心计算**:
  - pandas >= 1.5.0: 数据处理
  - numpy >= 1.21.0: 数值计算
  - networkx >= 2.6.0: 拓扑图构建
  - power-grid-model >= 1.0.0: 潮流计算核心库

- **工具库**:
  - loguru >= 0.6.0: 日志记录
  - rich >= 12.0.0: 终端美化

- **可视化（可选）**:
  - matplotlib >= 3.5.0: 静态图表
  - seaborn >= 0.11.0: 统计可视化
  - openpyxl >= 3.0.0: Excel生成
  - jinja2 >= 3.0.0: HTML模板

### 性能优化

- **并行计算**: 利用多核CPU，显著提升计算速度
- **内存管理**: 及时释放大数据对象，避免内存溢出
- **进度反馈**: 实时显示计算进度和状态

### 数据质量要求

- **拓扑完整性**: 电网拓扑必须连通，无孤岛
- **参数合理性**: 设备参数在合理范围内（电阻、电抗、容量等）
- **功率数据**: 负荷功率数据完整，无大量缺失

### 计算精度

- 电压基准：10kV（配网）
- 功率单位：kW
- 损耗单位：kWh
- 线损率单位：%
- 时间分辨率：15分钟（96点）或1小时（24点）