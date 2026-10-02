import fs from 'node:fs';
import path from 'node:path';
import { buildMgplanResults } from '@/lib/scheme-solve/mgplan-results';
import { readWorkspaceJson, schemeIdeaDirectory } from '@/lib/scheme-solve/workspace';
import type { SchemeProblemClass } from '@/lib/scheme-solve/types';
import { getVirtualSimTool } from './tools';

export type SimKpi = { key: string; label: string; value: string; hint?: string };
export type SimChart = {
  key: string;
  title: string;
  kind: 'bar' | 'pie' | 'line';
  x: string[];
  series: Array<{ name: string; data: number[] }>;
};
export type SimTable = { key: string; title: string; columns: string[]; rows: string[][] };
export type SimViz = {
  ready: boolean;
  engine: string;
  summary: string;
  kpis: SimKpi[];
  charts: SimChart[];
  tables: SimTable[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function asNumArray(value: unknown): number[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const nums = value.map((item) => toNumber(item));
  if (nums.some((item) => item == null)) return null;
  return nums as number[];
}

function formatValue(value: unknown) {
  if (value == null || value === '') return '—';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : value.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
  }
  return String(value);
}

function formatCase(value: unknown) {
  const record = asRecord(value);
  if (!record) return value;
  return record.case_id ?? record.caseId ?? record.id ?? record.name;
}

function formatFidelity(value: unknown) {
  if (value === 'paper-compatible') return '论文兼容复现';
  if (value === 'adapted') return '适配实验';
  if (value === 'fallback') return '回退基线';
  if (value === 'not-executed') return '未执行';
  return value;
}

function formatWeightStatus(value: unknown) {
  if (value === 'loaded') return '仓库现成权重';
  if (value === 'trained') return '现场训练权重';
  if (value === 'fallback') return '回退模型';
  return value;
}

function kpi(key: string, label: string, value: unknown, hint?: string): SimKpi | null {
  if (value == null || value === '') return null;
  return { key, label, value: formatValue(value), hint };
}

function chartsFromSeries(series: unknown, title = '仿真时序'): SimChart[] {
  const rec = asRecord(series);
  if (!rec) return [];
  if (Array.isArray(rec.columns) && Array.isArray(rec.data)) {
    const columns = rec.columns.map((item) => String(item));
    const rows = rec.data.filter(Array.isArray) as unknown[][];
    const timeIndex = columns.findIndex((name) => /time/i.test(name));
    const x = rows.map((row, index) => String(timeIndex >= 0 ? row[timeIndex] : index));
    const seriesRows = columns.flatMap((name, col) => {
      if (col === timeIndex) return [];
      const data = rows.map((row) => toNumber(row[col]) || 0);
      return [{ name, data }];
    });
    return seriesRows.length ? [{ key: 'series', title, kind: 'line', x, series: seriesRows }] : [];
  }
  const time = asNumArray(rec.time) || asNumArray(rec.Time);
  const keys = Object.keys(rec).filter((key) => key.toLowerCase() !== 'time' && asNumArray(rec[key]));
  if (keys.length) {
    const length = Math.max(...keys.map((key) => asNumArray(rec[key])!.length), time?.length || 0);
    const x = (time || Array.from({ length }, (_, index) => index)).map((item) => String(item));
    return [{
      key: 'series',
      title,
      kind: 'line',
      x,
      series: keys.map((name) => ({ name, data: asNumArray(rec[name]) || [] }))
    }];
  }
  return [];
}

function chartsFromVariables(result: Record<string, unknown>): SimChart[] {
  const raw = result.variables ?? result.values ?? result.primal ?? result.solution;
  if (Array.isArray(raw)) {
    const rows = raw.flatMap((item) => {
      const row = asRecord(item);
      if (!row || typeof row.name !== 'string') return [];
      const value = toNumber(row.value ?? row.x ?? row.level);
      return value == null ? [] : [{ name: row.name, value }];
    });
    if (!rows.length) return [];
    const top = [...rows].sort((left, right) => Math.abs(right.value) - Math.abs(left.value)).slice(0, 24);
    return [{
      key: 'variables',
      title: '主要决策变量',
      kind: 'bar',
      x: top.map((row) => row.name),
      series: [{ name: '取值', data: top.map((row) => row.value) }]
    }];
  }
  const rec = asRecord(raw);
  if (!rec) return [];
  const rows = Object.entries(rec).flatMap(([name, value]) => {
    const num = toNumber(value);
    return num == null ? [] : [{ name, value: num }];
  });
  if (!rows.length) return [];
  const top = [...rows].sort((left, right) => Math.abs(right.value) - Math.abs(left.value)).slice(0, 24);
  return [{
    key: 'variables',
    title: '主要决策变量',
    kind: 'bar',
    x: top.map((row) => row.name),
    series: [{ name: '取值', data: top.map((row) => row.value) }]
  }];
}

function parseCsv(text: string, maxRows = 240): { columns: string[]; rows: string[][] } | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const columns = lines[0].split(/[,;\t]/).map((item) => item.trim());
  const rows = lines.slice(1, maxRows + 1).map((line) => line.split(/[,;\t]/).map((item) => item.trim()));
  return { columns, rows };
}

