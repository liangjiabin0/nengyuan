import fs from 'node:fs';
import path from 'node:path';
import { resolvePython, runPythonModule, runPythonModuleSync, type SidecarPayload } from './compute-sidecar';
import { schemeIdeaDirectory, writeWorkspaceText } from './workspace';

export const LOSS_ENGINE = 'nwxs-loss';

export function resolveLossRoot() {
  return process.env.LOSS_ROOT?.trim() || path.join(process.cwd(), 'tools', 'nwxs-loss');
}

export function resolveLossPython() {
  return resolvePython('LOSS_PYTHON', path.join(process.cwd(), 'tools', 'nwxs-loss-venv'));
}

function assertRoot() {
  const root = resolveLossRoot();
  if (!fs.existsSync(path.join(root, 'loss_agent'))) {
    throw new Error(`未找到线损计算侧车：${root}`);
  }
  return root;
}

export function lossDirs(sessionId: string, ideaId: string) {
  const ideaDir = schemeIdeaDirectory(sessionId, ideaId);
  return {
    inputPath: path.join(ideaDir, 'loss', 'input.json'),
    outputDir: path.join(ideaDir, 'loss', 'output')
  };
}

export function getLossHealth() {
  try {
    const result = runPythonModuleSync({
      root: assertRoot(),
      module: 'loss_agent',
      args: ['health'],
      python: resolveLossPython(),
      extraPath: [path.join(assertRoot(), 'scripts')],
      timeoutMs: 20_000
    });
    return { ok: result.ok !== false, python: resolveLossPython(), root: resolveLossRoot() };
  } catch (error) {
    return {
      ok: false,
      python: resolveLossPython(),
      root: resolveLossRoot(),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function runLossCalculation(
  inputPath: string,
  outputDir: string,
  format = 'full',
  method = '04',
  workers?: number
) {
  const args = ['run', '--input', inputPath, '--output-dir', outputDir, '--format', format, '--method', method];
  if (workers && workers > 0) args.push('--workers', String(workers));
  return runPythonModule({
    root: assertRoot(),
    module: 'loss_agent',
    args,
    python: resolveLossPython(),
    extraPath: [path.join(assertRoot(), 'scripts')],
    timeoutMs: 20 * 60 * 1000
  });
}

export function writeLossResult(
  sessionId: string,
  ideaId: string,
  sidecar: SidecarPayload,
  extra?: { source?: 'attachment' | 'sample' }
) {
  const source = extra?.source || 'sample';
  const result = {
    ok: sidecar.ok !== false && sidecar.success !== false,
    success: sidecar.success !== false,
    engine: LOSS_ENGINE,
    status: sidecar.status || 'success',
    source,
    sample: source === 'sample',
    lossRate: sidecar.lossRate,
    statistics: sidecar.statistics,
    results: sidecar.results,
    outputDir: sidecar.outputDir,
    outputFiles: sidecar.outputFiles
  };
  writeWorkspaceText(sessionId, ideaId, 'result.json', `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
