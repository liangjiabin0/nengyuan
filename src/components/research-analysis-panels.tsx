'use client';

import { useMemo, useState } from 'react';
import { KnowledgeGraphView } from '@/components/knowledge-graph-canvas';
import type { GraphRelations } from '@/lib/graph-relations';

export type TimelineData = {
  meta: { paperCount: number; yearCount: number; keywordCount: number };
  years: number[];
  publications: Array<{ year: number; count: number }>;
  topics: Array<{ term: string; total: number; points: Array<{ year: number; count: number }> }>;
  heatmap: Array<{ term: string; points: Array<{ year: number; count: number }> }>;
};

export type BurstData = {
  meta: { paperCount: number; recentFrom: number; maxYear: number };
  years: number[];
  items: Array<{
    key: string;
    term: string;
    total: number;
    recentCount: number;
    baselineAvg: number;
    growthRate: number;
    score: number;
    firstYear: number;
    lastYear: number;
  }>;
};

export type AuthorData = {
  meta: { paperCount: number };
  nodes: Array<{
    key: string;
    name: string;
    paperCount: number;
    collaboratorCount: number;
    firstYear: number;
    lastYear: number;
    keywords: string[];
  }>;
  edges: Array<{ source: string; target: string; weight: number; relation: string }>;
};

export type TeamData = {
  meta: { paperCount: number };
  teams: Array<{
    id: string;
    label: string;
    leader: string;
    members: string[];
    memberKeys: string[];
    paperCount: number;
    collaborationStrength: number;
    firstYear: number;
    lastYear: number;
    keywords: string[];
  }>;
};

const SERIES_COLORS = ['#059669', '#0d9488', '#0284c7', '#7c3aed', '#d97706', '#dc2626'];

function EmptyAnalysis({ text }: { text: string }) {
  return <div className="flex min-h-[380px] items-center justify-center text-sm text-slate-400">{text}</div>;
}

