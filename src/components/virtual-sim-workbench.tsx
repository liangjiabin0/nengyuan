"use client";

import {
  Activity,
  Calculator,
  ChevronDown,
  CircuitBoard,
  Cpu,
  Download,
  LineChart,
  LoaderCircle,
  Network,
  Paperclip,
  Play,
  Send,
} from "lucide-react";
import type { PowerRun } from "@/lib/power-compute/store";
import { POWER_PHASES, powerTaskLabel } from "@/lib/power-compute/catalog";
import { PowerComputePanel } from "@/components/power-compute-panel";
import { PowerTaskIndicator } from "@/components/power-task-indicator";
import { useAuth } from "@/components/auth-provider";
import {
  readWorkbenchState,
  saveWorkbenchState,
  updateWorkbenchUrl,
} from "@/lib/workbench-state";
import { SchemeModelPicker } from "@/components/scheme-model-picker";
import type { ChatModelId } from "@/lib/model-ids";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CompactMessageAttachments } from "@/components/attachment-chips";
import {
  PaperReproExecutionChain,
  type PaperReproExecutionChainItem,
} from "@/components/paper-repro-execution-chain";
import { useNotifyError } from "@/components/app-notify";
import { usePageContentReady } from "@/components/page-nav-loading";
import { readDashboardListCache } from "@/lib/dashboard-list-cache";
import {
  VirtualSimOutputPreview,
  type VirtualSimOutputFile,
} from "@/components/virtual-sim-output-preview";
import { VirtualSimVizPanel } from "@/components/virtual-sim-viz";
import {
  WorkbenchComposer,
  WorkbenchConvItem,
  WorkbenchMain,
  WorkbenchMainHeader,
  WorkbenchPageShell,
  WorkbenchSidebar,
} from "@/components/workbench-page-shell";
import {
  type InspectorTraceItem,
  type SchemeArtifactFiles,
  type SchemeLiveTraceItem,
} from "@/lib/scheme-solve/agent-trace";
import {
  SCHEME_SOLVE_ATTACHMENT_ACCEPT,
  SCHEME_SOLVE_ATTACHMENT_HINT,
  SCHEME_STAGE_KEYS,
  SCHEME_STAGE_LABELS,
} from "@/lib/scheme-solve/constants";
import type {
  SchemeEvent,
  SchemeSession,
  SchemeSessionSnapshot,
  SchemeStageStatus,
} from "@/lib/scheme-solve/types";
import { composeVirtualSimTurn } from "@/lib/virtual-sim/trace";
import {
  VIRTUAL_SIM_API_BASE,
  VIRTUAL_SIM_CAPABILITIES,
  VIRTUAL_SIM_CAPABILITY_GROUPS,
  getVirtualSimCapability,
  getVirtualSimTool,
  inferVirtualSimRouting,
  type VirtualSimCapabilityGroupId,
  type VirtualSimCapabilityId,
  type VirtualSimToolId,
} from "@/lib/virtual-sim/tools";
import type { SimViz } from "@/lib/virtual-sim/visualize";
import { cn } from "@/lib/utils";
import { RagThinkCollapse } from "@/components/rag-think-collapse";

type DataPane = "overview" | "design" | "model" | "result" | "report";

function statusLabel(status: SchemeSession["status"]) {
  if (status === "researching") return "仿真中";
  if (status === "brainstorming") return "准备中";
  if (status === "ready") return "待运行";
  if (status === "done") return "已完成";
  if (status === "failed") return "失败";
  return "草稿";
}

