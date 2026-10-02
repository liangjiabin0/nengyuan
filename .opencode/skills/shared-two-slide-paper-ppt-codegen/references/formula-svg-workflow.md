# LaTeX-SVG formula workflow

Use LaTeX as the canonical equation source and SVG as the PowerPoint display object. This produces standard mathematical typography while keeping style changes code-editable.

## Manifest

Maintain `formula-manifest.json` beside the task builder:

```json
{
  "sourcePptx": "D:/project/output/base.pptx",
  "outputPptx": "D:/project/output/formula-revision.pptx",
  "formulas": [
    {
      "id": "fft-correlation",
      "label": "频域相关计算",
      "latex": "\\displaystyle Q_{\\mathrm{fft}}[k]=\\sum\\nolimits_{t=0}^{L-1}Q_t e^{-i2\\pi tk/L}",
      "color": "#123E78",
      "slide": 1,
      "targetShapeName": "formula-fft-correlation",
      "position": {"left": 462, "top": 611, "width": 356, "height": 39},
      "evidenceRef": "PDF p.6 Eq.7"
    }
  ]
}
```

`evidenceRef` belongs in the ledger or notes and must not be printed beside the equation. Do not display equation numbers unless the user explicitly needs them for oral cross-reference.

## Initial deck build

- Use `scripts/render_latex_svg.mjs` from the task builder to render each `latex` string.
- Insert the SVG with `fit: "contain"` inside the measured formula frame.
- Keep the SVG color aligned with the slide theme.
- Store the LaTeX source in SVG metadata or alternative text and keep the manifest as the editable source of truth.
- For a wide equation with tall limits, consider `\sum\nolimits` so the slide uses a legible single-line form without changing the mathematics.

The renderer downloads a pinned MathJax browser bundle into the task's private build cache on first use. Set `MATHJAX_SVG_BUNDLE` to an existing local `tex-svg.js` to work offline. Set `BROWSER_EXECUTABLE` when Edge is not in a standard Windows location.

## Formula-only revision

When the user wants to change formulas without rebuilding any other content:

1. Work from a copy of the last accepted PPTX.
2. Name each replaceable formula shape deterministically.
3. Run `scripts/apply_formula_manifest.mjs formula-manifest.json`.
4. The helper renders new SVGs and uses PowerPoint automation to delete only the named formula shapes and insert the replacements at the stored pixel coordinates.
5. Render the result with PowerPoint and compare all pixels outside the formula rectangles. Differences outside those rectangles are defects.

PowerPoint is required for the formula-only patch helper. Do not import and re-export the whole deck through another library when that would rewrite unrelated charts, tables, or workbooks.

## Local editor

For iterative editing, run:

```powershell
$env:FORMULA_MANIFEST='D:\project\build\formula-manifest.json'
node scripts/formula_editor_server.mjs
```

Open `http://127.0.0.1:4317`. The editor changes LaTeX, previews the SVG, saves the manifest, and invokes the formula-only patch helper. Keep the server bound to `127.0.0.1`.

## QA boundary

Some non-PowerPoint renderers preserve an SVG object but omit it from their PNG preview. Verify SVG equations with a PowerPoint export before concluding that a formula is missing. Still run structural PPTX validation and confirm the SVG objects remain independently selectable.
