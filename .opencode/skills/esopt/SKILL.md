---
name: esopt
description: >-
  Model and solve optimization with ESOPT/HiGHS via MCP: DCOPF, LP, MIP.
  Trigger on ESOPT, DCOPF, 最优潮流, 线性规划, 建模求解, HiGHS.
---

# ESOPT

本 skill 是 ESOPT MCP 的唯一入口。父 Agent 加载本 skill 后，不得直接调用 `esopt_*`，而要调用 `task`，指定 `subagent_type=esopt-mcp`；子任务提示必须包含用户原问题、输入文件相对路径和期望输出。未加载本 skill 时禁止派发 `esopt-mcp`。

`esopt-mcp` 子 Agent 先调用 MCP `esopt_help` topic=`workflow`，再按下列路径完成求解，并把最优状态、目标值、关键校验和错误以中文返回父 Agent。

| 意图 | 路径 |
|---|---|
| 电网 / DCOPF / case24 | `esopt_inspect_case` → `esopt_solve_dcopf` |
| 已有 `.mps` / `.lp` | `esopt_model_solve_file`，禁止抄成 variables JSON |
| 其他决策 | 自建线性/MIP，一次调用 `esopt_model_solve_json` |
| 二次 / sin/cos / 交流潮流 | 停止，不要硬算 |

禁止增量会话：不要 `esopt_model_create`。把完整模型写成 JSON 后一次性求解。

线性规则：只有 `+` `-` 和 `<= >= ==`。分数辆/台数用 `integer` 或 `binary`。

`termination_status` 必须为 `7` 才是最优。DCOPF 后检查发电 ≈ 负荷。

参考：case24 目标约 `58448.6`，负荷 `28.5`。
