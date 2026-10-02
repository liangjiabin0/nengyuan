'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RuntimeNode, RuntimeSnapshot, RuntimeStatus } from '@/lib/system-runtime-types';

const POLL_MS = 6_000;
const NODE_COPY: Record<string, { name: string; caption: string }> = {
  web: { name: 'Web 界面', caption: '提供平台页面与交互入口' },
  api: { name: 'API 服务', caption: '处理平台业务请求' },
  worker: { name: '任务工作进程', caption: '执行后台队列任务' },
  gateway: { name: 'LLM 网关', caption: '转发对话与图像模型请求' },
  opencode: { name: 'OpenCode 智能体', caption: '运行知识智能体任务' },
  'ppt-voice': { name: 'PPT 配音', caption: '生成幻灯片旁白音频' },
  mgplan: { name: '配电网规划', caption: '求解容量规划模型' },
  esopt: { name: 'ESOPT 求解器', caption: '执行 DCOPF、LP 与 MIP' },
  pdf2md: { name: 'PDF 解析器', caption: '将文档转换为 Markdown' },
  dispatch: { name: '电力调度', caption: '执行电力系统优化调度' },
  loss: { name: '线损计算', caption: '计算配电网理论线损' },
  forecast: { name: '源荷预测', caption: '预测光伏、风电与负荷' },
  modelica: { name: 'OpenModelica', caption: '执行物理模型仿真' },
  tdmg: { name: 'TDMG AC-OPF', caption: '求解交流最优潮流' }
};

const STATUS_LABEL: Record<RuntimeStatus, string> = {
  up: '运行中',
  busy: '忙碌',
  standby: '待命',
  down: '离线',
  missing: '未安装',
  checking: '检查中'
};

function countsOf(nodes: RuntimeNode[]) {
  return nodes.reduce(
    (acc, item) => {
      if (item.status === 'up' || item.status === 'busy') acc.live += 1;
      else if (item.status === 'standby') acc.standby += 1;
      else acc.down += 1;
      return acc;
    },
    { live: 0, standby: 0, down: 0 }
  );
}

function labelOf(item: RuntimeNode) {
  const copy = NODE_COPY[item.id];
  return {
    name: copy?.name || item.name || item.id,
    caption: copy?.caption || item.caption || item.detail
  };
}

const SIDECAR_IDS = new Set(['ppt-voice', 'mgplan', 'esopt', 'pdf2md', 'dispatch', 'loss', 'forecast', 'modelica', 'tdmg']);
const CORE_ORDER = ['web', 'api', 'worker', 'gateway', 'opencode'];
const SIDECAR_ORDER = ['ppt-voice', 'mgplan', 'esopt', 'pdf2md', 'dispatch', 'loss', 'forecast', 'modelica', 'tdmg'];

const STATUS_TONE: Record<RuntimeStatus, string> = {
  up: 'bg-emerald-500',
  busy: 'bg-amber-500',
  standby: 'bg-sky-500',
  down: 'bg-rose-500',
  missing: 'bg-rose-500',
  checking: 'bg-neutral-400'
};

function sortNodes(nodes: RuntimeNode[], order: string[]) {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...nodes].sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length));
}

