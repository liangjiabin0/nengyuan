'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import { KnowledgeGraphView } from '@/components/knowledge-graph-canvas';
import {
  AuthorPanel,
  BurstPanel,
  TeamPanel,
  TimelinePanel,
  type AuthorData,
  type BurstData,
  type TeamData,
  type TimelineData
} from '@/components/research-analysis-panels';
import { useNotifyError } from '@/components/app-notify';
import { notify } from '@/lib/notify';
import { usePageContentReady } from '@/components/page-nav-loading';
import { UiSelect } from '@/components/ui-select';
import type { GraphNode, GraphPaperPage, GraphRelations } from '@/lib/graph-relations';

export { KnowledgeGraphView } from '@/components/knowledge-graph-canvas';

const CLUSTER_COLORS = ['#2563eb', '#14b8a6', '#f97316', '#dc2626', '#8b5cf6', '#65a30d', '#0891b2', '#db2777'];

function primaryClusterLabel(label: string) {
  return label.split(/\s*·\s*/u)[0] || label;
}

type GraphTab = 'all' | 'timeline' | 'bursts' | 'authors' | 'teams';

const GRAPH_TABS: Array<{ id: GraphTab; label: string }> = [
  { id: 'all', label: '关键词共现' },
  { id: 'timeline', label: '时间演化' },
  { id: 'bursts', label: '突显关键词' },
  { id: 'authors', label: '作者分析' },
  { id: 'teams', label: '研究团队' }
];

const COMMON_GRAPH_SEED_TERMS = [
  '电力系统',
  '新能源',
  '储能',
  '配电网',
  '风电',
  '光伏',
  '虚拟电厂',
  '直流输电',
  '智能电网',
  '暂态稳定性',
  '构网型变流器',
  '虚拟同步机',
  '故障穿越',
  '电动汽车'
] as const;

function pickRandomGraphSeed() {
  const index = Math.floor(Math.random() * COMMON_GRAPH_SEED_TERMS.length);
  return COMMON_GRAPH_SEED_TERMS[index];
}

function GraphPaperDrawer({
  node,
  onClose,
  onExpand
}: {
  node: GraphNode;
  onClose: () => void;
  onExpand: () => void;
}) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<GraphPaperPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useNotifyError();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    fetch(`/api/graph?mode=papers&node=${encodeURIComponent(node.key)}&label=${encodeURIComponent(node.label)}&page=${page}&pageSize=8`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || '论文列表加载失败');
        if (!cancelled) setData(payload);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '论文列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [node.key, node.label, page]);

  const pageCount = Math.max(1, Math.ceil((data?.total || 0) / (data?.pageSize || 8)));

  return (
    <div className="fixed inset-0 z-[260] bg-slate-950/30" role="dialog" aria-modal="true" aria-label={`${node.label} 相关论文`}>
      <button type="button" aria-label="关闭论文抽屉" className="absolute inset-0 cursor-default" onClick={onClose} />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[430px] flex-col border-l border-slate-200 bg-white shadow-2xl">
        <header className="shrink-0 border-b border-slate-100 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] font-medium text-emerald-600">{node.entityType === 'person' ? '作者' : '关键词'}</div>
              <h2 className="mt-1 break-words font-serif text-3xl text-slate-900">{node.label}</h2>
              <div className="mt-2 text-xs text-slate-400">{data?.total ?? 0} 篇相关文献</div>
            </div>
            <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
              <X className="h-4 w-4" />
            </button>
          </div>
          <button type="button" onClick={onExpand} className="mt-3 text-xs font-medium text-emerald-700 hover:text-emerald-800">
            以此节点继续扩展图谱
          </button>
        </header>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-2">
          {loading ? <div className="py-12 text-center text-sm text-slate-400">正在检索相关文献…</div> : null}
          {error ? <div className="py-12 text-center text-sm text-slate-400">暂时无法加载相关文献。</div> : null}
          {!loading && !error && !data?.papers.length ? (
            <div className="py-12 text-center text-sm leading-6 text-slate-400">当前节点暂无可预览的关联论文。</div>
          ) : null}
          {data?.papers.map((paper, index) => (
            <button
              key={paper.paperKey}
              type="button"
              className="group flex w-full gap-3 border-b border-slate-100 py-4 text-left"
              onClick={() => window.open(`/api/files/preview?sourceType=paper&sourceKey=${encodeURIComponent(paper.paperKey)}`, '_blank', 'noopener,noreferrer')}
            >
              <span className="mt-0.5 w-5 shrink-0 font-serif text-xs text-slate-300">{String((page - 1) * 8 + index + 1).padStart(2, '0')}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium leading-5 text-slate-800 transition group-hover:text-emerald-700">{paper.title}</span>
                <span className="mt-1.5 line-clamp-2 block text-[11px] leading-5 text-slate-400">{paper.authors}</span>
              </span>
              <ExternalLink className="mt-1 h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-emerald-500" />
            </button>
          ))}
        </div>
        <footer className="flex shrink-0 items-center justify-between border-t border-slate-100 px-5 py-3 text-xs text-slate-400">
          <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} className="rounded-lg p-2 hover:bg-slate-100 disabled:opacity-30">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span>{page} / {pageCount}</span>
          <button type="button" disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)} className="rounded-lg p-2 hover:bg-slate-100 disabled:opacity-30">
            <ChevronRight className="h-4 w-4" />
          </button>
        </footer>
      </aside>
    </div>
  );
}

