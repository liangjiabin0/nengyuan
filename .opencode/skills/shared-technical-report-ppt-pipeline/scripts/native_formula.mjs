/** Native editable Office Math helpers. Pass the imported @oai/artifact-tool module. */
export function createFormulaHelpers(artifact) {
  const {
    createMath,
    mathDelimited,
    mathEquationArray,
    mathFraction,
    mathIdentifier,
    mathMatrix,
    mathNary,
    mathNumber,
    mathOperator,
    mathRadical,
    mathScripts,
    mathSequence,
    mathText,
  } = artifact;

  const scalar = (text) => mathIdentifier(text, { italic: true, bold: false });
  const vector = (text) => mathIdentifier(text, { italic: true, bold: true });
  const matrix = vector;
  const index = scalar;
  const upright = (text) => mathText(text, { italic: false, bold: false });
  const fn = upright;
  const num = (value) => mathNumber(value, { italic: false, bold: false });
  const op = (text) => mathOperator(text, { italic: false, bold: false });

  const seq = (...items) =>
    mathSequence(items.flat().filter((item) => item !== null && item !== undefined));

  const scripts = (base, subscript = null, superscript = null) =>
    mathScripts({ base, subscript, superscript });

  const frac = (numerator, denominator) => mathFraction({ numerator, denominator });

  const radical = (radicand, degree = null) =>
    mathRadical({ radicand, degree, hideDegree: degree === null });

  const summation = (body, lowerLimit = null, upperLimit = null) =>
    mathNary({
      operator: "∑",
      body,
      lowerLimit,
      upperLimit,
      hideSubscript: lowerLimit === null,
      hideSuperscript: upperLimit === null,
    });

  const delimit = (
    items,
    beginDelimiter = "(",
    endDelimiter = ")",
    separatorDelimiter = ",",
  ) =>
    mathDelimited({ items, beginDelimiter, endDelimiter, separatorDelimiter, grow: true });

  const matrixGrid = (rows) => mathMatrix({ rows });
  const equationArray = (rows) => mathEquationArray({ rows });
  const formula = (root, displayMode = "inline") => createMath({ root, displayMode });

  const addFormulaBox = (slide, options) => {
    const {
      position,
      root,
      displayMode = "inline",
      fontSize = 28,
      color = "#003B32",
      fill = "#F8FCFB",
      line = "#66A9A4",
      mathFont = "Cambria Math",
      name = "native-office-math",
    } = options;
    const box = slide.shapes.add({
      geometry: "roundRect",
      name,
      position,
      fill,
      line: { style: "solid", fill: line, width: 1 },
      borderRadius: 8,
    });
    box.text = [[{ math: formula(root, displayMode) }]];
    box.text.style = {
      typeface: mathFont,
      fontSize,
      color,
      verticalAlignment: "middle",
      alignment: "center",
      insets: { top: 6, right: 10, bottom: 6, left: 10 },
    };
    return box;
  };

  return {
    scalar,
    vector,
    matrix,
    index,
    upright,
    fn,
    num,
    op,
    seq,
    scripts,
    frac,
    radical,
    summation,
    delimit,
    matrixGrid,
    equationArray,
    formula,
    addFormulaBox,
  };
}
