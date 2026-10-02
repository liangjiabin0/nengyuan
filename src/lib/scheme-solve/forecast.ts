import fs from 'node:fs';
import path from 'node:path';
import { resolvePython, runPythonModule, runPythonModuleSync, type SidecarPayload } from './compute-sidecar';
import { schemeIdeaDirectory, writeWorkspaceText } from './workspace';

export const FORECAST_ENGINE = 'pv-wind-load-forecast';

export function resolveForecastRoot() {
  return process.env.FORECAST_ROOT?.trim() || path.join(process.cwd(), 'tools', 'pv-wind-load-forecast');
}

export function resolveForecastPython() {
  return resolvePython('FORECAST_PYTHON', path.join(process.cwd(), 'tools', 'forecast-venv'));
}

function assertRoot() {
  const root = resolveForecastRoot();
  if (!fs.existsSync(path.join(root, 'forecast_agent'))) {
    throw new Error(`未找到源荷预测侧车：${root}`);
  }
  return root;
}

export function forecastDirs(sessionId: string, ideaId: string) {
  return { outputDir: path.join(schemeIdeaDirectory(sessionId, ideaId), 'forecast') };
}

export function resolveForecastKind(text: string) {
  const value = text.toLowerCase();
  if (/wind|风电|风机/.test(value)) return 'wind';
  if (/电量|energy|ercot|德州|texas/.test(value)) return 'energy';
  if (/load|负荷/.test(value)) return 'load';
  if (/光伏|pv|solar/.test(value)) return 'pv';
  return 'pv';
}

export function resolveForecastHorizon(text: string) {
  const match = text.match(/(?:未来|之后|接下来|日前)?\s*(\d{1,3})\s*(?:小时|h\b)/i);
  if (match) return Number(match[1]);
  if (/一周|7\s*天/.test(text)) return 168;
  if (/日前|day.?ahead/.test(text)) return 24;
  return 24;
}

export function resolveForecastVariant(text: string) {
  const value = text.toLowerCase();
  if (/v5|按天|按周|按月|周期/.test(value)) return 'v5';
  if (/v4|季节|夏季|冬季|过渡季/.test(value)) return 'v4';
  if (/v2|此刻温度|当前天气/.test(value)) return 'v2';
  if (/v1|上一时刻/.test(value)) return 'v1';
  return 'v3';
}

export function resolveForecastModel(text: string) {
  const value = text.toLowerCase();
  if (/svr/.test(value)) return 'svr';
  if (/gru/.test(value)) return 'gru';
  if (/cnn/.test(value)) return 'cnn';
  return 'lstm';
}

export function getForecastHealth() {
  try {
    const result = runPythonModuleSync({
      root: assertRoot(),
      module: 'forecast_agent',
      args: ['health'],
      python: resolveForecastPython(),
      timeoutMs: 120_000
    });
    return { ok: result.ok !== false, python: resolveForecastPython(), root: resolveForecastRoot(), keras: Boolean(result.keras) };
  } catch (error) {
    return {
      ok: false,
      python: resolveForecastPython(),
      root: resolveForecastRoot(),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function runForecastTask(input: {
  command: 'predict' | 'train';
  kind: string;
  model: string;
  outputDir: string;
  data?: string;
  horizon?: number;
  variant?: string;
  epochs?: number;
  target?: string;
  features?: string[];
  window?: number;
  seed?: number;
  trainRatio?: number;
  validationRatio?: number;
  testRatio?: number;
  /** Paper-repro passes a device 5-minute budget. 0 still means no limit for other callers. */
  timeoutMs?: number;
  signal?: AbortSignal;
}) {
  const args = [
    input.command,
    '--kind',
    input.kind,
    '--model',
    input.model,
    '--output-dir',
    input.outputDir,
    '--horizon',
    String(input.horizon || 24),
    '--variant',
    input.variant || 'v3',
    '--epochs',
    String(input.epochs || (input.command === 'train' ? 8 : 4))
  ];
  if (input.data) args.push('--data', input.data);
  if (input.target) args.push('--target', input.target);
  if (input.features?.length) args.push('--features', input.features.join(','));
  if (input.window && input.window > 0) args.push('--window', String(input.window));
  if (input.seed != null) args.push('--seed', String(input.seed));
  if (input.trainRatio != null) args.push('--train-ratio', String(input.trainRatio));
  if (input.validationRatio != null) args.push('--validation-ratio', String(input.validationRatio));
  if (input.testRatio != null) args.push('--test-ratio', String(input.testRatio));
  return runPythonModule({
    root: assertRoot(),
    module: 'forecast_agent',
    args,
    python: resolveForecastPython(),
    timeoutMs: input.timeoutMs ?? 0,
    signal: input.signal,
    env: {
      TF_CPP_MIN_LOG_LEVEL: '2',
      TF_ENABLE_ONEDNN_OPTS: '0'
    }
  });
}

export function buildForecastResult(sidecar: SidecarPayload) {
  const requested = sidecar.requestedModel;
  const used = sidecar.model;
  const requestedName = String(requested || '');
  const usedName = String(used || '');
  const deep = requestedName === 'lstm' || requestedName === 'gru' || requestedName === 'cnn';
  const fidelity = String(sidecar.fidelity || '').trim();
  const requestedExecuted = requestedName
    ? usedName.toLowerCase().includes(requestedName.toLowerCase())
    : false;
  return {
    ok: sidecar.ok !== false && sidecar.success !== false,
    success: sidecar.success === true,
    engine: FORECAST_ENGINE,
    status: sidecar.status || 'success',
    kind: sidecar.kind,
    model: used,
    requestedModel: requested,
    usedModel: used,
    fallback: Boolean(sidecar.success !== false && deep && !requestedExecuted),
    fidelity: fidelity || (sidecar.success === false ? 'not-executed' : deep && requestedExecuted ? 'adapted' : 'fallback'),
    paper: sidecar.paper,
    variant: sidecar.variant,
    features: sidecar.features,
    weightPath: sidecar.weightPath,
    samples: sidecar.samples,
    metrics: sidecar.metrics,
    predictCsv: sidecar.predictCsv,
    profileCsv: sidecar.profileCsv,
    dispatchProfile: sidecar.dispatchProfile,
    chartPng: sidecar.chartPng,
    outputDir: sidecar.outputDir,
    outputFiles: sidecar.outputFiles,
    error: sidecar.error,
    weightStatus: sidecar.weightStatus,
    dataPath: sidecar.dataPath,
    dataSha256: sidecar.dataSha256,
    dataBytes: sidecar.dataBytes,
    inputShape: sidecar.inputShape,
    scaler: sidecar.scaler,
    warnings: Array.isArray(sidecar.warnings) ? sidecar.warnings : [],
    split: sidecar.split,
    audit: sidecar.audit
  };
}

export function writeForecastResult(sessionId: string, ideaId: string, sidecar: SidecarPayload) {
  const result = buildForecastResult(sidecar);
  writeWorkspaceText(sessionId, ideaId, 'result.json', `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
