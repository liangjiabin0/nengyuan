# Bidirectional overload thesis regression case

This is a tested two-slide build case for the exact thesis `20261010170602.pdf`, not a general manuscript parser. The source PDF is not redistributed. `prepare.py` verifies its SHA-256 before reusing the recorded claims. Read a changed manuscript and adapt evidence before using this case for it.

The approved GFM reference supplies the visual hierarchy and template parts. The case retains all three core chapters: shared aging/risk assessment, short-term EV/retired-storage coordination, and long-term collection/expansion. The latter two are alternatives with separate objectives and evidence. The bundled finished example has been opened and rendered in PowerPoint; it is a regression example, not a new user-approved standard.

## Rebuild

Read the Presentations skill and use `load_workspace_dependencies` to obtain the runtime paths. Set `CODEX_RUNTIME_ROOT` to the directory containing `node` and `python`; set `PRESENTATIONS_SKILL_ROOT` to the installed Presentations skill directory. Use a Python with `lxml` for `finish_package.py`; finalization uses the bundled Python, optionally overridden by `ARTIFACT_PYTHON`. Run from this case directory:

```powershell
python prepare.py 'absolute/path/to/20261010170602.pdf'
node build.mjs
python finish_package.py
node finalize.mjs
./render.ps1
```

Use the discovered Node executable if it is not on PATH. The unchanged case reuses the verified LaTeX-SVG assets in `reference-data/formula-svg` without network access. Changed formulas are regenerated through the standard MathJax workflow. Text, semantic diagram objects, four charts and the results table are native editable objects. Formula objects are replaceable SVGs; their canonical LaTeX is retained in the manifest and spec.

`build/` and `output/` are generated locally. Do not run from an unwritable installation folder; copy the whole skill to a task work directory first, preserving its relative layout. On a repeat run, use a suffix such as `node finalize.mjs -r2` and `./render.ps1 -Suffix -r2`. Do not overwrite an inspected final silently.

Run the spec, visible-language, template-binding and chart-axis validators from the skill's `scripts/`. Inspect both final renders. Create a real `visual-review.json` with observations and final PPTX, graph, layout, coverage, contribution-map and render hashes; run `audit_graphic_delivery.py`. Never copy the previous review as approval for a new render. The master/layout reciprocity gate catches a stale layout reference that generic package checks can miss.

## Evidence limits

Chapter 2 and Chapter 3 use different EV input baselines. Chapter 4 describes grey forecasting but its reported experiment directly scales resources and base load. Annual planning cost and annual storage net cost have different accounting bases. Optimized aging values slightly above 24 h must remain visible as a limitation. The values are reported thesis simulations on a modified IEEE 33-node case; this deck is not an independent reproduction of the optimization experiments.
