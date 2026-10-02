import fs from 'node:fs';
import path from 'node:path';
import { TDMG_ENGINE } from './tdmg';
import { hasTdmgOutput, listTdmgOutputFiles, tdmgOutputDir } from './tdmg-case';
import { getSchemeIdea } from './store';
import type { SchemeIdea } from './types';
import { writeWorkspaceText } from './workspace';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').replace(/,/g, '').trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function readJson(filePath: string) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function periodRows(summary: unknown): Array<Record<string, unknown>> {
  const root = asRecord(summary);
  if (!root) return [];
  const periods = root.periods;
  if (Array.isArray(periods)) {
    return periods.flatMap((item) => {
      const row = asRecord(item);
      return row ? [row] : [];
    });
  }
  const studies = root.studies;
  if (Array.isArray(studies)) {
    return studies.flatMap((study) => {
      const row = asRecord(study);
      const nested = row?.periods;
      if (Array.isArray(nested)) {
        return nested.flatMap((item) => {
          const period = asRecord(item);
          return period ? [period] : [];
        });
      }
      const scales = row?.time_scales;
      if (Array.isArray(scales)) {
        return scales.flatMap((scale) => {
          const item = asRecord(scale);
          const output = typeof item?.output === 'string' ? item.output : '';
          return output ? periodRows(readJson(path.join(output, 'summary.json'))) : [];
        });
      }
      return row ? [row] : [];
    });
  }
  return [];
}

function formatNum(value: number | null, digits = 4) {
  if (value == null) return '—';
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

export function summarizeTdmgDir(outputDir: string, options?: {
  caseName?: string;
  elapsedSeconds?: number;
  mode?: string;
}) {
  const summary = readJson(path.join(outputDir, 'summary.json'))
    || readJson(path.join(outputDir, 'portfolio_summary.json'))
    || readJson(path.join(outputDir, 'results', 'summary.json'))
    || readJson(path.join(outputDir, 'results', 'portfolio_summary.json'));
  const periods = periodRows(summary);
  const first = periods[0] || asRecord(summary) || {};
  const objectives = periods.map((row) => toNumber(row.objective)).filter((value): value is number => value != null);
  const objective = objectives.length
    ? objectives.reduce((sum, value) => sum + value, 0)
    : toNumber(first.objective);
  const allSuccess = periods.length
    ? periods.every((row) => {
      const solver = asRecord(row.solver);
      return row.success !== false && solver?.success !== false;
    })
    : Boolean(asRecord(summary)?.success === true);
  return {
    ok: allSuccess && objective != null,
    engine: TDMG_ENGINE,
    case: options?.caseName || '',
    status: allSuccess ? 'optimal' : 'failed',
    objective: objective == null ? null : Number(objective.toFixed(4)),
    mode: options?.mode || 'snapshot',
    elapsedSeconds: options?.elapsedSeconds ?? toNumber(asRecord(first.solver)?.elapsed_seconds),
    totalLoadMw: toNumber(first.total_load_p_mw),
    totalGenerationMw: toNumber(first.total_generation_p_mw),
    minVoltagePu: toNumber(first.min_voltage_pu),
    maxVoltagePu: toNumber(first.max_voltage_pu),
    maxBranchLoadingPercent: toNumber(first.max_branch_loading_percent),
    branchLossMw: toNumber(first.branch_active_loss_mw),
    periods,
    outputFiles: listTdmgOutputFiles(outputDir)
  };
}

export function buildTdmgResultsMarkdown(idea: SchemeIdea, result: Record<string, unknown>) {
  const periods = Array.isArray(result.periods) ? result.periods as Array<Record<string, unknown>> : [];
  const lines = [
    `# ${idea.title} · 交流最优潮流结果`,
    '',
    `> 数字来自本次 TDMG / PYPOWER AC-OPF（${result.case || '未标注算例'}）。`,
    '',
    '## 目标',
    `- 发电成本：**${formatNum(toNumber(result.objective))}**`,
    `- 求解状态：${result.status || 'unknown'}`,
    '',
    '## 电气摘要',
    `- 总负荷：${formatNum(toNumber(result.totalLoadMw))} MW`,
    `- 总出力：${formatNum(toNumber(result.totalGenerationMw))} MW`,
    `- 最低电压：${formatNum(toNumber(result.minVoltagePu))} p.u.`,
    `- 最高电压：${formatNum(toNumber(result.maxVoltagePu))} p.u.`,
    `- 最大支路负载率：${formatNum(toNumber(result.maxBranchLoadingPercent))} %`,
    `- 有功网损：${formatNum(toNumber(result.branchLossMw))} MW`,
    '',
    periods.length > 1 ? '## 分时段' : '',
    periods.length > 1
      ? periods.map((row) => `- ${row.period || 'period'}：目标 ${formatNum(toNumber(row.objective))}，负荷 ${formatNum(toNumber(row.total_load_p_mw))} MW`)
        .join('\n')
      : '',
    '',
    '## 产物',
    '- `tdmg/output/summary.json`：KPI 与区域交换',
    '- `tdmg/output/dispatch.csv`：机组 / DER 有功无功',
    '- `tdmg/output/buses.csv`：电压与节点电价',
    '- `tdmg/output/branches.csv`：支路潮流与负载率',
    ''
  ];
  return lines.filter((line) => line !== undefined).join('\n');
}

export async function writeTdmgResultJson(
  sessionId: string,
  ideaId: string,
  result: Record<string, unknown>
) {
  const idea = await getSchemeIdea(ideaId);
  const markdown = idea ? buildTdmgResultsMarkdown(idea, result) : '';
  writeWorkspaceText(sessionId, ideaId, 'result.json', `${JSON.stringify(result, null, 2)}\n`);
  if (markdown) writeWorkspaceText(sessionId, ideaId, 'RESULTS.md', `${markdown}\n`);
  return { result, markdown };
}

export function readTdmgSolveResult(sessionId: string, ideaId: string) {
  const outputDir = tdmgOutputDir(sessionId, ideaId);
  if (!hasTdmgOutput(outputDir)) return null;
  return summarizeTdmgDir(outputDir);
}
