# Objective Modules

每个目标项都必须包含 `enabled` 和 `weight`，推荐同时记录 normalization。

- `operating_cost`: 发电/购电/启停/储能等成本。
- `network_loss`: 有功网损。
- `voltage_deviation`: 节点电压偏差。
- `renewable_curtailment`: 弃风弃光。
- `boundary_tracking`: PCC 计划跟踪偏差。
- `load_shedding`: 失负荷惩罚。
- `storage_degradation`: 储能循环/吞吐惩罚。

多目标值必须保留分项，不允许只返回 total objective。
