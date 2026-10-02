/**
 * 逐题评测 domain-qa-20-questions.csv：问答 + 思维链（agent_step）
 * 用法: node scripts/eval-domain-20-questions.mjs [--base http://localhost:3000] [--from 1] [--to 20] [--id 3]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CSV_PATH = path.join(ROOT, 'outputs', 'domain-qa-20-questions.csv');
const GOLD_PATH = path.join(ROOT, 'eval', 'golden', 'domain-golden.json');
const OUT_DIR = path.join(ROOT, 'outputs', 'eval-domain-20');
const REPORT_JSON = path.join(OUT_DIR, 'report.json');
const REPORT_MD = path.join(OUT_DIR, 'report.md');

function parseArgs(argv) {
  const opts = { base: 'http://localhost:3000', from: 1, to: 20, ids: [], reportOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') opts.base = argv[++i];
    else if (a === '--from') opts.from = Number(argv[++i]);
    else if (a === '--to') opts.to = Number(argv[++i]);
    else if (a === '--id') opts.ids.push(Number(argv[++i]));
    else if (a === '--report-only') opts.reportOnly = true;
  }
  return opts;
}

/** 简易 CSV 解析（支持引号字段） */
function parseCsv(text) {
  const raw = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows[0];
  return rows.slice(1).filter((r) => r.some((c) => String(c).trim())).map((r) => {
    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = r[idx] ?? '';
    });
    return obj;
  });
}

function truncate(s, n = 400) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

const TOOL_ALIASES = {
  'search.unified': 'search.global',
  'search.keyword': 'search.global',
  'search.semantic': 'search.global',
  'domain.mentors.search': 'search.horizontal',
  'domain.papers.search': 'search.horizontal',
  'analytics.count_papers': 'analytics.group_by',
  search_horizontal: 'search.horizontal',
  graph_citation_chain: 'graph.citation_chain'
};

function canonicalTool(tool) {
  return TOOL_ALIASES[tool] || tool;
}

function loadGolden() {
  const doc = JSON.parse(fs.readFileSync(GOLD_PATH, 'utf8'));
  if (!Array.isArray(doc.cases)) throw new Error(`${GOLD_PATH}: cases 必须是数组`);
  const ids = new Set();
  for (const item of doc.cases) {
    for (const key of ['id', 'mustContain', 'mustTools', 'forbiddenTools', 'expectedSourceTypes', 'expectedRefusal']) {
      if (!(key in item)) throw new Error(`${GOLD_PATH}: case ${item.id ?? '?'} 缺少 ${key}`);
    }
    if (ids.has(item.id)) throw new Error(`${GOLD_PATH}: id ${item.id} 重复`);
    ids.add(item.id);
  }
  return new Map(doc.cases.map((item) => [Number(item.id), item]));
}

