/**
 * 校验专利成稿质量门槛（不重跑 OpenCode）。
 * 用法: npx tsx scripts/verify-patent-oneshot-quality.ts [projectId]
 */
import fs from 'node:fs';
import path from 'node:path';
import { countAbstractCharacters, splitClaims, validatePatentDraft } from '../src/lib/patent-generation/validators';
import { compactDiagramSpec } from '../src/lib/patent-generation/figures';

const projectId = process.argv[2] || 'ffd43540-26d6-42dc-add0-d4c72eafaa32';
const dir = path.join(process.cwd(), 'storage', 'patents', projectId, 'opencode');

function readJson<T>(name: string): T | null {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function readText(name: string): string | null {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

const status = readJson<{ status: string }>('STATUS.json');
const disclosure = readJson<any>('disclosure.json');
const draft = readJson<any>('draft.json');
const plan = readJson<{ diagrams?: any[] }>('drawings-plan.json');
const claims = (readText('claims.txt') || draft?.claims || '').trim();
const claimItems = splitClaims(claims);
const abstractLen = countAbstractCharacters(String(draft?.abstract || ''));
const embodimentLen = String(draft?.embodiments || '').replace(/\s+/g, '').length;

const labelIssues: string[] = [];
for (const diagram of plan?.diagrams || []) {
  const compacted = compactDiagramSpec(diagram, 8);
  for (const node of compacted.nodes || []) {
    if ([...String(node.label)].length > 8) {
      labelIssues.push(`图${diagram.figureNumber} ${node.id}=${node.label}`);
    }
  }
}

const audit = disclosure && draft
  ? validatePatentDraft(
    {
      ...draft,
      claims: claims || draft.claims
    },
    disclosure,
    { assets: [{ figureNumber: 1 }, { figureNumber: 2 }, { figureNumber: 3 }] as any, generatedFromSuggestions: true, notes: [] }
  )
  : null;

const report = {
  projectId,
  workspaceStatus: status?.status || 'missing',
  files: {
    disclosure: Boolean(disclosure),
    strategy: Boolean(readJson('strategy.json')),
    claims: Boolean(claims),
    drawingsPlan: Boolean(plan),
    draft: Boolean(draft),
    audit: Boolean(readJson('audit.json'))
  },
  claimCount: claimItems.length,
  abstractChars: abstractLen,
  embodimentChars: embodimentLen,
  diagramCount: plan?.diagrams?.length || 0,
  longLabels: labelIssues,
  deterministicErrors: audit?.deterministicIssues.filter((i) => i.severity === 'error').map((i) => i.id) || [],
  score: audit?.score,
  passed: audit?.passed,
  oneshotGate: {
    statusReady: status?.status === 'ready',
    claims12to16: claimItems.length >= 12 && claimItems.length <= 16,
    abstractOk: abstractLen > 0 && abstractLen <= 300,
    embodimentOk: embodimentLen >= 2500,
    diagrams3: (plan?.diagrams?.length || 0) === 3,
    labelsShort: labelIssues.length === 0,
    noDetErrors: !(audit?.deterministicIssues.some((i) => i.severity === 'error'))
  }
};

const gate = report.oneshotGate;
const ok = Object.values(gate).every(Boolean);
console.log(JSON.stringify(report, null, 2));
console.log(ok ? '\nONESHOT_GATE=PASS' : '\nONESHOT_GATE=FAIL');
process.exit(ok ? 0 : 1);
