# Autonomous image-to-editable-PPT replication

Use this workflow when the user expects the finished deck to require no manual
PowerPoint cleanup. The objective is not a single export; it is a closed loop that
keeps measuring, rendering, comparing, and repairing until every slide passes.

## Accuracy model

Treat fidelity as four independent gates:

1. **Content fidelity:** every visible string, number, table value, formula, icon,
   and chart label matches a supplied source. Prefer source documents or editable
   template objects over OCR guesses.
2. **Geometry fidelity:** all major objects use measured coordinates normalized
   from the reference canvas. Never position major elements from verbal estimates.
3. **Style fidelity:** fonts, weights, colors, fills, outlines, radii, spacing,
   crop windows, and z-order come from the template or measured reference.
4. **Package fidelity:** the PPTX opens, retains the intended masters/layouts, and
   keeps narrative text, tables, charts, diagrams, connectors, and page numbers
   editable.

Passing package validation does not imply visual fidelity. Passing visual
comparison does not imply editability. Require both.

## Deterministic preparation

1. Normalize references to their native pixel size; do not rescale them before
   measuring.
2. Run `scripts/measure_reference.py` for every reference image. Use its dominant
   colors and candidate guide lines as machine evidence, then complete each
   `layout-map.json` with classified text, image, table, chart, and shape elements.
   Validate completed maps with `scripts/validate_layout_map.py` against
   `references/layout-map-schema.json` before authoring.
3. When multiple reference slides share fixed chrome, detect the repeated header,
   footer, logo, page-number frame, and background decoration. Reuse the source
   template master/layout when available. Otherwise create one shared base slide or
   independent fixed assets once; do not redraw them independently on every slide.
4. Extract text from the source PPTX/DOCX/PDF first. Use visual transcription only
   for text absent from editable sources. Reconcile every number against the
   evidence ledger before authoring.
5. Define named anchors such as `title_left`, `content_top`, `footer_top`, column
   boundaries, and repeated card dimensions. Derive slide objects from anchors so
   one repair updates every related object consistently.
6. When the restrained green technical-report profile applies, use its measured
   normalized bands and palette as the initial slide spec. Preserve the reference
   page's actual measurements when they differ; do not force the profile over a
   supplied one-to-one target.

## Controlled icon system

The only default icon source is `assets/electrical-icons/manifest.json`. It is a
pinned local subset of Tabler Icons with one visual grammar. Run
`scripts/icon_registry.py <keyword> --json` to resolve an icon. Use `--copy`,
`--color`, and `--stroke-width` to produce a task-local SVG without modifying the
library.

- Use the first exact keyword result unless the reference visibly requires another
  allowlisted result.
- Do not search the web for a stylistically different replacement.
- A user-supplied icon or an icon extracted from the source template/reference is
  permitted only when recorded in `asset-ledger.json` with provenance.
- Do not ask image generation to draw icons. Generate or reserve the composition,
  then composite the exact local SVG for previews and insert the same SVG into the
  PPTX. This prevents icon drift between preview and deck.
- Keep original SVG proportions. Recolor only through `currentColor`; use one
  stroke width per deck unless the reference proves otherwise.
- Run `scripts/sync_icon_library.py` only to install or deliberately refresh the
  pinned version. Do not silently update the icon version during a deck task.
- Before delivery, run `scripts/audit_asset_ledger.py asset-ledger.json`. Treat an
  unlisted icon source or a changed library hash as a hard failure.

## Authoring representation

- Reuse an existing master/layout and editable objects whenever possible.
- Rebuild text, simple shapes, cards, lines, connectors, tables, charts, legends,
  axes, labels, and page numbers as native objects.
- Preserve complex illustrations as tightly cropped, independent, replaceable
  assets. A raster must never cover the whole slide or contain narrative text that
  should be editable.
- Parameterize all measured values in one slide-spec object. Avoid scattering raw
  coordinates throughout the authoring code.
- Create connectors before nodes. Assign explicit z-order groups: background,
  connectors, panels, icons, text, annotations.
- Calibrate fonts through render evidence. If the exact font is unavailable, choose
  a disclosed substitute and tune the text box width/line spacing against the
  reference; do not solve fit solely by shrinking type.
- Apply a page-level color budget. For restrained-green work, reject more than one
  green family plus neutrals or more than three chromatic colors unless the source
  evidence itself requires them.
- For equations, author from the formula manifest with native Office Math, then run
  both `validate_formula_manifest.py` and `audit_formula_pptx.py`. A whole-slide
  visual score cannot excuse a wrong operator, index, bound, or equation number.

## Automatic render-and-repair loop

For each slide, complete this loop before moving on:

1. Author from the measured slide spec.
2. Export the slide to PNG at the reference pixel dimensions and export layout
   metadata.
3. Run `scripts/visual_compare.py` on the reference and rendered slide. For a deck,
   run `scripts/replication_qa.py` to produce per-slide overlays, heatmaps, metrics,
   and a comparison contact sheet.
4. Inspect the five worst grid regions in the JSON report and the full-size overlay.
5. Repair by error class:
   - broad parallel edges: fix canvas scale, common anchors, or panel bounds;
   - doubled text edges: fix font family, font size, weight, line spacing, or inset;
   - large flat-color regions: fix fill, transparency, gradient, or crop;
   - isolated object mismatch: fix icon choice, image crop, shape geometry, or
     z-order;
   - repeated mismatch on all slides: repair the master/base layout once.
6. Render and compare again. Require measured improvement; do not count a pass that
   merely changes the slide.

Use the script defaults as an initial automated gate: normalized MAE at most 0.12,
mismatch ratio at most 0.34, and edge F1 at least 0.62 after small translation
alignment. Tighten the thresholds when a template-render calibration slide shows
that the local renderer can achieve better results. Never loosen thresholds merely
to pass a bad slide.

Allow up to six repair passes per slide. If two consecutive passes do not improve
the primary failing metric, generate two parameter variants for the failing region,
render both, and keep the better result. A user should not need to edit the deck.
Only stop for user input when a required source is absent, the intended text cannot
be determined, or lawful reproduction of an asset is unclear.

## Hard completion gates

Do not deliver until all conditions hold:

- every reference slide has exactly one output slide in the correct order and
  aspect ratio;
- no layout, overflow, clipping, placeholder, package-integrity, or font-policy
  errors remain;
- every slide passes the visual-comparison gate or has a precisely documented
  renderer-only exception supported by a calibration test;
- all narrative text and all simple visual structures are editable;
- every displayed equation passes manifest, native-structure, token, number, font,
  and high-resolution render-crop checks;
- restrained-green slides meet the palette budget and use consistent icon color
  and stroke width;
- no full-slide raster background is used to imitate the reference;
- every icon is allowlisted or has recorded source provenance;
- one complete second-pass render of the exported PPTX also passes;
- the final deck is reopened through the first-party PowerPoint import check.

## Practical limit

Pixel-identical output and full editability can conflict because PowerPoint and the
reference renderer may shape fonts, gradients, shadows, and charts differently.
The closed loop removes routine manual cleanup and should produce a presentation
ready to use. When the reference depends on unavailable fonts or inaccessible
source artwork, report the exact object rather than claiming literal pixel identity.
