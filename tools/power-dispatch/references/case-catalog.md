# Case Catalog

## 内置 case_id

| case_id | 类型 | 典型用途 | reference backend loader |
|---|---|---|---|
| ieee14 | IEEE 14-bus | AC/DC PF/OPF、接口联调 | `pandapower.networks.case14()` |
| ieee30 | 30-bus test case | OPF、规模扩展 | `pandapower.networks.case30()` |
| ieee57 | IEEE 57-bus | 中等规模 PF/OPF | `pandapower.networks.case57()` |
| ieee118 | IEEE 118-bus | 较大规模 PF/OPF | `pandapower.networks.case118()` |
| case33bw | 33-bus radial distribution | 配电网电压/网损/DER | `pandapower.networks.case33bw()` |
| main_dist_micro_demo | 组合模板 | 主配微工作流 | IEEE14 + case33bw + microgrid templates |

## 组合算例规则

`main_dist_micro_demo` 不应描述为 IEEE 官方标准算例。它只是利用标准网络作为上、下层基座，并通过 PCC 和微网资源模板进行组合。

组合前必须统一：
- base MVA；
- 电压等级与变压器映射；
- bus / element ID；
- PCC 上下级方向约定；
- P/Q 正负号；
- 时间索引。

## 自定义工程数据

后续可新增 `source.type = csv|excel|database|cim|custom_adapter`。真实工程数据不得由 LLM 自动补齐缺失参数。