function scoreAnswer(q, result) {
  const answer = result.answer || '';
  const steps = result.steps || [];
  const toolCalls = steps.filter((s) => s.type === 'tool_call' && s.tool);
  const tools = [...new Set(toolCalls.map((s) => canonicalTool(s.tool)))];
  const thoughts = steps.filter((s) => s.type === 'thought').map((s) => s.content);
  const checks = [];
  let score = 0;
  const max = 10;
  if (result.error) {
    return {
      score: 0,
      max,
      grade: 'weak',
      checks: [{ name: '接口执行成功', pass: false, detail: result.error }],
      tools,
      thoughtCount: 0,
      stepCount: steps.length
    };
  }

  const hasAnswer = Boolean(answer.trim()) && !/没有生成回答/.test(answer);
  checks.push({ name: '有回答', pass: hasAnswer });
  if (hasAnswer) score += 2;

  const emptyGraceful = /没有在已导入的数据中找到|无可靠命中|未找到足够相关|库内未/.test(answer);
  const isBoundary = q.gold.expectedRefusal;
  if (isBoundary) {
    const pass = emptyGraceful || /几乎没有|无关|无命中|找不到/.test(answer);
    checks.push({ name: '边界拒答合理', pass });
    if (pass) score += 4;
  }

  const usedTools = tools.length > 0;
  const maySkipTools = /研究框架|研究规划|评估“AI/.test(q.question) && Number(q.id) === 2;
  checks.push({ name: '调用了工具或可免工具', pass: usedTools || maySkipTools || isBoundary });
  if (usedTools || maySkipTools) score += 2;

  const hasThought = thoughts.length > 0 || steps.some((s) => s.type === 'plan');
  checks.push({ name: '有思维链步骤', pass: steps.length > 0 });
  if (steps.length > 0) score += 1;
  if (hasThought) score += 1;

  const sourcesOk = (result.sources?.length || 0) > 0 || emptyGraceful || maySkipTools || Number(q.id) === 9;
  checks.push({ name: '有来源或可无来源', pass: sourcesOk });
  if (sourcesOk) score += 1;

  const terms = q.gold.mustContain || [];
  const missingTerms = terms.filter((term) => !answer.toLocaleLowerCase().includes(String(term).toLocaleLowerCase()));
  const keywordPass = missingTerms.length === 0;
  checks.push({ name: '答案包含 gold.mustContain', pass: keywordPass, detail: missingTerms.length ? `缺少 ${missingTerms.join('、')}` : `${terms.length}/${terms.length}` });
  if (keywordPass) score += 2;

  // 幻觉硬伤：编造检索过程长篇空转
  const processDump = /我(先|将)?(使用|调用)(了)?(工具|search)/.test(answer) && answer.length < 80;
  if (processDump) score = Math.max(0, score - 2);

  const signatures = toolCalls.map((step) => `${canonicalTool(step.tool)}|${JSON.stringify(step.input || {})}`);
  const duplicateCalls = signatures.filter((signature, index) => signatures.indexOf(signature) !== index);
  const noDuplicateCalls = duplicateCalls.length === 0;
  checks.push({ name: '无完全重复工具调用', pass: noDuplicateCalls, detail: duplicateCalls.join('、') || undefined });
  if (!noDuplicateCalls) score = Math.max(0, score - 2);

  const citedIds = [...answer.matchAll(/\[E(\d+)\]/g)].map((match) => `E${match[1]}`);
  const sourceIds = new Set((result.sources || []).flatMap((source) => [source.id, ...(source.evidenceIds || [])]).filter(Boolean));
  const missingCitations = citedIds.filter((id) => !sourceIds.has(id));
  const citationsResolvable = missingCitations.length === 0;
  checks.push({ name: '引用编号可解析', pass: citationsResolvable, detail: missingCitations.join('、') || undefined });
  if (!citationsResolvable) score = Math.max(0, score - 2);

  const expectedSourceTypes = q.gold.expectedSourceTypes || [];
  const actualSourceTypes = new Set((result.sources || []).map((source) => source.sourceType));
  const sourceDomainsPass = expectedSourceTypes.every((type) => actualSourceTypes.has(type));
  if (expectedSourceTypes.length) {
    checks.push({
      name: '来源域符合题意',
      pass: sourceDomainsPass,
      detail: `期望 ${expectedSourceTypes.join('+')}，实际 ${[...actualSourceTypes].join('+') || '无'}`
    });
    if (!sourceDomainsPass) score = Math.max(0, score - 2);
  }

  const missingTools = (q.gold.mustTools || []).map(canonicalTool).filter((tool) => !tools.includes(tool));
  checks.push({ name: '使用 gold.mustTools', pass: missingTools.length === 0, detail: missingTools.join('、') || undefined });
  if (missingTools.length) score = Math.max(0, score - 2);

  const forbiddenUsed = (q.gold.forbiddenTools || []).map(canonicalTool).filter((tool) => tools.includes(tool));
  checks.push({ name: '未使用 gold.forbiddenTools', pass: forbiddenUsed.length === 0, detail: forbiddenUsed.join('、') || undefined });
  if (forbiddenUsed.length) score = Math.max(0, score - 2);

  const refusalPass = q.gold.expectedRefusal ? emptyGraceful : !emptyGraceful || (result.sources?.length || 0) > 0;
  checks.push({ name: '符合 gold.expectedRefusal', pass: refusalPass, detail: `期望 ${q.gold.expectedRefusal}` });
  if (!refusalPass) score = Math.max(0, score - 2);

  if (isBoundary && (result.sources?.length || 0) > 0) {
    checks.push({ name: '拒答未附无关来源', pass: false, detail: `${result.sources.length} 个来源` });
    score = Math.max(0, score - 2);
  }

  score = Math.min(max, score);
  const grade = score >= 8 ? 'good' : score >= 5 ? 'ok' : 'weak';
  return { score, max, grade, checks, tools, thoughtCount: thoughts.length, stepCount: steps.length };
}

