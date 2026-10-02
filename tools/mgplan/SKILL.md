---
name: mgplan-calculation
description: 执行基于 openTEPES 的多能系统规划、源网荷储投资优化和运行模拟。用于运行内置 sSEP 案例，以及分析投资、成本、机组、储能和网络结果。
---

# 多能系统规划计算 Skill

## 1. 触发边界 (Boundaries)

**Use this skill when:**

- 用户要求执行 openTEPES 多能系统规划计算
- 用户要求运行内置 `sSEP` 案例
- 用户需要电源投资、运行成本、储能、网损或规划评价结果

**Do NOT use this skill when:**

- 用户只询问模型原理，不要求实际计算
- 目标机器未通过原程序设备授权检查
- Gurobi、pyoptinterface 或有效求解授权不可用
- 用户只要求读取已有结果，无需重新求解

## 2. 结构化输入输出 (Structured I/O)

本 skill 不新增包装主函数，直接执行原程序：

```bash
python scripts/openTEPES_Main.py
```

原主函数中的运行配置：

```python
DIR = os.path.dirname(__file__)
CASE = "sSEP"
SOLVER = "gurobi"
LOG = "Yes"
```

系统缝合后输入默认在 `config/`（可用 `MGPLAN_CONFIG_DIR` 覆盖），输出在 `MGPLAN_OUTPUT_DIR` 或想法工作区 `mgplan/output`。原 `scripts/openTEPES_Main.py` 仍写 `scripts/sSEP/`；方案求解流水线走 `python -m mgplan_agent run`。

必需输入：

- `oT_Data_Option_sSEP.csv`
- `oT_Data_Parameter_sSEP.csv`
- `oT_Data_Demand_sSEP.csv`
- `oT_Data_ElectricityPrice_sSEP.csv`
- `oT_Data_Generation_sSEP.csv`
- `oT_Data_VariableMaxGeneration_sSEP.csv`
- `oT_Data_NodeLocation_sSEP.csv`
- `oT_Data_Network_sSEP.csv`
- `oT_Dict_LoadLevel_sSEP.csv`

主要输出：

- 经济与投资：成本汇总、电源投资、网架投资
- 机组运行：出力、启停、排放、技术类型电量
- 储能运行：充放电、库存、弃电、利用率
- 规划评价：技术与经济评价
- 网络结果：网损、失供电量和网络地图

## 3. 执行架构 (Execution Architecture)

```text
scripts/openTEPES_Main.py
  ├─ check_mac()                         设备授权检查
  └─ openTEPES.openTEPES_run()
       ├─ InputData_poi                  读取 scripts/sSEP
       ├─ SettingUpVariables_poi         定义变量
       ├─ openTEPES_ModelFormulation     构建目标与约束
       ├─ openTEPES_ProblemSolving       调用 Gurobi
       └─ openTEPES_OutputResults        写回 scripts/sSEP
```

计算流程：

1. 检查目标设备 MAC
2. 创建 pyoptinterface Gurobi 模型
3. 读取 sSEP 集合、参数与时间序列
4. 构建投资、发电、需求、储能和网络约束
5. 按 Option 开关加入 EV、热系统、合成氨或数据中心模型
6. 调用 Gurobi 求解
7. 输出 CSV、HTML 和 PNG

## 4. 执行步骤 (Steps)

### 步骤 0：检查环境

```bash
pip install -r requirements.txt
```

同时确认：

- Gurobi 已安装且许可证有效
- 目标设备通过 `scripts/openTEPES_Main.py` 中的 MAC 白名单
- `scripts/openTEPES.mapbox_token` 可用于网络地图

不得删除、注释或规避设备授权检查。

### 步骤 1：检查输入

确认 `scripts/sSEP/` 中存在全部必需 CSV，且文件名统一使用 `_sSEP.csv` 后缀。

### 步骤 2：执行计算

从 skill 根目录运行：

```bash
python scripts/openTEPES_Main.py
```

完整年度案例可能耗时较长，不要重复启动同一计算。

### 步骤 3：检查结果

至少检查：

- `scripts/sSEP/oT_Result_CostSummary_sSEP.csv`
- `scripts/sSEP/oT_Result_GenerationInvestment_sSEP.csv`
- `scripts/sSEP/oT_Result_GenerationOutput_sSEP.csv`
- `scripts/sSEP/oT_Result_Evaluations_sSEP.csv`
- `scripts/sSEP/oT_Result_NetworkPloss_sSEP.csv`
- `scripts/sSEP/oT_Result_NetworkENS_sSEP.csv`
- `scripts/sSEP/oT_Plot_MapNetwork_sSEP.html`

部分文件仅在对应集合非空或功能开关启用时生成。

## 5. 失败策略 (Failure Strategy)

**设备授权失败：**

- 原程序打印 MAC 错误并退出
- 联系授权提供方登记目标设备
- 不修改白名单，不提供绕过方案

**依赖或求解器失败：**

- 检查 `pyoptinterface`、`gurobipy` 和 Gurobi 本地许可证
- 检查 `scripts/opt/` 与目标 Gurobi 环境是否匹配

**输入或模型失败：**

- 检查 CSV 列名、索引、单位和 `_sSEP` 后缀
- 检查 Option 启用的扩展系统是否具备对应输入
- 模型不可行时读取 `scripts/sSEP/` 中生成的 IIS/ILP 文件

**可视化失败：**

- 保留已生成 CSV
- 检查 Mapbox token、Plotly 和 Chrome renderer
- 将可视化失败与优化求解失败分开报告

## 6. 配置参数 (Configuration)

入口配置位于 `scripts/openTEPES_Main.py`：

- `CASE = "sSEP"`
- `SOLVER = "gurobi"`
- `LOG = "Yes"`

求解参数位于 `scripts/openTEPES_ProblemSolving.py`，包括 Method、MIPFocus、MIPGap、Threads、TimeLimit 和 IterationLimit。

案例规划开关和参数分别位于：

- `scripts/sSEP/oT_Data_Option_sSEP.csv`
- `scripts/sSEP/oT_Data_Parameter_sSEP.csv`

## 7. 使用示例 (Examples)

```bash
cd mgplan-calculation-skill
python scripts/openTEPES_Main.py
```

若使用项目虚拟环境：

```powershell
& "$env:AI4ES_PROJECT_ROOT\tools\mgplan-venv\Scripts\python.exe" `
  "$env:AI4ES_PROJECT_ROOT\tools\mgplan\scripts\openTEPES_Main.py"
```

## 8. 技术说明 (Technical Notes)

### 依赖

- pandas、numpy、numpy-financial
- pyoptinterface、gurobipy、Gurobi
- psutil、memory-profiler
- matplotlib、Altair、Plotly、colour

### 路径约定

- 原始主函数：`scripts/openTEPES_Main.py`
- 计算模块：`scripts/openTEPES*.py`
- 求解器适配：`scripts/opt/`
- 输入输出案例：`scripts/sSEP/`
- 地图令牌：`scripts/openTEPES.mapbox_token`

### 完整性

- `openTEPES_Main.py` 由项目根目录原文件直接复制，未创建替代入口
- 原始 openTEPES Python 文件、`opt/` 和 `sSEP/` 已完整复制
- 原始设备授权检查保持有效
