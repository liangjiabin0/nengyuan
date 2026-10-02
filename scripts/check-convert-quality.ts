/**
 * 抽检 PDF/CAJ 重转质量：正文长度、空页壳、公式附近是否仍是孤立 '='。
 *
 *   npx tsx scripts/check-convert-quality.ts
 *   npx tsx scripts/check-convert-quality.ts --dir storage/knowledge-corpus/whitepapers
 */
import fs from 'node:fs';
import path from 'node:path';
import { getCorpusRoot } from '../src/lib/corpus/schema';
import { getParsedDocumentsDir } from '../src/lib/fund-markdown';
import { getConvertWorkDir } from '../src/lib/pdf2md';

function parseArgs(argv: string[]) {
  const args = { dir: '', limit: 40 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = String(argv[++i] || '');
    else if (argv[i] === '--limit') args.limit = Number(argv[++i] || 40) || 40;
  }
  return args;
}

function stripFrontmatter(text: string) {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return text;
  return text.slice(end + 4).replace(/^\s+/, '');
}

function inspectMarkdown(filePath: string) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const body = stripFrontmatter(raw);
  const compact = body.replace(/\s+/g, '');
  const pageShell = (body.match(/--\s*\d+\s*of\s*\d+\s*--/g) || []).length;
  const emptyPage = (body.match(/<!-- empty page=/g) || []).length;
  const figureMark = (body.match(/<!-- figure page=/g) || []).length;
  const chinese = (body.match(/[\u4e00-\u9fff]/g) || []).length;
  const isolatedEq = (body.match(/^\s*=\s*$/gm) || []).length;
  const formulaCue = (body.match(/如式|公式|式\s*[（(]\s*\d+/g) || []).length;
  const latex = (body.match(/\$[^$]+\$/g) || []).length;
  const damaged =
    compact.length < 80 ||
    (pageShell >= 10 && chinese < 200) ||
    (formulaCue >= 3 && isolatedEq >= 8 && latex === 0 && chinese < 500);
  return {
    file: filePath,
    bytes: Buffer.byteLength(raw),
    chars: compact.length,
    chinese,
    pageShell,
    emptyPage,
    figureMark,
    isolatedEq,
    formulaCue,
    latex,
    damaged
  };
}

function listMd(dir: string) {
  if (!fs.existsSync(dir)) return [] as string[];
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .map((name) => path.join(dir, name))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function summarize(label: string, files: string[], limit: number) {
  const sample = files.slice(0, Math.max(limit, files.length));
  const reports = sample.map(inspectMarkdown);
  const damaged = reports.filter((item) => item.damaged);
  const avgChars = reports.length ? Math.round(reports.reduce((sum, item) => sum + item.chars, 0) / reports.length) : 0;
  return {
    label,
    files: files.length,
    sampled: reports.length,
    damaged: damaged.length,
    avgChars,
    worst: [...reports].sort((a, b) => a.chars - b.chars).slice(0, 5).map((item) => ({
      file: path.basename(item.file),
      chars: item.chars,
      chinese: item.chinese,
      pageShell: item.pageShell,
      isolatedEq: item.isolatedEq,
      formulaCue: item.formulaCue
    })),
    damagedSamples: damaged.slice(0, 8).map((item) => path.basename(item.file))
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpus = getCorpusRoot();
  const targets = args.dir
    ? [{ label: args.dir, files: listMd(path.resolve(args.dir)) }]
    : [
        { label: 'corpus/whitepapers', files: listMd(path.join(corpus, 'whitepapers')) },
        { label: 'parsed/whitepapers', files: listMd(getParsedDocumentsDir('whitepapers')) },
        { label: 'corpus/papers', files: listMd(path.join(corpus, 'papers')) },
        { label: 'convert-work/md', files: listMd(path.join(getConvertWorkDir(), 'md')) }
      ];

  const report = {
    checkedAt: new Date().toISOString(),
    summaries: targets.map((item) => summarize(item.label, item.files, args.limit))
  };
  console.log(JSON.stringify(report, null, 2));
  const failed = report.summaries.filter((item) => item.files > 0 && item.damaged > 0 && /whitepaper/i.test(item.label));
  if (failed.length) {
    console.error('白皮书语料仍有损坏样本，请查看 damagedSamples。');
    process.exitCode = 2;
  }
}

main();
