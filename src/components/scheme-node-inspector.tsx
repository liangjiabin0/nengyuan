'use client';

import { ChevronDown, Download, LoaderCircle, Play, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CompactMessageAttachments } from '@/components/attachment-chips';
import type { SchemeCanvasSelection } from '@/components/scheme-flow-canvas';
import {
  composeAssistantReply,
  composeInspectorTimeline,
  composeUserBrief,
  problemClassLabel,
  type InspectorTraceItem,
  type SchemeArtifactFiles,
  type SchemeLiveTraceItem
} from '@/lib/scheme-solve/agent-trace';
import { pickBestSchemeIdea, readSolveObjective } from '@/lib/scheme-solve/best-idea';
import {
  SCHEME_AGENT_NODES,
  SCHEME_BRAINSTORM_AGENT,
  SCHEME_STAGE_KEYS,
  SCHEME_STAGE_LABELS
} from '@/lib/scheme-solve/constants';
import {
  readStageAgentTrace,
  type SchemeEvent,
  type SchemeIdeaView,
  type SchemeSessionSnapshot,
  type SchemeStage,
  type SchemeStageKey,
  type SchemeStageStatus
} from '@/lib/scheme-solve/types';
import { cn } from '@/lib/utils';
import { RagThinkCollapse } from '@/components/rag-think-collapse';

export type { SchemeArtifactFiles, SchemeLiveTraceItem };

type InspectorTab = 'chat' | 'data';
type DataPane = string;

type ChatTurn = {
  user: string;
  timeline: InspectorTraceItem[];
  reply: string;
  running: boolean;
  runningHint?: string;
  error?: string;
};

function formatTime(value: string) {
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function agentLabel(selection: SchemeCanvasSelection) {
  if (selection.kind === 'root') return SCHEME_BRAINSTORM_AGENT;
  if (selection.kind === 'idea') return '想法';
  return SCHEME_AGENT_NODES.find((item) => item.key === selection.stageKey)?.agent || 'Agent';
}

function sessionStatusLabel(status: SchemeSessionSnapshot['status']) {
  if (status === 'brainstorming') return '头脑风暴中';
  if (status === 'researching') return '研究中';
  if (status === 'ready') return '待研究';
  if (status === 'done') return '已完成';
  if (status === 'failed') return '失败';
  return '草稿';
}

function stageStatusLabel(status: SchemeStageStatus) {
  if (status === 'running') return '进行中';
  if (status === 'done') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'skipped') return '已跳过';
  return '等待';
}

function relatedStageKeys(stageKey?: SchemeStageKey): SchemeStageKey[] {
  if (stageKey === 'design') return ['design', 'model', 'solve'];
  if (stageKey === 'review') return ['review'];
  if (stageKey === 'write') return ['write', 'report'];
  if (stageKey === 'idea') return ['idea'];
  return [];
}

function eventsForSelection(session: SchemeSessionSnapshot, selection: SchemeCanvasSelection) {
  const events = session.events || [];
  if (selection.kind === 'root') {
    return events.filter((event) => !event.ideaId && (!event.stage || event.stage === 'brainstorm' || event.stage === 'session'));
  }
  if (selection.kind === 'idea') {
    return events.filter((event) => event.ideaId === selection.ideaId && (!event.stage || event.stage === 'idea' || event.stage === 'brainstorm'));
  }
  const keys = relatedStageKeys(selection.stageKey);
  return events.filter((event) => {
    if (selection.ideaId && event.ideaId && event.ideaId !== selection.ideaId) return false;
    return Boolean(event.stage && keys.includes(event.stage as SchemeStageKey));
  });
}

function prettyJson(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function resultMeta(text: string) {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    return {
      objective: json.objective ?? json.objective_value,
      status: json.termination_status ?? json.status
    };
  } catch {
    return null;
  }
}

function stageOf(stages: SchemeStage[], key: SchemeStageKey) {
  return stages.find((stage) => stage.key === key);
}