function AuthorNetwork({ data, onSelect }: { data: AuthorData; onSelect: (key: string) => void }) {
  const graph = useMemo((): GraphRelations => {
    const edges = (data?.edges || []).map((edge) => ({
      source: edge.source,
      target: edge.target,
      relation: edge.relation || 'collaborates',
      weight: edge.weight
    }));
    const connected = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
    const nodes = (data?.nodes || [])
      .filter((node) => connected.has(node.key))
      .map((node) => ({
        key: node.key,
        label: node.name,
        type: 'entity' as const,
        entityType: 'person'
      }));
    return { nodes, edges: edges.filter((edge) => connected.has(edge.source) && connected.has(edge.target)) };
  }, [data]);

  return (
    <KnowledgeGraphView
      graph={graph}
      height={620}
      className="border-0"
      emptyText="当前筛选范围没有可用的作者合作网络。"
      onNodeClick={(node) => onSelect(node.key)}
    />
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(1, ...values);
  const points = values.map((value, index) => `${(index / Math.max(1, values.length - 1)) * 90},${28 - (value / max) * 24}`).join(' ');
  return (
    <svg viewBox="0 0 90 32" className="h-8 w-24" aria-hidden>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TimelinePanel({ data, onTermClick }: { data: TimelineData; onTermClick: (term: string) => void }) {
  const years = data?.years || [];
  const publications = data?.publications || [];
  const topics = data?.topics || [];
  const heatmap = data?.heatmap || [];
  if (!years.length) return <EmptyAnalysis text="当前筛选范围没有可用的论文年份数据。" />;
  const maxCount = Math.max(1, ...publications.map((item) => item.count));
  const points = publications.map((item, index) => {
    const x = publications.length === 1 ? 400 : 48 + (index / Math.max(1, publications.length - 1)) * 704;
    const y = 188 - (item.count / maxCount) * 142;
    return { ...item, x, y };
  });
  const area = points.length
    ? `M ${points[0].x} 188 L ${points.map((point) => `${point.x} ${point.y}`).join(' L ')} L ${points.at(-1)!.x} 188 Z`
    : '';

  return (
    <div className="space-y-3 bg-slate-50/40 p-4">
      <section className="rounded-xl border border-slate-200/80 bg-white p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">年度发文</h3>
          <span className="text-[10px] text-slate-400">真实发表年份 · 年度论文数</span>
        </div>
        <svg viewBox="0 0 800 220" className="mt-3 h-[220px] w-full" role="img" aria-label="年度发文趋势">
          {[0, 1, 2, 3].map((line) => <line key={line} x1="48" x2="752" y1={46 + line * 47} y2={46 + line * 47} stroke="#e2e8f0" strokeWidth="1" />)}
          <path d={area} fill="#d1fae5" opacity="0.55" />
          <polyline points={points.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke="#059669" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          {points.map((point) => (
            <g key={point.year}>
              <circle cx={point.x} cy={point.y} r="4.5" fill="#059669"><title>{`${point.year}：${point.count} 篇`}</title></circle>
              <text x={point.x} y="210" textAnchor="middle" fontSize="11" fill="#94a3b8">{point.year}</text>
              <text x={point.x} y={point.y - 10} textAnchor="middle" fontSize="10" fill="#475569">{point.count}</text>
            </g>
          ))}
        </svg>
      </section>
      <div className="grid gap-3 lg:grid-cols-[360px_minmax(0,1fr)]">
        <section className="rounded-xl border border-slate-200/80 bg-white p-4">
          <div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-800">主题年度趋势</h3><span className="text-[10px] text-slate-400">前 {topics.length} 个主题</span></div>
          <div className="mt-3 space-y-2">
            {topics.map((topic, index) => (
              <div key={topic.term} className="grid grid-cols-[10px_minmax(0,1fr)_96px_38px] items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length] }} />
                <button type="button" onClick={() => onTermClick(topic.term)} className="truncate text-left text-[11px] text-slate-600 hover:text-emerald-700">{topic.term}</button>
                <Sparkline values={topic.points.map((point) => point.count)} color={SERIES_COLORS[index % SERIES_COLORS.length]} />
                <span className="text-right text-xs font-semibold text-slate-700">{topic.total}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="min-w-0 rounded-xl border border-slate-200/80 bg-white p-4">
          <div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-800">关键词热力</h3><span className="text-[10px] text-slate-400">颜色越深，年度出现越多</span></div>
          <div className="mt-4 overflow-x-auto">
            <div className="grid min-w-[480px] gap-1.5" style={{ gridTemplateColumns: `120px repeat(${years.length}, minmax(62px, 1fr))` }}>
              <span />
              {years.map((year) => <span key={year} className="text-center text-[10px] text-slate-400">{year}</span>)}
              {heatmap.flatMap((row) => {
                const max = Math.max(1, ...row.points.map((point) => point.count));
                return [
                  <button type="button" onClick={() => onTermClick(row.term)} key={`${row.term}-label`} className="truncate pr-2 text-right text-[10px] leading-7 text-slate-500 hover:text-emerald-700">{row.term}</button>,
                  ...row.points.map((point) => (
                    <span key={`${row.term}-${point.year}`} className="h-7 rounded" style={{ backgroundColor: `rgba(5, 150, 105, ${0.08 + (point.count / max) * 0.82})` }} title={`${row.term} · ${point.year} · ${point.count} 篇`} />
                  ))
                ];
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export function BurstPanel({ data, onTermClick }: { data: BurstData; onTermClick: (term: string, key: string) => void }) {
  const items = data?.items || [];
  const years = data?.years || [];
  if (!items.length || !years.length) return <EmptyAnalysis text="当前筛选范围没有满足条件的突显关键词。" />;
  const minYear = years[0];
  const span = Math.max(1, years.at(-1)! - minYear + 1);
  const maxScore = Math.max(1, ...items.map((item) => item.score));
  return (
    <div className="bg-slate-50/40 p-4">
      <section className="rounded-xl border border-slate-200/80 bg-white p-4">
        <div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-800">关键词突显时间窗</h3><span className="text-[10px] text-slate-400">深色代表更高突显分</span></div>
        <div className="mt-5 grid grid-cols-[150px_minmax(0,1fr)] gap-x-4 gap-y-2">
          <span />
          <div className="flex justify-between text-[10px] text-slate-400">{years.map((year) => <span key={year}>{year}</span>)}</div>
          {items.map((item) => {
            const left = ((item.firstYear - minYear) / span) * 100;
            const width = Math.max(5, ((item.lastYear - item.firstYear + 1) / span) * 100);
            return [
              <button key={`${item.term}-label`} type="button" onClick={() => onTermClick(item.term, item.key)} className="truncate text-right text-[10px] text-slate-600 hover:text-emerald-700">{item.term}</button>,
              <div key={`${item.term}-bar`} className="relative h-6 rounded bg-slate-50">
                <button type="button" onClick={() => onTermClick(item.term, item.key)} className="absolute top-1 h-4 rounded-md transition hover:brightness-95" style={{ left: `${left}%`, width: `${Math.min(100 - left, width)}%`, backgroundColor: `rgba(5, 150, 105, ${0.25 + (item.score / maxScore) * 0.7})` }} title={`${item.term}：${item.firstYear}-${item.lastYear}，突显分 ${item.score}`} />
              </div>
            ];
          })}
        </div>
      </section>
    </div>
  );
}

export function AuthorPanel({ data, onAuthorClick }: { data: AuthorData; onAuthorClick: (node: AuthorData['nodes'][number]) => void }) {
  const nodes = data?.nodes || [];
  const [selectedKey, setSelectedKey] = useState(nodes[0]?.key || '');
  const selected = nodes.find((node) => node.key === selectedKey) || nodes[0];
  if (!nodes.length) return <EmptyAnalysis text="当前筛选范围没有可用作者数据。" />;
  const maxPapers = Math.max(1, ...nodes.map((node) => node.paperCount));
  return (
    <div className="grid min-h-[500px] grid-cols-1 bg-slate-50/40 lg:grid-cols-[minmax(0,1fr)_260px]">
      <div className="min-w-0 border-b border-slate-200 p-3 lg:border-b-0 lg:border-r">
        <AuthorNetwork data={data} onSelect={setSelectedKey} />
      </div>
      <aside className="scrollbar-thin max-h-[524px] overflow-y-auto p-4">
        {selected ? (
          <button type="button" onClick={() => onAuthorClick(selected)} className="w-full rounded-xl border-t-4 border-amber-400 bg-white p-3 text-left shadow-sm">
            <div className="text-base font-semibold text-slate-800">{selected.name}</div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <div><b className="block text-lg text-amber-500">{selected.paperCount}</b><span className="text-[9px] text-slate-400">论文</span></div>
              <div><b className="block text-lg text-amber-500">{selected.collaboratorCount}</b><span className="text-[9px] text-slate-400">合作者</span></div>
              <div><b className="block text-lg text-amber-500">{selected.lastYear - selected.firstYear + 1}</b><span className="text-[9px] text-slate-400">活跃年</span></div>
            </div>
            <div className="mt-3 line-clamp-2 text-[10px] leading-5 text-slate-400">{selected.keywords.join(' · ')}</div>
          </button>
        ) : null}
        <h3 className="mt-4 text-xs font-semibold text-slate-700">作者排行</h3>
        <div className="mt-3 space-y-2">
          {nodes.slice(0, 12).map((node) => (
            <button key={node.key} type="button" onClick={() => setSelectedKey(node.key)} className="grid w-full grid-cols-[55px_1fr_26px] items-center gap-2 text-left text-[10px]">
              <span className="truncate text-slate-500">{node.name}</span>
              <span className="h-2 overflow-hidden rounded bg-slate-100"><span className="block h-full rounded bg-amber-400" style={{ width: `${(node.paperCount / maxPapers) * 100}%` }} /></span>
              <span className="text-right text-slate-500">{node.paperCount}</span>
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}

export function TeamPanel({ data, onMemberClick, onKeywordClick }: { data: TeamData; onMemberClick: (name: string, key: string) => void; onKeywordClick: (keyword: string) => void }) {
  const teams = data?.teams || [];
  if (!teams.length) return <EmptyAnalysis text="当前筛选范围没有达到最小规模的稳定研究团队。" />;
  const maxPapers = Math.max(1, ...teams.map((team) => team.paperCount));
  return (
    <div className="grid gap-3 bg-slate-50/40 p-4 md:grid-cols-2 xl:grid-cols-3">
      {teams.map((team, index) => (
        <article key={team.id} className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div><span className="text-[10px] font-medium text-emerald-600">#{index + 1} · 共著团队</span><h3 className="mt-1 text-sm font-semibold text-slate-800">{team.label}</h3></div>
            <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] text-emerald-700">{team.paperCount} 篇</span>
          </div>
          <div className="mt-4 h-1.5 overflow-hidden rounded bg-slate-100"><span className="block h-full rounded bg-emerald-500" style={{ width: `${(team.paperCount / maxPapers) * 100}%` }} /></div>
          <div className="mt-3 text-[10px] text-slate-400">{team.firstYear}-{team.lastYear} · 协作强度 {team.collaborationStrength}</div>
          <div className="mt-3 flex flex-wrap gap-1">
            {team.members.map((member, memberIndex) => (
              <button key={member} type="button" onClick={() => onMemberClick(member, team.memberKeys[memberIndex])} className="rounded-full border border-slate-200 px-2 py-1 text-[10px] text-slate-600 hover:border-emerald-200 hover:text-emerald-700">{member}</button>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-1">
            {team.keywords.map((keyword) => <button type="button" onClick={() => onKeywordClick(keyword)} key={keyword} className="rounded bg-slate-50 px-2 py-1 text-[9px] text-slate-500 hover:bg-emerald-50 hover:text-emerald-700">{keyword}</button>)}
          </div>
        </article>
      ))}
    </div>
  );
}
