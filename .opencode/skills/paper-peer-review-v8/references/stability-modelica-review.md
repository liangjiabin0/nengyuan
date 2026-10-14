# System Stability Analysis and Control Review with Modelica Logic

## Principle-level dynamic reproduction

Prefer Modelica/OpenModelica-style reconstruction of the minimal dynamic system needed to test the paper's central mechanism, even when authors used Simulink, PSCAD, RTDS, EMT software, or hardware.

Reconstruct:

- differential/algebraic equations;
- states, inputs, outputs;
- controller structure/gains;
- device/network parameters;
- initial conditions;
- filters;
- saturation/limiters;
- measurement/control delay;
- sampling/discretization when material;
- disturbance event;
- simulation horizon;
- solver/time step.

## Validation targets

Depending on claim, inspect:

- damping and oscillation decay;
- eigenvalue movement/damping ratio;
- frequency nadir/RoCoF/recovery;
- voltage deviation;
- current/power limits;
- synchronization angle;
- power-sharing ratios;
- disturbance recovery;
- robustness to parameter variation.

Point-by-point waveform equality is not required.

## Theory-time-domain consistency

Check:

- linearization point matches simulation point;
- small-signal prediction matches time-domain trend;
- Lyapunov/theorem assumptions hold in the simulated operating region;
- saturation/limiters invalidate or preserve theory;
- delays/discretization affect guarantees;
- reduced-order model excludes important dynamics;
- average-model conclusions are not overextended to switching/EMT behavior without evidence.

The formal Modelica Reproduction Barriers table contains only the three most important items.

## Triggered reusable checks

Apply M11 in [power-system-review-memory.md](power-system-review-memory.md) to reduced dynamic models, reviewer discretization and execution status. Record omitted states/limits and the consequences for the verified mechanism. Apply M15–M16 to engineering, robustness and mechanism-attribution claims; use probability/market rules only when those methods are present. A printed equation concern and an observed controller failure are distinct evidence levels.
