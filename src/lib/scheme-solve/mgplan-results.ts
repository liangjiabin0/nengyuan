import fs from 'node:fs';
import path from 'node:path';
import { MGPLAN_CASE } from './mgplan';
import {
  listConfigFiles,
  listOutputFiles,
  mgplanConfigDir,
  mgplanOutputDir,
  parseCsvText,
  readSmallTables
} from './mgplan-case';
import { getSchemeIdea, listSchemeIdeas, listSchemeStages } from './store';
import type { SchemeIdea, SchemeStage } from './types';
import { listIdeaReportFiles, readWorkspaceJson, schemeIdeaDirectory, writeWorkspaceText } from './workspace';

export type MgplanKpi = {
  key: string;
  label: string;
  value: number | string | null;
  unit?: string;
};

export type MgplanChart = {
  key: string;
  title: string;
  kind: 'bar' | 'pie' | 'line';
  x: string[];
  series: Array<{ name: string; data: number[] }>;
};

export type MgplanAsset = {
  name: string;
  kind: 'image' | 'html' | 'csv' | 'other';
  label: string;
  url: string;
};

export type MgplanProcessInfo = {
  assumptions: Array<{ name: string; value: string }>;
  modelFiles: string[];
  outputFiles: string[];
  solve: {
    status: string;
    engine: string;
    objective: number | null;
    elapsedSeconds: number | null;
    fixture: boolean;
  };
  constraints: string[];
  timeline: Array<{ key: string; label: string; status: string; headline: string; updatedAt?: string }>;
};

export type MgplanCompareRow = {
  ideaId: string;
  title: string;
  fixture: boolean;
  kpis: Record<string, number | string | null>;
};

export type MgplanResultPayload = {
  ideaId: string;
  title: string;
  fixture: boolean;
  ready: boolean;
  healthHint?: string;
  kpis: MgplanKpi[];
  tables: {
    costSummary: Array<Record<string, string>>;
    investment: Array<Record<string, string>>;
    evaluations: Array<Record<string, string>>;
    evaluationsEco: Array<Record<string, string>>;
  };
  charts: MgplanChart[];
  assets: MgplanAsset[];
  process: MgplanProcessInfo;
  compare: MgplanCompareRow[];
  markdown: {
    design: string;
    report: string;
    reviewSmall: string;
    reviewLarge: string;
    results: string;
  };
  result: Record<string, unknown> | null;
};

const META_COLS = /^(Period|Scenario|LoadLevel|Technology|GeneratingUnit|Node)$/i;

function readCsvRows(filePath: string) {
  if (!fs.existsSync(filePath)) return { headers: [] as string[], rows: [] as string[][] };
  return parseCsvText(fs.readFileSync(filePath, 'utf8'));
}

function toNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function evalMap(rows: Array<Record<string, string>>) {
  const map = new Map<string, { name: string; value: number | null; unit: string }>();
  for (const row of rows) {
    const metric = row.metric || row.name || '';
    if (!metric) continue;
    map.set(metric, {
      name: row.name || metric,
      value: toNumber(row.value),
      unit: row.unit || ''
    });
  }
  return map;
}

function csvRecords(filePath: string) {
  const parsed = readCsvRows(filePath);
  return parsed.rows.map((row) => {
    const record: Record<string, string> = {};
    parsed.headers.forEach((header, index) => {
      record[header] = row[index] || '';
    });
    return record;
  });
}

function loadLevelDate(value: string) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || '';
}

