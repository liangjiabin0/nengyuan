/**
 * 无 LLM 的检索层探测：评估 20 题在库内是否有支撑证据
 * 用法: node scripts/eval-domain-20-retrieval.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CSV_PATH = path.join(ROOT, 'outputs', 'domain-qa-20-questions.csv');
const OUT = path.join(ROOT, 'outputs', 'eval-domain-20', 'retrieval-probe.json');
const BASE = process.env.EVAL_BASE || 'http://localhost:3000';

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
      } else if (ch === '"') inQuotes = false;
      else field += ch;
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

const QUERY_PLAN = {
  1: ['匹配控制', '匹配控制 构网', '匹配控制型构网变流器'],
  2: ['SiC 变换器', '高频 SiC', 'SiC MOSFET', '高频 DAB'],
  3: ['SiC MOSFET', 'Si/SiC 混合器件', 'SiC 热管理'],
  4: ['构网型变流器', '构网型控制', '跟网 构网'],
  5: ['匹配控制 专利', '匹配控制型构网', '构网型变流器匹配控制'],
  6: ['匹配控制', '匹配控制 LCC-HVDC', '匹配控制 储能'],
  7: ['电力电子 变换器 导师', '宽禁带 导师', '新能源并网控制'],
  8: ['上海交通大学 电气工程学院', '上海交通大学 电力电子'],
  9: ['论文', '导师'], // 统计题，检索仅作对照
  10: ['国产 6.5 kV SiC MOSFET', '6.5 kV/400 A SiC'],
  11: ['匹配控制构网型直驱风电场', '次同步振荡 LCC-HVDC'],
  12: ['跟网型 构网型', '跟网型和构网型变流器'],
  13: ['VSG', '虚拟同步机', '虚拟惯量'],
  14: ['MMC', '柔性直流', 'MMC 直流故障穿越'],
  15: ['虚拟电厂', '虚拟电厂 优化调度'],
  16: ['高频变压器', '高频 DAB 变换器'],
  17: ['匹配控制构网型直驱风电场经LCC-HVDC', '高本锋'],
  18: ['构网型变流器', '匹配控制'],
  19: ['SiC MOSFET', 'SiC 热管理', '高频变换器'],
  20: ['量子纠缠超导芯片纳米材料']
};

async function search(q, limit = 8) {
  const url = `${BASE}/api/search?q=${encodeURIComponent(q)}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`search ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

function supportLevel(id, allHits) {
  const n = allHits.length;
  if (id === 20) {
    // 期望弱相关/无
    const strong = allHits.filter((h) => /量子|超导|纳米/.test(`${h.title}${h.snippet || ''}`)).length;
    return { level: strong === 0 ? 'expected_empty' : 'unexpected_hits', hitCount: n, strong };
  }
  if (id === 9) return { level: 'stats_question', hitCount: n };
  if (n >= 5) return { level: 'strong', hitCount: n };
  if (n >= 2) return { level: 'moderate', hitCount: n };
  if (n >= 1) return { level: 'weak', hitCount: n };
  return { level: 'none', hitCount: 0 };
}

async function main() {
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  const results = [];
  for (const row of rows) {
    const id = Number(row.id);
    const queries = QUERY_PLAN[id] || [row.question.slice(0, 40)];
    const merged = [];
    const seen = new Set();
    for (const q of queries) {
      const hits = await search(q, 6);
      for (const h of hits) {
        const key = `${h.sourceType}:${h.sourceKey || h.recordId || h.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({
          query: q,
          sourceType: h.sourceType,
          title: h.title,
          score: h.score,
          snippet: String(h.snippet || '').slice(0, 160)
        });
      }
    }
    const support = supportLevel(id, merged);
    const item = {
      id,
      category: row.category,
      capability: row.capability,
      question: row.question,
      queries,
      support,
      topHits: merged.slice(0, 10)
    };
    results.push(item);
    console.log(
      `Q${id} ${support.level} hits=${merged.length} types=${[...new Set(merged.map((m) => m.sourceType))].join(',') || '-'}`
    );
  }

  const summary = {
    testedAt: new Date().toISOString(),
    base: BASE,
    counts: {
      strong: results.filter((r) => r.support.level === 'strong').length,
      moderate: results.filter((r) => r.support.level === 'moderate').length,
      weak: results.filter((r) => r.support.level === 'weak').length,
      none: results.filter((r) => r.support.level === 'none').length,
      expected_empty: results.filter((r) => r.support.level === 'expected_empty').length,
      stats_question: results.filter((r) => r.support.level === 'stats_question').length
    },
    results
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2), 'utf8');
  console.log('\nsummary', summary.counts);
  console.log('wrote', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
