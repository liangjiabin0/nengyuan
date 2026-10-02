# Modular spatial and multi-timescale scenarios

Use this reference whenever a request combines subsystem scopes, boundary modes, resources, objectives, or time scales. The schema-v2 orchestrator composes validated modules; it does not accept arbitrary unknown module names.

## Scope presets

| Preset | Selected sidecar `level` values | Typical use |
|---|---|---|
| `tdm` | transmission + distribution + microgrid | Full main-distribution-microgrid coordination |
| `td` | transmission + distribution | Main-distribution coordination with microgrid removed or equivalenced |
| `dm` | distribution + microgrid | Distribution-microgrid coordination with main grid equivalenced |
| `t` | transmission | Main grid alone |
| `d` | distribution | Distribution grid alone |
| `m` | microgrid | Microgrid alone |
| `all` | every configured area | Entire supplied case regardless of level names |

Use `scope.areas` for exact area names or `scope.levels` for a custom union. A study may override `system.case` and `system.sidecar`, so a portfolio can combine separate transmission, distribution, and microgrid case files as independent studies.

When a selected scope cuts energized branches, choose a boundary mode:

- `equivalent-grid`: add a dispatchable boundary P/Q resource at every inside endpoint. Positive P/Q means import into the selected scope; negative means export.
- `fixed-exchange`: require `p_mw` and `q_mvar` for every cut branch in `scope.boundary.branches`.
- `islanded` or `none`: remove the external grid. Every resulting electrical island must contain an online internal generator. Use `islanded` to make intent explicit.

Never leave an unconstrained `RATE_A=0` cut branch implicit. Supply a `limit_mva` branch override or `default_limit_mva`. Set `p_import_max_mw`, `p_export_max_mw`, `q_import_max_mvar`, and `q_export_max_mvar` when active/reactive limits differ from MVA ratings.

## Module catalog and compatibility

| Module | Function | Requirement or incompatibility |
|---|---|---|
| `ac-opf` | Full active/reactive AC-OPF | Default; mutually exclusive with `dc-opf-diagnostic` |
| `dc-opf-diagnostic` | Active-only diagnostic | Do not present as P/Q coordination; incompatible with `storage-soc` here |
| `area-exchange` | Internal cross-area P/Q aggregation | Added by default |
| `boundary-equivalent` | Label boundary-equivalent studies | Actual behavior comes from `scope.boundary` |
| `loss-penalty` | Penalize total P generation, equivalent to loss penalty up to fixed load | Set nonnegative `price_per_mwh` |
| `warm-start` | Start from previous/parent solution | Useful for ordered profiles |
| `ramp-link` | Enforce sequential P ramp envelopes | Supply generator/resource ramp rates and at least two periods |
| `storage-soc` | Carry storage SOC and energy-feasible P limits | Supply storage data and at least two periods |
| `flexible-load-energy` | Carry remaining consumption/production energy for shiftable loads | Supply `energy_budget` data and at least two periods |
| `parent-tracking` | Penalize child schedule deviation from parent P plan | Supply an earlier `parent` scale and positive `weight_per_mw2`; tracked costs must be polynomial |
| `resource-coupling` | Enforce explicit linear P/Q equalities or inequalities among resource terminals | Supply `resource_couplings`; required for SOP/HVDC AC-side terminal loss balance |

Combine modules by listing them at study level, time-scale level, or both. Time-scale modules extend study modules. Unknown and incompatible combinations fail validation before solving.

## Scenario schema

Paths are relative to the scenario JSON unless absolute.

```json
{
  "schema_version": 2,
  "system": {
    "case": "case14.m",
    "sidecar": "case14.tdmg.json"
  },
  "output": "results",
  "studies": [
    {
      "name": "tdm-multiscale",
      "scope": "tdm",
      "modules": [
        "ac-opf",
        "area-exchange",
        "warm-start",
        "ramp-link",
        "storage-soc",
        "loss-penalty"
      ],
      "module_config": {
        "loss-penalty": {"price_per_mwh": 2.0}
      },
      "generator_dynamics": [
        {"generator": "gen-1", "up_mw_per_hour": 80, "down_mw_per_hour": 80}
      ],
      "time_scales": [
        {
          "name": "day-ahead",
          "step_minutes": 60,
          "profiles": "day-ahead.json"
        },
        {
          "name": "intraday",
          "parent": "day-ahead",
          "step_minutes": 15,
          "modules": ["parent-tracking"],
          "module_config": {
            "parent-tracking": {"weight_per_mw2": 0.2}
          },
          "profiles": "intraday.json"
        },
        {
          "name": "real-time",
          "parent": "intraday",
          "step_minutes": 5,
          "modules": ["parent-tracking"],
          "module_config": {
            "parent-tracking": {
              "weight_per_mw2": 1.0,
              "generators": ["gen-1", "mg-storage"]
            }
          },
          "profiles": "real-time.json"
        }
      ]
    },
    {
      "name": "distribution-only",
      "scope": {
        "preset": "d",
        "boundary": {
          "mode": "equivalent-grid",
          "default_limit_mva": 100,
          "p_import_max_mw": 100,
          "p_export_max_mw": 40,
          "q_import_max_mvar": 60,
          "q_export_max_mvar": 60,
          "energy_price_per_mwh": 50
        }
      },
      "modules": ["ac-opf", "boundary-equivalent"],
      "time_scales": [{"name": "base", "step_minutes": 60}]
    },
    {
      "name": "microgrid-islanded",
      "scope": {"preset": "m", "boundary": {"mode": "islanded"}},
      "modules": ["ac-opf", "storage-soc", "ramp-link"],
      "time_scales": [
        {"name": "operation", "step_minutes": 15, "profiles": "microgrid.json"}
      ]
    }
  ]
}
```

