import { createHash } from "node:crypto";
import { z } from "zod";

const finite = z.number().finite();
const fraction = finite.min(0).max(1);
const uuid = z.string().uuid();
const flow = z
  .object({
    analysis: z
      .enum([
        "ac_flow",
        "dc_flow",
        "ac_opf",
        "dc_opf",
        "n_minus_1",
        "n_minus_2",
      ])
      .default("ac_flow"),
    algorithm: z.enum(["nr", "bfsw", "gs", "fdxb", "fdbx"]).default("nr"),
    maxIterations: z.number().int().min(1).max(10000).default(30),
    calculateAngles: z.boolean().default(true),
    contingencyElements: z
      .array(z.string().regex(/^(line|trafo):[0-9]+$/))
      .max(200)
      .default([]),
    loadFactor: finite.min(0.1).max(3).default(1),
    voltageMinPu: finite.min(0.5).max(1).default(0.95),
    voltageMaxPu: finite.min(1).max(1.5).default(1.05),
    loadingMaxPercent: finite.min(1).max(200).default(100),
    toleranceMva: finite.min(1e-12).max(1e-3).default(1e-8),
  })
  .strict()
  .refine((p) => p.voltageMinPu < p.voltageMaxPu, "电压下限必须小于上限");
const storage = z
  .object({
    analysis: z
      .enum([
        "storage_dispatch",
        "economic_dispatch",
        "unit_commitment",
        "capacity_expansion",
      ])
      .default("storage_dispatch"),
    stepMinutes: finite.min(1).max(1440).default(60),
    solarProfile: z.array(fraction).min(2).max(8760).optional(),
    windProfile: z.array(fraction).min(2).max(8760).optional(),
    solarKw: finite.min(0).max(1e6).default(0),
    windKw: finite.min(0).max(1e6).default(0),
    generatorKw: finite.min(0).max(1e6).default(0),
    generatorCost: finite.min(0).max(100).default(0.8),
    startupCost: finite.min(0).max(1e8).default(50),
    minUpSteps: z.number().int().min(1).max(8760).default(2),
    minDownSteps: z.number().int().min(1).max(8760).default(1),
    rampPerStep: fraction.positive().default(0.5),
    solarMaxKw: finite.min(0).max(1e6).default(1000),
    windMaxKw: finite.min(0).max(1e6).default(0),
    storageMaxKw: finite.min(0).max(1e6).default(500),
    solarAnnualCost: finite.min(0).max(1e6).default(350),
    windAnnualCost: finite.min(0).max(1e6).default(500),
    storageAnnualCost: finite.min(0).max(1e6).default(500),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .default("2026-10-16"),
    timezone: z.literal("Asia/Shanghai").default("Asia/Shanghai"),
    loadsKw: z.array(finite.min(0).max(1e6)).min(2).max(8760),
    prices: z.array(finite.min(-100).max(100)).min(2).max(8760),
    capacityKwh: finite.positive().max(1e7).optional(),
    powerKw: finite.positive().max(1e6).optional(),
    gridLimitKw: finite.positive().max(1e6),
    efficiencyCharge: finite.min(0.1).max(1).default(0.95),
    efficiencyDischarge: finite.min(0.1).max(1).default(0.95),
    socMin: fraction.default(0.1),
    socMax: fraction.default(0.9),
    initialSoc: fraction.default(0.5),
    terminalSoc: fraction.default(0.5),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (
      ["storage_dispatch", "capacity_expansion"].includes(p.analysis) &&
      (!p.capacityKwh || !p.powerKw)
    )
      ctx.addIssue({ code: "custom", message: "请填写储能容量和储能功率" });
    if (
      p.loadsKw.length !== p.prices.length ||
      [p.solarProfile, p.windProfile].some(
        (a) => a && a.length !== p.loadsKw.length,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "负荷、电价及风光出力序列长度必须一致",
      });
    if (
      (p.solarKw > 0 ||
        (p.analysis === "capacity_expansion" && p.solarMaxKw > 0)) &&
      !p.solarProfile
    )
      ctx.addIssue({
        code: "custom",
        message: "光伏设备需提供与负荷对齐的出力系数",
      });
    if (
      (p.windKw > 0 ||
        (p.analysis === "capacity_expansion" && p.windMaxKw > 0)) &&
      !p.windProfile
    )
      ctx.addIssue({
        code: "custom",
        message: "风电设备需提供与负荷对齐的出力系数",
      });
    if (p.analysis === "unit_commitment" && p.generatorKw <= 0)
      ctx.addIssue({ code: "custom", message: "机组组合必须配置常规机组容量" });
    if (
      !Number.isFinite(Date.parse(p.date + "T00:00:00Z")) ||
      new Date(p.date + "T00:00:00Z").toISOString().slice(0, 10) !== p.date
    )
      ctx.addIssue({ code: "custom", message: "日期无效" });
    if (
      !(
        p.socMin < p.socMax &&
        p.initialSoc >= p.socMin &&
        p.initialSoc <= p.socMax &&
        p.terminalSoc >= p.socMin &&
        p.terminalSoc <= p.socMax
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "初末 SOC 必须位于 SOC 上下限内",
      });
  });
