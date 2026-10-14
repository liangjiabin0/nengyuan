# Data Science Review and Reproduction Protocol

## Principle-level reproduction

Use public/local/benchmark/simulated data consistent with the manuscript's stated data characteristics. Rebuild:

1. data ingestion;
2. preprocessing/normalization;
3. feature/target construction;
4. model architecture;
5. loss/objective;
6. optimizer/training schedule;
7. validation/model-selection protocol;
8. evaluation metrics.

Do not require the same score as the paper. Determine whether the method is implementable and whether its qualitative behavior is scientifically plausible.

## Reproduction difficulties

Prioritize gaps such as:

- target/label construction unclear;
- temporal windowing unclear;
- preprocessing order missing;
- split procedure or leakage risk unclear;
- architecture layer dimensions missing;
- optimizer/learning-rate/scheduler missing;
- hyperparameter-search protocol absent;
- random seeds/repeated runs absent;
- postprocessing/threshold choice undefined.

The formal table shows the three most important reproduction barriers.

## Generalization audit

### Time generalization

Use chronological transfer when applicable: different years/months/seasons, future-window testing, concept drift, extreme events, weekdays/holidays, rolling-origin validation.

Randomly shuffling one time period is not temporal generalization.

### Data/domain generalization

Test or inspect evidence across datasets, regions, sites, devices, customers, system scales, noise, missingness, imbalance, renewable penetration, or another meaningful data-domain shift.

## Parameter sensitivity

If key performance materially changes with learning rate, window length, depth, threshold, loss weight, cluster count, temperature, regularization, seed, or another parameter, require:

- search range;
- search method;
- validation set;
- selection criterion;
- scientific/empirical basis;
- representative sensitivity results when central conclusions depend on the parameter.

## Triggered reusable checks

Read M05–M08 in [power-system-review-memory.md](power-system-review-memory.md) when probabilistic outputs or correlated scenarios occur. Check latent-vs-physical correlation, calibration, forecast availability at decision time, risk units and probability aggregation. Preserve already-defined losses and preprocessing; missing configuration is separate from missing symbol meaning. Use M11 for executed reviewer tests and M15–M16 for claimed transfer or superiority. Record checked findings, including checks that identify no issue.