function chartsFromCsv(filePath: string, title: string): SimChart[] {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const parsed = parseCsv(fs.readFileSync(filePath, 'utf8'));
  if (!parsed) return [];
  const timeIndex = parsed.columns.findIndex((name) => /time|hour|t\b|stamp/i.test(name));
  const numeric = parsed.columns.flatMap((name, col) => {
    if (col === timeIndex) return [];
    const data = parsed.rows.map((row) => toNumber(row[col]));
    if (data.every((item) => item == null)) return [];
    return [{ name, data: data.map((item) => item || 0) }];
  });
  if (!numeric.length) return [];
  const x = parsed.rows.map((row, index) => String(timeIndex >= 0 ? row[timeIndex] : index));
  return [{ key: path.basename(filePath), title, kind: 'line', x, series: numeric }];
}

function tableFromRows(key: string, title: string, rows: Array<Record<string, unknown>>): SimTable | null {
  if (!rows.length) return null;
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 8);
  return {
    key,
    title,
    columns,
    rows: rows.slice(0, 24).map((row) => columns.map((column) => formatValue(row[column])))
  };
}

function genericViz(result: Record<string, unknown>, engine: string): SimViz {
  const values = asRecord(result.values);
  const kpis = [
    kpi('status', '状态', result.status ?? result.termination_status ?? result.terminationStatus),
    kpi('objective', '目标值', result.objective ?? result.objective_value),
    kpi('variables', '变量', result.n_variables),
    kpi('nonzero', '非零解', result.n_nonzero ?? (values ? Object.keys(values).length : undefined)),
    kpi('type', '问题类型', result.problemType),
    kpi('engine', '引擎', result.engine || engine)
  ].filter(Boolean) as SimKpi[];
  const charts = [
    ...chartsFromSeries(result.series || result.timeseries || result.curves),
    ...chartsFromVariables(result)
  ];
  return {
    ready: true,
    engine,
    summary: String(result.headline || result.message || result.status || '已拿到求解结果。'),
    kpis,
    charts,
    tables: []
  };
}

