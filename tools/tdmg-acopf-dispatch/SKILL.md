---
name: tdmg-acopf-dispatch
description: Parse and solve IEEE/MATPOWER-style cases with composable transmission-distribution-microgrid active/reactive dispatch. Use when a user supplies a case/scenario file and asks in one sentence to call the skill, show the generated task program and solve process, and deliver program, log, results, and model documentation. Also use for 主配微、主配、配微、主网/配网/微网单独、孤岛、边界等值、源网荷储、AC-OPF、多时间尺度、日前-日内-实时、爬坡、储能 SOC、柔性负荷电量、P/Q 耦合及 HVDC/SOP 交流侧等值的任意模块组合。Recognize conventional, renewable, inverter, storage, EV/V2G, flexible-load, reactive-support, shunt, boundary-grid, converter-terminal, and generic P/Q resources. Accept `.m`, `.py`, `.mat`, and structured JSON; generate an auditable task driver, input manifest, solve log, model document, and electrical/state results. Reject full DC-network data. Not for unbalanced three-phase, mixed-integer commitment, security-constrained OPF, simultaneous global multi-scale optimization, or full AC/DC coupled power flow.
---

# 模块化主配微有功无功协同调度

把用户要求拆成空间范围、边界条件、资源、物理约束、目标和时间尺度，再组合成可审计的平衡稳态 AC-OPF。未知模块、无法表示的设备或不兼容组合必须报错，不得静默忽略。

## 选择执行路径

- 单个全网快照或互相独立的时段：使用 `scripts/tdmg_opf.py`。
- 主配微任意子系统、孤岛、多个对比研究、爬坡/SOC/柔性负荷电量、日前—日内—实时层级：使用 `scripts/modular_dispatch.py`。
- 用户要求“输入文件 + 一句话调用 + 展示程序/求解过程 + 生成程序和文档”时：先使用 `scripts/task_pipeline.py` 生成任务专属交付包，再执行其中的 `generated_dispatch.py`。
- 识别或新增资源前，完整阅读 [resource-catalog.md](references/resource-catalog.md)。
- 创建 sidecar 或时序输入时，阅读 [input-schema.md](references/input-schema.md)。
- 组合空间和时间模块时，阅读 [modular-scenarios.md](references/modular-scenarios.md)。
- 判断模型适用性、交直流边界或结果可信度时，阅读 [model-and-validation.md](references/model-and-validation.md)。
- 需要生成任务程序、展示过程和固定交付包时，完整阅读 [task-artifacts.md](references/task-artifacts.md)。

## 定位运行时

使用工作区依赖加载器取得随附 Python。脚本优先从 `scripts/_vendor` 导入固定版本的 NumPy、SciPy 和 PYPOWER。

仅在依赖确实不可用时，说明正在初始化数值后端，然后运行：

```powershell
& '<bundled-python>' '<skill-root>\scripts\bootstrap.py'
```

## 先确认 AC/DC 模型边界

标准 MATPOWER/PYPOWER AC 潮流和 AC-OPF 只有交流母线、交流支路及节点 P/Q 平衡，不包含直流母线电压、直流线路潮流或换流器内部方程。

- 普通交流网络：直接计算。
- HVDC、SOP、柔直设备仅作为交流侧端口等值：使用两个或多个 `converter-ac-equivalent` 资源，并用 `resource_couplings` 写端口有功平衡/损耗；可优化各交流端口 P/Q，但不得称为完整交直流耦合潮流。
- 输入 `dc_buses`、`dc_branches`、`busdc`、`branchdc`、`convdc`、`dc_networks`、`dcline`，或把资源声明为 `hvdc`/`vsc-hvdc`/`lcc-hvdc`：当前后端必须拒绝并说明需要专用 AC/DC 求解器，不能丢弃直流状态后继续算。

## 组合空间与边界

将常用说法映射为范围预设：

- 主配微 → `tdm`
- 主配 → `td`
- 配微 → `dm`
- 主网、配网、微网单独 → `t`、`d`、`m`
- 完整独立 case → `all`

预设不足时使用精确的 `scope.areas` 或 `scope.levels`。一个 schema-v2 场景可以包含多个 `studies[]`，每个研究可覆盖不同范围或引用不同 case。

范围切断带电支路时必须明确边界：

- 并网子系统默认 `equivalent-grid`，并给出可信的 P/Q 容量和价格；
- 已知上级/下级计划用 `fixed-exchange`；
- 只有用户要求断开时才用 `islanded`，且每个孤岛必须存在在线电源。

## 规范化资源

运行资源目录查看所有规范类型与别名：

```powershell
& '<bundled-python>' '<skill-root>\scripts\resource_models.py' catalog
```

所有资源先映射为规范类型，再进入以下物理表示之一：交流发电机 P/Q、负发电机负荷、Q-only 资源、固定负荷、固定导纳、带状态储能，或带线性端口耦合的交流侧换流器等值。