function RuntimeItem({
  item,
  waveIndex
}: {
  item: RuntimeNode;
  waveIndex: number;
}) {
  const label = labelOf(item);

  return (
    <div
      className="runtime-service-item flex min-h-[44px] w-full min-w-0 items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2"
      style={{ animationDelay: `${waveIndex * 420}ms` }}
      title={`${label.name} · ${STATUS_LABEL[item.status]} · ${label.caption}`}
    >
      <span className={`runtime-service-dot h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_TONE[item.status]}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium leading-4 text-foreground">{label.name}</span>
        <span className="runtime-service-caption mt-0.5 block truncate text-[10px] leading-4 text-muted-foreground">{label.caption}</span>
      </span>
    </div>
  );
}

const PLACEHOLDER: RuntimeNode[] = Object.keys(NODE_COPY).map((id) => ({
  id,
  name: NODE_COPY[id]!.name,
  kind: id === 'gateway' ? 'gateway' : id === 'worker' ? 'worker' : id === 'web' || id === 'api' ? 'process' : 'sidecar',
  status: SIDECAR_IDS.has(id) ? 'standby' : 'checking',
  detail: SIDECAR_IDS.has(id) ? 'On-demand sidecar' : 'Checking runtime status',
  caption: NODE_COPY[id]!.caption
}));

function snapshotSignature(snapshot: RuntimeSnapshot) {
  return snapshot.nodes.map((item) => `${item.id}:${item.status}:${item.pid ?? ''}:${item.detail}`).join('|');
}

export function SystemRuntimeMonitor() {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [error, setError] = useState('');

  const poll = useCallback(async () => {
    try {
      const response = await fetch('/api/system/runtime', { cache: 'no-store', credentials: 'include' });
      const payload = (await response.json().catch(() => ({}))) as RuntimeSnapshot & { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Unable to read runtime status');
      setSnapshot((prev) => (prev && snapshotSignature(prev) === snapshotSignature(payload) ? prev : payload));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to read runtime status');
      setSnapshot((prev) => {
        const fallback: RuntimeSnapshot = {
          updatedAt: new Date().toISOString(),
          split: true,
          nodes: PLACEHOLDER.map((item) =>
            item.id === 'web'
              ? { ...item, status: 'up', detail: 'Current page is still reachable' }
              : SIDECAR_IDS.has(item.id)
                ? { ...item, status: 'standby', detail: 'On-demand sidecar' }
                : { ...item, status: 'checking', detail: 'Runtime API is unreachable' }
          )
        };
        return prev && snapshotSignature(prev) === snapshotSignature(fallback) ? prev : fallback;
      });
    }
  }, []);

  useEffect(() => {
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [poll]);

  const nodes = snapshot?.nodes?.length ? snapshot.nodes : PLACEHOLDER;
  const coreNodes = useMemo(() => sortNodes(nodes.filter((item) => !SIDECAR_IDS.has(item.id)), CORE_ORDER), [nodes]);
  const sidecarNodes = useMemo(() => sortNodes(nodes.filter((item) => SIDECAR_IDS.has(item.id)), SIDECAR_ORDER), [nodes]);

  const counts = countsOf(nodes);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start justify-between gap-4">
        <div>
          <div className="ui-kicker">Runtime Services</div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">进程与侧车</h2>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">服务合计</div>
          <div className="mt-0.5 text-xl font-semibold tabular-nums">{nodes.length}</div>
        </div>
      </div>
      {error ? <div className="mt-1 text-[11px] text-muted-foreground">{error}</div> : null}

      <div className="runtime-service-list mt-5 grid min-h-0 flex-1 grid-rows-[minmax(0,2fr)_minmax(0,3fr)] gap-3" aria-label="运行时服务列表">
        <section className="runtime-service-section flex min-h-0 flex-col rounded-lg border border-border bg-muted/30 p-3" aria-labelledby="runtime-core-title">
          <div className="flex shrink-0 items-center justify-between gap-3">
            <h3 id="runtime-core-title" className="text-[13px] font-medium text-foreground">核心进程</h3>
            <div className="flex items-center gap-2 text-[10px] tabular-nums text-muted-foreground">
              <span>{coreNodes.length} 项</span>
              <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{counts.live} 运行</span>
            </div>
          </div>
          <div className="runtime-service-grid mt-2 grid min-h-0 flex-1 auto-rows-fr gap-2 min-[360px]:grid-cols-2 xl:grid-cols-3">
            {coreNodes.map((item, index) => <RuntimeItem key={item.id} item={item} waveIndex={index} />)}
          </div>
        </section>

        <section className="runtime-service-section flex min-h-0 flex-col rounded-lg border border-border bg-muted/30 p-3" aria-labelledby="runtime-sidecar-title">
          <div className="flex shrink-0 items-center justify-between gap-3">
            <h3 id="runtime-sidecar-title" className="text-[13px] font-medium text-foreground">按需侧车</h3>
            <div className="flex items-center gap-2 text-[10px] tabular-nums text-muted-foreground">
              <span>{sidecarNodes.length} 项</span>
              <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-sky-500" />{counts.standby} 待命</span>
              {counts.down ? <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-rose-500" />{counts.down} 异常</span> : null}
            </div>
          </div>
          <div className="runtime-service-grid mt-2 grid min-h-0 flex-1 auto-rows-fr gap-2 min-[360px]:grid-cols-2 xl:grid-cols-3">
            {sidecarNodes.map((item, index) => <RuntimeItem key={item.id} item={item} waveIndex={coreNodes.length + index} />)}
          </div>
        </section>
      </div>
    </div>
  );
}
