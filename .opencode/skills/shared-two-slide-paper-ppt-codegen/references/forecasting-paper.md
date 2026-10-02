# Forecasting papers: computation and experiments

Use when the central contribution predicts future power, load, weather, or another time series. The two reference cases behind this guide were satellite/time-series PV forecasting and a spatial-temporal graph model for wind farms. Their input branches and losses differ, so preserve the paper's own topology.

## Method and computation slide

- State the target, spatial scope, input window, sampling interval, forecast horizon, and output shape together. Separate a single-site forecast from multi-device, multi-step prediction.
- Start with raw inputs and preprocessing. Show anomaly cleaning, missing-data handling, feature selection, location-guided cropping, graph construction, or normalization only when present; preserve which branch consumes each input.
- Keep parallel modalities/branches parallel until the actual fusion point. Mark cross-branch information exchange, attention, auto-correlation, decomposition, skip paths, ensemble, and auxiliary models as directed relationships. Do not linearize a graph model or move fusion ahead of its encoders.
- Separate inference from training. Ground truth, prediction loss, correlation/regularization loss, and optimizer feedback belong to a clearly marked training lane. They are not inference inputs.
- Label the final forecast and any ensemble operands. Place only the equations that identify a distinctive transformation or objective near the matching module.

Use [method-graph-workflow.md](method-graph-workflow.md) to build and validate the semantic graph. The slide may be a wide integrated flow, as in the reviewed prediction decks; choose density so the key connections and labels stay readable.

## Results and experiment analysis slide

Choose three complementary evidence themes, normally from:

1. **Overall accuracy:** dataset or test split, forecast horizon, baseline methods, metric name/unit/direction, and uncertainty or repeated runs if reported. Compare at matched evaluation conditions; do not mix different horizons or normalization conventions on a common axis without explanation.
2. **Why it works:** ablations, feature selection, encoder/fusion variants, or architecture component comparisons. Link each ablation to one stated mechanism and retain the full-model baseline.
3. **When it holds or fails:** cloud/weather regimes, ordered versus random tests, noise or missingness levels, long-horizon behavior, peaks and ramps, or representative forecast traces against ground truth. Show robustness and accuracy as separate quantities when the paper finds a tradeoff.

Any one theme may need two aligned plots, for example an accuracy chart and a representative trace, or a robustness curve and its tradeoff scatter. Use a native data chart when exact values are available. If the source gives only a plotted curve, preserve a separately selectable source crop or use a supported table; do not manufacture samples to redraw it. Provide a legend and units, and state whether lower or higher is better. Report training time, inference time, parameter count, or hardware only if the paper measures them; do not infer computational advantage from accuracy.
