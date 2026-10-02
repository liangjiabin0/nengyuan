import fs from 'node:fs';
import path from 'node:path';
import { lossDirs } from './loss';
import { readWorkspaceJson } from './workspace';

export type LossPreviewKind = 'excel' | 'chart' | 'html';

export type LossPreviewFile = {
  id: string;
  kind: LossPreviewKind;
  title: string;
  name: string;
  relative: string;
  size: number;
  mediaType: string;
};

const CATALOG: Array<{ id: string; kind: LossPreviewKind; relative: string; title: string }> = [
  { id: 'excel', kind: 'excel', relative: '线损统计汇总.xlsx', title: 'Excel 汇总' },
  { id: 'chart-1', kind: 'chart', relative: 'charts/chart_01_loss_distribution.png', title: '损耗分布图' },
  { id: 'chart-2', kind: 'chart', relative: 'charts/chart_02_time_series.png', title: '时序损耗趋势' },
  { id: 'chart-3', kind: 'chart', relative: 'charts/chart_03_ranking.png', title: '设备损耗排名' },
  { id: 'chart-4', kind: 'chart', relative: 'charts/chart_04_voltage_current.png', title: '电压电流趋势' },
  { id: 'html', kind: 'html', relative: '线损分析报告.html', title: 'HTML 报告' }
];

const MEDIA: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8'
};

function outputRoot(sessionId: string, ideaId: string) {
  return path.resolve(lossDirs(sessionId, ideaId).outputDir);
}

export function safeLossOutputPath(sessionId: string, ideaId: string, relative: string) {
  const root = outputRoot(sessionId, ideaId);
  const normalized = String(relative || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0') || /(^|\/)\.\.(\/|$)/.test(normalized)) {
    throw new Error('无效的产物路径。');
  }
  const allowed = new Set(CATALOG.map((item) => item.relative));
  if (!allowed.has(normalized)) throw new Error('该产物不支持在线预览。');
  const filePath = path.resolve(fallbackPath(sessionId, ideaId, normalized) || path.join(root, normalized));
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (filePath !== root && !filePath.startsWith(prefix)) throw new Error('产物路径越界。');
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error('产物文件不存在。');
  return filePath;
}

function fallbackPath(sessionId: string, ideaId: string, relative: string) {
  const stored = readWorkspaceJson(sessionId, ideaId, 'result.json');
  const record = stored && typeof stored === 'object' ? stored as Record<string, unknown> : null;
  const results = record?.results && typeof record.results === 'object'
    ? record.results as Record<string, unknown>
    : {};
  const base = path.basename(relative);
  const candidates = [
    path.join(outputRoot(sessionId, ideaId), relative),
    typeof results.excelSummary === 'string' ? results.excelSummary : '',
    typeof results.htmlReport === 'string' ? results.htmlReport : '',
    ...(Array.isArray(results.charts) ? results.charts.filter((item): item is string => typeof item === 'string') : [])
  ];
  return candidates.find((item) => item && path.basename(item) === base && fs.existsSync(item) && fs.statSync(item).isFile()) || '';
}

export function listLossPreviewFiles(sessionId: string, ideaId: string): LossPreviewFile[] {
  return CATALOG.flatMap((item) => {
    const filePath = fallbackPath(sessionId, ideaId, item.relative);
    if (!filePath) return [];
    const ext = path.extname(filePath).toLowerCase();
    return [{
      id: item.id,
      kind: item.kind,
      title: item.title,
      name: path.basename(filePath),
      relative: item.relative,
      size: fs.statSync(filePath).size,
      mediaType: MEDIA[ext] || 'application/octet-stream'
    }];
  });
}

export function lossPreviewFileUrl(sessionId: string, ideaId: string, relative: string, extra = '') {
  const query = new URLSearchParams({ ideaId, file: relative });
  if (extra) {
    const more = extra.startsWith('?') ? extra.slice(1) : extra;
    for (const [key, value] of new URLSearchParams(more)) query.set(key, value);
  }
  return `/api/virtual-sim/${sessionId}/artifact?${query.toString()}`;
}