function isoWeek(dateText: string) {
  const date = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateText;
  const target = new Date(date.valueOf());
  const day = (date.getDay() + 6) % 7;
  target.setDate(target.getDate() - day + 3);
  const first = new Date(target.getFullYear(), 0, 4);
  const week = 1 + Math.round((target.getTime() - first.getTime()) / 86400000 / 7);
  return `${target.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function aggregateTimeseries(
  filePath: string,
  mode: 'day' | 'week',
  options?: { splitSigned?: string }
) {
  const parsed = readCsvRows(filePath);
  const timeIndex = parsed.headers.findIndex((header) => /LoadLevel/i.test(header));
  if (timeIndex < 0) return { x: [] as string[], series: [] as Array<{ name: string; data: number[] }> };
  const valueCols = parsed.headers
    .map((header, index) => ({ header, index }))
    .filter(({ header, index }) => index !== timeIndex && !META_COLS.test(header));
  const buckets = new Map<string, number[]>();
  for (const row of parsed.rows) {
    const stamp = loadLevelDate(row[timeIndex] || '');
    if (!stamp) continue;
    const key = mode === 'week' ? isoWeek(stamp) : stamp;
    const current = buckets.get(key) || valueCols.flatMap((col) => {
      if (options?.splitSigned === col.header) return [0, 0];
      return [0];
    });
    let offset = 0;
    for (const col of valueCols) {
      const value = toNumber(row[col.index] || '') || 0;
      if (options?.splitSigned === col.header) {
        current[offset] = (current[offset] || 0) + Math.max(value, 0);
        current[offset + 1] = (current[offset + 1] || 0) + Math.min(value, 0);
        offset += 2;
      } else {
        current[offset] = (current[offset] || 0) + value;
        offset += 1;
      }
    }
    buckets.set(key, current);
  }
  const x = [...buckets.keys()].sort();
  const names = valueCols.flatMap((col) =>
    options?.splitSigned === col.header ? [`${col.header}(正)`, `${col.header}(负)`] : [col.header]
  );
  const series = names.map((name, index) => ({
    name,
    data: x.map((key) => Number((buckets.get(key)?.[index] || 0).toFixed(4)))
  }));
  return { x, series };
}

function formatMoney(value: number | null, digits = 2) {
  if (value == null) return '—';
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

export function summarizeMgplanDir(outputDir: string, options?: { fixture?: boolean; elapsedSeconds?: number }) {
  const costSummary = csvRecords(path.join(outputDir, `oT_Result_CostSummary_${MGPLAN_CASE}.csv`));
  const investment = csvRecords(path.join(outputDir, `oT_Result_GenerationInvestment_${MGPLAN_CASE}.csv`));
  const evaluations = csvRecords(path.join(outputDir, `oT_Result_Evaluations_${MGPLAN_CASE}.csv`));
  const evaluationsEco = csvRecords(path.join(outputDir, `oT_Result_EvaluationsEco_${MGPLAN_CASE}.csv`));
  const objective = costSummary.reduce((sum, row) => sum + (toNumber(row.CNY) || 0), 0);
  return {
    ok: true,
    engine: 'openTEPES',
    case: MGPLAN_CASE,
    status: options?.fixture ? 'fixture' : 'optimal',
    objective: Number(objective.toFixed(4)),
    fixture: Boolean(options?.fixture),
    elapsedSeconds: options?.elapsedSeconds ?? null,
    costSummary,
    investment,
    evaluations,
    evaluationsEco,
    outputFiles: listOutputFiles(outputDir)
  };
}

export function buildMgplanKpis(result: Record<string, unknown>): MgplanKpi[] {
  const investment = Array.isArray(result.investment) ? result.investment as Array<Record<string, string>> : [];
  const cost = Array.isArray(result.costSummary) ? result.costSummary as Array<Record<string, string>> : [];
  const ev = evalMap(Array.isArray(result.evaluations) ? result.evaluations as Array<Record<string, string>> : []);
  const eco = evalMap(Array.isArray(result.evaluationsEco) ? result.evaluationsEco as Array<Record<string, string>> : []);
  const costOf = (label: string) => toNumber(cost.find((row) => String(row['Cost/Payment'] || '').includes(label))?.CNY);
  const investMw = investment.reduce((sum, row) => sum + (toNumber(row.MW) || 0), 0);
  const investCny = investment.reduce((sum, row) => sum + (toNumber(row.CNY) || 0), 0);
  return [
    { key: 'investMw', label: '储能/电源新增容量', value: investMw, unit: 'MW' },
    { key: 'investCny', label: '电源投资', value: investCny, unit: 'CNY' },
    { key: 'om', label: '运维成本', value: costOf('运维'), unit: 'CNY' },
    { key: 'spill', label: '弃风/弃光成本', value: costOf('弃'), unit: 'CNY' },
    { key: 'gridBuy', label: '年购电成本', value: eco.get('cost_grid_purchase')?.value ?? null, unit: eco.get('cost_grid_purchase')?.unit },
    { key: 'gridUp', label: '总外送电量', value: ev.get('grid_up_sum')?.value ?? null, unit: ev.get('grid_up_sum')?.unit },
    { key: 'gridDown', label: '总受入电量', value: ev.get('grid_down_sum')?.value ?? null, unit: ev.get('grid_down_sum')?.unit },
    { key: 'essCharge', label: '储能总充电量', value: ev.get('ess_total_charge')?.value ?? null, unit: ev.get('ess_total_charge')?.unit },
    { key: 'essDischarge', label: '储能总放电量', value: ev.get('ess_total_discharge')?.value ?? null, unit: ev.get('ess_total_discharge')?.unit },
    { key: 'objective', label: '综合成本', value: toNumber(result.objective), unit: 'CNY' }
  ];
}

export function buildResultsMarkdown(idea: SchemeIdea, result: Record<string, unknown>) {
  const kpis = buildMgplanKpis(result);
  const cost = Array.isArray(result.costSummary) ? result.costSummary as Array<Record<string, string>> : [];
  const investment = Array.isArray(result.investment) ? result.investment as Array<Record<string, string>> : [];
  const ev = Array.isArray(result.evaluations) ? result.evaluations as Array<Record<string, string>> : [];
  const eco = Array.isArray(result.evaluationsEco) ? result.evaluationsEco as Array<Record<string, string>> : [];
  const fixture = result.fixture === true;
  const lines = [
    `# ${idea.title} · 规划结果解读`,
    '',
    fixture ? '> 当前展示的是 zip 样例输出，尚未用本机 Gurobi 重算。' : '> 数字来自本次 openTEPES 求解输出。',
    '',
    '## 投资',
    investment.length
      ? investment.map((row) =>
        `- ${row.GeneratingUnit || '机组'}：新增 ${row.MW || '0'} MW，投资 ${formatMoney(toNumber(row.CNY))} CNY`
      ).join('\n')
      : '- 无电源/储能投资记录',
    '',
    '## 成本构成',
    cost.length
      ? cost.map((row) => `- ${row['Cost/Payment'] || '成本'}：${formatMoney(toNumber(row.CNY))} CNY`).join('\n')
      : '- 无成本汇总',
    '',
    `综合成本（目标值）：**${formatMoney(toNumber(result.objective))} CNY**`,
    '',
    '## 储能',
    `- 新增容量：${kpis.find((item) => item.key === 'investMw')?.value ?? '—'} MW`,
    `- 总充电量：${kpis.find((item) => item.key === 'essCharge')?.value ?? '—'} MWh`,
    `- 总放电量：${kpis.find((item) => item.key === 'essDischarge')?.value ?? '—'} MWh`,
    '',
    '## 购售电',
    `- 总外送：${kpis.find((item) => item.key === 'gridUp')?.value ?? '—'} MWh`,
    `- 总受入：${kpis.find((item) => item.key === 'gridDown')?.value ?? '—'} MWh`,
    `- 年购电成本：${kpis.find((item) => item.key === 'gridBuy')?.value ?? '—'} 万元`,
    '',
    '## 弃电与运维',
    `- 运维成本：${formatMoney(toNumber(kpis.find((item) => item.key === 'om')?.value))} CNY`,
    `- 弃风/弃光成本：${formatMoney(toNumber(kpis.find((item) => item.key === 'spill')?.value))} CNY`,
    '',
    '## 技术评价',
    ev.slice(0, 16).map((row) => `- ${row.name || row.metric}：${row.value ?? '—'}${row.unit ? ` ${row.unit}` : ''}`).join('\n'),
    '',
    '## 经济评价',
    eco.map((row) => `- ${row.name || row.metric}：${row.value ?? '—'}${row.unit ? ` ${row.unit}` : ''}`).join('\n'),
    ''
  ];
  return lines.filter((line) => line !== undefined).join('\n');
}

