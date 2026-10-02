'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { KnowledgeGraphView } from '@/components/knowledge-graph-canvas';
import { notify } from '@/lib/notify';
import type { GraphRelations } from '@/lib/graph-relations';

export function KnowledgeGraphModal({ seedIds, onClose }: { seedIds: string[]; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [graph, setGraph] = useState<GraphRelations | null>(null);
  const normalizedSeeds = useMemo(() => [...new Set(seedIds.filter(Boolean))], [seedIds]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;

    async function loadGraph() {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams();
        if (normalizedSeeds.length) params.set('seeds', normalizedSeeds.join(','));
        params.set('limit', '100');
        params.set('hops', '2');
        const response = await fetch(`/api/graph?${params.toString()}`);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || '图谱关系加载失败');
        if (!cancelled) setGraph(payload as GraphRelations);
      } catch (err) {
        if (!cancelled) {
          const text = err instanceof Error ? err.message : '图谱关系加载失败';
          setError(text);
          notify.error(text);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadGraph();
    return () => {
      cancelled = true;
    };
  }, [normalizedSeeds]);

  const nodeLabels = new Map((graph?.nodes || []).map((node) => [node.key, node.label]));
  const label = (key: string) => nodeLabels.get(key) || key;

  return (
    <div className="rag-evidence-modal-backdrop" onClick={onClose}>
      <div className="rag-evidence-modal rag-evidence-modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <div className="ui-kicker">Knowledge Graph</div>
            <h3 className="mt-1 text-base font-semibold text-slate-900">知识图谱</h3>
            <p className="mt-1 text-xs text-slate-500">
              {normalizedSeeds.length ? `当前对话关联 ${normalizedSeeds.length} 个种子节点` : '展示库内权重最高的一组关系'}
              {' · '}
              <Link href="/graph" className="text-emerald-600 hover:underline">打开完整图谱页</Link>
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-50">关闭</button>
        </div>
        <div className="max-h-[calc(min(86vh,820px)-88px)] overflow-y-auto px-5 py-4">
          {loading ? <div className="py-10 text-center text-sm text-slate-500">正在加载知识图谱…</div> : null}
          {error ? <div className="py-10 text-center text-sm text-rose-600">{error}</div> : null}
          {graph && !graph.edges.length ? <div className="py-10 text-center text-sm text-slate-500">暂无可展示的图谱关系。</div> : null}
          {graph?.edges.length ? (
            <div className="space-y-4">
              <KnowledgeGraphView graph={graph} height={420} />
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="rounded-full bg-slate-100 px-2.5 py-1">节点 {graph.nodes.length}</span>
                <span className="rounded-full bg-slate-100 px-2.5 py-1">关系 {graph.edges.length}</span>
              </div>
              <div>
                <div className="mb-2 text-xs font-medium text-slate-500">关系列表</div>
                <div className="max-h-48 space-y-1.5 overflow-y-auto">
                  {graph.edges.slice(0, 40).map((edge, index) => (
                    <div key={`${edge.source}-${edge.target}-${edge.relation}-${index}`} className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm leading-6 text-slate-700">
                      <span className="font-medium text-slate-900">{label(edge.source)}</span>
                      <span className="mx-2 rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">{edge.relation}</span>
                      <span className="font-medium text-slate-900">{label(edge.target)}</span>
                      <span className="ml-2 text-xs text-slate-400">w={edge.weight}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
