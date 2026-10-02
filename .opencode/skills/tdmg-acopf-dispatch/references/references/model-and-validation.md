# Model and validation

Use this reference when interpreting results, diagnosing infeasibility, or deciding whether the bundled solver is appropriate.

## Mathematical scope

The default solve is a centralized, balanced, positive-sequence, steady-state AC optimal power flow in polar voltage coordinates. It minimizes the MATPOWER generator cost functions over bus voltage magnitude/angle and online-generator active/reactive power subject to:

- nonlinear nodal active and reactive power balance;
- generator P/Q bounds;
- bus voltage magnitude bounds;
- branch from-end and to-end apparent-power ratings (`RATE_A`);
- reference angle and MATPOWER branch angle constraints;
- transformer ratio and phase-shift data present in the branch matrix.

Treat main grid, distribution grid, microgrid generators, renewable units, and flexible P/Q resources as generators in one integrated network. This is a centralized coordination benchmark. Area labels do not change the physics; they drive reporting and tie-flow aggregation.

The resource adapter also represents storage/EV/flexible demand as signed injections, Q-only resources as zero-P generators, and fixed loads/shunts directly in bus data. Sidecar P-Q capability, power-factor, and terminal-coupling relations are enforced through sparse linear OPF constraints.

The schema-v2 modular orchestrator may extract transmission, distribution, microgrid, or a connected union. It removes branches outside the selected scope and represents each energized cut with a fixed or dispatchable boundary P/Q resource unless islanded mode is selected. Validate those exchange limits and prices as carefully as physical branch data.

Multi-timescale mode is a hierarchical rolling sequence of AC-OPFs. It can carry storage SOC, impose period-to-period ramp envelopes, and penalize child-stage deviation from a parent plan. It is not a simultaneous global optimum across all time scales.

The optional `--dc` path is only for active-power diagnosis. Do not present its Q values or voltages as an active/reactive coordinated result.

## AC/DC boundary

Standard steady-state AC power flow has no DC-network state. The bundled model therefore distinguishes:

- `converter-ac-equivalent`: supported controllable P/Q injections at AC terminals, optionally linked by a linear active-power/loss relation. This is an AC-side equivalent only.
- full HVDC/AC-DC network: requires DC nodal balance, DC voltages, DC branches, converter loss/rating equations, and control modes. It is not implemented by the bundled PYPOWER AC backend.

Reject full DC-network fields, ambiguous full-HVDC resource types, and native `dcline` data instead of solving the remaining AC matrices and claiming an AC/DC result. The `dc-opf-diagnostic` module is a linearized active-power AC-network diagnostic and is unrelated to a physical DC grid.

## Mandatory validation sequence

1. Confirm units: MW, Mvar, MVA, kV, degrees, and per-unit voltage on `baseMVA`.
2. Confirm bus IDs, branch endpoints, generator buses, one reference bus, and cost-row count.
3. Inspect every `RATE_A=0`; it disables the thermal constraint and may invalidate a study.
4. Confirm all configured areas and tie orientations against the one-line diagram.
5. For a reduced scope, confirm every cut branch, boundary resource, import/export sign, capacity, and price. For islanded mode, confirm each electrical island has internal generation.
6. Require `solver.success=true`; never call a failed point optimal.
7. Check the final feasibility condition in `summary.json`. Treat values above the configured violation tolerance as suspect even if a backend reports success.
8. Check voltage extrema, maximum branch loading, generator P/Q values against bounds, and sign of every tie exchange.
9. Recompute every fixed/minimum power-factor, P-Q capability, and named resource-coupling residual from `dispatch.csv`; do not rely only on a reported “applied” name.
10. Compare total generation minus total load with branch active loss, allowing small numerical tolerance and shunt effects.
11. For linked periods, check ramp deltas, SOC continuity, efficiency signs, terminal SOC behavior, flexible-load energy completion, and parent-tracking RMSE.
12. For research reporting, run a base case and at least one perturbation or independent power-flow cross-check.

## Diagnosing infeasibility

Check in this order:

1. Slack and online generation capacity versus total load and losses.
2. Reactive capability near low-voltage buses.
3. Unrealistic voltage limits such as identical `VMIN`/`VMAX` at many buses.
4. Tight or accidentally zero/nonzero branch ratings.
5. Islands, open branches, and islands without a reference or online generator.
6. Transformer taps, phase shifts, and angle limits.
7. Added resource costs, signs, and bounds.
8. Resource P-Q capability orientation, fixed/minimum power factor, terminal coupling, and scope cuts through a coupled device.

Do not silently relax constraints. If a diagnostic relaxation is useful, solve it as a clearly labeled second scenario and list every relaxed bound.

## Unsupported without model extension

- Three-phase unbalanced distribution flow, neutral conductors, or phase-specific controls.
- Simultaneous all-horizon/all-scale stochastic or robust co-optimization, binary charge/discharge complementarity, unit commitment, or minimum up/down time. The bundled temporal modules are sequential and continuous.
- Discrete tap/capacitor switching, topology reconfiguration, integer decisions, and chance constraints.
- N-1/security-constrained OPF, transient/dynamic security, protection coordination, and state estimation.
- Explicit TSO/DSO/aggregator privacy decomposition or ADMM market clearing.
- Full AC/DC coupled power flow or OPF with DC voltages, DC branches, and converter control equations. AC-side converter terminal equivalents are supported but must be labeled as approximations.

State these limits when they materially affect the user's requested study. Extend the model rather than implying the centralized snapshot solver covers them.
