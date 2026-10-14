# Paper Classification Protocol

Assign one primary category before running specialized reproduction.

## Data science (`data_science`)

Typical core contribution: learning/prediction/classification/clustering/anomaly detection/probabilistic forecasting/representation learning/graph learning/data-driven control policy evaluation where predictive/generalization performance is central.

Examples: renewable/load forecasting, fault diagnosis, event classification, data-driven state estimation, probabilistic prediction, ML-based anomaly detection, model-free RL when the primary claim is learned performance/generalization.

## Optimization planning and operation (`optimization_planning_operation`)

Typical core contribution: optimization formulation and decision making over planning/dispatch/market/operation variables.

Examples: unit commitment, economic dispatch, integrated energy optimization, network planning, robust/stochastic/distributionally robust optimization, bilevel optimization, market clearing, multi-objective scheduling, resilience planning.

## System stability analysis and control (`system_stability_control`)

Typical core contribution: dynamic system behavior, stability mechanism, feedback/controller design, dynamic response, eigenvalue/impedance analysis.

Examples: small-signal/transient/frequency/voltage stability, grid-forming control, VSG, microgrid secondary control, impedance stability, MPC/control design, converter dynamics.

## Mixed papers

Choose the category that determines whether the paper's central conclusion succeeds. Add a secondary category only when the second domain contributes material review requirements.

Examples:

- RL Volt/Var controller whose central claim is safe learned-policy robustness: primary `data_science`, secondary `system_stability_control`.
- Robust microgrid formation formulation using weather data: primary `optimization_planning_operation`, secondary `data_science` only if the data model is itself a contribution.
- Data-driven stabilizing controller with formal Lyapunov proof: primary depends on whether the novelty is the learned model or the control theorem; use the other as secondary.