export async function writeMgplanResultJson(
  sessionId: string,
  ideaId: string,
  result: Record<string, unknown>
) {
  const idea = await getSchemeIdea(ideaId);
  const markdown = idea ? buildResultsMarkdown(idea, result) : '';
  writeWorkspaceText(sessionId, ideaId, 'result.json', `${JSON.stringify(result, null, 2)}\n`);
  if (markdown) writeWorkspaceText(sessionId, ideaId, 'RESULTS.md', `${markdown}\n`);
  return { result, markdown };
}

function buildCharts(outputDir: string, result: Record<string, unknown>, mode: 'day' | 'week'): MgplanChart[] {
  const cost = Array.isArray(result.costSummary) ? result.costSummary as Array<Record<string, string>> : [];
  const investment = Array.isArray(result.investment) ? result.investment as Array<Record<string, string>> : [];
  const tech = aggregateTimeseries(path.join(outputDir, `oT_Result_TechnologyEnergy_${MGPLAN_CASE}.csv`), mode, { splitSigned: 'Grid' });
  const ess = aggregateTimeseries(path.join(outputDir, `oT_Result_ESSChargeDischarge_${MGPLAN_CASE}.csv`), mode);
  const loss = aggregateTimeseries(path.join(outputDir, `oT_Result_NetworkPloss_${MGPLAN_CASE}.csv`), mode);
  const ens = aggregateTimeseries(path.join(outputDir, `oT_Result_NetworkENS_${MGPLAN_CASE}.csv`), mode);
  const charts: MgplanChart[] = [
    {
      key: 'cost',
      title: '成本构成',
      kind: 'bar',
      x: cost.map((row) => row['Cost/Payment'] || ''),
      series: [{ name: 'CNY', data: cost.map((row) => toNumber(row.CNY) || 0) }]
    },
    {
      key: 'investment',
      title: '电源/储能投资',
      kind: 'bar',
      x: investment.map((row) => row.GeneratingUnit || ''),
      series: [
        { name: 'MW', data: investment.map((row) => toNumber(row.MW) || 0) },
        { name: 'CNY', data: investment.map((row) => toNumber(row.CNY) || 0) }
      ]
    }
  ];
  if (tech.x.length) charts.push({ key: 'technology', title: `技术出力/电量（按${mode === 'week' ? '周' : '日'}聚合）`, kind: 'line', ...tech });
  if (ess.x.length) charts.push({ key: 'ess', title: `储能充放电（按${mode === 'week' ? '周' : '日'}聚合）`, kind: 'line', ...ess });
  if (tech.x.length) {
    const grid = tech.series.filter((item) => /Grid/.test(item.name));
    if (grid.length) charts.push({ key: 'grid', title: '购售电（电网交换）', kind: 'line', x: tech.x, series: grid });
  }
  if (loss.x.length || ens.x.length) {
    charts.push({
      key: 'lossEns',
      title: '网损 / 失供电',
      kind: 'line',
      x: loss.x.length ? loss.x : ens.x,
      series: [
        { name: '网损合计', data: (loss.x.length ? loss.x : ens.x).map((_, index) =>
          (loss.series.reduce((sum, item) => sum + (item.data[index] || 0), 0))) },
        { name: '失供电合计', data: (loss.x.length ? loss.x : ens.x).map((stamp, index) => {
          const ensIndex = ens.x.indexOf(stamp);
          return ens.series.reduce((sum, item) => sum + (item.data[ensIndex] || 0), 0);
        }) }
      ]
    });
  }
  return charts.filter((chart) => chart.x.some(Boolean));
}