export function KnowledgeGraphWorkbench({
  compact = false,
  title = '学科研究图谱',
  onInitialReady
}: {
  compact?: boolean;
  title?: string;
  onInitialReady?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [bootstrapped, setBootstrapped] = useState(false);
  const [limit, setLimit] = useState(120);
  const [graph, setGraph] = useState<GraphRelations | null>(null);
  const [tab, setTab] = useState<GraphTab>('all');
  const [analysisData, setAnalysisData] = useState<TimelineData | BurstData | AuthorData | TeamData | null>(null);
  const [activeNode, setActiveNode] = useState<GraphNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [, setError] = useNotifyError();
  const [refreshing, setRefreshing] = useState(false);
  const [yearSpan, setYearSpan] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [clusterLegendOpen, setClusterLegendOpen] = useState(true);
  const [minCount, setMinCount] = useState(1);
  const [minTeamSize, setMinTeamSize] = useState(3);
  const analysisRequestRef = useRef(0);
  const initialReadyNotifiedRef = useRef(false);
  usePageContentReady(!compact && bootstrapped && !loading);

  useEffect(() => {
    if (!bootstrapped || loading || initialReadyNotifiedRef.current) return;
    initialReadyNotifiedRef.current = true;
    onInitialReady?.();
  }, [bootstrapped, loading, onInitialReady]);

  const loadGraph = useCallback(async (termQuery: string) => {
    analysisRequestRef.current += 1;
    setLoading(true);
    setError('');
    setAnalysisData(null);
    try {
      const params = new URLSearchParams();
      params.set('mode', 'terms');
      if (termQuery) params.set('q', termQuery);
      params.set('limit', String(limit));
      params.set('minCount', String(minCount));
      if (yearSpan > 0) {
        params.set('yearFrom', String(new Date().getFullYear() - yearSpan + 1));
        params.set('yearTo', String(new Date().getFullYear()));
      }
      const response = await fetch(`/api/graph?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '加载图谱失败');
      setGraph(data);
      if (termQuery && !data.nodes?.length) {
        notify.info(`未找到与“${termQuery}”相关的有效科研术语。`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载图谱失败');
    } finally {
      setLoading(false);
    }
  }, [limit, minCount, yearSpan]);

  useEffect(() => {
    const seed = pickRandomGraphSeed();
    setQuery(seed);
    setSubmittedQuery(seed);
    setBootstrapped(true);
  }, []);

  useEffect(() => {
    if (!bootstrapped) return;
    if (tab === 'all') void loadGraph(submittedQuery);
  }, [submittedQuery, loadGraph, tab, bootstrapped]);

  const loadAnalysis = useCallback(async (activeTab: GraphTab, refresh = false) => {
    if (activeTab === 'all') {
      await loadGraph(submittedQuery);
      return;
    }
    const requestId = ++analysisRequestRef.current;
    setLoading(true);
    setError('');
    setAnalysisData(null);
    try {
      const mode = activeTab === 'timeline' ? 'timeline' : activeTab === 'bursts' ? 'bursts' : activeTab;
      const params = new URLSearchParams({ mode, limit: String(limit), minCount: String(minCount), minTeamSize: String(minTeamSize) });
      if (submittedQuery) params.set('q', submittedQuery);
      if (yearSpan > 0) {
        params.set('yearFrom', String(new Date().getFullYear() - yearSpan + 1));
        params.set('yearTo', String(new Date().getFullYear()));
      }
      if (refresh) params.set('refresh', '1');
      const response = await fetch(`/api/graph/analytics?${params.toString()}`);
      const payload = await response.json();
      if (requestId !== analysisRequestRef.current) return;
      if (!response.ok) throw new Error(payload.error || '分析数据加载失败');
      setAnalysisData(payload);
    } catch (err) {
      if (requestId !== analysisRequestRef.current) return;
      setError(err instanceof Error ? err.message : '分析数据加载失败');
      setAnalysisData(null);
    } finally {
      if (requestId === analysisRequestRef.current) setLoading(false);
    }
  }, [limit, loadGraph, minCount, minTeamSize, submittedQuery, yearSpan]);

  useEffect(() => {
    if (!bootstrapped) return;
    if (tab !== 'all') void loadAnalysis(tab);
  }, [tab, loadAnalysis, bootstrapped]);

  const viewGraph = graph;
  const clusterSummaries = useMemo(() => {
    if (!viewGraph) return [];
    return (viewGraph.clusters || [])
      .map((cluster) => ({
        ...cluster,
        nodes: viewGraph.nodes.filter((node) => node.cluster === cluster.id)
      }))
      .filter((cluster) => cluster.nodes.length);
  }, [viewGraph]);

  function generateGraph() {
    const nextQuery = query.trim();
    if (nextQuery === submittedQuery) void loadAnalysis(tab);
    else setSubmittedQuery(nextQuery);
  }

  async function refreshCurrent() {
    setRefreshing(true);
    await loadAnalysis(tab, true);
    setRefreshing(false);
  }

  function exportCurrent() {
    const rows: Array<Record<string, unknown>> = [];
    if (tab === 'all') {
      for (const node of graph?.nodes || []) rows.push({ 类型: '节点', 名称: node.label, 分组: node.clusterLabel || '', 来源: node.entityType || node.type });
      for (const edge of graph?.edges || []) rows.push({ 类型: '关系', 名称: `${edge.source} -> ${edge.target}`, 分组: edge.relation, 来源: edge.weight });
    } else if (tab === 'timeline') {
      for (const item of (analysisData as TimelineData | null)?.publications || []) rows.push({ 年份: item.year, 发文量: item.count });
    } else if (tab === 'bursts') {
      for (const item of (analysisData as BurstData | null)?.items || []) rows.push({ 关键词: item.term, 首次出现: item.firstYear, 最近出现: item.lastYear, 突显分: item.score, 近期数量: item.recentCount });
    } else if (tab === 'authors') {
      for (const item of (analysisData as AuthorData | null)?.nodes || []) rows.push({ 作者: item.name, 论文数: item.paperCount, 合作者: item.collaboratorCount, 起始年: item.firstYear, 最近年: item.lastYear });
    } else {
      for (const item of (analysisData as TeamData | null)?.teams || []) rows.push({ 团队: item.label, 成员: item.members.join('、'), 论文数: item.paperCount, 协作强度: item.collaborationStrength, 主题: item.keywords.join('、') });
    }
    if (!rows.length) return;
    const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const csv = `\uFEFF${headers.map(escape).join(',')}\n${rows.map((row) => headers.map((header) => escape(row[header])).join(',')).join('\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `学科研究图谱-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className={`ui-card overflow-hidden ${compact ? '' : 'flex h-full min-h-0 flex-1 flex-col'}`}>
      <div className="shrink-0 border-b border-slate-100 px-4 py-4 lg:px-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <h2 className="text-base font-semibold text-slate-900">{title}</h2>
              <span className="text-xs text-slate-400">基于 {graph?.nodes.length ?? 0} 个可见节点</span>
            </div>
          </div>
          <div className="flex flex-1 flex-wrap items-center gap-2 xl:max-w-3xl xl:justify-end">
            <label className="relative min-w-[210px] flex-1 xl:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') generateGraph();
                }}
                placeholder="输入科研术语，直接生成共现网络…"
                className="ui-input py-2 pl-9 text-xs"
              />
            </label>
            <button type="button" className="ui-btn-primary px-3 py-2 text-xs" onClick={generateGraph}>生成图谱</button>
            <UiSelect
              className="w-[9.5rem] shrink-0"
              size="sm"
              value={String(yearSpan)}
              aria-label="年份范围"
              onChange={(next) => setYearSpan(Number(next))}
              options={[
                { value: '0', label: '全部年份' },
                { value: '3', label: '近 3 年' },
                { value: '5', label: '近 5 年' },
                { value: '10', label: '近 10 年' }
              ]}
            />
            <UiSelect
              className="w-[9.5rem] shrink-0"
              size="sm"
              value={String(limit)}
              aria-label="节点上限"
              onChange={(next) => setLimit(Number(next))}
              options={[
                { value: '80', label: '80 个节点' },
                { value: '120', label: '120 个节点' },
                { value: '160', label: '160 个节点' },
                { value: '200', label: '200 个节点' }
              ]}
            />
            <button type="button" title="高级筛选" onClick={() => setAdvancedOpen((value) => !value)} className={`rounded-lg border p-2 transition ${advancedOpen ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-400 hover:bg-emerald-50 hover:text-emerald-700'}`}><SlidersHorizontal className="h-4 w-4" /></button>
            <button type="button" title="刷新当前分析" disabled={refreshing} onClick={() => void refreshCurrent()} className="rounded-lg border border-slate-200 p-2 text-slate-400 transition hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-40">
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            <button type="button" title="导出当前数据" onClick={exportCurrent} className="rounded-lg border border-slate-200 p-2 text-slate-400 transition hover:bg-emerald-50 hover:text-emerald-700"><Download className="h-4 w-4" /></button>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">查询、年份与节点上限会同步应用到五种分析视图；全部结果来自本地论文与关系数据。</p>
        {advancedOpen ? (
          <div className="mt-3 flex flex-wrap items-center gap-4 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2.5">
            <label className="flex items-center gap-2 text-[10px] text-slate-500">最小共现/发文量<input type="number" min={1} max={20} value={minCount} onChange={(event) => setMinCount(Math.max(1, Number(event.target.value) || 1))} className="w-16 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-emerald-400" /></label>
            <label className="flex items-center gap-2 text-[10px] text-slate-500">团队最小人数<input type="number" min={2} max={12} value={minTeamSize} onChange={(event) => setMinTeamSize(Math.max(2, Number(event.target.value) || 2))} className="w-16 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-emerald-400" /></label>
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-5 overflow-x-auto border-b border-slate-100 px-4 lg:px-5">
        {GRAPH_TABS.map((item) => (
          <button key={item.id} type="button" onClick={() => setTab(item.id)} className={`relative shrink-0 py-3 text-xs font-medium transition ${tab === item.id ? 'text-emerald-700' : 'text-slate-400 hover:text-slate-700'}`}>
            {item.label}
            {tab === item.id ? <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-emerald-600" /> : null}
          </button>
        ))}
        <span className="ml-auto shrink-0 py-3 text-[11px] text-slate-400">{loading ? '分析加载中…' : tab === 'all' ? `节点 ${viewGraph?.nodes.length ?? 0} · 关系 ${viewGraph?.edges.length ?? 0}` : '真实论文统计'}</span>
      </div>

      <div className={compact ? '' : 'flex min-h-0 flex-1 flex-col overflow-auto'}>
        {loading ? (
          <div className={`flex items-center justify-center text-sm text-slate-400 ${compact ? 'min-h-[400px]' : 'min-h-[640px] flex-1'}`}>
            {tab === 'all' ? '正在加载图谱…' : '正在计算科研分析…'}
          </div>
        ) : null}
        {!loading && tab === 'all' ? (
          <div className={`grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_220px] ${compact ? 'min-h-[380px]' : 'min-h-[640px] flex-1'}`}>
            <div className={`relative min-w-0 border-b border-slate-100 p-3 lg:border-b-0 lg:border-r ${compact ? '' : 'flex min-h-[640px] flex-col'}`}>
              <div className={`absolute left-5 top-5 z-10 rounded-lg border border-slate-100 bg-white/90 px-3 py-2 text-[10px] text-slate-500 shadow-sm backdrop-blur transition-[width] ${clusterLegendOpen ? 'w-[280px] max-w-[calc(100%-2.5rem)]' : 'w-auto'}`}>
                <button
                  type="button"
                  aria-expanded={clusterLegendOpen}
                  onClick={() => setClusterLegendOpen((value) => !value)}
                  className="flex w-full items-center justify-between gap-3 font-medium text-slate-600"
                >
                  <span>主题分布 · {clusterSummaries.length}</span>
                  <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ${clusterLegendOpen ? 'rotate-180' : ''}`} />
                </button>
                <div className={`grid transition-[grid-template-rows,opacity] duration-200 ${clusterLegendOpen ? 'mt-1.5 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
                  <div className="min-h-0 overflow-hidden">
                    <div className="space-y-1">
                      {clusterSummaries.map((cluster) => (
                        <div key={cluster.id} className="flex items-center gap-1.5">
                          <i className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: CLUSTER_COLORS[cluster.id % CLUSTER_COLORS.length] }} />
                          <span className="truncate">{primaryClusterLabel(cluster.label)}</span>
                          <span className="ml-auto text-slate-300">{cluster.nodes.length}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <KnowledgeGraphView
                graph={viewGraph}
                height={compact ? 360 : '100%'}
                onNodeClick={setActiveNode}
                className={`border-0 ${compact ? '' : 'min-h-[640px] flex-1'}`}
              />
            </div>
            <aside className={`scrollbar-thin overflow-y-auto bg-slate-50/40 p-4 ${compact ? 'max-h-[400px]' : 'min-h-0 h-full'}`}>
              <div className="text-xs font-semibold text-slate-700">核心方向</div>
              <div className="mt-3 space-y-4">
                {clusterSummaries.map((cluster) => (
                  <section key={cluster.id}>
                    <div className="flex items-start gap-2">
                      <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: CLUSTER_COLORS[cluster.id % CLUSTER_COLORS.length] }} />
                      <div className="min-w-0">
                        <div className="line-clamp-2 text-[11px] font-medium leading-4 text-slate-700">{cluster.label}</div>
                        <div className="mt-0.5 text-[9px] text-slate-400">{cluster.nodes.length} 个核心词</div>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {cluster.nodes.map((node) => (
                        <button key={node.key} type="button" onClick={() => setActiveNode(node)} className="max-w-full truncate rounded-full border border-slate-200 bg-white px-2 py-1 text-[9px] text-slate-500 transition hover:border-emerald-200 hover:text-emerald-700">
                          {node.label}
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </aside>
          </div>
        ) : null}
        {!loading && tab !== 'all' ? (
          <div className={compact ? '' : 'scrollbar-thin min-h-0 flex-1 overflow-y-auto'}>
            {tab === 'timeline' && analysisData && Array.isArray((analysisData as TimelineData).years) ? <TimelinePanel data={analysisData as TimelineData} onTermClick={(term) => setActiveNode({ key: `keyword:${encodeURIComponent(term)}`, label: term, type: 'entity', entityType: 'keyword' })} /> : null}
            {tab === 'bursts' && analysisData && Array.isArray((analysisData as BurstData).items) && Array.isArray((analysisData as BurstData).years) ? <BurstPanel data={analysisData as BurstData} onTermClick={(term, key) => setActiveNode({ key, label: term, type: 'entity', entityType: 'keyword' })} /> : null}
            {tab === 'authors' && analysisData && Array.isArray((analysisData as AuthorData).nodes) ? <AuthorPanel data={analysisData as AuthorData} onAuthorClick={(node) => setActiveNode({ key: node.key, label: node.name, type: 'entity', entityType: 'person' })} /> : null}
            {tab === 'teams' && analysisData && Array.isArray((analysisData as TeamData).teams) ? <TeamPanel data={analysisData as TeamData} onMemberClick={(name, key) => setActiveNode({ key, label: name, type: 'entity', entityType: 'person' })} onKeywordClick={(keyword) => setActiveNode({ key: `keyword:${encodeURIComponent(keyword)}`, label: keyword, type: 'entity', entityType: 'keyword' })} /> : null}
          </div>
        ) : null}
      </div>

      {activeNode ? (
        <GraphPaperDrawer
          node={activeNode}
          onClose={() => setActiveNode(null)}
          onExpand={() => {
            setQuery(activeNode.label);
            setSubmittedQuery(activeNode.label);
            setTab('all');
            setActiveNode(null);
          }}
        />
      ) : null}
    </section>
  );
}
