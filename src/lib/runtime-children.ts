import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { RuntimeKind } from '@/lib/system-runtime-types';

export type RuntimeChild = {
  id: string;
  name: string;
  kind: RuntimeKind;
  pid: number;
  startedAt: string;
  caption?: string;
  jobType?: string;
};

const CHILDREN_DIR = path.join(process.cwd(), 'storage', 'runtime-children');

function childPath(pid: number) {
  return path.join(CHILDREN_DIR, `${pid}.json`);
}

export function isPidAlive(pid?: number | null) {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: string }).code) : '';
    return code === 'EPERM';
  }
}

export function childMetaForModule(module: string): Omit<RuntimeChild, 'pid' | 'startedAt'> {
  switch (module) {
    case 'dispatch_agent':
      return {
        id: 'dispatch',
        name: 'Power Dispatch',
        kind: 'sidecar',
        caption: 'Optimizes power dispatch',
        jobType: 'dispatch-run'
      };
    case 'loss_agent':
      return {
        id: 'loss',
        name: 'Line-Loss Sidecar',
        kind: 'sidecar',
        caption: 'Calculates theoretical line loss',
        jobType: 'loss-calc'
      };
    case 'forecast_agent':
      return {
        id: 'forecast',
        name: 'Source-Load Forecast',
        kind: 'sidecar',
        caption: 'Forecasts PV, wind and load',
        jobType: 'forecast-run'
      };
    case 'mgplan_agent':
      return {
        id: 'mgplan',
        name: 'MGPlan Sidecar',
        kind: 'sidecar',
        caption: 'Solves capacity-planning models',
        jobType: 'mgplan-solve'
      };
    case 'ppt_voice_agent':
      return {
        id: 'ppt-voice',
        name: 'PPT Voice Sidecar',
        kind: 'sidecar',
        caption: 'Builds slide narration audio',
        jobType: 'ppt-voice-build'
      };
    case 'esopt_agent':
      return {
        id: 'esopt',
        name: 'ESOPT Solver',
        kind: 'sidecar',
        caption: 'Runs DCOPF, LP and MIP models',
        jobType: 'scheme-research'
      };
    default:
      return {
        id: module.replace(/_agent$/, '') || module,
        name: module,
        kind: 'sidecar',
        caption: 'On-demand sidecar'
      };
  }
}

export function registerRuntimeChild(child: RuntimeChild) {
  if (!isPidAlive(child.pid)) return;
  try {
    fs.mkdirSync(CHILDREN_DIR, { recursive: true });
    fs.writeFileSync(childPath(child.pid), `${JSON.stringify(child)}\n`, 'utf8');
  } catch {
    // registry is best-effort for the homepage monitor
  }
}

export function unregisterRuntimeChild(pid?: number | null) {
  if (!pid || pid <= 0) return;
  try {
    fs.unlinkSync(childPath(pid));
  } catch {
    // already gone
  }
}

export function trackChildProcess(child: ChildProcess, meta: Omit<RuntimeChild, 'pid' | 'startedAt'>) {
  const pid = child.pid;
  if (!pid || pid <= 0) return;
  registerRuntimeChild({
    ...meta,
    pid,
    startedAt: new Date().toISOString()
  });
  const done = () => unregisterRuntimeChild(pid);
  child.once('exit', done);
  child.once('error', done);
}

export function listLiveRuntimeChildren(): RuntimeChild[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(CHILDREN_DIR);
  } catch {
    return [];
  }
  const live: RuntimeChild[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(CHILDREN_DIR, file);
    try {
      const raw = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw) as RuntimeChild;
      const pid = Number(parsed.pid);
      if (!isPidAlive(pid)) {
        fs.unlinkSync(full);
        continue;
      }
      live.push({ ...parsed, pid });
    } catch {
      try {
        fs.unlinkSync(full);
      } catch {
        // ignore
      }
    }
  }
  return live;
}