function assetKind(name: string): MgplanAsset['kind'] {
  if (name.endsWith('.png') || name.endsWith('.jpg')) return 'image';
  if (name.endsWith('.html')) return 'html';
  if (name.endsWith('.csv')) return 'csv';
  return 'other';
}

function assetLabel(name: string) {
  if (name.includes('ESSSimulation')) return '储能仿真曲线';
  if (name.includes('MapNetwork')) return '网络地图';
  if (name.includes('CostSummary')) return '成本汇总';
  if (name.includes('GenerationInvestment')) return '投资结果';
  if (name.includes('EvaluationsEco')) return '经济评价';
  if (name.includes('Evaluations')) return '技术评价';
  return name;
}

async function buildProcess(sessionId: string, ideaId: string, result: Record<string, unknown> | null): Promise<MgplanProcessInfo> {
  const configDir = mgplanConfigDir(sessionId, ideaId);
  const outputDir = mgplanOutputDir(sessionId, ideaId);
  const tables = readSmallTables(configDir);
  const option = tables.find((item) => item.key === 'option');
  const parameter = tables.find((item) => item.key === 'parameter');
  const assumptions: Array<{ name: string; value: string }> = [];
  if (option?.headers.length && option.rows[0]) {
    option.headers.forEach((header, index) => assumptions.push({ name: `Option.${header}`, value: option.rows[0]![index] || '' }));
  }
  if (parameter?.headers.length && parameter.rows[0]) {
    parameter.headers.forEach((header, index) => assumptions.push({ name: `Parameter.${header}`, value: parameter.rows[0]![index] || '' }));
  }
  const stages = await listSchemeStages(sessionId, ideaId);
  const labels: Record<string, string> = {
    design: '设计',
    model: '建模',
    solve: '求解',
    review: '审查',
    write: '撰写',
    report: '报告'
  };
  return {
    assumptions,
    modelFiles: listConfigFiles(configDir),
    outputFiles: listOutputFiles(outputDir),
    solve: {
      status: String(result?.status || 'idle'),
      engine: String(result?.engine || 'openTEPES'),
      objective: toNumber(result?.objective),
      elapsedSeconds: toNumber(result?.elapsedSeconds),
      fixture: result?.fixture === true
    },
    constraints: [
      '目标：最小化投资 + 运行（购电/燃料/弃电/失供电惩罚）成本',
      '电源扩容按连续容量（IndBinGenInvest=0），不是 0-1 建/不建',
      '交流线路潮流与网损按算例 Network 表；TTC 与损耗系数来自模板',
      '储能充放电、库容与效率来自 Generation 表',
      'v1 不启用热系统 / 合成氨 / 数据中心扩展'
    ],
    timeline: (['design', 'model', 'solve', 'review', 'write', 'report'] as const).map((key) => {
      const stage = stages.find((item: SchemeStage) => item.key === key);
      return {
        key,
        label: labels[key] || key,
        status: stage?.status || 'idle',
        headline: stage?.headline || '',
        updatedAt: stage?.updatedAt
      };
    })
  };
}