const dynamic = z
  .object({
    analysis: z.enum(["time_domain", "small_signal"]).default("time_domain"),
    busId: z.number().int().min(1).max(999999).default(5),
    faultAtS: finite.min(0.1).max(600).default(1),
    clearAtS: finite.min(0.11).max(600).default(1.1),
    endAtS: finite.min(1).max(600).default(10),
    stepS: finite.min(0.005).max(0.05).default(0.01),
    voltageMinPu: finite.min(0.5).max(1).default(0.95),
    voltageMaxPu: finite.min(1).max(1.5).default(1.05),
    recoverWithinS: finite.min(0.1).max(10).default(3),
    holdS: finite.min(0.1).max(10).default(1),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.endAtS / p.stepS > 120000)
      ctx.addIssue({
        code: "custom",
        message: "动态时间点数超过当前任务预算，请调整仿真范围",
      });
    if (
      p.analysis === "time_domain" &&
      !(
        p.clearAtS > p.faultAtS &&
        p.endAtS >= p.clearAtS + p.recoverWithinS + p.holdS &&
        p.voltageMinPu < p.voltageMaxPu
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "请检查故障起止、观察窗口和电压限值",
      });
  });
const context = {
  timeLimitSeconds: finite.min(0).max(604800).default(0),
  sessionId: uuid.optional(),
  ideaId: uuid.optional(),
  requestKey: uuid,
  modelUploadId: uuid.optional(),
  chatModel: z.enum(["arc", "thunder", "storm"]).optional(),
};
const requestSchema = z
  .discriminatedUnion("engine", [
    z
      .object({
        ...context,
        engine: z.literal("pandapower"),
        transport: z.enum(["direct", "mcp"]).default("direct"),
        modelId: z.enum(["ieee9", "ieee14", "uploaded"]),
        parameters: flow,
      })
      .strict(),
    z
      .object({
        ...context,
        engine: z.literal("pypsa"),
        transport: z.literal("mcp").default("mcp"),
        modelId: z.enum(["park-24h", "custom-timeseries", "uploaded"]),
        parameters: z.union([
          storage,
          z
            .object({
              analysis: z.enum([
                "storage_dispatch",
                "economic_dispatch",
                "unit_commitment",
                "capacity_expansion",
              ]),
            })
            .strict(),
        ]),
      })
      .strict(),
    z
      .object({
        ...context,
        engine: z.literal("andes"),
        transport: z.literal("mcp").default("mcp"),
        modelId: z.enum(["kundur-full", "uploaded"]),
        parameters: dynamic,
      })
      .strict(),
  ])
  .superRefine((request, ctx) => {
    if (
      request.engine === "pypsa" &&
      request.modelId !== "uploaded" &&
      !("loadsKw" in request.parameters)
    )
      ctx.addIssue({
        code: "custom",
        message: "请填写负荷、电价和设备参数，或导入完整模型",
      });
    if ((request.modelId === "uploaded") !== Boolean(request.modelUploadId))
      ctx.addIssue({
        code: "custom",
        message: "导入模型必须提供所属模型编号；标准模型不能混用导入文件",
      });
    if (
      request.engine === "andes" &&
      request.modelId === "kundur-full" &&
      request.parameters.busId > 10
    )
      ctx.addIssue({ code: "custom", message: "Kundur 模型母线编号为 1–10" });
  });
