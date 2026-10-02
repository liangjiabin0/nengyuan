# Input schema

Use this reference when creating or reviewing sidecar and profile JSON files. Bus, generator, and branch indices in sidecars are human-facing and therefore 1-based unless a field explicitly says it is a MATPOWER bus number.

For composable main/distribution/microgrid scopes and hierarchical day-ahead/intraday/real-time studies, also read [modular-scenarios.md](modular-scenarios.md).

For canonical resource types, aliases, natural device fields, P-Q capability, storage/flexible-load states, and converter-terminal coupling, read [resource-catalog.md](resource-catalog.md).

## Case files

Accept these formats:

- MATPOWER `.m` case with `baseMVA`, `bus`, `gen`, `branch`, and `gencost`.
- PYPOWER `.py` or MATPOWER `.mat` accepted by PYPOWER `loadcase`.
- JSON object with `version`, `baseMVA`, `bus`, `gen`, `branch`, and `gencost`. An outer `mpc` object is allowed.

Keep the standard MATPOWER v2 column conventions. `RATE_A=0` means an unconstrained branch rating. Cost rows may be polynomial model 2 or piecewise-linear model 1.

This backend reads standard AC case matrices only. It rejects native `dcline` and full DC-network fields such as `dc_buses`, `dc_branches`, `busdc`, `branchdc`, and `convdc`; see the AC/DC distinction in [resource-catalog.md](resource-catalog.md).

## Sidecar JSON

All fields are optional except the contents of each supplied object.

```json
{
  "schema_version": 1,
  "areas": [
    {"name": "main-grid", "level": "transmission", "buses": [1, 2, 3, 4, 5]},
    {"name": "distribution", "level": "distribution", "buses": [6, 7, 8, 9, 10]},
    {"name": "microgrid", "level": "microgrid", "buses": [11, 12, 13, 14]}
  ],
  "ties": [
    {
      "name": "main-to-distribution",
      "from_area": "main-grid",
      "to_area": "distribution",
      "branch_indices": [7]
    }
  ],
  "resources": [
    {
      "name": "mg-pv",
      "type": "renewable-generator",
      "bus": 14,
      "p_min_mw": 0,
      "p_max_mw": 20,
      "q_min_mvar": -8,
      "q_max_mvar": 8,
      "p_initial_mw": 10,
      "q_initial_mvar": 0,
      "voltage_setpoint_pu": 1.0,
      "status": 1,
      "cost": {"model": "polynomial", "coefficients": [0.002, 2.0, 0.0]}
    }
  ],
  "overrides": {
    "load_scale": {"default": 1.0, "distribution": 1.08, "microgrid": 0.95},
    "branch_limits": [
      {"index": 7, "rate_mva": 60},
      {"from_bus": 4, "to_bus": 7, "rate_mva": 60}
    ],
    "generator_bounds": [
      {"index": 1, "p_min_mw": 10, "p_max_mw": 250, "q_min_mvar": -50, "q_max_mvar": 150}
    ]
  },
  "solver": {
    "opf_algorithm": 560,
    "violation_tolerance": 0.000005,
    "max_iterations": 150,
    "verbose": 0
  }
}
```

Rules:

- Assign a bus to at most one area. Omitted buses become `unassigned`.
- `ties` define reporting orientation. If `branch_indices` is omitted, use every branch crossing the named area pair.
- Normalize each `resources` entry through the canonical resource registry. Dynamic devices become signed P/Q injections; fixed loads and fixed shunts modify bus data. Negative P permits charging or controllable consumption but does not add a temporal equation by itself.
- An unknown resource type is accepted through `generic-pq` only when all four explicit P/Q bounds are supplied. Its original type is retained in output.
- `s_rated_mva`, fixed/minimum power factor, and two-point P-Q capability data produce auditable linear constraints. Explicit `resource_couplings` can link P/Q among multiple terminals.
- Express polynomial `coefficients` from highest order to constant, evaluated on MW.
- For piecewise-linear costs, use `{"model":"piecewise_linear","points":[[0,0],[20,40]]}` with strictly increasing MW values.
- Impose a tie capacity through branch `RATE_A` or `overrides.branch_limits`; the `ties` section itself only labels and aggregates flows.
- `load_scale` may be a scalar or an object keyed by bus number, area, `default`, or `all`. Bus-specific values take precedence over area values.
- A branch override may select one 1-based row `index` or every matching unordered `from_bus`/`to_bus` pair.
- A resource may add `ramp` and `storage` objects for the schema-v2 modular orchestrator. Direct `tdmg_opf.py solve` ignores those temporal fields and remains a snapshot solver.

## Profiles JSON

Profiles are independent AC-OPF snapshots. Base sidecar overrides apply first, then period scaling applies multiplicatively for loads.

```json
{
  "periods": [
    {
      "name": "08:00",
      "load_scale": {"default": 0.85, "microgrid": 0.75},
      "resource_pmax_scale": {"mg-pv": 0.30}
    },
    {
      "name": "12:00",
      "load_scale": 1.0,
      "resource_pmax_scale": {"mg-pv": 1.0},
      "branch_limits": [{"index": 7, "rate_mva": 50}]
    }
  ]
}
```

Each period supports `load_scale`, `resource_pmax_scale`, `resource_availability`, `resource_q_scale`, `resource_status`, `resource_bounds`, `branch_limits`, and `generator_bounds`. This is snapshot scheduling unless temporal modules are enabled; it is never a mixed-integer unit-commitment model.

`resource_availability` scales signed P limits, `resource_q_scale` scales Q limits, `resource_status` switches named resources on/off, and `resource_bounds` replaces named P/Q limits for that period.

When used by `modular_dispatch.py`, the same period fields participate in sequential ramp/SOC linkage and parent-stage tracking if those modules are enabled.

## Outputs

The solver writes:

- `report.md`: concise Chinese audit report.
- `summary.json`: KPIs, solver quality, area totals, and tie exchanges.
- `results.json`: full solved MATPOWER matrices for reproducibility.
- `dispatch.csv`: generator and DER P/Q schedules and bounds.
- `buses.csv`: voltage, load, and nodal active/reactive prices.
- `branches.csv`: terminal flows, losses, ratings, and loading.
- `area_exchange.csv`: oriented transmission/distribution/microgrid exchanges.
- `static_resources.csv`: fixed load/shunt resources applied to bus matrices.
- `resource_couplings.csv`: evaluated P/Q coupling left-hand side, bounds, residual, violation, tolerance, and pass/fail status.

The modular orchestrator additionally writes `boundary_exchange.csv`, `states.csv` for storage, and `energy_budget.csv` for flexible-load energy requirements.
