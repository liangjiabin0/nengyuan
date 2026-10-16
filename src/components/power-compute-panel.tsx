"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PowerResultTable,
  EigenvalueChart,
} from "@/components/power-result-details";
import { downloadChart } from "@/lib/power-compute/chart-export";
import {
  CheckCircle2,
  Download,
  LoaderCircle,
  Play,
  Square,
} from "lucide-react";
import {
  POWER_ENGINES,
  POWER_TASKS,
  powerTaskLabel,
  defaultTaskParameters,
  POWER_PHASES,
  type EngineId,
} from "@/lib/power-compute/catalog";
import {
  defaultModelId,
  productionParameters,
  prepareParameters,
  planningFields,
  planningSeries,
  parameterLabels,
  modelLabel,
} from "@/lib/power-compute/input-form";
import type { PowerRun } from "@/lib/power-compute/store";
import { useAuth } from "@/components/auth-provider";
import {
  readWorkbenchState,
  saveWorkbenchState,
  updateWorkbenchUrl,
} from "@/lib/workbench-state";
import { createId } from "@/lib/create-id";
import {
  PowerModelUpload,
  type ModelUploadState,
} from "@/components/power-model-upload";

type Tab = "result" | "data" | "input" | "events" | "files";
const labels: Record<string, string> = {
  ...parameterLabels,
  loadFactor: "负荷倍率",
  analysis: "实验类型",
  algorithm: "潮流算法",
  maxIterations: "最大迭代次数",
  calculateAngles: "计算相角",
  voltageMinPu: "电压下限 / p.u.",
  voltageMaxPu: "电压上限 / p.u.",
  loadingMaxPercent: "负载率上限 / %",
  toleranceMva: "潮流容差 / MVA",
  busId: "故障母线",
  faultAtS: "故障发生 / s",
  clearAtS: "故障切除 / s",
  endAtS: "仿真时长 / s",
  stepS: "积分步长 / s",
  recoverWithinS: "恢复时限 / s",
  holdS: "至少保持 / s",
};
const metricLabels: Record<string, string> = {
  minVoltagePu: "最低电压 / p.u.",
  maxVoltagePu: "最高电压 / p.u.",
  lossMw: "网损 / MW",
  scenarioCount: "故障场景数",
  failedScenarios: "孤岛或不收敛场景",
  violatedScenarios: "越限场景数",
  operatingCostCny: "运行成本 / 元",
  investmentCostCny: "年化投资 / 元",
  curtailedKwh: "时段弃电 / kWh",
  unservedKwh: "时段缺供 / kWh",
  modeCount: "模态数",
  unstableModes: "正实部模态数",
  minDampingPercent: "最低振荡阻尼 / %",
  solarCapacityKw: "光伏容量 / kW",
  windCapacityKw: "风电容量 / kW",
  thermalCapacityKw: "常规机组容量 / kW",
  batteryCapacityKw: "储能功率 / kW",
  objective: "算例目标函数",
  investmentCost: "新增投资 / 原模型货币",
  operatingCost: "运行成本 / 原模型货币",
  snapshotCount: "时段数",
  maxLoadingPercent: "最高负载率 / %",
  violationCount: "越限数量",
  costCny: "总成本 / 元（口径见说明）",
  baselineCny: "全部购电基线 / 元",
  savingCny: "费用节约 / 元",
  finalSoc: "末 SOC",
  recoveryS: "切除后恢复 / s",
  speedPeakPu: "转速峰值 / p.u.",
};
const solverLabels: Record<string, string> = {
  converged: "已收敛",
  optimal: "获得最优解",
  completed: "计算完成",
  infeasible: "约束不可行",
  diverged: "未收敛",
  unavailable: "环境不可用",
  solver_error: "计算失败",
  timed_out: "达到时限",
};
const fidelityLabels: Record<string, string> = {
  AC: "交流稳态",
  DC: "直流线性近似",
  "single-bus-active-power": "单节点有功模型",
  "native-network-linear": "原生网络线性模型",
  "linearized-dynamic": "工作点线性化动态模型",
  "nonlinear-dynamic": "非线性动态模型",
};
const advancedParameterKeys = new Set([
  "algorithm",
  "maxIterations",
  "toleranceMva",
  "calculateAngles",
  "timezone",
  "efficiencyCharge",
  "efficiencyDischarge",
  "socMin",
  "socMax",
  "initialSoc",
  "terminalSoc",
  "solarKw",
  "windKw",
  "generatorKw",
  "minUpSteps",
  "minDownSteps",
  "rampPerStep",
  "recoverWithinS",
  "holdS",
]);
function ParameterField({
  name,
  value,
  onChange,
}: {
  name: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  return (
    <label className="min-w-0 text-xs">
      {labels[name] || name}
      {typeof value === "boolean" ? (
        <input
          type="checkbox"
          className="ml-2"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
        />
      ) : name === "algorithm" ? (
        <select
          className="ui-input mt-1 h-8 w-full"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        >
          {[
            ["nr", "牛顿法"],
            ["bfsw", "前推回代法"],
            ["gs", "高斯—赛德尔法"],
            ["fdxb", "快速解耦 XB"],
            ["fdbx", "快速解耦 BX"],
          ].map(([id, title]) => (
            <option key={id} value={id}>
              {title}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="ui-input mt-1 h-8 w-full"
          type={
            typeof value === "number" || value === null
              ? "number"
              : name === "date"
                ? "date"
                : "text"
          }
          step="any"
          placeholder="请填写"
          value={
            name === "timezone"
              ? "北京时间（UTC+8）"
              : value === null
                ? ""
                : String(value)
          }
          readOnly={name === "timezone"}
          onChange={(e) =>
            onChange(
              typeof value === "number" || value === null
                ? e.target.value === ""
                  ? null
                  : Number(e.target.value)
                : e.target.value,
            )
          }
        />
      )}
    </label>
  );
}
function resultMetrics(run: PowerRun) {
  const analysis = run.spec.parameters.analysis;
  const priority =
    analysis === "capacity_expansion"
      ? [
          "costCny",
          "solarCapacityKw",
          "windCapacityKw",
          "batteryCapacityKw",
          "investmentCostCny",
          "operatingCostCny",
        ]
      : analysis === "storage_dispatch"
        ? [
            "costCny",
            "savingCny",
            "finalSoc",
            "batteryCapacityKw",
            "curtailedKwh",
          ]
        : String(analysis).startsWith("n_minus_")
          ? [
              "scenarioCount",
              "failedScenarios",
              "violatedScenarios",
              "maxLoadingPercent",
              "minVoltagePu",
            ]
          : [];
  return Object.entries(run.result?.metrics || {}).sort(
    ([a], [b]) =>
      (priority.includes(a) ? priority.indexOf(a) : 100) -
      (priority.includes(b) ? priority.indexOf(b) : 100),
  );
}
function active(run: PowerRun) {
  return ["queued", "running", "cancel_requested"].includes(run.status);
}
async function readJson(response: Response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "请求失败");
  return value;
}
function SeriesChart({
  series,
}: {
  series: NonNullable<PowerRun["result"]>["series"][number];
}) {
  const chartRef = useRef<SVGSVGElement>(null);
  const exportSvg = () => downloadChart(chartRef.current, "curve.svg");
  const points = series.points;
  if (!points.length) return null;
  const xmin = points[0][0],
    xmax = points.at(-1)![0];
  const values = points.map((p) => p[1]),
    min = values.reduce((a, b) => Math.min(a, b), Infinity),
    max = values.reduce((a, b) => Math.max(a, b), -Infinity),
    pad = (max - min) * 0.1 || 0.02;
  const x = (v: number) => 45 + ((v - xmin) / (xmax - xmin || 1)) * 450;
  const y = (v: number) =>
    165 - ((v - min + pad) / (max - min + 2 * pad)) * 140;
  const sample = points.filter(
    (_, i) =>
      i % Math.max(1, Math.floor(points.length / 800)) === 0 ||
      i === points.length - 1,
  );
  return (
    <section className="rounded-lg border border-border p-3">
      <div className="flex justify-between text-xs">
        <strong>{series.label}</strong>
        <button className="underline" onClick={exportSvg}>
          导出图表
        </button>
        <span className="text-muted-foreground">{series.unit}</span>
      </div>
      <svg
        ref={chartRef}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 520 195"
        className="mt-2 max-h-44 w-full"
        role="img"
        aria-label={series.label}
      >
        {[0, 1, 2].map((i) => {
          const v = min + (i * (max - min)) / 2;
          return (
            <g key={i}>
              <line
                x1="45"
                x2="500"
                y1={y(v)}
                y2={y(v)}
                stroke="currentColor"
                opacity="0.08"
              />
              <text
                x="39"
                y={y(v) + 3}
                textAnchor="end"
                fontSize="9"
                fill="currentColor"
              >
                {v.toFixed(3)}
              </text>
            </g>
          );
        })}
        <path
          d={sample
            .map(
              (p, i) =>
                `${i ? "L" : "M"}${x(p[0]).toFixed(2)},${y(p[1]).toFixed(2)}`,
            )
            .join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <text x="45" y="187" fontSize="9">
          {xmin}
        </text>
        <text x="500" y="187" textAnchor="end" fontSize="9">
          {xmax} {series.xUnit}
        </text>
      </svg>
    </section>
  );
}
export function PowerComputePanel({
  sessionId,
  ideaId,
  initialAnalysis,
  onInitialAnalysisConsumed,
  showHistory = true,
  engines = ["pandapower", "pypsa", "andes"],
  onUseResult,
}: {
  sessionId?: string;
  ideaId?: string;
  initialAnalysis?: string;
  onInitialAnalysisConsumed?: () => void;
  showHistory?: boolean;
  engines?: EngineId[];
  onUseResult?: (text: string) => void;
}) {
  const { user } = useAuth();
  const stateName =
    "power:" +
    (typeof window === "undefined" ? "" : window.location.pathname) +
    ":" +
    (sessionId || "") +
    ":" +
    (ideaId || "");
  const [engine, setEngine] = useState<EngineId>(engines[0]);
  const [model, setModel] = useState<string>(defaultModelId(engines[0]));
  const [parameters, setParameters] = useState(
    productionParameters(POWER_TASKS.find((t) => t.engine === engines[0])!.id),
  );
  const [timeLimitSeconds, setTimeLimitSeconds] = useState(0);
  // Restored drafts keep their transport so a pending request retains its identity.
  const [transport, setTransport] = useState<"direct" | "mcp">("direct");
  const [engineState, setEngineState] = useState<{
    ready: boolean;
    reason?: string;
  } | null>(null);
  useEffect(() => {
    if (!user?.id) {
      setEngineState(null);
      return;
    }
    let disposed = false;
    setEngineState(null);
    void fetch(
      "/api/power-capabilities?engine=" +
        engine +
        "&transport=" +
        (engine === "pandapower" ? transport : "mcp"),
      { cache: "no-store" },
    )
      .then(readJson)
      .then((value) => {
        if (!disposed) setEngineState(value);
      })
      .catch(() => {
        if (!disposed)
          setEngineState({
            ready: false,
            reason: "环境检查暂不可用，可稍后重新打开任务",
          });
      });
    return () => {
      disposed = true;
    };
  }, [engine, transport, user?.id]);
  const [validation, setValidation] = useState<{
    signature: string;
    status: "checking" | "valid" | "invalid";
    message: string;
  } | null>(null);
  const [chartIndex, setChartIndex] = useState<number | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [batchModelIds, setBatchModelIds] = useState<string[]>([]);
  const [importState, setImportState] = useState<ModelUploadState>({
    busy: false,
    hasErrors: false,
  });
  const [arrayDraft, setArrayDraft] = useState<Record<string, string>>({});
  const sourceDrafts = useRef<
    Record<
      string,
      {
        parameters: Record<string, unknown>;
        arrays: Record<string, string>;
        uploadId: string;
        batchIds?: string[];
      }
    >
  >({});
  const [models, setModels] = useState<
    Array<{
      id: string;
      engine: string;
      filename: string;
      diagnosis_json?: string;
    }>
  >([]);
  const [modelUploadId, setModelUploadId] = useState("");
  const [runs, setRuns] = useState<PowerRun[]>([]),
    [selected, setSelected] = useState<string>("");
  const [run, setRun] = useState<PowerRun | null>(null),
    [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(true),
    [tab, setTab] = useState<Tab>("result");
  const submitting = useRef(false),
    requestKey = useRef<string | null>(null);
  const loaded = useRef(false);
  const selectRun = useCallback(
    (id: string) => {
      setSelected(id);
      setEditing(false);
      setRun(null);
      setError("");
      saveWorkbenchState(user?.id || "", stateName, {
        runId: id,
        tab: "result",
      });
      setTab("result");
      updateWorkbenchUrl({ powerRun: id });
    },
    [user?.id, stateName],
  );
  useEffect(() => {
    const selected = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (typeof id === "string") selectRun(id);
    };
    window.addEventListener("power-run-selected", selected);
    return () => window.removeEventListener("power-run-selected", selected);
  }, [selectRun]);
  const refresh = useCallback(async () => {
    const data = await readJson(
      await fetch(
        "/api/power-runs" +
          (sessionId ? "?sessionId=" + encodeURIComponent(sessionId) : ""),
        { cache: "no-store" },
      ),
    );
    setRuns(
      (data.runs as PowerRun[]).filter((r) => !ideaId || r.ideaId === ideaId),
    );
  }, [sessionId, ideaId]);
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, [refresh]);
  const refreshModels = useCallback(async () => {
    const data = await readJson(
      await fetch("/api/power-models", { cache: "no-store" }),
    );
    setModels(data.models);
  }, []);
  useEffect(() => {
    void refreshModels().catch((e) => setError(String(e)));
  }, [refreshModels]);
  useEffect(() => {
    const onCreated = () => {
      void refresh().catch(() => undefined);
    };
    window.addEventListener("power-run-created", onCreated);
    return () => window.removeEventListener("power-run-created", onCreated);
  }, [refresh]);
  useEffect(() => {
    if (!selected) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let repeat = true;
      try {
        const data = await readJson(
          await fetch("/api/power-runs/" + selected, { cache: "no-store" }),
        );
        if (
          (sessionId && data.run.sessionId !== sessionId) ||
          (ideaId && data.run.ideaId !== ideaId)
        ) {
          repeat = false;
          if (!disposed) {
            setSelected("");
            setEditing(true);
            updateWorkbenchUrl({ powerRun: null });
          }
          return;
        }
        repeat = active(data.run);
        if (!disposed) {
          setRun(data.run);
          setError("");
          setFiles(data.artifacts);
          setRuns((list) =>
            list.map((item) => (item.id === data.run.id ? data.run : item)),
          );
        }
      } catch (e) {
        if (!disposed) setError(String(e));
      } finally {
        if (!disposed && repeat) timer = setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [selected, sessionId, ideaId]);
  useEffect(() => {
    if (!user?.id || loaded.current) return;
    loaded.current = true;
    const saved = readWorkbenchState<{
      runId: string;
      tab: Tab;
      draft: {
        engine: EngineId;
        model: string;
        parameters: Record<string, unknown>;
        arrayDraft: Record<string, string>;
        modelUploadId: string;
        batchModelIds?: string[];
        timeLimitSeconds?: number;
        transport?: "direct" | "mcp";
      };
      pending: { key: string; signature: string };
    }>(user.id, stateName);
    if (initialAnalysis) {
      const task = POWER_TASKS.find((t) => t.id === initialAnalysis);
      if (task && engines.includes(task.engine as EngineId)) {
        setEngine(task.engine as EngineId);
        setModel(defaultModelId(task.engine as EngineId));
        setParameters(productionParameters(task.id));
        setEditing(true);
        onInitialAnalysisConsumed?.();
        return;
      }
    }
    const id =
      new URL(window.location.href).searchParams.get("powerRun") || saved.runId;
    if (id) {
      setSelected(id);
      setEditing(false);
      if (
        saved.runId === id &&
        ["result", "data", "input", "events", "files"].includes(saved.tab || "")
      )
        setTab(saved.tab!);
      return;
    }
    if (saved.draft && engines.includes(saved.draft.engine)) {
      setEngine(saved.draft.engine);
      setModel(saved.draft.model);
      setParameters({
        ...productionParameters(String(saved.draft.parameters.analysis)),
        ...saved.draft.parameters,
      });
      setArrayDraft(saved.draft.arrayDraft || {});
      setModelUploadId(saved.draft.modelUploadId || "");
      setBatchModelIds(saved.draft.batchModelIds || []);
      setTimeLimitSeconds(saved.draft.timeLimitSeconds || 0);
      setTransport(saved.draft.transport || "direct");
    }
    if (saved.pending) {
      requestKey.current = saved.pending.key;
      void fetchPending()
        .then(readJson)
        .then((data) => {
          const found = (data.runs as PowerRun[]).find(
            (r) => r.spec.requestKey === saved.pending!.key,
          );
          if (found) selectRun(found.id);
        })
        .catch(() => undefined);
    }
    async function fetchPending() {
      return fetch("/api/power-runs", { cache: "no-store" });
    }
  }, [
    user?.id,
    stateName,
    engines,
    selectRun,
    initialAnalysis,
    onInitialAnalysisConsumed,
  ]);
  useEffect(() => {
    if (loaded.current && user?.id && selected && !editing)
      saveWorkbenchState(user.id, stateName, { runId: selected, tab });
  }, [user?.id, stateName, selected, tab, editing]);
  useEffect(() => {
    if (!loaded.current || !editing || !user?.id) return;
    const timer = setTimeout(() => {
      const previous = readWorkbenchState<{ pending: object }>(
        user.id,
        stateName,
      );
      saveWorkbenchState(user.id, stateName, {
        draft: {
          engine,
          model,
          parameters,
          arrayDraft,
          modelUploadId,
          batchModelIds,
          timeLimitSeconds,
          transport,
        },
        ...(previous.pending ? { pending: previous.pending } : {}),
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [
    editing,
    user?.id,
    stateName,
    engine,
    model,
    parameters,
    arrayDraft,
    modelUploadId,
    batchModelIds,
    timeLimitSeconds,
    transport,
  ]);
  const switchAnalysis = (analysis: string) => {
    const task = POWER_TASKS.find((t) => t.id === analysis);
    if (!task) return;
    const id = task.engine as EngineId;
    const nextModel = id === engine ? model : defaultModelId(id);
    setModel(nextModel);
    if (id !== engine) {
      setModelUploadId("");
      setBatchModelIds([]);
    }
    setEngine(id);
    setAcknowledged(false);
    setError("");
    setParameters(
      nextModel === "custom-timeseries" || nextModel === "uploaded"
        ? {
            ...productionParameters(analysis),
            ...(id === engine ? parameters : {}),
            analysis,
          }
        : {
            ...productionParameters(analysis),
            ...defaultTaskParameters(analysis),
          },
    );
    if (
      id !== engine ||
      (nextModel !== "custom-timeseries" && nextModel !== "uploaded")
    )
      setArrayDraft({});
    sourceDrafts.current = {};
    requestKey.current = null;
  };
  const submit = async () => {
    if (submitting.current || !inputReady || !preparedRequest.body) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const prepared = preparedRequest.body.parameters;
      const signature = JSON.stringify({
        engine,
        model,
        parameters: prepared,
        timeLimitSeconds,
        transport,
        modelUploadId,
        ...(modelUploadIds.length > 1 ? { modelUploadIds } : {}),
        sessionId,
        ideaId,
      });
      const previous = readWorkbenchState<{
        pending: { key: string; signature: string; keys?: string[] };
        draft: object;
      }>(user?.id || "", stateName);
      requestKey.current =
        previous.pending?.signature === signature
          ? previous.pending.key
          : createId();
      const bodies = JSON.parse(validationBody) as Array<
        Record<string, unknown>
      >;
      const keys =
        previous.pending?.signature === signature &&
        previous.pending.keys?.length === bodies.length
          ? previous.pending.keys
          : bodies.map((_, index) =>
              index ? createId() : requestKey.current!,
            );
      saveWorkbenchState(user?.id || "", stateName, {
        draft: {
          engine,
          model,
          parameters,
          arrayDraft,
          modelUploadId,
          batchModelIds,
          timeLimitSeconds,
          transport,
        },
        pending: { key: requestKey.current, signature, keys },
      });
      const requests = bodies.map((body, index) => ({
        ...body,
        requestKey: keys[index],
      }));
      const data = await readJson(
        await fetch(
          "/api/power-runs" + (requests.length > 1 ? "?batch=1" : ""),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(requests.length > 1 ? requests : requests[0]),
          },
        ),
      );
      const firstRun = data.run || data.runs[0];
      selectRun(firstRun.id);
      setRun(firstRun);
      setTab("result");
      await refresh();
      window.dispatchEvent(new Event("power-run-created"));
    } catch (e) {
      setError(String(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const editRun = (reuse = false) => {
    sourceDrafts.current = {};
    setBatchModelIds([]);
    if (reuse && run && engines.includes(run.spec.engine)) {
      setTimeLimitSeconds(run.spec.timeLimitSeconds || 0);
      setTransport(run.spec.transport || "mcp");
      setEngine(run.spec.engine);
      setModel(run.spec.modelId);
      setParameters({
        ...productionParameters(run.spec.parameters.analysis),
        ...run.spec.parameters,
      });
      setModelUploadId(run.spec.modelUploadId || "");
    } else {
      const nextEngine = run?.spec.engine || engine;
      const nextAnalysis =
        run?.spec.parameters.analysis || String(parameters.analysis);
      setEngine(nextEngine);
      setModel(defaultModelId(nextEngine));
      setModelUploadId("");
      setParameters(productionParameters(nextAnalysis));
      setTimeLimitSeconds(0);
      setTransport(nextEngine === "pandapower" ? "direct" : "mcp");
    }
    setSelected("");
    setRun(null);
    setAcknowledged(false);
    setArrayDraft({});
    requestKey.current = null;
    setEditing(true);
    setError("");
    updateWorkbenchUrl({ powerRun: null });
    saveWorkbenchState(user?.id || "", stateName, {});
  };
  const engineInfo = POWER_ENGINES[engine];
  const currentTask =
    POWER_TASKS.find((t) => t.id === parameters.analysis) ||
    POWER_TASKS.find((t) => t.engine === engine)!;
  const selectSource = (next: string) => {
    if (next === model) return;
    sourceDrafts.current[model] = {
      parameters,
      arrays: arrayDraft,
      uploadId: modelUploadId,
      batchIds: batchModelIds,
    };
    const previous = sourceDrafts.current[next];
    setModel(next);
    setModelUploadId(previous?.uploadId || "");
    setBatchModelIds(previous?.batchIds || []);
    setAcknowledged(false);
    setArrayDraft(previous?.arrays || {});
    setError("");
    requestKey.current = null;
    setParameters(
      previous?.parameters ||
        (next === "custom-timeseries" || next === "uploaded"
          ? productionParameters(currentTask.id)
          : {
              ...productionParameters(currentTask.id),
              ...defaultTaskParameters(currentTask.id),
            }),
    );
  };
  const sample = model !== "uploaded" && model !== "custom-timeseries";
  const modelUploadIds =
    model === "uploaded"
      ? batchModelIds.length
        ? batchModelIds
        : modelUploadId
          ? [modelUploadId]
          : []
      : [];
  const selectedModels = modelUploadIds
    .map((id) => models.find((m) => m.id === id))
    .filter((m): m is (typeof models)[number] => Boolean(m));
  const changeModelSelection = useCallback((ids: string[]) => {
    setBatchModelIds(ids);
    setModelUploadId(ids[0] || "");
    setAcknowledged(false);
    setError("");
    requestKey.current = null;
  }, []);
  const selectedModel = models.find(
    (m) => model === "uploaded" && m.id === modelUploadId,
  ) as ((typeof models)[number] & { diagnosis_json?: string }) | undefined;
  const diagnosis = selectedModel?.diagnosis_json
    ? (JSON.parse(
        selectedModel.diagnosis_json,
      ) as import("@/lib/power-compute/imports").ImportDiagnosis)
    : null;
  const requiresAcknowledgement = selectedModels.some(
    (m) =>
      m.diagnosis_json &&
      (
        JSON.parse(
          m.diagnosis_json,
        ) as import("@/lib/power-compute/imports").ImportDiagnosis
      ).diagnostics.some((d) => d.severity?.toLowerCase() === "warning"),
  );
  const summarySignature = JSON.stringify({
    engine,
    model,
    modelUploadId,
    batchModelIds,
    parameters,
    arrayDraft,
    timeLimitSeconds,
    transport,
    sessionId,
    ideaId,
  });
  const preparedRequest = (() => {
    try {
      if (model === "uploaded" && !modelUploadId)
        throw new Error("请先导入模型，或选择已导入的模型");
      const prepared = prepareParameters(engine, model, parameters, arrayDraft);
      return {
        body: {
          engine,
          timeLimitSeconds,
          transport: engine === "pandapower" ? transport : "mcp",
          modelId: model,
          parameters: prepared,
          ...(model === "uploaded" ? { modelUploadId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(ideaId ? { ideaId } : {}),
        },
        error: "",
      };
    } catch (e) {
      return { body: null, error: e instanceof Error ? e.message : String(e) };
    }
  })();
  const validationBody = preparedRequest.body
    ? JSON.stringify(
        modelUploadIds.length
          ? modelUploadIds.map((modelUploadId) => ({
              ...preparedRequest.body,
              modelUploadId,
            }))
          : [preparedRequest.body],
      )
    : "";
  useEffect(() => {
    if (
      !editing ||
      !user?.id ||
      busy ||
      importState.busy ||
      importState.hasErrors ||
      !validationBody
    )
      return;
    const controller = new AbortController();
    let disposed = false;
    setValidation({
      signature: summarySignature,
      status: "checking",
      message: "正在自动检查参数…",
    });
    const timer = setTimeout(() => {
      void fetch("/api/power-runs?check=1&batch=1", {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          (JSON.parse(validationBody) as object[]).map((body) => ({
            ...body,
            requestKey: createId(),
          })),
        ),
      })
        .then(readJson)
        .then(() => {
          if (!disposed)
            setValidation({
              signature: summarySignature,
              status: "valid",
              message: "参数检查通过",
            });
        })
        .catch((reason) => {
          if (!disposed)
            setValidation({
              signature: summarySignature,
              status: "invalid",
              message:
                reason instanceof Error ? reason.message : String(reason),
            });
        });
    }, 400);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    editing,
    user?.id,
    busy,
    importState.busy,
    importState.hasErrors,
    validationBody,
    summarySignature,
  ]);
  const inputReady = Boolean(
    preparedRequest.body &&
      validation?.signature === summarySignature &&
      validation.status === "valid" &&
      (!requiresAcknowledgement || acknowledged) &&
      !importState.busy &&
      !importState.hasErrors &&
      engineState?.ready === true,
  );
  const inputStatus = importState.busy
    ? "正在逐算例导入并检查…"
    : importState.hasErrors
      ? "有文件导入失败，请移除或重新上传后再计算"
      : preparedRequest.error ||
        (validation?.signature === summarySignature
          ? validation.message
          : "正在自动检查参数…");
  const chartRun = useRef(selected);
  useEffect(() => {
    if (chartRun.current !== selected) {
      chartRun.current = selected;
      setChartIndex(null);
    }
  }, [selected]);
  const parameterEntries = Object.entries(parameters).filter(
    ([key, value]) =>
      !(engine === "pypsa" && model === "uploaded") &&
      !Array.isArray(value) &&
      key !== "analysis" &&
      (engine !== "pypsa" || planningFields(parameters).includes(key)) &&
      !(
        [
          "algorithm",
          "maxIterations",
          "toleranceMva",
          "calculateAngles",
        ].includes(key) &&
        ["dc_flow", "ac_opf", "dc_opf"].includes(currentTask.id)
      ),
  );
  const isAdvancedParameter = (key: string) =>
    advancedParameterKeys.has(key) &&
    !(
      key === "generatorKw" &&
      ["economic_dispatch", "unit_commitment"].includes(currentTask.id)
    );
  const renderParameter = ([key, value]: [string, unknown]) => (
    <ParameterField
      key={key}
      name={key}
      value={value}
      onChange={(next) => setParameters((p) => ({ ...p, [key]: next }))}
    />
  );
  return (
    <section className="min-w-0 space-y-3 p-4 text-sm" aria-label="电力计算">
      {editing ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">配置分析</h2>
          </div>
        </div>
      ) : null}
      {showHistory && runs.length ? (
        <label className="block text-xs text-muted-foreground">
          历史运行
          <select
            className="ui-input mt-1 w-full text-xs"
            value={selected}
            onChange={(e) => selectRun(e.target.value)}
          >
            <option value="">选择运行</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {powerTaskLabel(r.spec.parameters, r.spec.engine)} ·{" "}
                {new Date(r.createdAt).toLocaleString()} ·{" "}
                {POWER_PHASES[r.status]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-border bg-muted/40 p-3 text-xs"
        >
          {error}
        </div>
      ) : null}
      {editing ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs">
              能力组
              <select
                className="ui-input mt-1 w-full"
                value={currentTask.group}
                onChange={(e) =>
                  switchAnalysis(
                    POWER_TASKS.find(
                      (t) =>
                        t.group === e.target.value &&
                        engines.includes(t.engine as EngineId),
                    )!.id,
                  )
                }
              >
                {[
                  ...new Set(
                    POWER_TASKS.filter((t) =>
                      engines.includes(t.engine as EngineId),
                    ).map((t) => t.group),
                  ),
                ].map((group) => (
                  <option key={group}>{group}</option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              实验类型
              <select
                className="ui-input mt-1 w-full"
                value={currentTask.id}
                onChange={(e) => switchAnalysis(e.target.value)}
              >
                {POWER_TASKS.filter(
                  (t) =>
                    t.group === currentTask.group &&
                    engines.includes(t.engine as EngineId),
                ).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {engineState && !engineState.ready ? (
            <p role="alert" className="text-xs text-destructive">
              {engineState.reason || "计算服务暂不可用，请稍后重试"}
            </p>
          ) : null}
          <section className="space-y-3" aria-label="数据来源">
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap text-xs font-medium">
                数据来源
                <select
                  className="ui-input h-8 w-auto text-xs font-normal"
                  value={model}
                  disabled={busy}
                  onChange={(e) => selectSource(e.target.value)}
                >
                  {engine === "pypsa" ? (
                    <option value="custom-timeseries">填写数据</option>
                  ) : null}
                  <option value="uploaded">模型文件</option>
                  {sample ? <option value={model}>示例数据</option> : null}
                </select>
              </label>
              <button
                type="button"
                disabled={busy}
                aria-pressed={sample}
                className="ml-auto text-xs text-muted-foreground underline underline-offset-4"
                onClick={() => selectSource(engineInfo.models[0][0])}
              >
                加载示例
              </button>
            </div>
            {sample ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 p-3 text-xs">
                <span className="rounded border border-border px-2 py-1">
                  示例数据
                </span>
                {engineInfo.models.length > 1 ? (
                  <label>
                    示例算例
                    <select
                      className="ui-input ml-2"
                      value={model}
                      onChange={(e) => selectSource(e.target.value)}
                    >
                      {engineInfo.models.map(([id, title]) => (
                        <option key={id} value={id}>
                          {title}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span>{modelLabel(model)}</span>
                )}
              </div>
            ) : null}
            {model === "custom-timeseries" ? (
              <p className="text-xs text-muted-foreground">
                填写本项目的负荷、电价和设备参数。此表单计算总功率平衡；需要线路与多节点约束时，请导入完整模型。
              </p>
            ) : null}
          </section>
          {model === "uploaded" ? (
            <div
              className="grid items-start gap-3"
              style={{
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 16rem), 1fr))",
              }}
            >
              <PowerModelUpload
                key={engine}
                engine={engine}
                models={models}
                selectedIds={modelUploadIds}
                onChange={changeModelSelection}
                onRefresh={refreshModels}
                onStateChange={setImportState}
                disabled={busy}
              />
              {diagnosis ? (
                <section className="space-y-1 rounded-lg bg-muted/30 p-3 text-xs">
                  <strong>
                    算例诊断
                    {selectedModels.length > 1
                      ? ` · ${selectedModel?.filename}`
                      : ""}
                  </strong>
                  <p className="leading-5">
                    母线 {diagnosis.counts.buses || 0} · 线路{" "}
                    {diagnosis.counts.lines || 0} · 发电机{" "}
                    {diagnosis.counts.generators || 0} · 负荷{" "}
                    {diagnosis.counts.loads || 0}
                    {diagnosis.counts.storage
                      ? ` · 储能 ${diagnosis.counts.storage}`
                      : ""}
                    {diagnosis.counts.snapshots
                      ? ` · ${diagnosis.counts.snapshots} 个时段`
                      : ""}
                    {diagnosis.counts.dynamicModels
                      ? ` · 动态设备 ${diagnosis.counts.dynamicModels}`
                      : ""}
                  </p>
                  <details open={requiresAcknowledgement}>
                    <summary className="cursor-pointer py-1 text-muted-foreground">
                      单位与转换说明
                      {requiresAcknowledgement ? " · 需确认警告" : ""}
                    </summary>
                    <p className="mt-2">
                      基准容量{" "}
                      {diagnosis.baseMva === null
                        ? "原模型未声明"
                        : diagnosis.baseMva + " MVA"}{" "}
                      · {diagnosis.units}
                    </p>
                    <p className="mt-1">
                      变压器 {diagnosis.counts.transformers || 0}
                    </p>
                    {diagnosis.diagnostics.map((d, i) => (
                      <p className="mt-2 text-muted-foreground" key={i}>
                        {d.message || d.code}
                      </p>
                    ))}
                  </details>
                  {selectedModels.slice(1).map((m) => {
                    if (!m.diagnosis_json) return null;
                    const d = JSON.parse(
                      m.diagnosis_json,
                    ) as import("@/lib/power-compute/imports").ImportDiagnosis;
                    return (
                      <details
                        key={m.id}
                        open={d.diagnostics.some(
                          (n) => n.severity?.toLowerCase() === "warning",
                        )}
                        className="border-t border-border pt-1"
                      >
                        <summary className="cursor-pointer py-1">
                          {m.filename} · 母线 {d.counts.buses || 0}
                          {d.counts.snapshots
                            ? ` · ${d.counts.snapshots} 个时段`
                            : ""}
                        </summary>
                        {d.diagnostics.map((note, i) => (
                          <p
                            key={i}
                            className="mt-1 leading-5 text-muted-foreground"
                          >
                            {note.message || note.code}
                          </p>
                        ))}
                      </details>
                    );
                  })}
                </section>
              ) : null}
            </div>
          ) : null}
          {requiresAcknowledgement ? (
            <label className="flex gap-2 text-xs">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              已了解上述算例警告，按本次诊断及转换后的模型计算。
            </label>
          ) : null}
          {parameterEntries.some(([key]) => !isAdvancedParameter(key)) ? (
            <section className="space-y-2">
              <h3 className="text-xs font-medium">计算参数</h3>
              <div
                className="grid gap-3"
                style={{
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(min(100%, 10rem), 1fr))",
                }}
              >
                {parameterEntries
                  .filter(([key]) => !isAdvancedParameter(key))
                  .map(renderParameter)}
              </div>
            </section>
          ) : null}
          <details className="border-y border-border text-xs">
            <summary className="cursor-pointer py-2.5">高级设置</summary>
            <div
              className="grid gap-3 pb-3"
              style={{
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 10rem), 1fr))",
              }}
            >
              {parameterEntries
                .filter(([key]) => isAdvancedParameter(key))
                .map(renderParameter)}
              <label>
                计算时限 / 秒
                <input
                  className="ui-input mt-1 h-8 w-full"
                  type="number"
                  min="0"
                  max="604800"
                  placeholder="不限制"
                  value={timeLimitSeconds || ""}
                  onChange={(e) => setTimeLimitSeconds(Number(e.target.value))}
                />
              </label>
            </div>
            <p className="pb-3 text-[11px] text-muted-foreground">
              计算引擎：{engineInfo.name}
              。计算时限留空不限制时长；设置后，超过时限将停止计算。
            </p>
          </details>
          {engine === "pypsa" && model !== "uploaded" ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                按时间顺序填写，各列时段数需一致。可从 Excel
                复制一列；支持逗号、空格或换行分隔。
              </p>
              <div
                className="grid gap-3"
                style={{
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(min(100%, 14rem), 1fr))",
                }}
              >
                {planningSeries(parameters).map((key) => (
                  <label key={key} className="block text-xs">
                    {parameterLabels[key]}
                    <textarea
                      className="ui-input mt-1 h-20 w-full resize-y text-xs"
                      placeholder="粘贴本项目各时段数据"
                      value={
                        arrayDraft[key] ??
                        (Array.isArray(parameters[key])
                          ? parameters[key].join(", ")
                          : "")
                      }
                      onChange={(e) =>
                        setArrayDraft((p) => ({ ...p, [key]: e.target.value }))
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          <footer className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-card px-4 py-3">
            <p
              role="status"
              aria-live="polite"
              className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground"
            >
              {inputReady ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              ) : preparedRequest.body &&
                (!validation ||
                  validation.signature !== summarySignature ||
                  validation.status === "checking") ? (
                <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : null}
              {busy
                ? "正在处理…"
                : inputReady
                  ? "参数检查通过，可开始计算"
                  : requiresAcknowledgement &&
                      !acknowledged &&
                      validation?.status === "valid"
                    ? "请确认上方的模型转换警告"
                    : inputStatus}
            </p>
            <button
              className="ui-btn-primary h-9 shrink-0 gap-2 px-4 text-xs"
              disabled={busy || !inputReady}
              onClick={() => void submit()}
            >
              {busy ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {modelUploadIds.length > 1
                ? `开始计算（${modelUploadIds.length} 个算例）`
                : "开始计算"}
            </button>
          </footer>
        </div>
      ) : run ? (
        <div className="space-y-3">
          <header className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">
                {powerTaskLabel(run.spec.parameters, run.spec.engine)}
              </h2>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {POWER_PHASES[run.phase] || run.phase} ·{" "}
                {modelLabel(run.spec.modelId)} · {run.id.slice(0, 8)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {active(run) ? (
                <button
                  className="ui-btn-secondary h-8 gap-1.5 px-3 text-xs"
                  disabled={run.status === "cancel_requested"}
                  onClick={() => {
                    void fetch("/api/power-runs/" + run.id + "/cancel", {
                      method: "POST",
                    })
                      .then(readJson)
                      .then((d) => setRun(d.run))
                      .catch((e) => setError(String(e)));
                  }}
                >
                  <Square className="h-3 w-3" />
                  取消
                </button>
              ) : (
                <button
                  className="ui-btn-secondary h-8 px-3 text-xs"
                  onClick={() => editRun(true)}
                >
                  调整参数
                </button>
              )}
              <button
                type="button"
                className="ui-btn-secondary h-8 px-3 text-xs"
                onClick={() => editRun()}
              >
                新建计算
              </button>
            </div>
          </header>
          <nav
            className="flex flex-wrap gap-5 border-b border-border"
            aria-label="计算结果栏目"
          >
            {(
              [
                ["result", "结果"],
                ["data", "数据表"],
                ["input", "输入"],
                ["events", "运行记录"],
                ["files", "产物"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={
                  "border-b-2 py-2 text-xs " +
                  (tab === id
                    ? "border-foreground font-medium"
                    : "border-transparent text-muted-foreground")
                }
                aria-current={tab === id ? "page" : undefined}
              >
                {label}
              </button>
            ))}
          </nav>
          {run.result && onUseResult ? (
            <button
              className="ui-btn-secondary m-3 h-8 px-3 text-xs"
              onClick={() =>
                onUseResult(
                  `请解读本次数值计算结果，说明判据、局限及后续建议，不要编造缺失结果。\n${JSON.stringify({ runId: run.id, input: run.spec, result: run.result })}`,
                )
              }
            >
              将真实结果带回对话
            </button>
          ) : null}
          <div className="space-y-3">
            {tab === "result" ? (
              <>
                {active(run) ? (
                  <div className="flex items-center gap-2 text-xs">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    {POWER_PHASES[run.phase] || run.phase}
                    ，可在右上任务卡片查看进度。
                  </div>
                ) : null}
                {run.error ? (
                  <p
                    role="alert"
                    className="mb-3 rounded-lg bg-muted p-3 text-xs"
                  >
                    {run.error}
                  </p>
                ) : null}
                {run.result ? (
                  <>
                    <p className="flex flex-wrap items-center gap-x-2 text-xs font-medium">
                      求解：
                      {solverLabels[run.result.solverStatus] ||
                        run.result.solverStatus}{" "}
                      · 判据：
                      {run.result.criteriaStatus === "pass"
                        ? "满足设定判据"
                        : run.result.criteriaStatus === "violation"
                          ? "存在不满足项"
                          : "未评定"}
                    </p>
                    {Number(run.result.metrics.failedScenarios) > 0 ? (
                      <p
                        role="alert"
                        className="mb-3 rounded-lg border border-border p-3 text-xs"
                      >
                        有 {run.result.metrics.failedScenarios}{" "}
                        个故障场景形成孤岛或不收敛，请展开场景明细；这些场景未通过安全校核。
                      </p>
                    ) : null}
                    {run.result.message ? (
                      <p className="my-2 text-xs">{run.result.message}</p>
                    ) : null}
                    <dl
                      className="grid gap-2"
                      style={{
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(min(100%, 7.5rem), 1fr))",
                      }}
                    >
                      {resultMetrics(run)
                        .slice(0, 5)
                        .map(([key, value]) => (
                          <div
                            key={key}
                            className="min-w-0 rounded-lg bg-muted/40 px-3 py-2"
                          >
                            <dt className="text-[10px] text-muted-foreground">
                              {metricLabels[key] || key}
                            </dt>
                            <dd className="mt-1 text-base font-medium">
                              {value === null
                                ? key === "recoveryS"
                                  ? "未恢复"
                                  : "未提供"
                                : Number(value).toLocaleString(undefined, {
                                    maximumFractionDigits: 5,
                                  })}
                            </dd>
                          </div>
                        ))}
                    </dl>
                    <p className="text-[11px] leading-5 text-muted-foreground">
                      来源：
                      {run.result.source === "user"
                        ? run.spec.modelId === "custom-timeseries"
                          ? "用户填写"
                          : "用户导入"
                        : run.result.source === "generated"
                          ? "系统生成"
                          : "标准示例"}{" "}
                      · 实际引擎 {run.result.engine}{" "}
                      {run.result.version ||
                        run.result.versions[run.result.engine]}{" "}
                      ·{" "}
                      {run.result.execution
                        ? (run.result.execution.durationMs / 1000).toFixed(2) +
                          " 秒"
                        : ""}
                    </p>
                    {run.result.series.length ? (
                      <div className="space-y-2">
                        <label className="flex items-center justify-between gap-3 text-xs">
                          结果曲线
                          <select
                            className="ui-input h-8 w-auto max-w-[75%] text-xs"
                            value={
                              chartIndex ??
                              Math.max(
                                0,
                                run.result.series.findIndex((s) =>
                                  /SOC/i.test(s.label),
                                ),
                              )
                            }
                            onChange={(e) =>
                              setChartIndex(Number(e.target.value))
                            }
                          >
                            {run.result.series.map((s, i) => (
                              <option key={s.label} value={i}>
                                {s.label} · {s.unit}
                              </option>
                            ))}
                          </select>
                        </label>
                        <SeriesChart
                          series={
                            run.result.series[
                              chartIndex ??
                                Math.max(
                                  0,
                                  run.result.series.findIndex((s) =>
                                    /SOC/i.test(s.label),
                                  ),
                                )
                            ] || run.result.series[0]
                          }
                        />
                      </div>
                    ) : null}
                    {run.result.tables.modes ? (
                      <EigenvalueChart modes={run.result.tables.modes} />
                    ) : null}
                    <details
                      className="border-t border-border text-xs"
                      open={run.result.criteriaStatus === "violation"}
                    >
                      <summary className="cursor-pointer py-2">
                        计算说明与来源详情
                      </summary>
                      <p className="text-[11px] leading-5 text-muted-foreground">
                        求解器：{run.result.solver || "旧版记录未提供"} ·
                        模型口径：
                        {fidelityLabels[run.result.fidelity || ""] ||
                          run.result.fidelity ||
                          "详见原始记录"}
                      </p>
                      {run.spec.engine === "andes" &&
                      run.spec.parameters.analysis !== "small_signal" ? (
                        <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                          最低电压包含故障期间；恢复判据检查故障切除后的电压恢复时间与保持窗口。
                        </p>
                      ) : null}
                      {run.result.warnings?.map((w) => (
                        <p
                          key={w}
                          className="mt-2 text-[11px] leading-5 text-muted-foreground"
                        >
                          {w}
                        </p>
                      ))}
                      {Object.keys(run.result.metrics).length > 5 ? (
                        <dl className="mt-3 grid gap-2 sm:grid-cols-2">
                          {resultMetrics(run)
                            .slice(5)
                            .map(([key, value]) => (
                              <div key={key}>
                                <dt className="text-muted-foreground">
                                  {metricLabels[key] || key}
                                </dt>
                                <dd>
                                  {value === null
                                    ? "未提供"
                                    : Number(value).toLocaleString(undefined, {
                                        maximumFractionDigits: 5,
                                      })}
                                </dd>
                              </div>
                            ))}
                        </dl>
                      ) : null}
                    </details>
                  </>
                ) : null}
              </>
            ) : tab === "data" ? (
              run.result ? (
                <div className="divide-y divide-border">
                  {Object.entries(run.result.tables).map(([name, rows]) => (
                    <PowerResultTable
                      key={run.id + name}
                      runId={run.id}
                      name={name}
                      rows={rows}
                      total={run.result?.tableCounts?.[name]}
                    />
                  ))}
                  {!Object.values(run.result.tables).some(
                    (rows) => rows.length,
                  ) ? (
                    <p className="text-xs text-muted-foreground">
                      本次运行没有可展示的数据表。
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  计算完成后可查看数据表。
                </p>
              )
            ) : tab === "input" ? (
              <div className="space-y-3">
                <dl className="grid gap-3 sm:grid-cols-2">
                  {Object.entries(run.spec.parameters)
                    .filter(([key]) => key !== "analysis")
                    .map(([key, value]) => (
                      <div key={key} className="min-w-0">
                        <dt className="text-xs text-muted-foreground">
                          {labels[key] || key}
                        </dt>
                        <dd className="mt-1 break-words text-xs">
                          {Array.isArray(value)
                            ? value.join(", ")
                            : typeof value === "boolean"
                              ? value
                                ? "是"
                                : "否"
                              : String(value)}
                        </dd>
                      </div>
                    ))}
                </dl>
                <details className="border-t border-border text-xs">
                  <summary className="cursor-pointer py-2">
                    完整输入记录
                  </summary>
                  <pre className="overflow-auto whitespace-pre-wrap text-[11px]">
                    {JSON.stringify(run.spec, null, 2)}
                  </pre>
                </details>
              </div>
            ) : tab === "events" ? (
              <div className="space-y-3">
                {run.events.map((e, i) => (
                  <div className="text-xs" key={i}>
                    <small className="text-muted-foreground">
                      {new Date(e.at).toLocaleTimeString()} ·{" "}
                      {POWER_PHASES[e.phase] || e.phase}
                    </small>
                    <p className="mt-1">{e.detail}</p>
                  </div>
                ))}
                <p className="text-[11px] text-muted-foreground">
                  展示已执行的步骤与状态；输入、结果及诊断可在产物中下载。
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {files.map((name) => (
                  <a
                    className="flex items-center justify-between rounded-lg border border-border p-3 text-xs"
                    key={name}
                    href={
                      "/api/power-runs/" +
                      run.id +
                      "/artifacts/" +
                      encodeURIComponent(name)
                    }
                    download
                  >
                    {name}
                    <Download className="h-3.5 w-3.5" />
                  </a>
                ))}
                {!files.length ? (
                  <p className="text-xs text-muted-foreground">
                    产物尚未生成。
                  </p>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          选择一次运行查看结果，或新建计算。
        </p>
      )}
    </section>
  );
}