function compareKpis(result: Record<string, unknown> | null) {
  const kpis = result ? buildMgplanKpis(result) : [];
  const pick = (key: string) => kpis.find((item) => item.key === key)?.value ?? null;
  return {
    investMw: pick('investMw'),
    investCny: pick('investCny'),
    om: pick('om'),
    spill: pick('spill'),
    gridBuy: pick('gridBuy'),
    gridUp: pick('gridUp'),
    gridDown: pick('gridDown'),
    essCharge: pick('essCharge'),
    essDischarge: pick('essDischarge'),
    objective: pick('objective')
  };
}

export async function buildMgplanCompare(sessionId: string): Promise<MgplanCompareRow[]> {
  return (await listSchemeIdeas(sessionId))
    .filter((idea) => idea.problemClass === 'mgplan' && idea.solvability === 'solvable')
    .map((idea) => {
      const result = readWorkspaceJson(sessionId, idea.id, 'result.json') as Record<string, unknown> | null;
      return {
        ideaId: idea.id,
        title: idea.title,
        fixture: result?.fixture === true,
        kpis: compareKpis(result)
      };
    });
}

export async function buildMgplanResults(sessionId: string, ideaId: string, aggregate: 'day' | 'week' = 'day'): Promise<MgplanResultPayload> {
  const idea = await getSchemeIdea(ideaId);
  if (!idea || idea.sessionId !== sessionId) throw new Error('想法不存在。');
  const outputDir = mgplanOutputDir(sessionId, ideaId);
  const stored = readWorkspaceJson(sessionId, ideaId, 'result.json') as Record<string, unknown> | null;
  const result = stored && typeof stored === 'object'
    ? stored
    : fs.existsSync(path.join(outputDir, `oT_Result_CostSummary_${MGPLAN_CASE}.csv`))
      ? summarizeMgplanDir(outputDir, { fixture: true })
      : null;
  const files = listIdeaReportFiles(sessionId, ideaId);
  const resultsPath = path.join(schemeIdeaDirectory(sessionId, ideaId), 'RESULTS.md');
  const resultsMd = fs.existsSync(resultsPath)
    ? fs.readFileSync(resultsPath, 'utf8')
    : result
      ? buildResultsMarkdown(idea, result)
      : '';
  const assets = listOutputFiles(outputDir).map((name) => ({
    name,
    kind: assetKind(name),
    label: assetLabel(name),
    url: `/api/scheme-solve/${sessionId}/mgplan/file?ideaId=${encodeURIComponent(ideaId)}&name=${encodeURIComponent(name)}`
  }));
  return {
    ideaId,
    title: idea.title,
    fixture: result?.fixture === true,
    ready: Boolean(result),
    kpis: result ? buildMgplanKpis(result) : [],
    tables: {
      costSummary: (result?.costSummary as Array<Record<string, string>>) || [],
      investment: (result?.investment as Array<Record<string, string>>) || [],
      evaluations: (result?.evaluations as Array<Record<string, string>>) || [],
      evaluationsEco: (result?.evaluationsEco as Array<Record<string, string>>) || []
    },
    charts: result ? buildCharts(outputDir, result, aggregate) : [],
    assets,
    process: await buildProcess(sessionId, ideaId, result),
    compare: await buildMgplanCompare(sessionId),
    markdown: {
      design: files.design,
      report: files.report,
      reviewSmall: files.reviewSmall,
      reviewLarge: files.reviewLarge,
      results: resultsMd
    },
    result
  };
}

export const MGPLAN_EXPORT_FILES = [
  `oT_Result_CostSummary_${MGPLAN_CASE}.csv`,
  `oT_Result_GenerationInvestment_${MGPLAN_CASE}.csv`,
  `oT_Result_Evaluations_${MGPLAN_CASE}.csv`,
  `oT_Result_EvaluationsEco_${MGPLAN_CASE}.csv`,
  `oT_Result_ESSChargeDischarge_${MGPLAN_CASE}.csv`,
  `oT_Result_TechnologyEnergy_${MGPLAN_CASE}.csv`,
  `oT_Result_NetworkPloss_${MGPLAN_CASE}.csv`,
  `oT_Result_NetworkENS_${MGPLAN_CASE}.csv`,
  `oT_Plot_ESSSimulation_${MGPLAN_CASE}.png`,
  `oT_Plot_MapNetwork_${MGPLAN_CASE}.html`
];
