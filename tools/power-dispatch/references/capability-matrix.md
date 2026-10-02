# Capability Matrix

| 能力 | 参考执行器 | 研究 backend |
|---|---:|---:|
| IEEE case 加载 | ✅ | 可复用 |
| Baseline AC PF | ✅ pandapower | 可复用 |
| 单时刻 AC OPF | ✅ pandapower | 可替换 |
| 单时刻 DC OPF | ✅ pandapower | 可替换 |
| 24h profile orchestration | ✅ 流程/数据层 | ✅ |
| 储能跨时段联合优化 | 接口保留 | ✅ custom backend |
| P/Q 联合网络约束 | ✅ 静态 AC OPF | ✅ 多时段/层级 |
| 主配微 PCC 数据结构 | ✅ | ✅ |
| 主配微联合求解 | reference workflow | ✅ custom backend |
| 日前+日内滚动 | ✅ 状态机/接口 | ✅ custom backend |
| C&CG / DRO / MPC / MARL | ❌ 不伪造 | ✅ 插件 |

“reference workflow”表示数据、状态、接口和执行 DAG 已实现/定义，但不宣称等价于论文级耦合优化算法。