function formatTime(value: string) {
  const date = new Date(
    value.includes("T") ? value : `${value.replace(" ", "T")}Z`,
  );
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatDuration(ms?: number) {
  if (!ms || ms < 400) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function CapabilityGroupIcon({
  groupId,
  className = "h-3.5 w-3.5",
}: {
  groupId: VirtualSimCapabilityGroupId;
  className?: string;
}) {
  if (groupId === "forecast")
    return <LineChart className={className} aria-hidden="true" />;
  if (groupId === "dispatch")
    return <Network className={className} aria-hidden="true" />;
  if (groupId === "acopf")
    return <CircuitBoard className={className} aria-hidden="true" />;
  if (groupId === "modelica")
    return <Cpu className={className} aria-hidden="true" />;
  if (groupId === "esopt")
    return <Calculator className={className} aria-hidden="true" />;
  return <Activity className={className} aria-hidden="true" />;
}

function ExperimentCatalogTable() {
  return (
    <section
      className="min-w-0 max-w-full overflow-hidden"
      aria-labelledby="virtual-sim-catalog-title"
    >
      <div className="flex items-end justify-between gap-4 border-b border-border pb-2">
        <div>
          <h2
            id="virtual-sim-catalog-title"
            className="text-sm font-semibold text-foreground"
          >
            可运行实验
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            按实验类型匹配计算工具
          </p>
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {VIRTUAL_SIM_CAPABILITIES.length} 类
        </span>
      </div>
      <div className="scrollbar-thin w-full max-w-full overflow-x-auto">
        <table className="w-full min-w-[720px] table-fixed text-left text-xs">
          <thead className="text-[11px] text-muted-foreground">
            <tr className="border-b border-border">
              <th className="w-[16%] px-2 py-2 font-medium">分类</th>
              <th className="w-[22%] px-2 py-2 font-medium">实验类型</th>
              <th className="w-[31%] px-2 py-2 font-medium">求解方法</th>
              <th className="w-[31%] px-2 py-2 font-medium">计算工具 / 状态</th>
            </tr>
          </thead>
          <tbody>
            {VIRTUAL_SIM_CAPABILITIES.map((item) => {
              const group = VIRTUAL_SIM_CAPABILITY_GROUPS.find(
                (candidate) => candidate.id === item.groupId,
              );
              return (
                <tr
                  key={item.id}
                  className="border-b border-border/70 align-top last:border-b-0"
                >
                  <td className="px-2 py-2.5 text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <CapabilityGroupIcon groupId={item.groupId} />
                      {group?.label}
                    </span>
                  </td>
                  <td className="px-2 py-2.5 font-medium text-foreground">
                    {item.label}
                  </td>
                  <td className="break-words px-2 py-2.5 leading-5 text-foreground">
                    {item.method}
                  </td>
                  <td className="break-words px-2 py-2.5 leading-5">
                    <div className="text-foreground">{item.engine}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {item.integration}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function executionStatus(
  status: SchemeStageStatus,
): PaperReproExecutionChainItem["status"] {
  if (status === "running") return "running";
  if (status === "done") return "success";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return "queued";
}

const EXECUTION_STAGE_LABELS: Record<string, string> = {
  idea: "解析任务与实验契约",
  design: "Agent 设计求解路径",
  model: "生成规范化模型",
  solve: "执行数值计算",
  review: "双模型结果审查",
  write: "生成实验纪要",
  report: "归档报告与审计产物",
};

function buildExecutionChain(
  session: SchemeSessionSnapshot | null,
  engine: string,
): PaperReproExecutionChainItem[] {
  const stages = session?.ideas[0]?.stages || [];
  return stages.map((stage) => ({
    type: "execution_step",
    stepId: stage.key,
    engine,
    status: executionStatus(stage.status),
    message:
      stage.status === "running" && stage.headline
        ? `${EXECUTION_STAGE_LABELS[stage.key] || SCHEME_STAGE_LABELS[stage.key]}：${stage.headline}`
        : EXECUTION_STAGE_LABELS[stage.key] || SCHEME_STAGE_LABELS[stage.key],
  }));
}

function readResultRecord(result?: string) {
  if (!result?.trim()) return null;
  try {
    const parsed = JSON.parse(result) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function fidelityLabel(value: unknown) {
  if (value === "paper-compatible") return "论文兼容复现";
  if (value === "adapted") return "适配实验";
  if (value === "fallback") return "回退基线";
  if (value === "not-executed") return "未执行";
  return value ? String(value) : "";
}

function weightStatusLabel(value: unknown) {
  if (value === "loaded") return "仓库现成权重";
  if (value === "trained") return "现场训练权重";
  if (value === "fallback") return "回退模型";
  return value ? String(value) : "";
}

function InspectorMarkdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "scheme-md min-w-0 text-[13px] leading-6 text-foreground",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-2 mt-3 text-sm font-semibold first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-3 text-sm font-semibold first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1.5 mt-2.5 text-[13px] font-semibold first:mt-0">
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="my-2 list-disc space-y-1 pl-4">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 list-decimal space-y-1 pl-4">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-6">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          code: ({ className: codeClass, children }) => (
            <code
              className={cn(
                "rounded-md bg-muted px-1 py-0.5 text-[0.9em]",
                codeClass,
              )}
            >
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="scrollbar-thin my-2 overflow-x-auto rounded-lg border border-border bg-muted/50 p-2.5 text-[11px] leading-4">
              {children}
            </pre>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function TraceLine({
  item,
  active,
}: {
  item: InspectorTraceItem;
  active?: boolean;
}) {
  if (item.kind === "tool") {
    const [verb, ...rest] = item.body.split(" · ");
    return (
      <div className={cn("rag-oc-tool", active && "rag-oc-tool-active")}>
        <span className="rag-oc-tool-verb">{item.label || verb}</span>
        <span className="rag-oc-tool-detail">
          {rest.join(" · ") || item.body}
        </span>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "rag-oc-prose space-y-1",
        active && "rag-oc-prose-active",
        item.kind === "error" && "text-destructive",
      )}
    >
      <div className="flex items-center gap-2 text-[10px] tracking-wide text-muted-foreground">
        <span>{item.label}</span>
        {item.time ? <span>{formatTime(item.time)}</span> : null}
        {formatDuration(item.durationMs) ? (
          <span>{formatDuration(item.durationMs)}</span>
        ) : null}
      </div>
      <div className="rag-oc-prose-body whitespace-pre-wrap">{item.body}</div>
    </div>
  );
}

function ThinkingBlock({
  items,
  running,
}: {
  items: InspectorTraceItem[];
  running?: boolean;
}) {
  const [open, setOpen] = useState(true);
  if (!items.length) return null;
  const tools = items.filter((item) => item.kind === "tool").length;
  const thoughts = items.filter(
    (item) => item.kind === "thought" || item.kind === "plan",
  ).length;
  const label = running
    ? `推理链展开中 · ${items.length} 步`
    : `推理链 · ${items.length} 步${thoughts ? ` · ${thoughts} 次思考` : ""}${tools ? ` · ${tools} 次工具` : ""}`;
  return (
    <div className={cn("rag-think", open && "rag-think-open")}>
      <button
        type="button"
        className="rag-think-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span
          className={cn(
            "rag-think-label",
            running && "rag-think-label-shimmer",
          )}
        >
          {label}
        </span>
        <ChevronDown
          className={cn("rag-think-chevron h-3.5 w-3.5", open && "rotate-180")}
        />
      </button>
      <RagThinkCollapse open={open}>
        <div className="rag-oc-stream rag-think-body space-y-2.5">
          {items.map((item, index) => (
            <TraceLine
              key={item.id}
              item={item}
              active={running && index === items.length - 1}
            />
          ))}
        </div>
      </RagThinkCollapse>
    </div>
  );
}

function isPendingSession(session: SchemeSessionSnapshot | null) {
  return Boolean(session?.id.startsWith("pending-"));
}

function makePendingSnapshot(
  text: string,
  toolId: VirtualSimToolId,
): SchemeSessionSnapshot {
  const now = new Date().toISOString();
  const title = text.length > 28 ? `${text.slice(0, 28)}…` : text;
  const tool = getVirtualSimTool(toolId);
  return {
    id: `pending-${Date.now()}`,
    title,
    seedIdea: text,
    status: "researching",
    progress: 5,
    progressDetail: `已提交，${tool.engine} 正在进入求解队列`,
    source: "virtual-sim",
    toolId,
    createdAt: now,
    updatedAt: now,
    ideas: [
      {
        id: "pending-idea",
        sessionId: "pending",
        parentId: null,
        title,
        summary: text,
        solvability: "solvable",
        problemClass: toolId,
        sortOrder: 1,
        createdAt: now,
        updatedAt: now,
        stages: SCHEME_STAGE_KEYS.map((key) => ({
          id: key,
          sessionId: "pending",
          ideaId: "pending-idea",
          key,
          status:
            key === "idea" ? "done" : key === "design" ? "running" : "idle",
          headline:
            key === "idea"
              ? text.slice(0, 80)
              : key === "design"
                ? "已提交，AI 正在排队建模"
                : `等待${SCHEME_STAGE_LABELS[key]}`,
          updatedAt: now,
        })),
      },
    ],
    events: [],
  };
}

function ThinkingLive({
  hint,
  items,
}: {
  hint: string;
  items: InspectorTraceItem[];
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(
      () => setElapsed((value) => value + 1),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);
  const clock =
    elapsed >= 60
      ? `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`
      : `${elapsed} 秒`;
  return (
    <div className="rag-oc-live" aria-busy="true" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <div className="rag-oc-live-label rag-think-label-shimmer">思考中</div>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          已用时 {clock}
        </span>
      </div>
      <div className="rag-oc-stream space-y-2.5">
        {items.length ? (
          items.map((item, index) => (
            <TraceLine
              key={item.id}
              item={item}
              active={index === items.length - 1}
            />
          ))
        ) : (
          <div className="rag-oc-prose rag-oc-prose-active">
            <div className="rag-oc-prose-body">{hint || "正在整理思路…"}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function VirtualSimResultBundle({
  title,
  engine,
  status,
  fidelity,
  weightStatus,
  sample,
  pane,
  onPaneChange,
  artifact,
  artifactLoading,
  viz,
  vizLoading,
}: {
  title: string;
  engine: string;
  status: string;
  fidelity?: string;
  weightStatus?: string;
  sample?: boolean;
  pane: DataPane;
  onPaneChange: (pane: DataPane) => void;
  artifact: SchemeArtifactFiles | null;
  artifactLoading: boolean;
  viz: SimViz | null;
  vizLoading: boolean;
}) {
  const tabs: Array<[DataPane, string]> = [
    ["overview", "结果"],
    ["design", "设计"],
    ["model", "模型"],
    ["result", "原始输出"],
    ["report", "报告"],
  ];
  return (
    <section
      className="mt-4 overflow-hidden rounded-lg border border-border bg-background"
      aria-label="虚拟仿真结果"
    >
      <header className="border-b border-border px-3 py-2.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">{title}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {engine}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-foreground">
              {status}
            </span>
            {fidelity ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-foreground">
                {fidelity}
              </span>
            ) : null}
            {weightStatus ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                {weightStatus}
              </span>
            ) : null}
            {sample ? (
              <span className="rounded-full border border-amber-500/40 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                样例数据
              </span>
            ) : null}
          </div>
        </div>
        <div
          className="mt-2 flex gap-1 overflow-x-auto"
          role="tablist"
          aria-label="仿真结果视图"
        >
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={pane === id}
              className={cn(
                "scheme-inspector-chip shrink-0",
                pane === id && "scheme-inspector-chip-active",
              )}
              onClick={() => onPaneChange(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      <div className="p-3">
        {artifactLoading && pane !== "overview" ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            正在读取产物…
          </div>
        ) : null}
        {pane === "overview" ? (
          <VirtualSimVizPanel viz={viz} loading={vizLoading} />
        ) : null}
        {pane === "design" ? (
          artifact?.design ? (
            <InspectorMarkdown content={artifact.design} />
          ) : (
            <div className="text-xs text-muted-foreground">
              还没有 DESIGN.md
            </div>
          )
        ) : null}
        {pane === "model" ? (
          artifact?.model ? (
            <pre className="scrollbar-thin max-h-[420px] overflow-auto rounded-md border border-border bg-muted/40 p-2.5 font-mono text-[11px] leading-4">
              {artifact.model}
            </pre>
          ) : (
            <div className="text-xs text-muted-foreground">
              还没有 model.json
            </div>
          )
        ) : null}
        {pane === "result" ? (
          artifact?.result ? (
            <pre className="scrollbar-thin max-h-[420px] overflow-auto rounded-md border border-border bg-muted/40 p-2.5 font-mono text-[11px] leading-4">
              {artifact.result}
            </pre>
          ) : (
            <div className="text-xs text-muted-foreground">
              还没有 result.json
            </div>
          )
        ) : null}
        {pane === "report" ? (
          artifact?.report ? (
            <InspectorMarkdown content={artifact.report} />
          ) : (
            <div className="text-xs text-muted-foreground">
              技术报告尚未落盘
            </div>
          )
        ) : null}
      </div>
    </section>
  );
}

export function VirtualSimWorkbench() {
  const { user } = useAuth();
  const [powerMode, setPowerMode] = useState(false);
  const [powerHistory, setPowerHistory] = useState<PowerRun[]>([]);
  const [newAnalysis, setNewAnalysis] = useState<string | undefined>();
  useEffect(() => {
    let disposed = false;
    const refreshPower = () =>
      void fetch("/api/power-runs", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!disposed && data)
            setPowerHistory(data.runs.filter((r: PowerRun) => !r.sessionId));
        })
        .catch(() => undefined);
    refreshPower();
    window.addEventListener("power-run-created", refreshPower);
    const interval = setInterval(refreshPower, 15000);
    return () => {
      disposed = true;
      clearInterval(interval);
      window.removeEventListener("power-run-created", refreshPower);
    };
  }, [user?.id]);
  useEffect(() => {
    if (!user?.id) return;
    const saved = readWorkbenchState<{ mode: string }>(user.id, "virtual");
    if (
      new URL(window.location.href).searchParams.has("powerRun") ||
      saved.mode === "power"
    )
      setPowerMode(true);
  }, [user?.id]);
  const choosePowerMode = (value: boolean) => {
    setPowerMode(value);
    const saved = readWorkbenchState<{ sessionId: string }>(
      user?.id || "",
      "virtual",
    );
    saveWorkbenchState(user?.id || "", "virtual", {
      ...saved,
      mode: value ? "power" : "legacy",
    });
    if (!value) updateWorkbenchUrl({ powerRun: null });
  };
  const [capabilityId, setCapabilityId] =
    useState<VirtualSimCapabilityId>("dispatch");
  const [modelConfig, setModelConfig] = useState<{
    chatModel: ChatModelId;
    thinkingId: string;
  }>({ chatModel: "thunder", thinkingId: "medium" });
  const [sessions, setSessions] = useState<SchemeSession[]>([]);
  const [session, setSession] = useState<SchemeSessionSnapshot | null>(null);
  const [search, setSearch] = useState("");
  const [idea, setIdea] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [, setError] = useNotifyError();
  const [busy, setBusy] = useState(false);
  const [artifact, setArtifact] = useState<SchemeArtifactFiles | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [outputFiles, setOutputFiles] = useState<VirtualSimOutputFile[]>([]);
  const [previewFile, setPreviewFile] = useState<VirtualSimOutputFile | null>(
    null,
  );
  const [viz, setViz] = useState<SimViz | null>(null);
  const [vizLoading, setVizLoading] = useState(false);
  const [liveTrace, setLiveTrace] = useState<SchemeLiveTraceItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dataPane, setDataPane] = useState<DataPane>("overview");
  const fileRef = useRef<HTMLInputElement>(null);
  const eventAfterRef = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const capability = getVirtualSimCapability(capabilityId);
  const toolId = capability.toolId;

  usePageContentReady(true);

  const refreshSessions = useCallback(async (force = false) => {
    const list = await readDashboardListCache(
      VIRTUAL_SIM_API_BASE,
      async () => {
        const response = await fetch(VIRTUAL_SIM_API_BASE, {
          cache: "no-store",
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "读取任务列表失败。");
        return (data.sessions || []) as SchemeSession[];
      },
      { force },
    );
    setSessions(list);
    return list;
  }, []);

  const loadSession = useCallback(
    async (id: string, after = eventAfterRef.current) => {
      const response = await fetch(
        `${VIRTUAL_SIM_API_BASE}/${id}?after=${after}`,
        { cache: "no-store" },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取任务失败。");
      const next = data.session as SchemeSessionSnapshot;
      const routing = inferVirtualSimRouting(
        `${next.ideas[0]?.caseHint || ""} ${next.seedIdea}`,
        next.attachments?.map((item) => item.name) || [],
        next.toolId,
      );
      setCapabilityId(routing.capabilityId);
      setSession((prev) => {
        if (!prev || prev.id !== next.id) return next;
        const seen = new Set(prev.events.map((item) => item.id));
        const merged = [...prev.events];
        for (const event of next.events || []) {
          if (!seen.has(event.id)) merged.push(event);
        }
        return { ...next, events: merged };
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
                updatedAt: next.updatedAt,
              }
            : item,
        ),
      );
      const maxId = Math.max(
        after,
        ...(next.events || []).map((item: SchemeEvent) => item.id),
        0,
      );
      eventAfterRef.current = maxId;
      return next;
    },
    [],
  );

  useEffect(() => {
    eventAfterRef.current = 0;
    setSession(null);
    setArtifact(null);
    setOutputFiles([]);
    setPreviewFile(null);
    setViz(null);
    setLiveTrace([]);
    setError("");
    if (!user?.id) return;
    const saved = readWorkbenchState<{ sessionId: string; mode: string }>(
      user.id,
      "virtual",
    );
    const desired =
      new URL(window.location.href).searchParams.get("simId") ||
      saved.sessionId;
    void refreshSessions()
      .then((list) => {
        const target = list.find((item) => item.id === desired);
        if (target) return loadSession(target.id, 0);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "加载失败。"),
      );
  }, [refreshSessions, loadSession, user?.id]);
  useEffect(() => {
    if (!user?.id || !session || isPendingSession(session)) return;
    const saved = readWorkbenchState<{ mode: string }>(user.id, "virtual");
    saveWorkbenchState(user.id, "virtual", { ...saved, sessionId: session.id });
    updateWorkbenchUrl({ simId: session.id });
  }, [user?.id, session?.id]);

  useEffect(() => {
    if (isPendingSession(session)) return;
    const active =
      session?.status === "researching" ||
      session?.status === "brainstorming" ||
      sessions.some(
        (item) =>
          item.status === "researching" || item.status === "brainstorming",
      );
    if (!active) return;
    const timer = window.setInterval(async () => {
      const id = session?.id;
      void (id ? loadSession(id) : refreshSessions()).catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [session?.id, session?.status, sessions, loadSession, refreshSessions]);

  const ideaId = session?.ideas[0]?.id;

  useEffect(() => {
    if (!session || !ideaId || isPendingSession(session)) {
      setArtifact(null);
      setViz(null);
      setOutputFiles([]);
      return;
    }
    let cancelled = false;
    const version = encodeURIComponent(
      session.updatedAt || String(session.progress || 0),
    );
    setArtifactLoading(true);
    setVizLoading(true);
    fetch(
      `${VIRTUAL_SIM_API_BASE}/${session.id}/artifact?ideaId=${ideaId}&v=${version}`,
      { cache: "no-store" },
    )
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "读取产物失败。");
        if (!cancelled) {
          setArtifact(data.files || null);
          setOutputFiles(Array.isArray(data.outputs) ? data.outputs : []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setArtifact(null);
          setOutputFiles([]);
        }
      })
      .finally(() => {
        if (!cancelled) setArtifactLoading(false);
      });
    fetch(
      `${VIRTUAL_SIM_API_BASE}/${session.id}/viz?ideaId=${ideaId}&v=${version}`,
      { cache: "no-store" },
    )
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "读取可视化失败。");
        if (!cancelled) {
          const nextViz = data.viz as SimViz | null;
          const caseHint = session.ideas[0]?.caseHint;
          setViz(
            nextViz && caseHint
              ? {
                  ...nextViz,
                  kpis: nextViz.kpis.map((item) =>
                    item.key === "case" && item.value === "[object Object]"
                      ? { ...item, value: caseHint }
                      : item,
                  ),
                }
              : nextViz || null,
          );
        }
      })
      .catch(() => {
        if (!cancelled) setViz(null);
      })
      .finally(() => {
        if (!cancelled) setVizLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.id, ideaId, session?.updatedAt, session?.progress]);

  const turn = useMemo(
    () =>
      session ? composeVirtualSimTurn(session, artifact, liveTrace) : null,
    [session, artifact, liveTrace],
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turn?.reply, turn?.timeline.length, turn?.running]);

  const visibleSessions = useMemo(() => {
    const keyword = search.trim();
    if (!keyword) return sessions;
    return sessions.filter(
      (item) => item.title.includes(keyword) || item.seedIdea.includes(keyword),
    );
  }, [sessions, search]);

  async function startRun(sessionId?: string) {
    const id = sessionId || session?.id;
    if (!id || id.startsWith("pending-")) return;
    setBusy(true);
    setError("");
    setLiveTrace([]);
    try {
      const response = await fetch(`${VIRTUAL_SIM_API_BASE}/${id}/run`, {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "启动仿真失败。");
      eventAfterRef.current = 0;
      if (data.session) setSession(data.session);
      await loadSession(id, 0);
      await refreshSessions(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "启动仿真失败。");
    } finally {
      setBusy(false);
    }
  }

  async function createSession() {
    const text = idea.trim();
    if (text.length < 4) {
      setError("请至少用几句话描述仿真任务。");
      return;
    }
    setBusy(true);
    setError("");
    eventAfterRef.current = 0;
    setDataPane("overview");
    setArtifact(null);
    setViz(null);
    setLiveTrace([]);
    const routing = inferVirtualSimRouting(
      text,
      files.map((file) => file.name),
    );
    const routedCapability = getVirtualSimCapability(routing.capabilityId);
    setCapabilityId(routing.capabilityId);
    setSession(makePendingSnapshot(text, routing.toolId));
    setIdea("");
    try {
      const form = new FormData();
      form.set("idea", text);
      form.set("chatModel", modelConfig.chatModel);
      form.set("thinkingId", modelConfig.thinkingId);
      // Compatibility for the currently running split API; the updated API revalidates this routing.
      form.set("toolId", routing.toolId);
      form.set("capabilityId", routing.capabilityId);
      for (const file of files) form.append("files", file);
      const response = await fetch(VIRTUAL_SIM_API_BASE, {
        method: "POST",
        body: form,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "创建失败。");
      const next = data.session as SchemeSessionSnapshot;
      if (data.routing?.capabilityId)
        setCapabilityId(data.routing.capabilityId as VirtualSimCapabilityId);
      setFiles([]);
      setSession({
        ...next,
        status:
          next.status === "draft" || next.status === "ready"
            ? "researching"
            : next.status,
        progress: Math.max(next.progress || 0, 5),
        progressDetail:
          next.progressDetail ||
          `已提交，${routedCapability.engine} 正在进入求解队列`,
      });
      if (next.status === "draft" || next.status === "ready") {
        await startRun(next.id);
      } else {
        await loadSession(next.id, 0);
        await refreshSessions(true);
      }
    } catch (reason) {
      setSession(null);
      setIdea(text);
      setError(reason instanceof Error ? reason.message : "创建失败。");
    } finally {
      setBusy(false);
    }
  }

  async function exportReport() {
    if (!session || !ideaId) return;
    const response = await fetch(`/api/scheme-solve/${session.id}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ideaId }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setError(data.error || "导出失败。");
      return;
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = encoded ? decodeURIComponent(encoded) : "仿真报告.docx";
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  async function removeSession(id: string) {
    const response = await fetch(`${VIRTUAL_SIM_API_BASE}/${id}`, {
      method: "DELETE",
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || "删除失败。");
      return;
    }
    if (session?.id === id) setSession(null);
    await refreshSessions(true);
  }

  const ideaView = session?.ideas[0];
  const reportDone = Boolean(
    ideaView?.stages.some(
      (stage) => stage.key === "report" && stage.status === "done",
    ) || artifact?.report,
  );
  const solveTried = Boolean(
    ideaView?.stages.some(
      (stage) =>
        stage.key === "solve" &&
        (stage.status === "done" || stage.status === "failed"),
    ),
  );
  const working = Boolean(
    session &&
      (isPendingSession(session) ||
        session.status === "researching" ||
        session.status === "brainstorming" ||
        (session.source === "virtual-sim" &&
          session.status === "draft" &&
          (session.progress || 0) > 0)),
  );
  const canRerun = Boolean(
    session &&
      !working &&
      !isPendingSession(session) &&
      (reportDone ||
        solveTried ||
        session.status === "done" ||
        session.status === "failed"),
  );
  const usedSampleLoss =
    toolId === "loss" &&
    /样例馈线|sample\.json|source": "sample"/.test(
      `${artifact?.result || ""} ${session?.events?.map((item) => item.text).join(" ") || ""}`,
    );
  const showResult = Boolean(
    !working &&
      (reportDone ||
        solveTried ||
        session?.status === "done" ||
        session?.status === "failed"),
  );
  const executionChain = buildExecutionChain(session, capability.engine);
  const resultRecord = readResultRecord(artifact?.result);
  const resultFidelity = fidelityLabel(resultRecord?.fidelity);
  const resultWeightStatus = weightStatusLabel(resultRecord?.weightStatus);

  return (
    <WorkbenchPageShell
      crumb="Dashboard / Simulation"
      title="虚拟仿真"
      description="用于创建和运行虚拟仿真实验，并查看模型、计算结果和实验记录。"
    >
      <div className="flex min-h-0 min-w-0 max-w-full flex-1">
        <WorkbenchSidebar
          className={powerMode ? "md:w-[220px] lg:w-[240px]" : undefined}
          historyOpen={historyOpen}
          search={search}
          onSearch={setSearch}
          searchPlaceholder="搜索全部仿真任务..."
          onNew={() => {
            choosePowerMode(false);
            saveWorkbenchState(user?.id || "", "virtual", { mode: "legacy" });
            updateWorkbenchUrl({ simId: null, powerRun: null });
            eventAfterRef.current = 0;
            setSession(null);
            setArtifact(null);
            setViz(null);
            setError("");
            setHistoryOpen(false);
          }}
          newLabel="新任务"
          hasItems={visibleSessions.length > 0 || powerHistory.length > 0}
          emptyIcon={
            <CircuitBoard
              className="h-8 w-8 text-muted-foreground/40"
              strokeWidth={1.4}
            />
          }
          emptyTitle="暂无仿真任务"
          emptyHint="创建实验后，可从这里恢复进度与结果"
        >
          {powerHistory
            .filter(
              (item) =>
                !search ||
                (
                  powerTaskLabel(item.spec.parameters, item.spec.engine) +
                  " " +
                  item.id
                ).includes(search),
            )
            .map((item) => (
              <button
                key={item.id}
                className="w-full rounded-lg px-3 py-3 text-left hover:bg-muted/60"
                onClick={() => {
                  setNewAnalysis(undefined);
                  choosePowerMode(true);
                  setHistoryOpen(false);
                  updateWorkbenchUrl({ powerRun: item.id });
                  window.dispatchEvent(
                    new CustomEvent("power-run-selected", { detail: item.id }),
                  );
                }}
              >
                <span className="block truncate text-sm">
                  {powerTaskLabel(item.spec.parameters, item.spec.engine)}
                </span>
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  {POWER_PHASES[item.status]} · {formatTime(item.updatedAt)}
                </span>
              </button>
            ))}
          {visibleSessions.map((item) => (
            <WorkbenchConvItem
              key={item.id}
              active={session?.id === item.id}
              title={item.title}
              time={formatTime(item.updatedAt)}
              subtitle={statusLabel(item.status)}
              onOpen={() => {
                choosePowerMode(false);
                eventAfterRef.current = 0;
                setHistoryOpen(false);
                void loadSession(item.id, 0).catch((reason) =>
                  setError(
                    reason instanceof Error ? reason.message : "读取失败。",
                  ),
                );
              }}
              onDelete={() => void removeSession(item.id)}
              deleteLabel="删除任务"
            />
          ))}
        </WorkbenchSidebar>

        <WorkbenchMain historyOpen={historyOpen}>
          {!powerMode ? (
            <WorkbenchMainHeader
              title={
                powerMode ? "电力分析实验" : session?.title || "新建仿真实验"
              }
              subtitle={
                powerMode
                  ? "检查算例、配置分析任务，后台计算并保存结果"
                  : session
                    ? `${working ? "Agent 正在执行" : statusLabel(session.status)} · ${session.progressDetail || capability.engine}`
                    : "自动识别任务并匹配计算工具"
              }
              onOpenHistory={() => setHistoryOpen(true)}
              historyLabel="打开任务列表"
              actions={
                session ? (
                  <>
                    {working ? (
                      <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2.5 text-xs text-foreground">
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                        Agent 正在执行
                      </span>
                    ) : canRerun ? (
                      <button
                        type="button"
                        className="ui-btn-secondary h-8 gap-1.5 px-2.5 text-xs"
                        disabled={busy}
                        onClick={() => void startRun()}
                      >
                        <Play className="h-3.5 w-3.5" />
                        重新仿真
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="ui-btn-secondary h-8 gap-1.5 px-2.5 text-xs"
                      disabled={!reportDone && !solveTried}
                      onClick={() => void exportReport()}
                    >
                      <Download className="h-3.5 w-3.5" />
                      导出产物
                    </button>
                  </>
                ) : null
              }
            />
          ) : null}

          <nav
            className="flex shrink-0 items-center gap-5 border-b border-border px-4"
            aria-label="仿真类型"
          >
            {powerMode ? (
              <button
                type="button"
                className="ui-btn-secondary h-8 px-2 text-xs md:hidden"
                onClick={() => setHistoryOpen(true)}
              >
                历史任务
              </button>
            ) : null}
            <button
              className={
                "border-b-2 py-3 text-xs " +
                (!powerMode
                  ? "border-foreground font-medium"
                  : "border-transparent text-muted-foreground")
              }
              onClick={() => choosePowerMode(false)}
            >
              常规实验
            </button>
            <button
              className={
                "border-b-2 py-3 text-xs " +
                (powerMode
                  ? "border-foreground font-medium"
                  : "border-transparent text-muted-foreground")
              }
              onClick={() => choosePowerMode(true)}
            >
              电力分析
            </button>
            {powerMode ? (
              <div className="ml-auto">
                <PowerTaskIndicator />
              </div>
            ) : null}
          </nav>
          {powerMode ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <PowerComputePanel
                showHistory={false}
                initialAnalysis={newAnalysis}
                onInitialAnalysisConsumed={() => setNewAnalysis(undefined)}
              />
            </div>
          ) : (
            <>
              {!session ? (
                <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
                  <div className="mx-auto w-full max-w-5xl py-2">
                    <div className="mb-5">
                      <h2 className="mb-3 text-sm font-medium">
                        按分析目标新建实验
                      </h2>
                      <div className="grid gap-3 md:grid-cols-3">
                        {[
                          [
                            "ac_flow",
                            "静态电网分析",
                            "潮流、最优潮流、N-1 / N-2",
                          ],
                          [
                            "storage_dispatch",
                            "规划与调度",
                            "经济运行、储能、机组组合与扩建",
                          ],
                          ["time_domain", "动态稳定", "故障时域与小信号稳定"],
                        ].map(([id, title, description]) => (
                          <button
                            key={id}
                            className="rounded-xl border border-border p-4 text-left hover:bg-muted/40"
                            onClick={() => {
                              setNewAnalysis(id);
                              choosePowerMode(true);
                              updateWorkbenchUrl({ powerRun: null });
                            }}
                          >
                            <strong className="text-sm">{title}</strong>
                            <p className="mt-2 text-xs text-muted-foreground">
                              {description}
                            </p>
                          </button>
                        ))}
                      </div>
                    </div>
                    <ExperimentCatalogTable />
                  </div>
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
                      {turn ? (
                        <div className="flex flex-col gap-4">
                          <div className="flex justify-end">
                            <div className="rag-user-bubble max-w-[92%]">
                              <InspectorMarkdown
                                content={session.seedIdea}
                                className="text-primary-foreground [&_*]:text-inherit"
                              />
                              {session.attachments?.length ? (
                                <CompactMessageAttachments
                                  attachments={session.attachments}
                                  inverted
                                  onOpen={(item) =>
                                    window.open(
                                      item.previewUrl,
                                      "_blank",
                                      "noopener,noreferrer",
                                    )
                                  }
                                />
                              ) : null}
                            </div>
                          </div>
                          <div className="flex justify-start">
                            <div className="rag-assistant-bubble max-w-[98%]">
                              {working ? (
                                <div className="space-y-3">
                                  <ThinkingLive
                                    hint={
                                      turn.runningHint ||
                                      session.progressDetail ||
                                      "正在整理思路…"
                                    }
                                    items={turn.timeline}
                                  />
                                  {turn.error ? (
                                    <p className="text-sm text-destructive">
                                      {turn.error}
                                    </p>
                                  ) : null}
                                </div>
                              ) : (
                                <>
                                  <ThinkingBlock
                                    items={turn.timeline}
                                    running={false}
                                  />
                                  {turn.reply ? (
                                    <div className="mt-2 min-w-0">
                                      <InspectorMarkdown content={turn.reply} />
                                    </div>
                                  ) : !turn.timeline.length &&
                                    !turn.error &&
                                    !showResult ? (
                                    <p className="text-sm text-muted-foreground">
                                      还没有 Agent
                                      输出。在下方发送题目后会自动开跑。
                                    </p>
                                  ) : null}
                                  {turn.error ? (
                                    <p className="mt-1 text-sm text-destructive">
                                      {turn.error}
                                    </p>
                                  ) : null}
                                </>
                              )}
                              {showResult ? (
                                <VirtualSimResultBundle
                                  title={`${capability.label}实验结果`}
                                  engine={capability.engine}
                                  status={statusLabel(session.status)}
                                  fidelity={resultFidelity}
                                  weightStatus={resultWeightStatus}
                                  sample={usedSampleLoss}
                                  pane={dataPane}
                                  onPaneChange={setDataPane}
                                  artifact={artifact}
                                  artifactLoading={artifactLoading}
                                  viz={viz}
                                  vizLoading={vizLoading}
                                />
                              ) : null}
                            </div>
                          </div>
                          <div ref={endRef} />
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              )}
              <WorkbenchComposer>
                <div className="mb-2">
                  <SchemeModelPicker
                    value={modelConfig}
                    onChange={setModelConfig}
                    disabled={busy}
                  />
                </div>
                {usedSampleLoss ? (
                  <div className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                    当前线损结果来自系统样例馈线，不是你上传的数据。
                  </div>
                ) : null}
                {session ? (
                  <div className="mb-2 text-[11px] text-muted-foreground">
                    {working
                      ? `本题已自动开始，${capability.engine} 正在运行。下方发送会另建新任务。`
                      : `已识别为${capability.label}。下方发送会自动识别并新建任务。${canRerun ? "要重跑本题请点「重新仿真」。" : ""}`}
                  </div>
                ) : (
                  <div className="mb-2 text-[11px] text-muted-foreground">
                    描述需求，自动选择计算工具
                  </div>
                )}
                {files.length ? (
                  <div className="mb-2 text-xs text-muted-foreground">
                    {files.map((file) => file.name).join("、")}
                  </div>
                ) : null}
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept={SCHEME_SOLVE_ATTACHMENT_ACCEPT}
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(event) =>
                    setFiles(Array.from(event.target.files || []))
                  }
                />
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1 rounded-lg border border-input bg-background shadow-sm transition focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
                    <textarea
                      value={idea}
                      onChange={(event) => setIdea(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void createSession();
                        }
                      }}
                      placeholder="描述实验目标、数据、时间范围和约束…"
                      rows={1}
                      className="max-h-40 min-h-11 w-full resize-none bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
                    />
                    <div className="flex min-h-9 flex-wrap items-center gap-1 px-2 pb-2">
                      <button
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        disabled={busy}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
                        aria-label="添加附件"
                        title={SCHEME_SOLVE_ATTACHMENT_HINT}
                      >
                        <Paperclip className="h-3.5 w-3.5" />
                      </button>
                      <span
                        className="mx-1 h-4 w-px shrink-0 bg-border"
                        aria-hidden="true"
                      />
                      <span className="text-[11px] text-muted-foreground">
                        自动分类并开始求解
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy || idea.trim().length < 4}
                    onClick={() => void createSession()}
                    className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="发送并开始仿真"
                  >
                    {busy ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </WorkbenchComposer>
            </>
          )}
        </WorkbenchMain>
        {session && !powerMode ? (
          <PaperReproExecutionChain
            items={executionChain}
            solverOutput={
              artifact?.result ||
              session.events
                .filter((event) => event.level === "output")
                .map((event) => event.text)
                .join("\n")
            }
            outputs={outputFiles}
            onOpenOutput={setPreviewFile}
          />
        ) : null}
      </div>
      {previewFile ? (
        <VirtualSimOutputPreview
          file={previewFile}
          onClose={() => setPreviewFile(null)}
        />
      ) : null}
    </WorkbenchPageShell>
  );
}