Use `study.system` to override the root system for a study:

```json
{
  "name": "ieee33-distribution",
  "system": {"case": "case33.m", "sidecar": "case33.tdmg.json"},
  "scope": "all",
  "modules": ["ac-opf"],
  "time_scales": [{"name": "base", "step_minutes": 60}]
}
```

## Time-scale profiles

Use the profile period fields from [input-schema.md](input-schema.md): `load_scale`, resource availability/Q/status/bounds overrides, `branch_limits`, and `generator_bounds`. Profiles may be an inline object/list or a JSON path.

For a child scale, map each period to its parent with `parent_period`. If omitted, map periods proportionally in list order. Explicit mapping is preferable for research work.

The hierarchy is causal:

1. Solve the parent scale.
2. Interpolate or explicitly map its generator P plan to child periods.
3. Add the quadratic tracking penalty.
4. Apply previous-period ramp and storage-energy bounds.
5. Apply flexible-load remaining-energy bounds and all automatic/explicit resource P-Q couplings.
6. Warm-start and solve the child AC-OPF.

This implements hierarchical rolling coordination. It does not solve all scales, scenarios, and integer decisions in one global stochastic program.

## Storage and ramp fields

Attach storage and ramp data to a sidecar resource:

```json
{
  "name": "mg-storage",
  "kind": "storage",
  "bus": 13,
  "p_min_mw": -8,
  "p_max_mw": 8,
  "q_min_mvar": -4,
  "q_max_mvar": 4,
  "cost": {"model": "polynomial", "coefficients": [0.01, 0, 0]},
  "ramp": {"up_mw_per_hour": 16, "down_mw_per_hour": 16},
  "storage": {
    "energy_capacity_mwh": 20,
    "initial_soc": 0.6,
    "soc_min": 0.2,
    "soc_max": 0.9,
    "charge_efficiency": 0.95,
    "discharge_efficiency": 0.95,
    "enforce_terminal_soc": false,
    "terminal_soc_target": 0.6
  }
}
```

Use generator names such as `gen-1` in `generator_dynamics`. Positive storage P is discharge/injection; negative P is charging/consumption. `enforce_terminal_soc=true` fixes final-period P to reach the target and may reveal infeasibility; it is not a substitute for global horizon optimization.

## Commands and outputs

```powershell
& '<python>' '<skill-root>\scripts\modular_dispatch.py' catalog
& '<python>' '<skill-root>\scripts\modular_dispatch.py' template '<case>' --sidecar '<sidecar>' --output '<scenario.json>'
& '<python>' '<skill-root>\scripts\modular_dispatch.py' validate '<scenario.json>'
& '<python>' '<skill-root>\scripts\modular_dispatch.py' run '<scenario.json>' --output '<output-directory>'
```

The root output contains `portfolio_report.md`, `portfolio_summary.json`, and `scenario_used.json`. Every `<study>/<time-scale>/` folder contains `report.md`, `summary.json`, `results.json`, standard dispatch/bus/branch/area CSV files, plus:

- `boundary_exchange.csv`: import/export through cut-network equivalent resources.
- `states.csv`: storage energy and SOC before/after every period.
- `energy_budget.csv`: flexible-load/production energy used and remaining by period.
- `static_resources.csv`: fixed P/Q loads and fixed GS/BS devices incorporated into bus data.
- `resource_couplings.csv`: period-by-period residual audit for automatic P-Q capability and explicit terminal couplings.

`resource_couplings` and `converter-ac-equivalent` model only the AC terminals of an SOP/HVDC device. They do not introduce DC buses, DC voltages, or DC-line equations; see [resource-catalog.md](resource-catalog.md).
