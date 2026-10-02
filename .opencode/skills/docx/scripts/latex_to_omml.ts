/**
 * LaTeX -> Word native OMML, for writing formulas into word/document.xml.
 *
 *   npx tsx <skill>/scripts/latex_to_omml.ts --display "x^{(k+1)} = \\arg\\min_x \\sum_i w_i^{(k)}"
 *   npx tsx <skill>/scripts/latex_to_omml.ts --inline "\\rho_i"
 *   npx tsx <skill>/scripts/latex_to_omml.ts --paragraph --display "E = mc^2"   # ready <w:p>
 *   echo '\\frac{a}{b}' | npx tsx <skill>/scripts/latex_to_omml.ts --display -
 *
 * Writing ASCII like `x_hat = arg min_x (z - h(x))^T` into a single <m:r> is not
 * a formula: Word shows it as italic text with no real sub/superscripts, and any
 * PDF path that re-typesets paragraph text drops it entirely. This emits the
 * structural elements (m:sSup, m:sSub, m:f, m:nary, m:rad) that survive
 * conversion, with variables in Times New Roman italic.
 *
 * Reuses src/lib/patent-generation/docx-math.ts (KaTeX -> MathML -> OMML),
 * resolved through AI4ES_PROJECT_ROOT so it works from any copy of this skill.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

type DocxMath = {
  latexToOmml: (latex: string, displayMode?: boolean) => string | null;
  normalizeLatexForOmml: (latex: string) => string;
};

const MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function usage(message: string): never {
  console.error(`${message}

usage: latex_to_omml.ts [--display|--inline] [--paragraph] <latex | ->
  --display     centred m:oMathPara block (default)
  --inline      bare m:oMath for use inside a run of text
  --paragraph   wrap the result in a <w:p> ready to paste into document.xml
  -             read the LaTeX from stdin`);
  process.exit(2);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function loadDocxMath(): Promise<DocxMath> {
  const root = process.env.AI4ES_PROJECT_ROOT || process.cwd();
  const modulePath = path.join(root, 'src', 'lib', 'patent-generation', 'docx-math.ts');
  try {
    return (await import(pathToFileURL(modulePath).href)) as DocxMath;
  } catch (error) {
    console.error(
      `无法加载 ${modulePath}\n` +
        '设置 AI4ES_PROJECT_ROOT 指向仓库根目录，并用 npx tsx 运行本脚本。\n' +
        String(error)
    );
    process.exit(2);
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const display = !argv.includes('--inline');
  const asParagraph = argv.includes('--paragraph');
  const positional = argv.filter((value) => !value.startsWith('--'));
  if (positional.length !== 1) usage('需要且只需要一个 LaTeX 参数');

  const latex = positional[0] === '-' ? await readStdin() : positional[0];
  if (!latex.trim()) usage('LaTeX 为空');

  const { latexToOmml } = await loadDocxMath();
  const omml = latexToOmml(latex.trim(), display);
  if (!omml) {
    console.error(`KaTeX 无法解析该 LaTeX：${latex.trim()}`);
    return 1;
  }

  if (!asParagraph) {
    process.stdout.write(`${omml}\n`);
    return 0;
  }

  const inner = omml.replace(/ xmlns:(?:m|w)="[^"]*"/g, '');
  process.stdout.write(
    `<w:p xmlns:w="${WORD_NS}" xmlns:m="${MATH_NS}">` +
      '<w:pPr><w:jc w:val="center"/></w:pPr>' +
      inner +
      '</w:p>\n'
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
