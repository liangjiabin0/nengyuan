'use client';

import {
  Download,
  Lightbulb,
  LoaderCircle,
  Paperclip,
  Play,
  Send,
  Sparkles
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useAuth } from '@/components/auth-provider';
import { readWorkbenchState, saveWorkbenchState, updateWorkbenchUrl } from '@/lib/workbench-state';
import { SchemeModelPicker } from '@/components/scheme-model-picker';
import type { ChatModelId } from '@/lib/model-ids';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNotifyError } from '@/components/app-notify';
import { usePageContentReady } from '@/components/page-nav-loading';
import { readDashboardListCache } from '@/lib/dashboard-list-cache';
import { MgplanWorkbenchPanel } from '@/components/mgplan-workbench-panel';
import type { SchemeCanvasSelection } from '@/components/scheme-flow-canvas';
import { SchemeNodeInspector, type SchemeArtifactFiles, type SchemeLiveTraceItem } from '@/components/scheme-node-inspector';
import {
  WorkbenchComposer,
  WorkbenchConvItem,
  WorkbenchMain,
  WorkbenchMainHeader,
  WorkbenchPageShell,
  WorkbenchSidebar
} from '@/components/workbench-page-shell';
import { liveKindFromStep } from '@/lib/scheme-solve/agent-trace';
import { pickBestSchemeIdea } from '@/lib/scheme-solve/best-idea';
import {
  SCHEME_BRAINSTORM_AGENT,
  SCHEME_SOLVE_ATTACHMENT_ACCEPT,
  SCHEME_SOLVE_ATTACHMENT_HINT
} from '@/lib/scheme-solve/constants';
import type { SchemeEvent, SchemeSession, SchemeSessionSnapshot } from '@/lib/scheme-solve/types';
import { cn } from '@/lib/utils';

const SchemeFlowCanvas = dynamic(
  () => import('@/components/scheme-flow-canvas').then((mod) => mod.SchemeFlowCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在加载流程画布…</div>
    )
  }
);

const STARTERS = [
  {
    label: 'IEEE 9 节点交流最优潮流',
    value: '对 IEEE 9 节点系统做交流最优潮流，最小化发电成本并满足电压与线路极限。'
  },
  {
    label: '24 节点直流最优潮流',
    value: '对 IEEE/PGLib 24 节点系统做直流最优潮流，最小化发电成本并满足负荷与线路极限。'
  },
  {
    label: '最小成本配料',
    value: '在营养与预算约束下选择食物配比，建立线性规划并求最小成本。'
  },
  {
    label: '背包式投资组合',
    value: '在容量/资金上限下选择若干项目或设备，建立 0-1 规划使收益最大。'
  },
  {
    label: '三节点微网源网荷储规划（sSEP）',
    value: '对三节点微网做源网荷储规划：电源与储能投资、8760 运行模拟、购售电与弃电成本，用 openTEPES 求最小综合成本。'
  },
  {
    label: 'IEEE 14 有功无功调度',
    value: '对 IEEE 14 节点系统用 pandapower 做有功无功优化调度，输出越限、电压和线路负载，不要只用直流潮流。'
  },
  {
    label: '馈线理论线损',
    value: '对一条 10kV 馈线做南网理论线损计算，输出 17 张结果表、线损率、铁损和铜损。'
  },
  {
    label: '储能 SOC 动态仿真',
    value: '用 OpenModelica 仿真一个储能电池 SOC 动态模型，放电功率 20kW，初始 SOC 0.8，仿真 1 小时，输出 SOC 曲线。'
  },
  {
    label: '光伏日前功率预测',
    value: '对光伏电站做日前 24 小时功率预测，使用多特征 LSTM 论文实现，输出 MAE/RMSE 和可回灌调度的标幺曲线。'
  },
  {
    label: '风电日前功率预测',
    value: '对风电场做日前 24 小时功率预测，使用多特征 LSTM 并加载现成权重，输出曲线和可回灌调度的标幺曲线。'
  },
  {
    label: '负荷季节拆分预测',
    value: '对城市负荷做未来 24 小时预测，使用多特征 V4 季节拆分，输出 MAE/RMSE。'
  },
  {
    label: '德州电量预测回灌调度',
    value: '先对 ERCOT 电量做日前预测，再把标幺曲线回灌到 24 小时配网调度。'
  }
];

function statusLabel(status: SchemeSession['status']) {
  if (status === 'brainstorming') return '头脑风暴中';
  if (status === 'researching') return '研究中';
  if (status === 'ready') return '待研究';
  if (status === 'done') return '已完成';
  if (status === 'failed') return '失败';
  return '草稿';
}

