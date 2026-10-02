import type { DbSummaryPayload } from '@/lib/db-summary';
import { formatNumber } from '@/lib/utils';

export type MetricSlice = {
  key: string;
  label: string;
  value: number;
  color: string;
  hint?: string;
};

export function metricValue(value: number | undefined | null) {
  return Number(value) || 0;
}

export function formatCompact(value: number) {
  const abs = Math.abs(value);
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (abs >= 10_000) {
    const wan = value / 10_000;
    return `${wan >= 100 ? wan.toFixed(0) : wan.toFixed(1).replace(/\.0$/, '')}万`;
  }
  return formatNumber(value);
}

export function formatUpdatedAt(iso?: string) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

export function getCorpusSlices(data: DbSummaryPayload | null): MetricSlice[] {
  return [
    { key: 'papers', label: '论文', value: metricValue(data?.papers), color: '#0284c7', hint: '期刊与会议文献' },
    { key: 'patents', label: '专利', value: metricValue(data?.patents), color: '#7c3aed', hint: '发明专利文本' },
    { key: 'books', label: '书籍', value: metricValue(data?.books ?? data?.whitepapers), color: '#0d9488', hint: '行业书籍' },
    { key: 'mentors', label: '导师', value: metricValue(data?.mentors), color: '#d97706', hint: '导师档案' },
    { key: 'projects', label: '项目', value: metricValue(data?.stats.projects), color: '#2563eb', hint: '归一化项目主表' },
    { key: 'outputs', label: '成果', value: metricValue(data?.stats.outputs), color: '#db2777', hint: '科研产出记录' }
  ];
}

export function getDiskSlices(data: DbSummaryPayload | null): MetricSlice[] {
  const disk = data?.disk;
  return [
    { key: 'pdf', label: '论文 PDF', value: metricValue(disk?.paperPdf), color: '#0ea5e9' },
    { key: 'caj', label: '论文 CAJ', value: metricValue(disk?.paperCaj), color: '#38bdf8' },
    { key: 'patentMd', label: '专利 Markdown', value: metricValue(disk?.patentMd), color: '#a78bfa' },
    { key: 'book', label: '书籍 PDF', value: metricValue(disk?.bookPdf ?? disk?.whitepaperPdf), color: '#14b8a6' },
    { key: 'mentor', label: '导师档案', value: metricValue(disk?.mentorMd), color: '#f59e0b' },
    { key: 'fund', label: '基金表', value: metricValue(disk?.fundTables), color: '#64748b' }
  ];
}

export function getBaseSlices(data: DbSummaryPayload | null): MetricSlice[] {
  const stats = data?.stats;
  return [
    { key: 'files', label: '导入文件', value: metricValue(stats?.files), color: '#334155', hint: 'Excel / CSV 数据源' },
    { key: 'raw', label: '原始记录', value: metricValue(stats?.rawRecords), color: '#475569', hint: '保留完整 JSON 行' },
    { key: 'entities', label: '知识实体', value: metricValue(stats?.entities), color: '#0f766e', hint: '归一化实体' },
    { key: 'edges', label: '关系边', value: metricValue(stats?.edges), color: '#6d28d9', hint: '用于星图和关联查询' }
  ];
}

export function getIndexSlices(data: DbSummaryPayload | null): MetricSlice[] {
  const index = data?.indexStats;
  return [
    { key: 'records', label: '索引记录', value: metricValue(index?.searchRecords), color: '#0369a1' },
    { key: 'terms', label: '检索词项', value: metricValue(index?.searchTerms), color: '#7c3aed' },
    { key: 'aliases', label: '别名', value: metricValue(index?.aliases), color: '#0d9488' },
    { key: 'mentions', label: '提及', value: metricValue(index?.mentions), color: '#d97706' },
    { key: 'merge', label: '待合并候选', value: metricValue(index?.mergeCandidates), color: '#94a3b8' }
  ];
}

export function sumSlices(slices: MetricSlice[]) {
  return slices.reduce((sum, slice) => sum + slice.value, 0);
}

export function maxSliceValue(slices: MetricSlice[]) {
  return Math.max(1, ...slices.map((slice) => slice.value));
}
