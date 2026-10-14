# Approved graphical references

These four editable two-slide decks capture the user's preferred graphical standard from the 2026-10-10 revision. They complement the existing planning and forecasting templates. Open/render the closest reference before authoring; inspect both its visual hierarchy and its native objects. They are examples of explanation and composition, never data sources for a different manuscript.

| Reference in `assets/reference-pptx/图形框架基准/` | Transferable composition | Preserve only when the current source supports it |
| --- | --- | --- |
| `01_复合风光低出力_关键负荷调度.pptx` | Event evidence beside a source/storage/load power-flow diagram, with a narrower priority/feasibility sequence | Actual event definition, storage temporal coupling and load hierarchy |
| `02_GFM变流器_分层功率再分配.pptx` | Horizontal control layers, reference signals, summing/integration operations, physical plant and return measurements; adjacent core equations | Distinct EMS, secondary and primary responsibilities; real measured feedback |
| `03_主动孤岛检测_运行可行性协调.pptx` | Injection point, switch path, resource and measurement roles; adjacent solver with feasibility branches and convergence return | Actual detection coupling and actual solver algorithm |
| `04_充放换电站群_异质用户双层优化.pptx` | Station resources, differentiated users, offers/prices and response paths; adjacent optimization conditions | Decision ownership, response direction and heterogeneity actually modeled |

For forecasting, retain the forecasting reference deck's computation graph and training/inference distinctions. Do not insert electrical equipment to make a forecasting-only paper appear more visual.

Record in `visual-design-spec.md`: selected reference path, slide size, header/footer/master treatment, body composition, relationship types, formula locations, and which elements must change for the new paper. “Same blue color and three columns” does not establish template fidelity. Preserve provided editable template geometry where relevant, while changing method-body organization to explain the new paper. Do not use a screenshot of an approved slide as the new slide's background.

The reusable drawing helper is `scripts/draw_semantic_diagram.mjs`. Use its semantic object naming and routing rather than copying absolute file paths or manuscript-specific values from an old builder.