未知资源若明确给出 `p_min_mw`、`p_max_mw`、`q_min_mvar`、`q_max_mvar`，使用 `generic-pq` 适配器并保留原始类型；否则拒绝。设备若还含离散档位、内部网络状态、非线性控制器或跨能流方程，必须增加专用模型，不能只凭名称猜测。

在求解前校验资源 sidecar：

```powershell
& '<bundled-python>' '<skill-root>\scripts\resource_models.py' validate '<case-file>' '<sidecar.json>'
```

## 选择物理和时间模块

按需组合：

- `ac-opf`、`area-exchange`、`boundary-equivalent`、`loss-penalty`；
- `warm-start`、`ramp-link`、`storage-soc`、`flexible-load-energy`、`parent-tracking`；
- `resource-coupling` 用于 SOP/HVDC 交流侧端口、CHP 电侧等可线性表示的 P/Q 等式或不等式；
- `dc-opf-diagnostic` 只用于明确标注的有功诊断，不是直流网络模型，也不能代替有功无功协同。

不确定时运行 `modular_dispatch.py catalog`，不得编造模块名。

多时间尺度按因果顺序组织：日前父层、日内子层、实时子层；采用用户给定分辨率。子时段优先用 `parent_period` 显式映射。当前实现是层级滚动/顺序 AC-OPF，传递爬坡、SOC、柔性负荷剩余电量并可惩罚父子计划偏差，不是一次性全时域随机、鲁棒或混合整数全局最优。

## 构建、验证和执行

保留源 case，不原地修改。先检查 `baseMVA`、节点/机组/支路数、参考节点、P/Q 与电压边界、成本、变压器、孤岛和全部 `RATE_A=0`。

生成 sidecar 草稿：

```powershell
& '<bundled-python>' '<skill-root>\scripts\tdmg_opf.py' inspect '<case-file>' --output '<case-stem>.tdmg.json'
```

生成并验证模块化场景：

```powershell
& '<bundled-python>' '<skill-root>\scripts\modular_dispatch.py' template '<case-file>' --sidecar '<sidecar.json>' --output '<scenario.json>'
& '<bundled-python>' '<skill-root>\scripts\modular_dispatch.py' validate '<scenario.json>'
```

执行快照或模块化调度：

```powershell
& '<bundled-python>' '<skill-root>\scripts\tdmg_opf.py' solve '<case-file>' --config '<sidecar.json>' --output '<output-directory>'
& '<bundled-python>' '<skill-root>\scripts\modular_dispatch.py' run '<scenario.json>' --output '<output-directory>'
```

## 展示程序与求解过程

当用户采用“一句话调用”或要求可见的程序/过程/文档时，必须采用以下交互协议；普通快速计算可直接走前述求解路径。

1. 在界面说明已识别的文件类型、网络规模、资源、时间尺度和输入问题。
2. 说明将采用的空间范围、边界模式、资源/时间模块、目标和关键假设。
3. 生成任务包并在求解前链接任务程序和模型说明：

```powershell
& '<bundled-python>' '<skill-root>\scripts\task_pipeline.py' prepare '<case-or-scenario>' --request '<用户原话>' --output '<task-directory>'
```

快照可追加 `--sidecar`、`--profiles`；复杂模块组合应先生成 schema-v2 scenario，再把该 scenario 交给任务流水线。

4. 简要展示 `generated_dispatch.py` 的输入、执行命令和模型路由，然后使用非缓冲模式执行，使阶段状态和求解器输出在界面可见：

```powershell
& '<bundled-python>' -u '<task-directory>\generated_dispatch.py'
```

5. 求解后继续执行工程校核；不得因为程序返回码为零就省略残差、电压、容量、边界和时序状态检查。

通用求解器是可信内核，任务程序是 AI 针对本次输入生成的透明入口。不要为满足“生成程序”而复制整个数值后端。

## 验证结果

除求解器成功外，必须检查：

- 最终可行性、节点有功/无功平衡、电压、两端支路容量和网损；
- 每个资源的 P/Q 边界、视在功率/能力曲线、固定或最小功率因数约束；
- 每条资源耦合等式/不等式的实际残差，尤其是换流器端口功率和损耗；
- 内部联络线方向、边界交换符号和每条切割支路的等值方式；
- 爬坡、SOC、效率、终端 SOC、柔性负荷总电量和父子计划偏差；
- 无额定容量支路、未分区节点、电气孤岛和所有披露的假设。

不得把失败点或未校核点称为最优，不得静默放松约束。诊断性放松必须另建命名研究。

## 交付

先给出场景级成功状态和工程结论。任务包模式必须链接 `generated_dispatch.py`、`normalized_input.json`、`model_document.md`、`solve.log`、`task_manifest.json`、`delivery_report.md` 和 `results/` 中的关键报告/CSV；直接求解模式则链接原有 portfolio/summary/results 文件。明确列出范围、边界、资源类型、时间尺度、假设和不支持项。

当前需专用扩展的内容包括：完整 AC/DC 耦合潮流/OPF、不平衡三相、离散开关/档位和机组组合、N-1/安全约束、动态安全，以及同时全尺度随机/鲁棒全局优化。
