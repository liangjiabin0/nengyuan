# Latest Relevant Literature and Comparator Audit

## Purpose

Determine whether the manuscript is positioned against the current relevant literature and, where it claims superiority, whether it is experimentally compared with strong recent methods under conditions fair enough to interpret the result.

## 1. Search strategy

When external research is enabled:

1. extract the paper's task, domain, key method names, benchmark/test system, claimed contribution, and strongest superiority claim;
2. search current primary sources using combinations of those terms;
3. prioritize recent work, normally the last 2-5 years depending on field pace, while retaining older seminal baselines when still technically central;
4. verify publication/preprint dates and use the most recent authoritative version available;
5. prefer publisher pages, DOI records, arXiv for current preprints, official conference/journal pages, and primary paper repositories;
6. avoid treating secondary summaries as proof of state of the art.

The goal is not to find the paper with the newest date. The goal is to identify the most recent **credible and directly relevant** comparators that could change the interpretation of novelty or performance.

## 2. Separate citation currency from experimental comparison

Audit both:

### Literature coverage

- Are recent directly relevant approaches cited?
- Does the manuscript accurately distinguish itself from them?
- Are important recent developments omitted such that novelty appears overstated?

### Experimental baseline strength

- Are recent strong methods actually implemented or otherwise compared quantitatively?
- Are datasets/test systems, splits, scenarios, metrics, tuning budgets, compute budgets, solver limits, and preprocessing sufficiently comparable?
- Are baseline implementations official or faithful enough to support the comparison?
- Is the paper comparing against only outdated/easy baselines despite claiming state-of-the-art or superiority?

A citation in Related Work is not an experimental comparison.

## 3. Fairness checks

Look for:

- different data splits or leakage advantages;
- unequal hyperparameter search/tuning budgets;
- inconsistent hardware or runtime accounting;
- different feasibility constraints or solver tolerances;
- missing confidence intervals/repeated runs when rankings are close;
- selective omission of recent methods that are particularly competitive;
- reimplemented baselines without validation against reported reference performance.

## 4. Status

Assign `comparison_status`:

- `adequate`: current literature coverage and baseline set are sufficient for the paper's claimed contribution;
- `partially_adequate`: mostly current, but one or more relevant recent methods or fairness details remain missing;
- `inadequate`: the omitted recent work or weak baseline set materially prevents interpretation of novelty/superiority;
- `not_assessable`: external verification was unavailable or the field scope could not be responsibly resolved.

## 5. Decision consequences

- Missing a recent strong comparator is normally **major** when the paper's main claim is superiority, state-of-the-art performance, or practical advantage.
- Missing a recent citation can be moderate/minor if it does not affect the central novelty claim or experimental interpretation.
- If a recent method is inaccessible, non-reproducible, or based on incompatible data/test assumptions, do not automatically demand implementation. Require transparent discussion, bounded claims, and the strongest feasible comparable baseline instead.