export async function buildVirtualSimViz(sessionId: string, ideaId: string, problemClass?: SchemeProblemClass): Promise<SimViz> {
  const tool = problemClass ? getVirtualSimTool(problemClass) : null;
  const engine = tool?.engine || '求解器';
  const empty: SimViz = { ready: false, engine, summary: '还没有可视化结果。开始仿真后会在这里展开曲线与指标。', kpis: [], charts: [], tables: [] };
  const stored = readWorkspaceJson(sessionId, ideaId, 'result.json');
  const result = asRecord(stored);
  if (!result) return empty;

  if (problemClass === 'mgplan') {
    try {
      const payload = await buildMgplanResults(sessionId, ideaId, 'day');
      return {
        ready: payload.ready,
        engine,
        summary: payload.fixture ? '当前为样例输出（求解环境未就绪时回退）。' : 'openTEPES 规划结果已落盘。',
        kpis: (payload.kpis || []).map((item) => ({
          key: item.key,
          label: item.label,
          value: formatValue(item.value),
          hint: item.unit
        })),
        charts: (payload.charts || []).map((chart) => ({
          key: chart.key,
          title: chart.title,
          kind: chart.kind,
          x: chart.x,
          series: chart.series
        })),
        tables: [
          tableFromRows('cost', '成本构成', payload.tables.costSummary),
          tableFromRows('investment', '投资', payload.tables.investment)
        ].filter(Boolean) as SimTable[]
      };
    } catch {
      return genericViz(result, engine);
    }
  }

  if (problemClass === 'modelica') {
    const series = result.series;
    const charts = chartsFromSeries(series, `${formatValue(result.model_name || 'Modelica')} 时序`);
    const rec = asRecord(series);
    const soc = rec ? asNumArray(rec.SOC || rec.soc) : null;
    return {
      ready: true,
      engine,
      summary: `${formatValue(result.model_name || '模型')} 仿真完成。`,
      kpis: [
        kpi('model', '模型', result.model_name),
        kpi('status', '状态', result.status),
        kpi('points', '采样点', charts[0]?.x.length),
        kpi('soc', '末端 SOC', soc?.at(-1))
      ].filter(Boolean) as SimKpi[],
      charts,
      tables: []
    };
  }

  if (problemClass === 'forecast') {
    const metrics = asRecord(result.metrics) || {};
    const ideaDir = schemeIdeaDirectory(sessionId, ideaId);
    const predict = String(result.predictCsv || '');
    const predictPath = predict && fs.existsSync(predict)
      ? predict
      : path.join(ideaDir, 'forecast', path.basename(predict || 'predict.csv'));
    return {
      ready: true,
      engine,
      summary: `${formatValue(result.kind || '源荷')} / ${formatValue(result.model || '模型')} 预测完成。`,
      kpis: [
        kpi('kind', '对象', result.kind),
        kpi('model', '模型', result.model),
        kpi('mae', 'MAE', metrics.mae ?? metrics.MAE),
        kpi('rmse', 'RMSE', metrics.rmse ?? metrics.RMSE),
        kpi('mape', 'MAPE', metrics.mape ?? metrics.MAPE),
        kpi('smape', 'SMAPE', metrics.smape ?? metrics.SMAPE),
        kpi('fidelity', '复现层级', formatFidelity(result.fidelity)),
        kpi('weights', '权重来源', formatWeightStatus(result.weightStatus)),
        kpi('status', '状态', result.status)
      ].filter(Boolean) as SimKpi[],
      charts: chartsFromCsv(predictPath, '预测曲线'),
      tables: []
    };
  }

  if (problemClass === 'loss') {
    const stats = asRecord(result.statistics) || {};
    const rows = Array.isArray(result.results)
      ? (result.results as Array<Record<string, unknown>>)
      : [];
    return {
      ready: true,
      engine,
      summary: `理论线损率 ${formatValue(result.lossRate ?? stats.lossRate)}。`,
      kpis: [
        kpi('lossRate', '线损率', result.lossRate ?? stats.lossRate),
        kpi('line', '线路损耗', stats.lineLoss ?? stats.line),
        kpi('transformer', '变压器损耗', stats.transformerLoss ?? stats.transformer),
        kpi('status', '状态', result.status)
      ].filter(Boolean) as SimKpi[],
      charts: [],
      tables: [tableFromRows('loss', '线损结果', rows)].filter(Boolean) as SimTable[]
    };
  }

  if (problemClass === 'acopf' || problemClass === 'dispatch') {
    const bundle = asRecord(result.bundle) || result;
    const periods = Array.isArray(bundle.periods) ? bundle.periods as Array<Record<string, unknown>> : [];
    const periodChart = periods.length
      ? [{
          key: 'periods',
          title: '分时段目标',
          kind: 'line' as const,
          x: periods.map((row, index) => String(row.period ?? row.name ?? index + 1)),
          series: [{ name: '目标', data: periods.map((row) => toNumber(row.objective) || 0) }]
        }]
      : [];
    return {
      ready: true,
      engine,
      summary: `${engine} 已返回 ${formatValue(result.status || 'success')}。`,
      kpis: [
        kpi('objective', '目标值', result.objective ?? result.objective_value),
        kpi('status', '状态', result.status),
        kpi('case', '算例', formatCase(result.case || bundle.case)),
        kpi('fixture', '样例回退', result.fixture === true ? '是' : undefined)
      ].filter(Boolean) as SimKpi[],
      charts: [...periodChart, ...chartsFromVariables(bundle), ...chartsFromSeries(bundle.series)],
      tables: [tableFromRows('periods', '时段结果', periods)].filter(Boolean) as SimTable[]
    };
  }

  return genericViz(result, engine);
}