// Validate user inputs before defaults are applied; existing sample requests stay compatible.
export const powerRequestSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (!value || typeof value !== "object") return;
    const request = value as Record<string, unknown>;
    if (request.engine !== "pypsa" || request.modelId !== "custom-timeseries")
      return;
    const p = request.parameters as Record<string, unknown> | undefined;
    if (!p || typeof p !== "object") return;
    const fields = [
      "analysis",
      "date",
      "stepMinutes",
      "gridLimitKw",
      "loadsKw",
      "prices",
      ...(["storage_dispatch", "capacity_expansion"].includes(
        String(p.analysis),
      )
        ? [
            "capacityKwh",
            "powerKw",
            "efficiencyCharge",
            "efficiencyDischarge",
            "socMin",
            "socMax",
            "initialSoc",
            "terminalSoc",
          ]
        : []),
      ...(Number(p.generatorKw) > 0 || p.analysis === "unit_commitment"
        ? ["generatorKw", "generatorCost"]
        : []),
      ...(p.analysis === "unit_commitment"
        ? ["startupCost", "minUpSteps", "minDownSteps", "rampPerStep"]
        : []),
      ...(p.analysis === "capacity_expansion"
        ? [
            "solarMaxKw",
            "windMaxKw",
            "storageMaxKw",
            ...(Number(p.solarMaxKw) > 0 ? ["solarAnnualCost"] : []),
            ...(Number(p.windMaxKw) > 0 ? ["windAnnualCost"] : []),
            ...(Number(p.storageMaxKw) > 0 ? ["storageAnnualCost"] : []),
          ]
        : []),
    ];
    for (const key of fields)
      if (p[key] === undefined || p[key] === null || p[key] === "")
        ctx.addIssue({
          code: "custom",
          path: ["parameters", key],
          message: "用户数据不完整，请填写所需时间、设备和成本参数",
        });
    if (
      p.analysis === "capacity_expansion" &&
      ![p.solarMaxKw, p.windMaxKw, p.storageMaxKw].some((v) => Number(v) > 0)
    )
      ctx.addIssue({
        code: "custom",
        message: "容量扩展至少需要设置一种设备的新增容量上限",
      });
  })
  .pipe(requestSchema);
export type PowerRequest = z.infer<typeof powerRequestSchema>;
export class PowerRunConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PowerRunConflictError";
  }
}
export type PowerEngine = PowerRequest["engine"];
export const terminalStatuses = new Set([
  "succeeded",
  "failed",
  "infeasible",
  "nonconverged",
  "cancelled",
  "timed_out",
]);
export type PowerStatus =
  | "queued"
  | "running"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "infeasible"
  | "nonconverged"
  | "cancelled"
  | "timed_out";
