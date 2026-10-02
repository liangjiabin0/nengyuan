# Active/reactive resource catalog

Use this reference whenever a sidecar introduces generation, demand, storage, reactive support, a power-electronic terminal, or an unfamiliar device type. The adapter uses injection signs: positive P/Q injects into the AC bus; negative P/Q consumes from it. Capacitive fixed shunt `BS` is positive and inductive `BS` is negative.

## Canonical resource families

| Canonical type | Common aliases/examples | Steady-state representation |
|---|---|---|
| `conventional-generator` | thermal, coal, gas, diesel, hydro, nuclear, microturbine, CHP electrical side | Dispatchable P/Q generator |
| `renewable-generator` | PV, solar, wind | Curtailable P/Q generator with inverter capability |
| `inverter-der` | smart inverter, GFL/GFM inverter, IBR, fuel cell | Generic inverter P/Q terminal |
| `storage` | BESS, pumped storage, flywheel, supercapacitor, CAES | Bidirectional P/Q injection; optional sequential SOC |
| `ev-storage` | EV, V2G, charging station, EV aggregator | Bidirectional or charging-only aggregate; optional SOC |
| `flexible-load` | demand response, curtailable/interruptible/shiftable load, electrolyzer, heat pump | Negative P/Q generator; optional energy budget |
| `synchronous-condenser` | syncon | Q-only source/sink with optional active loss |
| `statcom` | SVG, D-STATCOM | Continuous Q-only converter approximation |
| `svc` | static var compensator | Continuous Q source/sink approximation |
| `continuous-capacitor` | continuous capacitor bank | Continuous relaxed capacitive Q |
| `continuous-reactor` | continuous shunt reactor | Continuous relaxed inductive Q |
| `fixed-capacitor` | fixed capacitor bank | Voltage-dependent positive bus `BS` |
| `fixed-reactor` | fixed shunt reactor | Voltage-dependent negative bus `BS` |
| `fixed-shunt` | admittance shunt | Bus `GS/BS` at 1 pu |
| `fixed-load` | PQ/static load | Added to bus `PD/QD` |
| `boundary-grid` | external grid, import/export equivalent | Signed dispatchable boundary P/Q |
| `converter-ac-equivalent` | explicitly labeled HVDC AC terminal, SOP terminal, converter terminal | AC-side P/Q terminal plus linear resource coupling; no DC state |
| `generic-pq` | future device with explicit bounds | Generic dispatchable P/Q terminal |
| `acdc-converter` | HVDC, VSC-HVDC, LCC-HVDC, MTDC | Requires a dedicated AC/DC-network solver and is rejected here |

The catalog is extensible, not a claim that every physical device can be reduced safely to four bounds. An unknown `type` falls back to `generic-pq` only when all four explicit P/Q bounds are present. The output preserves `original_type` so the approximation remains auditable.

## Core dynamic fields

```json
{
  "name": "device-name",
  "type": "canonical-or-alias",
  "bus": 14,
  "p_min_mw": 0,
  "p_max_mw": 20,
  "q_min_mvar": -8,
  "q_max_mvar": 8,
  "p_initial_mw": 10,
  "q_initial_mvar": 0,
  "status": 1,
  "cost": {"model": "polynomial", "coefficients": [0.002, 2.0, 0.0]}
}
```

Natural adapters also accept:

- renewable `available_p_mw` and `curtailment_penalty_per_mwh`;
- storage/EV `charge_max_mw`, `discharge_max_mw`, `storage`, and `ramp`;
- flexible load `baseline_p_mw`, `min_consumption_mw`, `max_consumption_mw`, discomfort/curtailment cost, and `energy_budget`;
- Q-only resources `q_rating_mvar` or explicit Q limits, plus optional `active_loss_mw`;
- fixed load `p_mw`, `q_mvar`; fixed shunt `g_mw_at_1pu`, `b_mvar_at_1pu`.

Control modes are `pq`, `q-only`, `fixed-pq`, and `fixed-q`. `volt-var` or `droop` requires a dedicated nonlinear controller; set `approximation: "continuous-q"` only when the user accepts a continuous-Q relaxation.

## P-Q capability

Use one or more of:

- explicit P/Q box limits;
- `s_rated_mva` for a linear chord approximation of the inverter capability over a one-sign P interval;
- `power_factor` for an exact fixed-PF line;
- `power_factor_min` for `|Q| <= tan(acos(pf_min)) |P|` when P has a known sign;
- `pq_capability` or `capability_points` with exactly two points, each containing `p_mw`, `q_min_mvar`, and `q_max_mvar`.

These sidecar capability limits are translated to general OPF linear constraints and checked after solution. A minimum-PF constraint across a P range that crosses zero is non-convex; split operating modes or use a dedicated formulation.

## Storage and flexible-load states

Positive storage P discharges; negative P charges. Enable `storage-soc` for sequential energy limits and state propagation. This remains a continuous model and does not enforce binary charge/discharge commitment.

For a flexible load, consumption is negative P injection. Add:

```json
"energy_budget": {
  "target_mwh": 24,
  "direction": "consumption",
  "enforce_terminal": true
}
```

and enable `flexible-load-energy`. The orchestrator carries the remaining energy requirement and forces the final period to meet it when requested.

## Linear terminal/resource coupling

Each coupling enforces a signed MW/Mvar equality or interval over named resource terminals:

```json
{
  "resource_couplings": [
    {
      "name": "sop-active-loss",
      "terms": [
        {"resource": "sop-a", "quantity": "p", "coefficient": 1},
        {"resource": "sop-b", "quantity": "p", "coefficient": 1}
      ],
      "equal": -0.2
    }
  ]
}
```

With the injection convention, `P_a + P_b = -P_loss` means the paired AC terminals consume total converter loss. Use `lower`/`upper` instead of `equal` for inequalities. A coupling split by a selected spatial scope is rejected unless `allow_partial_scope: true` is explicitly justified.

## AC-side HVDC equivalent versus full AC/DC coupling

Do not conflate these models:

1. Standard AC power flow/AC-OPF: no DC buses, DC branch currents, or converter internal states.
2. AC-side HVDC/SOP equivalent supported here: converter terminals are controllable AC P/Q injections; linear terminal active-power/loss relations may be enforced. It can answer how the AC grids see the device, not the DC voltage/current distribution.
3. Full AC/DC coupled steady-state model: adds DC nodal balance, DC voltage, DC branch conductance/current, converter loss/rating equations, and converter control modes. The bundled backend does not solve this and rejects `dc_buses`, `dc_branches`, `busdc`, `branchdc`, `convdc`, `dc_networks`, ambiguous `hvdc` resource types, and native `dcline` data rather than silently dropping them.

For a MATPOWER/PYPOWER `dcline` study, either convert it explicitly to paired `converter-ac-equivalent` resources plus coupling and disclose that approximation, or use a solver with native DC-line/full AC/DC support.
