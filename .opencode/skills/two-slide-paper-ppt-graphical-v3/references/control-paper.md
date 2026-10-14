# Control, stability and detection papers

Use `meta.paperType: "control"` when the contribution is a control law, stability mechanism, or detection design rather than an optimization objective. A paper whose main contribution is detection-aware optimization may use `planning` with semantic profile `detection`.

Read the source's system diagram, equations, assumptions, controller hierarchy, measurements and validation together. Record `control-model.md`: physical plant, reference/disturbance inputs, measured outputs, control variables, time scales, controller operations, stability/detection assumptions, and source references. Put this path in `slide1.methodModelPath`.

The first slide explains the source-grounded control structure with native device/block symbols, signal arrows and applicable feedback. Distinguish summing, integration, filtering, limiting, control allocation, and plant dynamics when these operations define the contribution. Show where scheduling setpoints enter and where measurements return. Place the defining control/detection equations beside their operations. Do not invent a cost objective or a closed loop for an open-loop method.

Choose three results themes supported by the experiments: tracking/detection quality, disturbance or parameter robustness, stability/transient behavior, practical operating constraints, or computation/communication demands. Retain units, initial conditions and comparable scenarios. Use original trace crops when exact time-series data are unavailable, with editable adjacent labels. Do not redraw guessed traces.

Follow [graphic-method-workflow.md](graphic-method-workflow.md), including its graph, mapping and final-render gates. The GFM and island-detection decks in [graphic-reference-cases.md](graphic-reference-cases.md) are visual references for this route.
