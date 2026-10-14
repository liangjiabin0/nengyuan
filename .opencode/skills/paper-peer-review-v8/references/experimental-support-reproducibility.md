# Experimental Support and Reproducibility Audit

## Central-claim inventory

Extract only claims needed for the paper's contribution: superiority, effectiveness, robustness, generalization, safety, stability, efficiency, scalability, practical applicability, causal/module attribution.

For each claim check:

- experiment/analysis is capable of testing the claim;
- controls/baselines are appropriate;
- data splits are independent and leakage-free;
- metrics measure the claimed property;
- stochastic variation/repeated runs are handled;
- ablation exists for component-attribution claims;
- robustness/sensitivity exists for robustness claims;
- external validation exists for broad generalization claims;
- computational claims use comparable hardware/tolerance/budgets;
- figures/tables agree with text.

Status:

- `supported`
- `partially_supported`
- `unsupported`
- `not_assessable`

## Reproduction readiness

Assess whether a competent independent researcher can rebuild the main workflow without consequential guesswork.

Levels:

- `ready`
- `minor_gaps`
- `major_gaps`
- `not_assessable`
- `not_applicable`

Verification scope:

- `reporting_only`
- `artifacts_inspected`
- `partial_execution`
- `end_to_end_execution`

Never say a result was reproduced unless execution actually occurred.

## Evidence and scope checks

Apply M02, M08, M11 and M15–M16 in [power-system-review-memory.md](power-system-review-memory.md) where relevant. Interpret a numerical claim with the exact table/figure/metric and its difference; consider sampling variation, solver gaps and physical approximation before declaring a small advantage. Preserve existing ablations and pressure tests. State what a reviewer experiment retains and omits, and separate local mechanism findings from whole-model conclusions.
