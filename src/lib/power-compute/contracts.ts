import type { PowerRequest, PowerResult, PowerStatus } from "./schema";

// The durable contracts are the existing RunSpec/ResultBundle schema family.
// The old HTTP shape is a compatibility view, never a second stored protocol.
export function asRunSpec(
  request: PowerRequest,
  runId: string,
  digest: string,
  modelHash?: string,
) {
  return {
    version: "1.1",
    task: {
      mode:
        request.engine === "pypsa" ? "time_series_dispatch" : "composed_task",
      name: request.parameters.analysis || request.engine,
    },
    case: {
      case_id: request.modelUploadId || request.modelId,
      source:
        request.modelUploadId || request.modelId === "custom-timeseries"
          ? "user"
          : "sample",
      asset_id: request.modelUploadId || request.modelId,
    },
    capabilities: {
      hierarchy: "single_grid",
      time_scales: [request.engine === "pypsa" ? "day_ahead" : "single_period"],
      power_control:
        request.engine === "pypsa" ||
        String(request.parameters.analysis).startsWith("dc_")
          ? "P"
          : "PQ",
    },
    objective:
      request.engine === "pypsa"
        ? request.modelUploadId
          ? { native_model_objective: true }
          : {
              total_cost: true,
              annualized: request.parameters.analysis === "capacity_expansion",
            }
        : request.engine === "andes"
          ? { dynamic_analysis: { type: request.parameters.analysis } }
          : {
              [String(request.parameters.analysis).includes("opf")
                ? "generation_cost"
                : "power_flow_feasibility"]: true,
            },
    constraints: {},
    solver: {
      backend: request.engine,
      options: { transport: request.transport },
      time_limit_s: request.timeLimitSeconds || 0,
      solver_name:
        request.engine === "pypsa"
          ? "highs"
          : request.engine === "andes"
            ? request.parameters.analysis === "small_signal"
              ? "EIG"
              : "TDS"
            : request.parameters.analysis,
    },
    outputs: ["metrics", "series", "tables", "logs"],
    metadata: {
      run_id: runId,
      input_digest: digest,
      asset_digest: modelHash,
      analysis: request.parameters.analysis,
      parameters: request.parameters,
      model_id: request.modelId,
      model_upload_id: request.modelUploadId,
      request_key: request.requestKey,
      session_id: request.sessionId,
      idea_id: request.ideaId,
      chat_model: request.chatModel,
    },
  };
}

export function asResultBundle(result: PowerResult, status: PowerStatus) {
  return {
    version: "1.1",
    run_id: result.runId,
    status:
      status === "succeeded"
        ? "success"
        : status === "infeasible"
          ? "infeasible"
          : "failed",
    input_digest: result.inputHash,
    backend: {
      name: result.engine,
      version: result.version || result.versions[result.engine],
    },
    solver: { name: result.solver, status: result.solverStatus },
    validation: {
      criteriaStatus: result.criteriaStatus,
      executionStatus: status,
    },
    metrics: result.metrics,
    series: Object.fromEntries(
      result.series.map((value, index) => ["series-" + index, value]),
    ),
    warnings: result.warnings || [],
    artifacts: ["result.json", "report.md"],
    metadata: {
      transport: result.transport,
      source: result.source,
      engine: result.engine,
      version: result.version,
      solver: result.solver,
      fidelity: result.fidelity,
      model_id: result.modelId,
      model_digest: result.modelHash,
      execution: result.execution,
      versions: result.versions,
      message: result.message,
      table_counts: result.tableCounts,
    },
    tables: result.tables,
  };
}

type CanonicalSpec = ReturnType<typeof asRunSpec>;
type CanonicalResult = ReturnType<typeof asResultBundle>;
export function specView(value: unknown): PowerRequest & {
  runId: string;
  inputHash: string;
  schemaVersion: string;
  runSpec?: CanonicalSpec;
  modelSourceHash?: string;
} {
  const spec = value as CanonicalSpec;
  if (spec.version !== "1.1" || !spec.metadata)
    return value as ReturnType<typeof specView>;
  const m = spec.metadata;
  return {
    transport: spec.solver.options.transport,
    timeLimitSeconds: spec.solver.time_limit_s || 0,
    engine: spec.solver.backend,
    modelId: m.model_id,
    parameters: m.parameters,
    requestKey: m.request_key,
    ...(m.model_upload_id ? { modelUploadId: m.model_upload_id } : {}),
    ...(m.session_id ? { sessionId: m.session_id } : {}),
    ...(m.idea_id ? { ideaId: m.idea_id } : {}),
    ...(m.chat_model ? { chatModel: m.chat_model } : {}),
    runId: m.run_id,
    inputHash: m.input_digest,
    schemaVersion: "RunSpec/1.1",
    runSpec: spec,
    ...(m.asset_digest ? { modelSourceHash: m.asset_digest } : {}),
  } as ReturnType<typeof specView>;
}
export function resultView(value: unknown): PowerResult {
  const bundle = value as CanonicalResult;
  if (bundle.version !== "1.1" || !bundle.metadata) return value as PowerResult;
  const m = bundle.metadata;
  return {
    schemaVersion: "power-result/v1",
    dataOrigin: "engine",
    computedByEngine: true,
    runId: bundle.run_id,
    inputHash: bundle.input_digest,
    engine: m.engine,
    modelId: m.model_id,
    modelHash: m.model_digest,
    solverStatus: bundle.solver.status,
    criteriaStatus: bundle.validation.criteriaStatus,
    transport: m.transport,
    source: m.source,
    version: m.version,
    solver: m.solver,
    fidelity: m.fidelity,
    execution: m.execution,
    versions: m.versions,
    message: m.message,
    metrics: bundle.metrics,
    series: Object.values(bundle.series),
    tables: bundle.tables,
    tableCounts: m.table_counts,
    warnings: bundle.warnings,
    bundle,
  };
}
