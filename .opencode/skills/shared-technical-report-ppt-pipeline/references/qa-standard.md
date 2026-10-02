# PPT quality assurance standard

## Per-slide authoring loop

1. Author one slide from its mapped template source slide.
2. Export the slide PNG and layout JSON.
3. Inspect the PNG at full size.
4. Compare against the approved image preview and source-slide pattern.
5. Fix placement, wrapping, crop, hierarchy, and formula issues.
6. Re-render and pass the slide before continuing.

## Geometry tolerances

- Main module edge deviation: ≤ 0.5% of the 1280 × 720 canvas.
- Title and main text-frame deviation: ≤ 0.8%.
- Font-size deviation from the template: ≤ 2 pt.
- Fixed master elements and page number: identical across all content slides.

## Mandatory final checks

- User/reference-specified page ratio and expected slide count.
- Master/layout inheritance retained.
- All one-line titles remain one line.
- No text clipping, overflow, unexplained overlap, or slide-canvas overflow.
- No image distortion, blurred crops, or whole-slide screenshot backgrounds.
- No connectors crossing labels or nodes.
- No empty inherited placeholders or visible editing prompts.
- No duplicate or inconsistent page numbers.
- All visible narrative text editable.
- Native charts/tables/diagrams editable where required.
- Complex illustrations are independent replaceable images.
- Every default icon resolves to the pinned local electrical icon allowlist; every
  source/user exception has provenance in the asset ledger.
- Reference-image replication passes the automated visual-difference thresholds
  and retains its per-slide overlay, heatmap, and metric report in the build folder.
- Every quantitative claim and report figure traces to the evidence ledger.
- No fabricated data or unsupported trend scales.
- Every formula matches the formula manifest and is an Office Math object.
- Native math font evidence is Cambria Math unless the measured template specifies
  another verified math font; Chinese text uses the selected template font or a
  disclosed substitute.
- Restrained-green pages use one green family plus neutrals and no more than three
  chromatic colors unless the source figure itself requires more.

## Formula failure conditions

Fail the deck if any slide contains visible raw LaTeX, underscores used as scripts,
caret-based superscripts, missing equation numbers, malformed fraction/sum/matrix,
a scalar/vector style mismatch, a failed canonical/token/structure audit, or a
formula rendered with clipped glyphs.

## Final package check

Render every slide, generate a contact sheet, run overflow checks, run
`pptx_preflight.py`, run `audit_formula_pptx.py` when formulas exist, reopen the
exported PPTX, and perform at least one complete correction pass. Record unresolved
exceptions by slide and element.