export type PowerResult = {
  schemaVersion: string;
  transport?: "direct" | "mcp";
  source?: "sample" | "user" | "generated";
  solver?: string;
  version?: string;
  fidelity?: string;
  execution?: { startedAt: string; finishedAt: string; durationMs: number };
  bundle?: Record<string, unknown>;
  dataOrigin: "engine";
  computedByEngine: true;
  runId: string;
  inputHash: string;
  engine: PowerEngine;
  modelId: string;
  modelHash: string;
  solverStatus: string;
  criteriaStatus: "pass" | "violation" | "not_evaluated";
  message?: string;
  warnings?: string[];
  versions: Record<string, string>;
  metrics: Record<string, number | null>;
  series: Array<{
    label: string;
    unit: string;
    xUnit: string;
    points: number[][];
  }>;
  tableCounts?: Record<string, number>;
  tables: Record<string, Array<Record<string, string | number>>>;
};
const resultPayloadSchema = z.object({
  schemaVersion: z.literal("power-result/v1"),
  engine: z.enum(["pandapower", "pypsa", "andes"]),
  modelHash: z.string().regex(/^[a-f0-9]{64}$/),
  versions: z.record(z.string(), z.string().min(1)),
  metrics: z.record(z.string(), z.number().finite().nullable()),
  tables: z.record(
    z.string(),
    z.array(z.record(z.string(), z.union([z.string(), z.number().finite()]))),
  ),
  tableCounts: z.record(z.string(), z.number().int().nonnegative()).optional(),
  warnings: z.array(z.string()).optional(),
  series: z.array(
    z.object({
      label: z.string().min(1),
      unit: z.string().min(1),
      xUnit: z.string().min(1),
      points: z
        .array(z.tuple([z.number().finite(), z.number().finite()]))
        .min(1),
    }),
  ),
});
export function inputHash(request: PowerRequest) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        engine: request.engine,
        modelId: request.modelId,
        modelUploadId: request.modelUploadId,
        parameters: request.parameters,
        timeLimitSeconds: request.timeLimitSeconds || 0,
        transport: request.transport,
      }),
    )
    .digest("hex");
}
export function validateResult(
  value: unknown,
  spec: {
    runId: string;
    inputHash: string;
    engine?: PowerEngine;
    modelId?: string;
    schemaVersion?: string;
  },
): asserts value is PowerResult {
  if (!value || typeof value !== "object")
    throw new Error("结果不是结构化对象");
  const r = value as PowerResult;
  if (
    spec.schemaVersion?.startsWith("RunSpec/") &&
    (!["sample", "user", "generated"].includes(r.source || "") ||
      !r.solver ||
      !r.version ||
      !r.fidelity ||
      !r.execution ||
      !Number.isFinite(r.execution.durationMs) ||
      r.execution.durationMs < 0 ||
      !Number.isFinite(Date.parse(r.execution.startedAt)) ||
      !Number.isFinite(Date.parse(r.execution.finishedAt)))
  )
    throw new Error("新运行的计算来源与执行时间不完整");
  if (
    (spec.engine && r.engine !== spec.engine) ||
    (spec.modelId && r.modelId !== spec.modelId)
  )
    throw new Error("结果引擎或模型与输入不一致");
  if (
    spec.schemaVersion?.startsWith("RunSpec/") &&
    spec.modelId &&
    r.source !==
      (["uploaded", "custom-timeseries"].includes(spec.modelId)
        ? "user"
        : "sample")
  )
    throw new Error("结果的数据来源与输入不一致");
  if (
    r.dataOrigin !== "engine" ||
    r.computedByEngine !== true ||
    r.runId !== spec.runId ||
    r.inputHash !== spec.inputHash
  )
    throw new Error("结果来源或运行标识不一致");
  if (!resultPayloadSchema.safeParse(r).success)
    throw new Error("结果字段不完整");
  if (
    !r.versions[r.engine] ||
    (r.version && r.version !== r.versions[r.engine])
  )
    throw new Error("结果中的实际引擎版本缺失或不一致");
  if (
    r.execution &&
    Date.parse(r.execution.finishedAt) < Date.parse(r.execution.startedAt)
  )
    throw new Error("执行结束时间早于开始时间");
  for (const [name, rows] of Object.entries(r.tables)) {
    const total = r.tableCounts?.[name];
    if (total !== undefined && total < rows.length)
      throw new Error("表格总数小于已返回的记录数");
  }
  if (
    ["converged", "optimal", "completed"].includes(r.solverStatus) &&
    !Object.values(r.metrics).some((metric) => typeof metric === "number")
  )
    throw new Error("成功结果缺少有效指标");
  if (
    ![
      "converged",
      "optimal",
      "completed",
      "infeasible",
      "diverged",
      "unavailable",
      "solver_error",
      "timed_out",
    ].includes(r.solverStatus)
  )
    throw new Error("未知求解状态");
  if (!["pass", "violation", "not_evaluated"].includes(r.criteriaStatus))
    throw new Error("未知判据状态");
  for (const series of r.series) {
    let previous = -Infinity;
    for (const point of series.points) {
      if (point[0] <= previous) throw new Error("曲线坐标无效或顺序错误");
      previous = point[0];
    }
  }
  const finiteTree = (v: unknown): boolean =>
    typeof v === "number"
      ? Number.isFinite(v)
      : Array.isArray(v)
        ? v.every(finiteTree)
        : v && typeof v === "object"
          ? Object.values(v).every(finiteTree)
          : true;
  if (!finiteTree(r)) throw new Error("结果包含非有限数");
  if (
    [
      "infeasible",
      "diverged",
      "unavailable",
      "solver_error",
      "timed_out",
    ].includes(r.solverStatus) &&
    (r.series.length || r.criteriaStatus !== "not_evaluated")
  )
    throw new Error("失败求解不得包含成功曲线或通过判据");
}
