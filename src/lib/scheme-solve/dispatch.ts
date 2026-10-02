import fs from 'node:fs';
import path from 'node:path';
import { resolvePython, runPythonModule, runPythonModuleSync, type SidecarPayload } from './compute-sidecar';
import { schemeIdeaDirectory, writeWorkspaceText } from './workspace';

export const DISPATCH_ENGINE = 'power-dispatch';

export function resolveDispatchRoot() {
  return process.env.DISPATCH_ROOT?.trim() || path.join(process.cwd(), 'tools', 'power-dispatch');
}

export function resolveDispatchPython() {
  return resolvePython('DISPATCH_PYTHON', path.join(process.cwd(), 'tools', 'power-dispatch-venv'));
}

function assertRoot() {
  const root = resolveDispatchRoot();
  if (!fs.existsSync(path.join(root, 'dispatch_agent'))) {
    throw new Error(`未找到调度优化侧车：${root}`);
  }
  return root;
}

export function dispatchDirs(sessionId: string, ideaId: string) {
  const ideaDir = schemeIdeaDirectory(sessionId, ideaId);
  return {
    ideaDir,
    specPath: path.join(ideaDir, 'dispatch', 'run-spec.yaml'),
    outputDir: path.join(ideaDir, 'dispatch')
  };
}

export function getDispatchHealth() {
  try {
    const result = runPythonModuleSync({
      root: assertRoot(),
      module: 'dispatch_agent',
      args: ['health'],
      python: resolveDispatchPython(),
      extraPath: [path.join(assertRoot(), 'src')],
      timeoutMs: 20_000
    });
    return {
      ok: Boolean(result.pandapower),
      python: resolveDispatchPython(),
      pandapower: Boolean(result.pandapower),
      pyomo: Boolean(result.pyomo),
      root: resolveDispatchRoot()
    };
  } catch (error) {
    return {
      ok: false,
      python: resolveDispatchPython(),
      root: resolveDispatchRoot(),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function validateDispatchSpec(specPath: string) {
  return runPythonModuleSync({
    root: assertRoot(),
    module: 'dispatch_agent',
    args: ['validate', '--spec', specPath],
    python: resolveDispatchPython(),
    extraPath: [path.join(assertRoot(), 'src')],
    timeoutMs: 30_000
  });
}

export function listDispatchCases() {
  return runPythonModuleSync({
    root: assertRoot(),
    module: 'dispatch_agent',
    args: ['cases'],
    python: resolveDispatchPython(),
    extraPath: [path.join(assertRoot(), 'src')],
    timeoutMs: 20_000
  });
}

export function listDispatchBackends() {
  return runPythonModuleSync({
    root: assertRoot(),
    module: 'dispatch_agent',
    args: ['backends'],
    python: resolveDispatchPython(),
    extraPath: [path.join(assertRoot(), 'src')],
    timeoutMs: 20_000
  });
}

export function runDispatchTask(specPath: string, outputDir: string, dryRun = false) {
  return runPythonModule({
    root: assertRoot(),
    module: 'dispatch_agent',
    args: ['run', '--spec', specPath, '--output-dir', outputDir, ...(dryRun ? ['--dry-run'] : [])],
    python: resolveDispatchPython(),
    extraPath: [path.join(assertRoot(), 'src')],
    timeoutMs: 20 * 60 * 1000
  });
}

export function writeDispatchResult(sessionId: string, ideaId: string, sidecar: SidecarPayload) {
  const bundle = (sidecar.bundle && typeof sidecar.bundle === 'object' ? sidecar.bundle : sidecar) as Record<string, unknown>;
  const result = {
    ok: sidecar.ok !== false && (sidecar.success === true || sidecar.status === 'success' || sidecar.status === 'planned'),
    success: sidecar.success === true || sidecar.status === 'success',
    engine: DISPATCH_ENGINE,
    status: sidecar.status || (sidecar.success ? 'success' : 'failed'),
    fixture: sidecar.fixture === true,
    objective: sidecar.objective ?? (bundle.objective as { total?: unknown } | undefined)?.total,
    bundle,
    outputDir: sidecar.outputDir,
    outputFiles: sidecar.outputFiles
  };
  writeWorkspaceText(sessionId, ideaId, 'result.json', `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