function rollupStatus(stages: SchemeStage[], keys: SchemeStageKey[]): SchemeStageStatus {
  if (keys.some((key) => stageOf(stages, key)?.status === 'running')) return 'running';
  if (keys.some((key) => stageOf(stages, key)?.status === 'failed')) return 'failed';
  if (keys.length && keys.every((key) => stageOf(stages, key)?.status === 'done' || stageOf(stages, key)?.status === 'skipped')) {
    return 'done';
  }
  return 'idle';
}

function nodeStatus(session: SchemeSessionSnapshot, selection: SchemeCanvasSelection, idea?: SchemeIdeaView): SchemeStageStatus | SchemeSessionSnapshot['status'] {
  if (selection.kind === 'root') return session.status;
  if (selection.kind === 'idea') return idea?.solvability === 'rejected' ? 'skipped' : idea ? 'done' : 'idle';
  return rollupStatus(idea?.stages || [], relatedStageKeys(selection.stageKey));
}

function buildTurn(
  session: SchemeSessionSnapshot,
  selection: SchemeCanvasSelection,
  idea: SchemeIdeaView | undefined,
  events: SchemeEvent[],
  liveTrace: SchemeLiveTraceItem[],
  artifact: SchemeArtifactFiles | null
): ChatTurn {
  const keys = relatedStageKeys(selection.stageKey);
  const running = selection.kind === 'root'
    ? session.status === 'brainstorming'
    : selection.kind === 'stage'
      && (
        rollupStatus(idea?.stages || [], keys) === 'running'
        || (session.status === 'researching' && keys.some((key) => stageOf(idea?.stages || [], key)?.status === 'running'))
      );
  const headline = keys.map((key) => stageOf(idea?.stages || [], key)?.headline).filter(Boolean).at(-1) || '';
  const errorEvent = [...events].reverse().find((event) => event.level === 'error');
  const trace = readStageAgentTrace(
    idea && selection.stageKey ? stageOf(idea.stages, selection.stageKey === 'write' ? 'write' : selection.stageKey) : undefined
  );
  const brief = { kind: selection.kind, stageKey: selection.stageKey, session, idea };
  return {
    user: composeUserBrief(brief),
    timeline: composeInspectorTimeline({
      ...brief,
      events,
      liveTrace: selection.kind === 'root' || running ? liveTrace : [],
      artifact,
      trace
    }),
    reply: composeAssistantReply({ ...brief, artifact, trace, running }),
    running,
    runningHint: session.progressDetail || headline || 'Agent 正在展开推理链…',
    error: selection.kind === 'root' && session.status === 'failed' ? session.error : errorEvent?.text
  };
}

function InspectorMarkdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn('scheme-md min-w-0 text-[13px] leading-6 text-foreground', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mb-2 mt-3 text-sm font-semibold first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-3 text-sm font-semibold first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1.5 mt-2.5 text-[13px] font-semibold first:mt-0">{children}</h3>,
          p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-4">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-4">{children}</ol>,
          li: ({ children }) => <li className="leading-6">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="font-medium text-blue-800 underline">
              {children}
            </a>
          ),
          code: ({ className, children }) => (
            <code className={cn('rounded-md bg-muted px-1 py-0.5 text-[0.9em]', className)}>{children}</code>
          ),
          pre: ({ children }) => (
            <pre className="scrollbar-thin my-2 overflow-x-auto rounded-lg border border-border bg-muted/50 p-2.5 text-[11px] leading-4">
              {children}
            </pre>
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function formatDuration(ms?: number) {
  if (!ms || ms < 400) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function TraceLine({ item, active }: { item: InspectorTraceItem; active?: boolean }) {
  if (item.kind === 'tool') {
    const [verb, ...rest] = item.body.split(' · ');
    return (
      <div className={cn('rag-oc-tool', active && 'rag-oc-tool-active')}>
        <span className="rag-oc-tool-verb">{item.label || verb}</span>
        <span className="rag-oc-tool-detail">{rest.join(' · ') || item.body}</span>
      </div>
    );
  }
  return (
    <div className={cn('rag-oc-prose space-y-1', active && 'rag-oc-prose-active', item.kind === 'error' && 'text-destructive')}>
      <div className="flex items-center gap-2 text-[10px] tracking-wide text-muted-foreground">
        <span>{item.label}</span>
        {item.time ? <span>{formatTime(item.time)}</span> : null}
        {formatDuration(item.durationMs) ? <span>{formatDuration(item.durationMs)}</span> : null}
      </div>
      <div className="rag-oc-prose-body whitespace-pre-wrap">{item.body}</div>
    </div>
  );
}

function ThinkingBlock({ items, running }: { items: InspectorTraceItem[]; running?: boolean }) {
  const [open, setOpen] = useState(true);
  if (!items.length) return null;
  const tools = items.filter((item) => item.kind === 'tool').length;
  const thoughts = items.filter((item) => item.kind === 'thought' || item.kind === 'plan').length;
  const label = running
    ? `推理链展开中 · ${items.length} 步`
    : `推理链 · ${items.length} 步${thoughts ? ` · ${thoughts} 次思考` : ''}${tools ? ` · ${tools} 次工具` : ''}`;
  return (
    <div className={cn('rag-think', open && 'rag-think-open')}>
      <button type="button" className="rag-think-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={cn('rag-think-label', running && 'rag-think-label-shimmer')}>{label}</span>
        <ChevronDown className={cn('rag-think-chevron h-3.5 w-3.5', open && 'rotate-180')} />
      </button>
      <RagThinkCollapse open={open}>
        <div className="rag-oc-stream rag-think-body space-y-2.5">
          {items.map((item, index) => (
            <TraceLine key={item.id} item={item} active={running && index === items.length - 1} />
          ))}
        </div>
      </RagThinkCollapse>
    </div>
  );
}

function MetaCard({ label, value }: { label: string; value?: string | number | null }) {
  if (value == null || value === '') return null;
  return (
    <div className="scheme-inspector-meta">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 whitespace-pre-wrap text-xs leading-5 text-foreground">{String(value)}</div>
    </div>
  );
}

function StatusDot({ status }: { status: SchemeStageStatus }) {
  return (
    <span
      className={cn(
        'mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full',
        status === 'running' && 'bg-blue-500',
        status === 'done' && 'bg-emerald-500',
        status === 'failed' && 'bg-destructive',
        status === 'skipped' && 'bg-muted-foreground/40',
        status === 'idle' && 'bg-muted-foreground/25'
      )}
    />
  );
}

function StageTimeline({ stages, keys = SCHEME_STAGE_KEYS }: { stages: SchemeStage[]; keys?: readonly SchemeStageKey[] }) {
  return (
    <div className="space-y-2">
      {keys.map((key) => {
        const stage = stageOf(stages, key);
        const status = stage?.status || 'idle';
        return (
          <div key={key} className="flex gap-2">
            <StatusDot status={status} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-foreground">{SCHEME_STAGE_LABELS[key]}</span>
                <span className="text-[10px] text-muted-foreground">{stageStatusLabel(status)}</span>
              </div>
              {stage?.headline ? <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{stage.headline}</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ArtifactView({
  title,
  content,
  json = false,
  empty
}: {
  title: string;
  content?: string;
  json?: boolean;
  empty: string;
}) {
  if (!content) {
    return <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">{empty}</div>;
  }
  if (json) {
    return (
      <pre className="scrollbar-thin max-h-[420px] overflow-auto rounded-lg border border-border bg-muted/40 p-2.5 font-mono text-[11px] leading-4">
        {prettyJson(content)}
      </pre>
    );
  }
  return (
    <div className="min-w-0">
      <div className="mb-2 text-[11px] font-medium text-muted-foreground">{title}</div>
      <InspectorMarkdown content={content} />
    </div>
  );
}

export function SchemeNodeInspector({
  session,
  selection,
  artifact,
  artifactLoading,
  liveTrace,
  busy,
  onClose,
  onSelect,
  onResearchIdea,
  onExportReport
}: {
  session: SchemeSessionSnapshot;
  selection: SchemeCanvasSelection;
  artifact: SchemeArtifactFiles | null;
  artifactLoading?: boolean;
  liveTrace: SchemeLiveTraceItem[];
  busy: boolean;
  onClose: () => void;
  onSelect: (selection: SchemeCanvasSelection) => void;
  onResearchIdea: (ideaId: string) => void;
  onExportReport: (ideaId?: string) => void;
}) {
  const [tab, setTab] = useState<InspectorTab>('chat');
  const [dataPane, setDataPane] = useState<DataPane>('overview');
  const endRef = useRef<HTMLDivElement>(null);
  const idea = session.ideas.find((item) => item.id === selection.ideaId);
  const bestIdea = pickBestSchemeIdea(session.ideas);
  const events = useMemo(() => eventsForSelection(session, selection), [session, selection]);
  const turn = useMemo(
    () => buildTurn(session, selection, idea, events, liveTrace, artifact),
    [session, selection, idea, events, liveTrace, artifact]
  );
  const status = nodeStatus(session, selection, idea);
  const running = turn.running || status === 'running' || status === 'brainstorming' || status === 'researching';
  const attachments = session.attachments || [];
  const reportDone = Boolean(idea?.stages.some((stage) => stage.key === 'report' && stage.status === 'done') || artifact?.report);
  const canResearch = Boolean(idea && idea.solvability === 'solvable');
  const trace = readStageAgentTrace(idea && selection.stageKey ? stageOf(idea.stages, selection.stageKey === 'write' ? 'write' : selection.stageKey) : undefined);

  const dataPanes = useMemo(() => {
    if (selection.kind === 'root') return [
      { id: 'overview', label: '概览' },
      { id: 'ideas', label: '想法' },
      { id: 'files', label: '附件' }
    ];
    if (selection.kind === 'idea') return [
      { id: 'overview', label: '概览' },
      { id: 'pipeline', label: '流水线' }
    ];
    if (selection.stageKey === 'design') return [
      { id: 'overview', label: '概览' },
      { id: 'design', label: '设计' },
      { id: 'model', label: '模型' },
      { id: 'result', label: '结果' },
      { id: 'results', label: '解读' }
    ];
    if (selection.stageKey === 'review') return [
      { id: 'overview', label: '概览' },
      { id: 'reviewSmall', label: '小模型' },
      { id: 'reviewLarge', label: '大模型' }
    ];
    return [
      { id: 'overview', label: '概览' },
      { id: 'report', label: '报告' }
    ];
  }, [selection.kind, selection.stageKey]);

  useEffect(() => {
    setTab('chat');
    setDataPane('overview');
  }, [selection.kind, selection.ideaId, selection.stageKey]);

  useEffect(() => {
    if (tab !== 'chat') return;
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [tab, turn.reply, turn.timeline.length, turn.running]);

  const headerStatus = selection.kind === 'root'
    ? sessionStatusLabel(session.status)
    : selection.kind === 'idea'
      ? idea?.solvability === 'rejected' ? '不可研究' : '可研究'
      : stageStatusLabel(typeof status === 'string' && ['idle', 'running', 'done', 'failed', 'skipped'].includes(status) ? status as SchemeStageStatus : 'idle');

  return (
    <aside className="rag-knowledge-panel flex w-[min(52%,480px)] min-w-0 shrink-0 border-l border-border">
      <header className="flex shrink-0 items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="truncate text-sm font-semibold text-foreground">{selection.title}</div>
            {running ? <span className="rag-oc-status-dot" aria-label="进行中" /> : null}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {agentLabel(selection)} · {headerStatus}
          </div>
        </div>
        <button type="button" className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={onClose} aria-label="关闭详情">
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="scheme-inspector-tabs" role="tablist">
          <button type="button" className={cn('scheme-inspector-tab', tab === 'chat' && 'scheme-inspector-tab-active')} onClick={() => setTab('chat')}>
            对话
          </button>
          <button type="button" className={cn('scheme-inspector-tab', tab === 'data' && 'scheme-inspector-tab-active')} onClick={() => setTab('data')}>
            数据
          </button>
        </div>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {tab === 'chat' ? (
          <div className="flex flex-col gap-4 p-4">
            <div className="flex justify-end">
              <div className="rag-user-bubble max-w-[92%]">
                <InspectorMarkdown content={turn.user} className="text-primary-foreground [&_*]:text-inherit [&_a]:underline" />
                {selection.kind === 'root' && attachments.length ? (
                  <CompactMessageAttachments
                    attachments={attachments}
                    inverted
                    onOpen={(item) => window.open(item.previewUrl, '_blank', 'noopener,noreferrer')}
                  />
                ) : null}
              </div>
            </div>
            <div className="flex justify-start">
              <div className="rag-assistant-bubble max-w-[98%]">
                {turn.running && !turn.reply ? (
                  <div className="rag-oc-live" aria-busy="true">
                    <div className="rag-oc-live-label rag-think-label-shimmer">{turn.runningHint || '推理链展开中…'}</div>
                    {turn.timeline.length ? (
                      <div className="rag-oc-stream space-y-2.5">
                        {turn.timeline.map((item, index) => (
                          <TraceLine key={item.id} item={item} active={index === turn.timeline.length - 1} />
                        ))}
                      </div>
                    ) : (
                      <div className="rag-oc-prose rag-oc-prose-active">
                        <div className="rag-oc-prose-body">{turn.runningHint}</div>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <ThinkingBlock items={turn.timeline} running={turn.running} />
                    {turn.reply ? (
                      <div className="mt-2 min-w-0">
                        <InspectorMarkdown content={turn.reply} />
                      </div>
                    ) : !turn.running ? (
                      <p className="text-sm text-muted-foreground">该节点还没有对话输出。</p>
                    ) : null}
                    {turn.error ? <p className="mt-1 text-sm text-destructive">{turn.error}</p> : null}
                    {(artifact?.design || artifact?.reviewSmall || artifact?.report) && selection.kind === 'stage' ? (
                      <button
                        type="button"
                        className="mt-2 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        onClick={() => {
                          setTab('data');
                          setDataPane(selection.stageKey === 'design' ? 'design' : selection.stageKey === 'review' ? 'reviewSmall' : 'report');
                        }}
                      >
                        查看完整产物
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            </div>
            <div ref={endRef} />
          </div>
        ) : (
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap gap-1">
              {dataPanes.map((pane) => (
                <button
                  key={pane.id}
                  type="button"
                  className={cn('scheme-inspector-chip', dataPane === pane.id && 'scheme-inspector-chip-active')}
                  onClick={() => setDataPane(pane.id)}
                >
                  {pane.label}
                </button>
              ))}
            </div>
            {artifactLoading && selection.ideaId ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                正在读取产物…
              </div>
            ) : null}

            {dataPane === 'overview' && selection.kind === 'root' ? (
              <div className="space-y-2">
                <MetaCard label="会话状态" value={`${sessionStatusLabel(session.status)}${session.progressDetail ? ` · ${session.progressDetail}` : ''}`} />
                <MetaCard label="可研究想法" value={session.ideas.filter((item) => item.solvability === 'solvable').length} />
                <MetaCard label="不可研究" value={session.ideas.filter((item) => item.solvability === 'rejected').length} />
                <MetaCard label="最优方案" value={bestIdea?.title} />
                {session.error ? <MetaCard label="错误" value={session.error} /> : null}
              </div>
            ) : null}

            {dataPane === 'ideas' && selection.kind === 'root' ? (
              <div className="space-y-2">
                {session.ideas.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="scheme-inspector-meta w-full text-left transition hover:bg-accent"
                    onClick={() => onSelect({
                      kind: 'idea',
                      ideaId: item.id,
                      stageKey: 'idea',
                      title: item.title,
                      headline: item.rejectReason || item.summary
                    })}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium">{item.title}</span>
                      <span className="text-[10px] text-muted-foreground">{item.solvability === 'rejected' ? '不可研究' : '可研究'}</span>
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{item.summary}</div>
                  </button>
                ))}
                {!session.ideas.length ? <div className="text-xs text-muted-foreground">还没有想法树。</div> : null}
              </div>
            ) : null}

            {dataPane === 'files' && selection.kind === 'root' ? (
              attachments.length ? (
                <CompactMessageAttachments
                  attachments={attachments}
                  onOpen={(item) => window.open(item.previewUrl, '_blank', 'noopener,noreferrer')}
                />
              ) : (
                <div className="text-xs text-muted-foreground">这个方案没有附件。</div>
              )
            ) : null}

            {dataPane === 'overview' && selection.kind === 'idea' && idea ? (
              <div className="space-y-2">
                <MetaCard label="可研究性" value={idea.solvability === 'rejected' ? '不可研究' : '可研究'} />
                <MetaCard label="问题类型" value={idea.problemClass ? problemClassLabel(idea.problemClass) : undefined} />
                <MetaCard label="摘要" value={idea.summary} />
                <MetaCard label="决策" value={idea.decisions} />
                <MetaCard label="约束" value={idea.limits} />
                <MetaCard label="目标" value={idea.goal} />
                <MetaCard label="算例提示" value={idea.caseHint} />
                <MetaCard label="可研究依据" value={idea.whySolvable} />
                <MetaCard label="拒绝原因" value={idea.rejectReason} />
              </div>
            ) : null}

            {dataPane === 'pipeline' && idea ? <StageTimeline stages={idea.stages} /> : null}

            {dataPane === 'overview' && selection.kind === 'stage' ? (
              <div className="space-y-2">
                {selection.stageKey === 'review' || selection.stageKey === 'write' ? (
                  <MetaCard label="最优方案" value={idea?.title} />
                ) : (
                  <MetaCard label="想法" value={idea?.title} />
                )}
                <MetaCard label="Agent" value={agentLabel(selection)} />
                <MetaCard label="会话" value={[trace.agentUid, trace.agentUid2].filter(Boolean).join(' · ')} />
                {idea ? <StageTimeline stages={idea.stages} keys={relatedStageKeys(selection.stageKey)} /> : null}
                {selection.stageKey === 'design' && artifact?.result ? (
                  <>
                    <MetaCard label="目标值" value={resultMeta(artifact.result)?.objective as string | number | undefined} />
                    <MetaCard label="终止状态" value={resultMeta(artifact.result)?.status as string | number | undefined} />
                  </>
                ) : null}
                {events.length ? (
                  <div className="scheme-inspector-meta">
                    <div className="text-[10px] text-muted-foreground">事件</div>
                    <div className="mt-1 space-y-1.5">
                      {events.slice(-8).map((event) => (
                        <div key={event.id} className="text-[11px] leading-4 text-muted-foreground">
                          <span className="mr-1 text-[10px]">{formatTime(event.createdAt)}</span>
                          {event.text}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {dataPane === 'design' ? <ArtifactView title="DESIGN.md" content={artifact?.design} empty="还没有 DESIGN.md" /> : null}
            {dataPane === 'model' ? <ArtifactView title="model.json" content={artifact?.model} json empty="还没有 model.json" /> : null}
            {dataPane === 'result' ? <ArtifactView title="result.json" content={artifact?.result} json empty="还没有求解结果" /> : null}
            {dataPane === 'results' ? <ArtifactView title="RESULTS.md" content={artifact?.results} empty="还没有 RESULTS.md" /> : null}
            {dataPane === 'reviewSmall' ? <ArtifactView title="小模型审查" content={artifact?.reviewSmall} empty="小模型审查尚未落盘" /> : null}
            {dataPane === 'reviewLarge' ? <ArtifactView title="大模型审查" content={artifact?.reviewLarge} empty="大模型审查尚未落盘" /> : null}
            {dataPane === 'report' ? <ArtifactView title="REPORT.md" content={artifact?.report} empty="技术报告尚未落盘" /> : null}
          </div>
        )}
      </div>

      {canResearch || (selection.stageKey === 'write' && reportDone) ? (
        <div className="flex shrink-0 gap-2 border-t border-border p-3">
          {canResearch ? (
            <button
              type="button"
              className="ui-btn-secondary h-8 flex-1 gap-1.5 px-3 text-xs"
              disabled={busy || session.status === 'researching' || session.status === 'brainstorming'}
              onClick={() => onResearchIdea(idea!.id)}
            >
              <Play className="h-3.5 w-3.5" />
              只研究这条想法
            </button>
          ) : null}
          {selection.stageKey === 'write' && reportDone ? (
            <button
              type="button"
              className="ui-btn-secondary h-8 flex-1 gap-1.5 px-3 text-xs"
              onClick={() => onExportReport(idea?.id)}
            >
              <Download className="h-3.5 w-3.5" />
              导出报告
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
