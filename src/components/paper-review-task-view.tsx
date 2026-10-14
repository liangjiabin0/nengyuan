'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CircleDashed, Download, FileText, Loader2, OctagonX, RefreshCw, RotateCcw, Square, TriangleAlert, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PaperReviewProposals } from '@/components/paper-review-proposals';

export type StageView = { id: string; label: string; group: string; status: string; detail?: string; startedAt?: string; finishedAt?: string };
export type Artifact = { id: string; kind: string; label: string; path: string; size: number; stage: string; previewable: boolean };
export type TaskDetail = {
  id: string;
  title: string;
  status: string;
  stage: string;
  progress: number;
  progressDetail: string;
  inputs: Array<{ id: string; role: string; name: string; size: number }>;
  skills: Record<string, { version: string | null; originalName: string; contentSha256: string }> | null;
  model: { requested?: { model: string; thinking: string }; resolved?: { kind: string; model: string; thinking: string }; probe?: { actualModel?: string; reason?: string } } | null;
  stages: StageView[];
  gates: Record<string, { passed: boolean; detail?: string }>;
  artifacts: Artifact[];
  usage: { calls: number; promptTokens: number; completionTokens: number; reasoningTokens: number; totalTokens: number; limit: number; durationMs: number; models: string[] };
  error: string | null;
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
};
export type EventView = { id: number; stage: string | null; level: string; text: string; createdAt: string };

const STATUS_TEXT: Record<string, string> = {
  draft: '未开始', queued: '排队中', running: '运行中', completed: '已完成', partial: '部分成果', blocked: '受阻', failed: '失败', cancelled: '已取消', waiting_for_approval: '等待确认'
};
const GROUP_TEXT: Record<string, string> = { prepare: '准备', reproduction: '原理级复现', review: '学术评审', ppt: '两页 PPT', package: '质量门禁与打包' };
const GATE_TEXT: Record<string, string> = {
  review_json: '评审 JSON 通过 v8 校验', review_docx: '评审报告 Word', reproduction_evidence: '复现证据或不可复现说明',
  ppt_two_slides: '两页可编辑 PPT', ppt_render_audit: '最终渲染审核（hash 绑定）', literature: '文献获取结果'
};

function StageIcon({ status }: { status: string }) {
  if (status === 'passed') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />;
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-600" />;
  if (status === 'failed') return <XCircle className="h-3.5 w-3.5 text-rose-600" />;
  if (status === 'blocked') return <OctagonX className="h-3.5 w-3.5 text-amber-600" />;
  if (status === 'skipped') return <TriangleAlert className="h-3.5 w-3.5 text-muted-foreground" />;
  return <CircleDashed className="h-3.5 w-3.5 text-muted-foreground/60" />;
}

const fmt = (n: number) => n.toLocaleString('zh-CN');
const href = (taskId: string, a: Artifact, preview = false) => `/api/paper-review/${taskId}/artifacts/${a.id}${preview ? '?mode=preview' : ''}`;

