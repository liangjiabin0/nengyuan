# Main-Distribution-Microgrid Coordination

## 分层对象

- Main / upper grid：提供系统级边界、上级电源、价格或安全边界。
- Distribution：协调馈线、DER、OLTC、无功装置与微网 PCC。
- Microgrid：协调 PV/WT、储能、可控负荷、微型机组等。

## BoundaryPort

每个 PCC 至少包含：

```json
{
  "pcc_id": "PCC_D1_MG1",
  "upper_region": "distribution_1",
  "lower_region": "microgrid_1",
  "upper_bus": 18,
  "lower_bus": 0,
  "variables": ["P_MW", "Q_Mvar", "V_pu"],
  "sign_convention": "positive_from_upper_to_lower"
}
```

## 联合/分布式 backend

Backend 可以是：
- centralized integrated model;
- alternating coordination;
- ADMM / decomposition;
- C&CG / DRO;
- MPC rolling optimizer;
- MARL policy + safety projection。

但都必须接受相同 RunSpec 并输出相同 ResultBundle。
