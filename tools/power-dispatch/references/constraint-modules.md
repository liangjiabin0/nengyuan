# Constraint Modules

推荐约束注册表：

1. `active_power_balance`
2. `reactive_power_balance`
3. `bus_voltage_limits`
4. `branch_thermal_limits`
5. `generator_p_limits`
6. `generator_q_limits`
7. `pq_capability_curve`
8. `storage_soc_balance`
9. `storage_power_limits`
10. `storage_charge_discharge_logic`
11. `ramp_limits`
12. `flexible_load_bounds`
13. `oltc_discrete_steps`
14. `shunt_discrete_steps`
15. `pcc_balance`
16. `boundary_tracking_band`
17. `state_inheritance`

每个自定义 backend 应报告它实际启用的约束集合。
