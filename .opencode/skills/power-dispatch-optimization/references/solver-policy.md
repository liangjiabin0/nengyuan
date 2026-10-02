# Solver Policy

## backend 优先级

1. 用户显式指定的已注册 backend。
2. 静态 AC OPF -> `pandapower_acopf`。
3. 静态 DC OPF -> `pandapower_dcopf`。
4. 研究级时序/层级问题 -> 项目自定义 backend。
5. 仅联调 -> `reference_dry_run`。

## Solver metadata

必须返回：
- backend 名称/版本；
- solver 名称；
- termination condition；
- solve time；
- objective；
- errors/warnings；
- model fidelity。

## Pyomo

Pyomo 只是建模层，具体 solver 由 `SolverFactory`/Adapter 选择。不要假设用户一定安装了 Gurobi/CPLEX/IPOPT。