async function download(taskId: string, a: Artifact) {
  const res = await fetch(href(taskId, a));
  if (!res.ok) throw new Error('下载失败');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = a.label;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

function Preview({ taskId, artifact }: { taskId: string; artifact: Artifact }) {
  const [content, setContent] = useState<{ kind: string; html?: string; text?: string } | null>(null);
  const isImage = /\.(png|jpg|svg)$/i.test(artifact.path);
  useEffect(() => {
    if (isImage) return;
    let cancelled = false;
    void fetch(href(taskId, artifact, true)).then((r) => r.json()).then((d) => { if (!cancelled) setContent(d); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [taskId, artifact, isImage]);
  if (isImage) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={href(taskId, artifact, true)} alt={artifact.label} className="w-full rounded border border-border" />;
  }
  if (!content) return <div className="p-4 text-xs text-muted-foreground">加载中…</div>;
  if (content.kind === 'html') return <div className="prose prose-sm max-w-none p-4 dark:prose-invert" dangerouslySetInnerHTML={{ __html: content.html || '' }} />;
  return <pre className="scrollbar-thin max-h-[60vh] overflow-auto whitespace-pre-wrap p-4 text-[11px] leading-5 text-foreground">{content.text}</pre>;
}

export function PaperReviewTaskView({ task, events, onAction, busy }: {
  task: TaskDetail;
  events: EventView[];
  onAction: (action: string, extra?: Record<string, unknown>) => Promise<void>;
  busy: boolean;
}) {
  const [tab, setTab] = useState<'progress' | 'results' | 'proposals'>('progress');
  const [selected, setSelected] = useState<Artifact | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => {
    const out: Array<{ group: string; stages: StageView[] }> = [];
    for (const s of task.stages) {
      const last = out.at(-1);
      if (last?.group === s.group) last.stages.push(s);
      else out.push({ group: s.group, stages: [s] });
    }
    return out;
  }, [task.stages]);
  const renders = task.artifacts.filter((a) => a.kind === 'ppt_render');
  const zip = task.artifacts.find((a) => a.kind === 'zip');
  const failedStage = task.stages.find((s) => s.status === 'failed' || s.status === 'blocked');
  const gateEntries = Object.entries(task.gates);
  const allGates = gateEntries.length > 0 && gateEntries.every(([, g]) => g.passed);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events.length]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground" title={task.title}>{task.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground">
            <span className={cn('font-medium', task.status === 'completed' ? 'text-emerald-700' : ['failed', 'blocked'].includes(task.status) ? 'text-rose-700' : task.status === 'partial' ? 'text-amber-700' : 'text-foreground')}>
              {STATUS_TEXT[task.status] || task.status}{task.running ? ` · ${task.progressDetail || ''}` : ''}
            </span>
            <span className="tabular-nums">进度 {task.progress}%</span>
            {task.model?.resolved ? <span>模型 {task.model.resolved.model}（{task.model.resolved.thinking}{task.model.resolved.kind === 'storm-fallback' ? '，Storm 回退' : ''}）</span> : null}
            <span className="tabular-nums">tokens {fmt(task.usage.totalTokens)} / {fmt(task.usage.limit)}</span>
          </div>
        </div>
        {task.running ? (
          <button type="button" className="ui-btn-secondary h-8 gap-1 px-3 text-xs" disabled={busy} onClick={() => void onAction('cancel')}>
            <Square className="h-3.5 w-3.5" />取消
          </button>
        ) : (
          <>
            {task.status === 'draft' ? (
              <button type="button" className="ui-btn-primary h-8 px-3 text-xs" disabled={busy} onClick={() => void onAction('start')}>开始</button>
            ) : null}
            {['failed', 'blocked', 'partial', 'cancelled'].includes(task.status) ? (
              <button type="button" className="ui-btn-primary h-8 gap-1 px-3 text-xs" disabled={busy} onClick={() => void onAction('retry')} title="已通过的阶段会直接复用，只从失败或受阻处继续">
                <RotateCcw className="h-3.5 w-3.5" />从断点继续
              </button>
            ) : null}
            {['completed', 'partial'].includes(task.status) ? (
              <button type="button" className="ui-btn-secondary h-8 gap-1 px-3 text-xs" disabled={busy} onClick={() => void onAction('rerun_from', { fromStage: 'academic_review' })} title="复现结果更新后，重新生成评审报告、PPT 和成果包">
                <RefreshCw className="h-3.5 w-3.5" />重跑报告与 PPT
              </button>
            ) : null}
          </>
        )}
      </div>

      {task.error && !task.running ? (
        <div className="shrink-0 border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-800" role="alert">
          {failedStage ? `${failedStage.label}：` : ''}{task.error}
        </div>
      ) : null}

      <div className="flex shrink-0 gap-1 border-b border-border px-4 pt-2" role="tablist">
        {([['progress', '进度与证据'], ['results', '结果与下载'], ['proposals', '经验候选']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={cn('rounded-t-md px-3 py-1.5 text-xs transition', tab === id ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'progress' ? (
          <div className="grid h-full min-h-0 gap-0 md:grid-cols-[minmax(0,320px)_1fr]">
            <div className="scrollbar-thin min-h-0 overflow-y-auto border-b border-border p-3 md:border-b-0 md:border-r">
              {groups.map((g) => (
                <div key={g.group} className="mb-3">
                  <div className="mb-1 text-[11px] font-semibold text-muted-foreground">{GROUP_TEXT[g.group] || g.group}</div>
                  <ul className="space-y-0.5">
                    {g.stages.map((s) => (
                      <li key={s.id} className="flex items-start gap-1.5 text-xs" title={s.detail || ''}>
                        <span className="mt-0.5"><StageIcon status={s.status} /></span>
                        <span className="min-w-0 flex-1">
                          <span className={cn(s.status === 'pending' ? 'text-muted-foreground' : 'text-foreground')}>{s.label}</span>
                          {s.detail && ['failed', 'blocked', 'skipped'].includes(s.status) ? <span className="block truncate text-[10px] text-muted-foreground">{s.detail}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <div className="mt-2 space-y-1 rounded-md border border-border p-2 text-[11px] text-muted-foreground">
                <div className="font-medium text-foreground">实际调用</div>
                {task.usage.models.map((m) => <div key={m} className="truncate" title={m}>{m}</div>)}
                <div className="tabular-nums">{task.usage.calls} 次调用 · 输入 {fmt(task.usage.promptTokens)} · 输出 {fmt(task.usage.completionTokens)}（推理 {fmt(task.usage.reasoningTokens)}）</div>
                {task.skills ? Object.entries(task.skills).map(([k, v]) => <div key={k} className="truncate" title={v.contentSha256}>{k} · v{v.version || '?'} · {v.contentSha256}</div>) : null}
              </div>
            </div>
            <div ref={logRef} className="scrollbar-thin min-h-0 overflow-y-auto p-3 font-mono text-[11px] leading-5" aria-live="polite">
              {events.map((e) => (
                <div key={e.id} className={cn(e.level === 'error' ? 'text-rose-700' : e.level === 'warn' ? 'text-amber-700' : e.level === 'success' ? 'text-emerald-700' : 'text-foreground')}>
                  <span className="text-muted-foreground">{e.createdAt.slice(11, 19)} </span>{e.text}
                </div>
              ))}
              {!events.length ? <div className="text-muted-foreground">暂无日志</div> : null}
            </div>
          </div>
        ) : tab === 'results' ? (
          <div className="grid h-full min-h-0 md:grid-cols-[minmax(0,320px)_1fr]">
            <div className="scrollbar-thin min-h-0 overflow-y-auto border-b border-border p-3 md:border-b-0 md:border-r">
              <div className="mb-3 space-y-1">
                <div className="text-[11px] font-semibold text-muted-foreground">质量门禁</div>
                {gateEntries.length ? gateEntries.map(([k, g]) => (
                  <div key={k} className="flex items-start gap-1.5 text-xs" title={g.detail || ''}>
                    {g.passed ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-emerald-600" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 text-rose-600" />}
                    <span>{GATE_TEXT[k] || k}</span>
                  </div>
                )) : <div className="text-xs text-muted-foreground">尚未检查</div>}
              </div>
              {zip ? (
                <button type="button" className="ui-btn-primary mb-2 h-8 w-full gap-1.5 text-xs" onClick={() => void download(task.id, zip)}>
                  <Download className="h-3.5 w-3.5" />下载{allGates ? '完整成果包' : '部分成果草稿包'}
                </button>
              ) : !task.running && ['partial', 'blocked', 'failed'].includes(task.status) && task.stages.some((s) => s.id === 'report_render' && s.status === 'passed') ? (
                <button type="button" className="ui-btn-secondary mb-2 h-8 w-full text-xs" disabled={busy} onClick={() => void onAction('export_draft')}>导出部分成果草稿包（标记为不完整）</button>
              ) : null}
              <div className="text-[11px] font-semibold text-muted-foreground">产物</div>
              <ul className="mt-1 space-y-0.5">
                {task.artifacts.filter((a) => a.kind !== 'zip').map((a) => (
                  <li key={a.id} className="flex items-center gap-1 text-xs">
                    <button type="button" className={cn('min-w-0 flex-1 truncate text-left hover:underline', selected?.id === a.id && 'font-medium text-foreground')} onClick={() => setSelected(a)} disabled={!a.previewable} title={a.path}>
                      <FileText className="mr-1 inline h-3 w-3" />{a.label}
                    </button>
                    <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" aria-label={`下载 ${a.label}`} onClick={() => void download(task.id, a)}>
                      <Download className="h-3 w-3" />
                    </button>
                  </li>
                ))}
                {!task.artifacts.length ? <li className="text-xs text-muted-foreground">尚无产物</li> : null}
              </ul>
            </div>
            <div className="scrollbar-thin min-h-0 overflow-y-auto p-3">
              {selected ? <Preview taskId={task.id} artifact={selected} /> : renders.length ? (
                <div className="space-y-3">
                  <div className="text-[11px] text-muted-foreground">两页 PPT 的最终渲染（由导出的 PPTX 经 PowerPoint 渲染，不是设计草图）</div>
                  {renders.map((r) => <Preview key={r.id} taskId={task.id} artifact={r} />)}
                </div>
              ) : <div className="text-xs text-muted-foreground">选择左侧产物查看预览</div>}
            </div>
          </div>
        ) : (
          <PaperReviewProposals taskId={task.id} canGenerate={task.stages.some((s) => s.id === 'academic_review' && s.status === 'passed')} />
        )}
      </div>
    </div>
  );
}