function formatTime(value: string) {
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

const BRAINSTORM_NOISE = /^(启动|能元会话|正在|附件|形成 \d+|标准 |已按|小模型|大模型|调用|read |glob |write |list |grep |技术报告|求解成功|CLI |设计 Agent|撰写 Agent|审查)/;

function isBrainstormTraceEvent(event: SchemeEvent) {
  if (event.level === 'thought' || event.level === 'output') {
    return !event.stage || event.stage === 'brainstorm' || event.stage === 'session';
  }
  if (event.stage !== 'brainstorm' || event.level !== 'info') return false;
  const text = event.text.trim();
  if (/^\[(tool:|observe|thought|plan|output)\]/.test(text)) return true;
  if (/"ideas"\s*:/.test(text)) return true;
  if (text.length < 48 || BRAINSTORM_NOISE.test(text)) return false;
  if (/ses_[A-Za-z0-9]+/.test(text) && text.length < 100) return false;
  return /[。！？；]/.test(text) || text.length > 80;
}

function feedLabel(item: { kind?: string; level?: string; text: string }) {
  if (item.kind === 'tool' || /^\[tool:/.test(item.text)) return '工具';
  if (item.kind === 'plan' || /^\[plan\]/.test(item.text)) return '规划';
  if (item.kind === 'observe' || /^\[observe\]/.test(item.text)) return '回读';
  if (item.kind === 'output' || item.level === 'output' || /"ideas"\s*:/.test(item.text)) return '输出';
  return '思考';
}

function keepSessionIdeas(prev: SchemeSessionSnapshot | null, next: SchemeSessionSnapshot): SchemeSessionSnapshot {
  const incoming = Array.isArray(next.ideas) ? next.ideas : [];
  if (prev && prev.id === next.id && prev.ideas.length && !incoming.length) {
    return { ...next, ideas: prev.ideas };
  }
  return { ...next, ideas: incoming };
}

type LiveTraceItem = SchemeLiveTraceItem;

export function SchemeSolveWorkbench() {
  const {user} = useAuth();
  const [modelConfig, setModelConfig] = useState<{ chatModel: ChatModelId; thinkingId: string }>({ chatModel: 'thunder', thinkingId: 'medium' });
  const [sessions, setSessions] = useState<SchemeSession[]>([]);
  const [session, setSession] = useState<SchemeSessionSnapshot | null>(null);
  const [search, setSearch] = useState('');
  const [idea, setIdea] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [, setError] = useNotifyError();
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<SchemeCanvasSelection | null>(null);
  const [artifact, setArtifact] = useState<SchemeArtifactFiles | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [liveTrace, setLiveTrace] = useState<LiveTraceItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const eventAfterRef = useRef(0);

  usePageContentReady(true);

  const refreshSessions = useCallback(async (force = false) => {
    const list = await readDashboardListCache('/api/scheme-solve', async () => {
      const response = await fetch('/api/scheme-solve');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '读取方案列表失败。');
      return (data.sessions || []) as SchemeSession[];
    }, { force });
    setSessions(list);
    return list;
  }, []);

  const loadSession = useCallback(async (id: string, after = eventAfterRef.current) => {
    const response = await fetch(`/api/scheme-solve/${id}?after=${after}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取方案失败。');
    const next = data.session as SchemeSessionSnapshot;
    setSession((prev) => {
      const incoming = Array.isArray(next?.ideas) ? next.ideas : [];
      const ideas = incoming.length > 0 ? incoming : prev?.id === next.id ? prev.ideas : incoming;
      if (!prev || prev.id !== next.id) return { ...next, ideas };
      const seen = new Set(prev.events.map((item) => item.id));
      const merged = [...prev.events];
      for (const event of next.events || []) {
        if (!seen.has(event.id)) merged.push(event);
      }
      return { ...next, ideas, events: merged };
    });
    setSessions((prev) =>
      prev.map((item) =>
        item.id === next.id
          ? {
              ...item,
              status: next.status,
              progress: next.progress,
              progressDetail: next.progressDetail,
              title: next.title,
              updatedAt: next.updatedAt
            }
          : item
      )
    );
    const maxId = Math.max(after, ...(next.events || []).map((item: SchemeEvent) => item.id), 0);
    eventAfterRef.current = maxId;
    return next;
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    const saved=readWorkbenchState<{sessionId:string;selection:SchemeCanvasSelection;fresh:boolean}>(user.id,'scheme');
    const params=new URL(window.location.href).searchParams;
    const desired=params.get('schemeId') || saved.sessionId;
    void refreshSessions().then(async list=>{
      const target=list.find(item=>item.id===desired) || (!saved.fresh ? list[0] : undefined);
      if (!target)return;
      eventAfterRef.current=0;
      const next=await loadSession(target.id,0);
      const ideaId=params.get('schemeIdea');
      if (saved.sessionId===target.id && saved.selection && saved.selection.ideaId===ideaId && !params.has('powerRun')) setSelection(saved.selection);
      else if (ideaId && next.ideas.some(item=>item.id===ideaId)) setSelection({kind:'stage',ideaId,stageKey:'design',title:'设计求解',headline:'设计与计算'});
      else { const selection=saved.selection; if(selection && (selection.kind==='root' || next.ideas.some(item=>item.id===selection.ideaId))) setSelection(selection); }
    }).catch(reason=>setError(reason instanceof Error?reason.message:'加载失败。'));
  }, [refreshSessions,loadSession,user?.id]);
  useEffect(()=>{
    if(!user?.id || !session)return;
    saveWorkbenchState(user.id,'scheme',{sessionId:session.id,selection});
    updateWorkbenchUrl({schemeId:session.id,schemeIdea:selection?.ideaId||null});
  },[user?.id,session?.id,selection]);

  useEffect(() => {
    const active = session?.status === 'brainstorming' || session?.status === 'researching'
      || sessions.some((item) => item.status === 'brainstorming' || item.status === 'researching');
    if (!active) return;
    const timer = window.setInterval(async () => {
      const id = session?.id;
      void (id ? loadSession(id) : refreshSessions()).catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [session?.id, session?.status, sessions, loadSession, refreshSessions]);

  useEffect(() => {
    if (!session || !selection?.ideaId) {
      setArtifact(null);
      setArtifactLoading(false);
      return;
    }
    let cancelled = false;
    setArtifactLoading(true);
    fetch(`/api/scheme-solve/${session.id}/artifact?ideaId=${selection.ideaId}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '读取节点内容失败。');
        if (!cancelled) setArtifact(data.files || null);
      })
      .catch(() => {
        if (!cancelled) setArtifact(null);
      })
      .finally(() => {
        if (!cancelled) setArtifactLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.id, selection?.ideaId, session?.updatedAt]);

  const visibleSessions = useMemo(() => {
    const keyword = search.trim();
    if (!keyword) return sessions;
    return sessions.filter((item) => item.title.includes(keyword) || item.seedIdea.includes(keyword));
  }, [sessions, search]);

  async function createSession() {
    const text = idea.trim();
    if (text.length < 4) {
      setError('请至少用几句话描述想法。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.set('idea', text);
      form.set('chatModel', modelConfig.chatModel);
      form.set('thinkingId', modelConfig.thinkingId);
      for (const file of files) form.append('files', file);
      const response = await fetch('/api/scheme-solve', { method: 'POST', body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '创建失败。');
      eventAfterRef.current = 0;
      setSession(data.session);
      setIdea('');
      setFiles([]);
      await refreshSessions(true);
      await brainstorm(data.session);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建失败。');
    } finally {
      setBusy(false);
    }
  }

  async function brainstorm(target = session) {
    if (!target) return;
    setBusy(true);
    setError('');
    setLiveTrace([]);
    try {
      const response = await fetch(`/api/scheme-solve/${target.id}/brainstorm`, { method: 'POST' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || '头脑风暴失败。');
      }
      if (!response.body) throw new Error('响应流不可用。');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const consume = async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const event = JSON.parse(trimmed) as {
          type?: string;
          error?: string;
          session?: SchemeSessionSnapshot;
          step?: { type?: string; step?: number; content?: string; tool?: string };
        };
        if (event.type === 'error') throw new Error(event.error || '头脑风暴失败。');
        if (event.session) setSession((prev) => keepSessionIdeas(prev, event.session!));
        if (event.type === 'agent_step' && event.step) {
          const step = event.step;
          const text = (step.content || '').trim();
          if (!text && step.type !== 'tool_call') return;
          const key = `${step.type}:${step.step ?? text.slice(0, 24)}:${step.tool || ''}`;
          setLiveTrace((prev) => [...prev.filter((item) => item.key !== key), {
            key,
            kind: liveKindFromStep(step.type),
            text: text || step.tool || '工具调用',
            tool: step.tool
          }]);
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: !done });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          await consume(line);
          newline = buffer.indexOf('\n');
        }
        if (done) break;
      }
      if (buffer.trim()) await consume(buffer);
      await loadSession(target.id, 0);
      await refreshSessions(true);
      setLiveTrace([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '头脑风暴失败。');
      await loadSession(target.id).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function startResearch(ideaIds?: string[]) {
    if (!session) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/scheme-solve/${session.id}/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ideaIds })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '启动研究失败。');
      if (data.session) setSession((prev) => keepSessionIdeas(prev, data.session as SchemeSessionSnapshot));
      await loadSession(session.id);
      await refreshSessions(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '启动研究失败。');
    } finally {
      setBusy(false);
    }
  }

  async function exportReport(ideaId?: string) {
    if (!session) return;
    const response = await fetch(`/api/scheme-solve/${session.id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ideaId })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setError(data.error || '导出失败。');
      return;
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = encoded ? decodeURIComponent(encoded) : '技术报告.docx';
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  async function removeSession(id: string) {
    const response = await fetch(`/api/scheme-solve/${id}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || '删除失败。');
      return;
    }
    if (session?.id === id) {
      setSession(null);
      setSelection(null);
    }
    await refreshSessions(true);
  }

  const solvableCount = session?.ideas.filter((item) => item.solvability === 'solvable').length || 0;
  const bestIdea = session ? pickBestSchemeIdea(session.ideas) : undefined;

  const brainstormFeed = useMemo(() => {
    const persisted = (session?.events || [])
      .filter(isBrainstormTraceEvent)
      .map((event) => ({
        key: `event:${event.id}`,
        kind: /^\[tool:/.test(event.text) ? 'tool' as const : event.level === 'output' ? 'output' as const : 'thought' as const,
        text: event.text.replace(/^\[(thought|plan|output|observe|tool:[^\]]+)\]\s*/, ''),
        time: formatTime(event.createdAt)
      }));
    const seen = new Set(persisted.map((item) => item.text.trim()));
    const live = liveTrace
      .filter((item) => !seen.has(item.text.trim()))
      .map((item) => ({ key: item.key, kind: item.kind, text: item.text, time: '此刻' }));
    return [...persisted, ...live].reverse();
  }, [session?.events, liveTrace]);

  return (
    <WorkbenchPageShell
      crumb="Dashboard / Scheme"
      title="方案求解"
      description="用于梳理方案思路，比较不同求解路径并形成分析报告。"
    >
      <WorkbenchSidebar
        historyOpen={historyOpen}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="搜索方案..."
        onNew={() => {
          saveWorkbenchState(user?.id||'','scheme',{fresh:true});
          updateWorkbenchUrl({schemeId:null,schemeIdea:null,powerRun:null});
          setSession(null);
          setSelection(null);
          setError('');
          setHistoryOpen(false);
        }}
        newLabel="新方案"
        hasItems={visibleSessions.length > 0}
        emptyIcon={<Lightbulb className="h-8 w-8 text-muted-foreground/40" strokeWidth={1.4} />}
        emptyTitle="暂无方案"
        emptyHint="描述想法后会显示在这里"
      >
        {visibleSessions.map((item) => (
          <WorkbenchConvItem
            key={item.id}
            active={session?.id === item.id}
            title={item.title}
            time={formatTime(item.updatedAt)}
            subtitle={statusLabel(item.status)}
            onOpen={() => {
              eventAfterRef.current = 0;
              setSelection(null);
              setHistoryOpen(false);
              void loadSession(item.id, 0).catch((reason) => setError(reason instanceof Error ? reason.message : '读取失败。'));
            }}
            onDelete={() => void removeSession(item.id)}
            deleteLabel="删除方案"
          />
        ))}
      </WorkbenchSidebar>

      <WorkbenchMain historyOpen={historyOpen}>
        <WorkbenchMainHeader
          title={session?.title || '新方案'}
          subtitle={
            session
              ? `${statusLabel(session.status)} · ${session.progressDetail || session.seedIdea}`
              : '选择或开始一个方案'
          }
          onOpenHistory={() => setHistoryOpen(true)}
          historyLabel="打开方案列表"
          actions={
            session ? (
              <>
                <button
                  type="button"
                  className="ui-btn-primary h-8 gap-1.5 px-2.5 text-xs"
                  disabled={busy || session.status === 'brainstorming' || session.status === 'researching'}
                  onClick={() => void brainstorm()}
                >
                  {session.status === 'brainstorming' ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  头脑风暴
                </button>
                <button
                  type="button"
                  className="ui-btn-secondary h-8 gap-1.5 px-2.5 text-xs"
                  disabled={busy || !solvableCount || session.status === 'researching' || session.status === 'brainstorming'}
                  onClick={() => void startResearch()}
                >
                  <Play className="h-3.5 w-3.5" />
                  开始研究
                </button>
                <button
                  type="button"
                  className="ui-btn-secondary h-8 gap-1.5 px-2.5 text-xs"
                  disabled={!session.ideas.some((item) => item.stages.some((stage) => stage.key === 'report' && stage.status === 'done'))}
                  onClick={() => void exportReport(bestIdea?.id)}
                >
                  <Download className="h-3.5 w-3.5" />
                  导出
                </button>
              </>
            ) : null
          }
        />

        {!session ? (
          <>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <div className="flex h-full min-h-72 flex-col items-center justify-center px-4 text-center">
                <Lightbulb className="h-8 w-8 text-muted-foreground/40" strokeWidth={1.4} />
                <p className="mt-4 text-sm font-medium text-foreground">描述一个可建模的决策问题</p>
                <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                  例如直流最优潮流、配料、背包，或三节点微网源网荷储规划。可研究想法会展开成流程树。
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {STARTERS.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
                      onClick={() => setIdea(item.value)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <WorkbenchComposer>
              <div className="mb-2"><SchemeModelPicker value={modelConfig} onChange={setModelConfig} disabled={busy}/></div>
              {files.length ? (
                <div className="mb-2 text-xs text-muted-foreground">{files.map((file) => file.name).join('、')}</div>
              ) : null}
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={SCHEME_SOLVE_ATTACHMENT_ACCEPT}
                className="sr-only"
                tabIndex={-1}
                onChange={(event) => setFiles(Array.from(event.target.files || []))}
              />
              <div className="flex items-end gap-2">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
                  aria-label="添加附件"
                  title={SCHEME_SOLVE_ATTACHMENT_HINT}
                >
                  <Paperclip className="h-4 w-4" />
                </button>
                <textarea
                  value={idea}
                  onChange={(event) => setIdea(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void createSession();
                    }
                  }}
                  placeholder="输入你的方案构想..."
                  rows={2}
                  className="ui-input max-h-40 min-h-10 flex-1 resize-none py-2.5"
                />
                <button
                  type="button"
                  disabled={busy || idea.trim().length < 4}
                  onClick={() => void createSession()}
                  className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="创建方案"
                >
                  {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                </button>
              </div>
            </WorkbenchComposer>
          </>
        ) : (
          <>
            <div className="flex min-h-0 flex-1">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="relative min-h-0 flex-1">
                  <SchemeFlowCanvas session={session} onSelect={setSelection} />
                  {!session.ideas.length ? (
                    <div className="pointer-events-none absolute inset-x-0 top-4 z-10 text-center text-sm text-muted-foreground">
                      先点击「头脑风暴」生成想法树。
                    </div>
                  ) : null}
                </div>
                <div className="scrollbar-thin h-[260px] shrink-0 overflow-y-auto border-t border-border bg-muted/20 px-4 py-2">
                  <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                    {SCHEME_BRAINSTORM_AGENT} · 推理链
                  </div>
                  <div className="space-y-2.5">
                    {brainstormFeed.map((item) => (
                      <div key={item.key} className="text-[11px] leading-5">
                        <div className="text-[10px] text-muted-foreground">
                          {item.time} · {feedLabel(item)}
                        </div>
                        <div className={cn('mt-0.5 whitespace-pre-wrap', item.kind === 'output' ? 'text-xs text-foreground' : 'text-[11px] text-muted-foreground')}>
                          {item.text}
                        </div>
                      </div>
                    ))}
                    {!brainstormFeed.length ? <div className="text-xs text-muted-foreground">还没有推理链。头脑风暴开始后会显示思考、工具调用与输出。</div> : null}
                  </div>
                </div>
              </div>
              {selection && session.ideas.find((item) => item.id === selection.ideaId)?.problemClass === 'mgplan' ? (
                <MgplanWorkbenchPanel
                  session={session}
                  idea={session.ideas.find((item) => item.id === selection.ideaId)!}
                  selection={selection}
                  busy={busy}
                  onClose={() => setSelection(null)}
                  onResearch={() => void startResearch([selection.ideaId!])}
                  onSession={(next) => setSession((prev) => keepSessionIdeas(prev, next))}
                  onExport={() => void exportReport(selection.ideaId)}
                />
              ) : selection ? (
                <SchemeNodeInspector
                  session={session}
                  selection={selection}
                  artifact={artifact}
                  artifactLoading={artifactLoading}
                  liveTrace={liveTrace}
                  busy={busy}
                  onClose={() => setSelection(null)}
                  onSelect={setSelection}
                  onResearchIdea={(ideaId) => void startResearch([ideaId])}
                  onExportReport={(ideaId) => void exportReport(ideaId)}
                />
              ) : null}
            </div>
          </>
        )}
      </WorkbenchMain>
    </WorkbenchPageShell>
  );
}
