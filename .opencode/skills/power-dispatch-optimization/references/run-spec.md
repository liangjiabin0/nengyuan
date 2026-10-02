# RunSpec Contract

RunSpec 是 Web、Agent、Skill、求解器之间的唯一任务契约。

## 必需字段

- `version`
- `task.mode`
- `case`
- `capabilities`
- `objective`
- `constraints`
- `solver`
- `outputs`

## 关键语义

### task.mode

`single_period_operation | time_series_dispatch | hierarchical_coordination | multi_timescale_coordination | composed_task | review_only`

### capabilities.hierarchy

`single_grid | transmission | distribution | microgrid | transmission_distribution | distribution_microgrid | main_distribution_microgrid`

### capabilities.power_control

`P | Q | PQ`

### capabilities.time_scales

可包含 `single_period | day_ahead | intra_day | real_time`。

### solver.backend

- `pandapower_acopf`
- `pandapower_dcopf`
- `reference_dry_run`
- `custom_pyomo`
- 用户注册的研究 backend 名称

完整校验规则见 `schemas/run-spec.schema.json`。