async function askChat(base, question) {
  const started = Date.now();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, messages: [], mode: 'agent' }),
    signal: AbortSignal.timeout(180_000)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const steps = [];
  const statuses = [];
  let answer = '';
  let meta = {};
  let doneMetrics = {};
  let error = '';

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (evt.type === 'agent_step' && evt.step) steps.push(evt.step);
      else if (evt.type === 'status') statuses.push({ phase: evt.phase, detail: evt.detail });
      else if (evt.type === 'chunk') answer += evt.content || '';
      else if (evt.type === 'meta') meta = { ...meta, ...evt };
      else if (evt.type === 'done') doneMetrics = evt.metrics || {};
      else if (evt.type === 'error') error = evt.error || 'unknown error';
    }
  }
  if (buffer.trim()) {
    try {
      const evt = JSON.parse(buffer.trim());
      if (evt.type === 'chunk') answer += evt.content || '';
      if (evt.type === 'error') error = evt.error || error;
    } catch {
      /* ignore */
    }
  }

  return {
    answer,
    steps,
    statuses,
    sources: meta.sources || [],
    graphSeedIds: meta.graphSeedIds || [],
    confidence: meta.confidence,
    intent: meta.intent,
    conversationId: meta.conversationId,
    trace: meta.trace || doneMetrics,
    error,
    durationMs: Date.now() - started
  };
}

function formatChain(steps) {
  return steps.map((s) => {
    const head = `[${s.type}${s.tool ? `:${s.tool}` : ''}]`;
    const body = truncate(s.content, 280);
    const input = s.input ? ` args=${truncate(JSON.stringify(s.input), 160)}` : '';
    return `${head}${input} ${body}`.trim();
  });
}

