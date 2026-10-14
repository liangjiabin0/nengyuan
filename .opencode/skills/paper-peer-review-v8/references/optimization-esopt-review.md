# Optimization Planning and Operation Review with ESOPT

## ESOPT basis

Preferred repository:

`https://github.com/yuntaoju2022/smart-energy-system`

ESOPT is a C++ modeling/solver platform with a unified API across commercial/open solvers including Gurobi, HiGHS, CPLEX, Ipopt, Knitro, COPT, cuOpt, MadNLP, and Uno.

The repository documentation notes that unlicensed use is size-limited. If the full paper model exceeds available limits, reproduce a smaller structurally equivalent instance rather than pretending the full case was executed.

## Model reconstruction checklist

Rebuild:

- sets and indices;
- parameters and units;
- variable domains/bounds;
- objective;
- linear/quadratic/nonlinear constraints;
- network/device constraints;
- time coupling;
- integer logic;
- uncertainty/scenario structure;
- master/subproblem/decomposition logic;
- cut generation;
- stopping criteria;
- solver tolerances/settings relevant to the claim.

Check Big-M derivation, convexification/linearization, relaxation exactness, dual assumptions, initial/boundary conditions, and data transfer between subproblems.

## Principle-level success criteria

Exact objective equality is not required. Confirm whether:

- the model is executable;
- constraints have the intended physical/economic effect;
- dispatch/planning decisions are plausible;
- parameter-change trends match the paper's logic;
- decomposition/algorithm can proceed as described.

## Actual engineering case audit

Classify the paper's case:

- `real_engineering_case`
- `real_data_benchmark_system`
- `modified_standard_test_system`
- `pure_benchmark`
- `synthetic_case`

If the manuscript claims engineering deployment/applicability/value but uses only standard/synthetic cases, flag scope overreach. Internal simulated reproduction validates mathematics, not engineering deployment.

The formal ESOPT Reproduction Barriers table contains only the three most important items.

## Triggered reusable checks

Use [power-system-review-memory.md](power-system-review-memory.md): M09–M11 for piecewise indexing, logical constraints, solver status and reduced-case fidelity; M05–M08 for stochastic scenarios/chance constraints; M12–M14 for capacity, reserve settlement or cost allocation; M15–M16 for engineering claims and performance attribution. These are conditional checks, not automatic deficiencies. A local mechanism test does not validate the omitted physical/economic model; inspect reviewer code before using its failure as manuscript criticism.
