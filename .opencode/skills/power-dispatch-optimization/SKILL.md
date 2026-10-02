---
name: power-dispatch-optimization
description: Build, validate, execute, and review configurable power-system dispatch optimization tasks. Use for standard IEEE/MATPOWER test cases, operating optimization, transmission-distribution-microgrid coordination, multi-timescale day-ahead/intra-day workflows, active/reactive power coordination, resource scheduling, scenario comparison, and Web-Agent orchestration. Convert user intent into a validated RunSpec before numerical execution. Never invent grid parameters or optimization results.
---

# Power Dispatch Optimization

## 1. Overview

This skill is the orchestration contract for power-system dispatch optimization. It separates four concerns:

1. **Intent/plan**: natural-language request -> `RunSpec`.
2. **Model assembly**: case + time series + resources + objective + constraints.
3. **Numerical execution**: power-flow / OPF / custom optimization backend.
4. **Validation/reporting**: solver status + AC feasibility + KPI + reproducible artifacts.

The LLM plans and explains. The numerical backend computes. Never fabricate numerical results.

## 2. Determine task mode

Choose exactly one primary mode before execution:

- `single_period_operation`: one operating point, baseline PF, AC/DC OPF, voltage/reactive-power optimization.
- `time_series_dispatch`: multi-period scheduling with profiles, storage, renewable generation, flexible load.
- `hierarchical_coordination`: transmission-distribution, distribution-microgrid, or transmission-distribution-microgrid coordination.
- `multi_timescale_coordination`: day-ahead plan plus intra-day/real-time rolling correction with state inheritance.
- `composed_task`: free composition across hierarchy x timescale x P/Q x resource x objective.
- `review_only`: validate a RunSpec, model contract, result bundle, or implementation without executing optimization.

## 3. Required workflow

### Step A — Read references

Always read:
- `references/domain-scope.md`
- `references/run-spec.md`
- `references/capability-matrix.md`
- `references/validation-checklist.md`

Read additional references only when relevant:
- IEEE/test cases -> `references/case-catalog.md`
- P/Q -> `references/pq-coordination.md`
- multi-timescale -> `references/multi-timescale.md`
- main-distribution-microgrid -> `references/main-distribution-microgrid.md`
- solver selection -> `references/solver-policy.md`
- objectives/constraints -> corresponding modules.

### Step B — Produce RunSpec first

Before any numeric call, produce a `RunSpec` conforming to `schemas/run-spec.schema.json`.

Do not silently guess real-grid parameters. If no engineering data is provided:
- use an explicit built-in test case/template; or
- mark the missing field and stop numeric execution if no safe default exists.

### Step C — Compatibility validation

Validate the composition before building the model.

Examples:
- `PQ` coordination requires a backend with AC/PQ capability.
- intertemporal storage requires `time_series_dispatch` or multi-timescale backend support.
- main-distribution-microgrid requires explicit PCC mapping.
- approximate/relaxed models must declare `model_fidelity` and `relaxations_used`.

### Step D — Numerical execution

Use the executor tools/scripts. Preferred order:

1. load/normalize case;
2. build scenario and time series;
3. run baseline power flow when applicable;
4. assemble objective and constraints;
5. solve through a registered backend;
6. run post-solution AC validation when the formulation is approximate or network-constrained;
7. package the result as `ResultBundle`.

### Step E — Multi-timescale state inheritance

When day-ahead/intra-day/real-time layers are combined, explicitly carry forward:
- storage SOC;
- committed/previous generator output when relevant;
- executed control actions;
- PCC target/actual P-Q values;
- previous rolling-window terminal state.

### Step F — Result integrity

A result is successful only if all applicable checks pass:
- schema valid;
- backend execution completed;
- solver termination is acceptable;
- no unhandled constraint violations;
- AC validation converges where required.

Never transform a failed solve into a successful narrative.

## 4. Free composition model

Resolve requests as:

`hierarchy × timescale × power_control × resources × objectives × constraints × backend`

Examples:
- `transmission × single_period × PQ × generators × cost × network_limits × pandapower_acopf`
- `distribution × day_ahead × PQ × PV+storage × voltage+curtailment × SOC+V_limits × custom_pyomo`
- `main_distribution_microgrid × day_ahead+intra_day × PQ × PV+storage+OLTC × cost+voltage+tracking × PCC+SOC+network × research_backend`

## 5. Standard cases

Use `case_id` from the case registry. Initial catalog:
- `ieee14`
- `ieee30`
- `ieee57`
- `ieee118`
- `case33bw`
- `main_dist_micro_demo` (composite template, not an IEEE standard case)

Do not call a composite main-distribution-microgrid network an “IEEE standard main-distribution-microgrid case”. Record its component sources separately.

## 6. Reference executor versus research backends

The package includes a **reference executor** for integration and reproducibility:
- case registry and loading;
- schema validation;
- baseline power flow;
- static AC/DC OPF through pandapower when installed;
- time-series orchestration hooks;
- Web API example;
- deterministic dry-run for frontend/backend integration.

Advanced research algorithms (distributed coordination, C&CG, DRO, MPC, MARL, custom P/Q coordination) must implement `OptimizationBackend` in `src/power_dispatch_skill/backends/base.py` and register with `BackendRegistry`.

## 7. Review guidance

Prioritize:
- wrong physical units/base values;
- missing PCC mapping;
- inconsistent hierarchy or time resolution;
- hidden objective scaling/weights;
- storage SOC discontinuity;
- solver success asserted without termination evidence;
- approximate model reported without AC re-validation;
- generated/guessed engineering data presented as real data;
- numerical results generated by the LLM instead of a solver.

## 8. Commands

Validate only:

```bash
python scripts/validate_spec.py examples/inputs/ieee14_acopf.yaml
```

Dry-run (no pandapower/solver required):

```bash
python scripts/run_task.py examples/inputs/ieee14_acopf.yaml --dry-run
```

Execute (full dependencies required):

```bash
python scripts/run_task.py examples/inputs/ieee14_acopf.yaml --output runs/ieee14
```

Web demo:

```bash
uvicorn web.fastapi_app:app --host 0.0.0.0 --port 8000
```

## 9. References

See `references/` and `docs/WEB_AGENT_INTEGRATION.md`.