function buildMarkdown(results) {
  const summary = {
    total: results.length,
    good: results.filter((r) => r.rubric.grade === 'good').length,
    ok: results.filter((r) => r.rubric.grade === 'ok').length,
    weak: results.filter((r) => r.rubric.grade === 'weak').length,
    errors: results.filter((r) => r.error).length,
    avgScore: results.length
      ? (results.reduce((a, r) => a + r.rubric.score, 0) / results.length).toFixed(2)
      : '0',
    avgMs: results.length
      ? Math.round(results.reduce((a, r) => a + r.durationMs, 0) / results.length)
      : 0
  };

  const lines = [
    '# 电元系统 20 题问答+思维链评测',
    '',
    `测试时间：${new Date().toISOString()}`,
    '',
    '## 总览',
    '',
    `| 指标 | 值 |`,
    `|---|---|`,
    `| 题数 | ${summary.total} |`,
    `| 良好 / 一般 / 偏弱 | ${summary.good} / ${summary.ok} / ${summary.weak} |`,
    `| 平均分 ( /10 ) | ${summary.avgScore} |`,
    `| 平均耗时 | ${summary.avgMs} ms |`,
    `| 接口错误 | ${summary.errors} |`,
    '',
    '## 逐题结果',
    ''
  ];

  for (const r of results) {
    lines.push(`### Q${r.id} · ${r.category} · ${r.rubric.grade} (${r.rubric.score}/10)`);
    lines.push('');
    lines.push(`**能力**：${r.capability}`);
    lines.push('');
    lines.push(`**问题**：${r.question}`);
    lines.push('');
    lines.push(`- 耗时：${r.durationMs} ms`);
    lines.push(`- confidence：${r.confidence || '-'} · intent：${r.intent || '-'}`);
    lines.push(`- 工具：${r.rubric.tools.join(' → ') || '无'}`);
    lines.push(`- 步骤数：${r.rubric.stepCount}（thought ${r.rubric.thoughtCount}）`);
    lines.push(`- 来源数：${r.sources?.length || 0}`);
    if (r.error) lines.push(`- **错误**：${r.error}`);
    lines.push('');
    lines.push('**评分检查**');
    for (const c of r.rubric.checks) {
      lines.push(`- ${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
    }
    lines.push('');
    lines.push('**思维链摘要**');
    lines.push('');
    lines.push('```');
    lines.push((r.chainPreview || ['（无）']).join('\n'));
    lines.push('```');
    lines.push('');
    lines.push('**回答摘要**');
    lines.push('');
    lines.push(truncate(r.answer, 800) || '（空）');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push('## 系统表现结论');
  lines.push('');
  lines.push('（由脚本自动生成骨架；详见同目录 report.json 完整字段）');
  lines.push('');
  return { markdown: lines.join('\n'), summary };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const golden = loadGolden();
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  let questions = rows.map((r) => ({
    id: Number(r.id),
    category: r.category,
    capability: r.capability,
    question: r.question,
    design_note: r.design_note,
    gold: golden.get(Number(r.id))
  }));
  const missingGold = questions.filter((q) => !q.gold).map((q) => q.id);
  if (missingGold.length) throw new Error(`domain golden 缺少题目: ${missingGold.join(', ')}`);

  if (opts.ids.length) {
    questions = questions.filter((q) => opts.ids.includes(q.id));
  } else {
    questions = questions.filter((q) => q.id >= opts.from && q.id <= opts.to);
  }

  console.log(`评测 ${questions.length} 题 · base=${opts.base}`);
  if (opts.reportOnly) {
    const existing = questions.map((q) => {
      const casePath = path.join(OUT_DIR, `q${String(q.id).padStart(2, '0')}.json`);
      if (!fs.existsSync(casePath)) throw new Error(`缺少逐题报告 ${casePath}；请先运行对应题目，或移除 --report-only`);
      const item = JSON.parse(fs.readFileSync(casePath, 'utf8'));
      return { ...item, rubric: scoreAnswer(q, item) };
    });
    const { markdown, summary } = buildMarkdown(existing);
    fs.writeFileSync(REPORT_JSON, JSON.stringify({ summary, results: existing }, null, 2), 'utf8');
    fs.writeFileSync(REPORT_MD, markdown, 'utf8');
    console.log('从逐题结果重建报告', summary);
    return;
  }
  const results = [];

  for (const q of questions) {
    process.stdout.write(`Q${q.id} ${q.category} … `);
    const casePath = path.join(OUT_DIR, `q${String(q.id).padStart(2, '0')}.json`);
    try {
      const raw = await askChat(opts.base, q.question);
      const rubric = scoreAnswer(q, raw);
      const item = {
        ...q,
        ...raw,
        chainPreview: formatChain(raw.steps).slice(0, 24),
        rubric
      };
      results.push(item);
      fs.writeFileSync(casePath, JSON.stringify(item, null, 2), 'utf8');
      console.log(`${rubric.grade} ${rubric.score}/10 ${raw.durationMs}ms tools=${rubric.tools.join(',') || '-'}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const item = {
        ...q,
        answer: '',
        steps: [],
        statuses: [],
        sources: [],
        error: message,
        durationMs: 0,
        chainPreview: [],
        rubric: { score: 0, max: 10, grade: 'weak', checks: [{ name: '执行成功', pass: false }], tools: [], thoughtCount: 0, stepCount: 0 }
      };
      results.push(item);
      fs.writeFileSync(casePath, JSON.stringify(item, null, 2), 'utf8');
      console.log(`ERROR ${message}`);
    }

    // 增量写总报告，避免中断丢结果
    const { markdown, summary } = buildMarkdown(results);
    fs.writeFileSync(REPORT_JSON, JSON.stringify({ summary, results }, null, 2), 'utf8');
    fs.writeFileSync(REPORT_MD, markdown, 'utf8');
  }

  const { summary } = buildMarkdown(results);
  console.log('\n完成', summary);
  console.log('报告:', REPORT_MD);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
