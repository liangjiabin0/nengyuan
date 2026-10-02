# Experimental Support and Reproducibility Audit

## A. Experimental support for conclusions

The central question is not whether experiments exist, but whether the reported evidence is capable of supporting the stated conclusion at the claimed scope.

For each central claim, record:

- exact claim and manuscript location;
- intended supporting experiment/table/figure/analysis;
- comparator/control relevance and fairness;
- sample size, repeated runs, statistical uncertainty, or deterministic sensitivity evidence as applicable;
- data split independence and leakage risk;
- ablations when gains are attributed to components;
- robustness/sensitivity when robustness is claimed;
- external/scenario validation when generalization is claimed;
- computational conditions when efficiency is claimed;
- whether the reported evidence supports the whole claim or only a narrower statement.

Assign:

- `supported`
- `partially_supported`
- `unsupported`
- `not_assessable`

A narrow claim supported by strong evidence is preferable to an ambitious claim supported only indirectly.

### Engineering / optimization / control emphasis

Also inspect:

- standard test systems versus claimed field generality;
- feasibility and constraint satisfaction, not only objective improvement;
- dynamic limits, current/voltage/frequency limits, saturation, delays, uncertainty, and failure conditions when relevant;
- identical solver tolerances, time limits, hardware, and tuning budgets for computational claims;
- multiple operating points and stress conditions when a method is claimed to be robust or deployable.

## B. Reproducibility

Distinguish **reproduction readiness** from **successful reproduction**.

### Minimum inventory

Check relevant items:

- data source/version/access;
- train/validation/test or scenario split construction;
- preprocessing/filtering/normalization/feature engineering;
- model/algorithm/mathematical formulation;
- objective, constraints, parameters, initialization;
- hyperparameters and search procedure;
- random seeds and nondeterminism controls;
- solver/optimizer and versions;
- tolerances/stopping criteria;
- metric definitions and aggregation;
- baseline implementation and tuning;
- hardware/runtime environment when material;
- executable code/configs/data preparation instructions/checkpoints where necessary.

Assign `reproduction_readiness`:

- `ready`
- `minor_gaps`
- `major_gaps`
- `not_assessable`
- `not_applicable`

Assign actual `verification_scope`:

- `reporting_only`
- `artifacts_inspected`
- `partial_execution`
- `end_to_end_execution`

Never describe the study as reproduced unless execution actually occurred.
