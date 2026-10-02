# 示例说明

## 标准网络样例

- `ieee14_acopf.yaml`：推荐作为首个真实数值联调案例。
- `ieee30_dcopf.yaml`：用于演示 DC OPF 与“近似模型必须校核”的规则。
- `ieee57_baseline.yaml`：中等规模 dry-run。
- `ieee118_baseline.yaml`：较大规模 dry-run。

## 配电与主配微样例

- `case33bw_pq_24h.yaml`：24 h P/Q + PV + 储能的研究 backend 输入协议。
- `main_dist_micro_multiscale.yaml`：IEEE14 + case33bw + 2 个微网模板，日前/日内 P/Q 协同。
- `free_composition_template.yaml`：Web 多选配置的通用组合模板。

`main_dist_micro_demo` 是组合模板，不是官方 IEEE 主配微标准算例。
