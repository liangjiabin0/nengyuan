import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { listJobs } from '@/lib/jobs/queue';
import { isPdf2mdAvailable } from '@/lib/pdf2md';
import { isPidAlive, listLiveRuntimeChildren, type RuntimeChild } from '@/lib/runtime-children';
import { inspectEsoptInstallation } from '@/lib/scheme-solve/esopt';
import { resolveMgplanRoot } from '@/lib/scheme-solve/mgplan';
import type { RuntimeNode, RuntimeSnapshot, RuntimeStatus } from '@/lib/system-runtime-types';

const STORAGE = path.join(process.cwd(), 'storage');
const PIDS_PATH = path.join(STORAGE, 'intranet.pids.json');
const HEARTBEAT_PATH = path.join(STORAGE, 'worker-heartbeat.json');
const SIDECAR_PATH = path.join(STORAGE, 'opencode-sidecar.json');
const MODELICA_PID_PATH = path.join(STORAGE, 'openmodelica-gateway.pid');
const WORKER_STALE_MS = 20_000;
const PROBE_MS = 1_800;

type IntranetPids = {
  at?: string;
  mode?: string;
  api?: number | null;
  worker?: number | null;
  web?: number | null;
  ports?: { web?: number; api?: number; opencode?: number };
};

type WorkerHeartbeat = {
  workerId?: string;
  role?: string;
  at?: string;
  pid?: number;
  status?: string;
  jobId?: string;
  jobType?: string;
};

type SidecarFile = {
  pid?: number;
  baseUrl?: string;
  username?: string;
  password?: string;
  startedAt?: string;
  gatewayPid?: number;
  gatewayUrl?: string;
};

type HttpProbe = {
  reachable: boolean;
  ok: boolean;
  status?: number;
  latencyMs: number;
  json?: Record<string, unknown>;
  error?: string;
};

const JOB_LABELS: Record<string, string> = {
  'data-import': 'disk import',
  'excel-ingest': 'table ingest',
  'graph-rebuild': 'graph rebuild',
  reindex: 'reindex',
  'patent-run': 'patent run',
  'grid-guide-task': 'grid guide',
  'scheme-research': 'scheme solve',
  'ppt-voice-build': 'slide narration',
  'mgplan-solve': 'planning solve',
  'tdmg-solve': 'AC-OPF solve',
  'dispatch-run': 'dispatch optimize',
  'loss-calc': 'line-loss calc',
  'modelica-sim': 'model simulation',
  'forecast-run': 'source-load forecast'
};

function readJson<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function ageMs(iso?: string) {
  if (!iso) return Number.POSITIVE_INFINITY;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return Number.POSITIVE_INFINITY;
  return Date.now() - time;
}

function jobLabel(type?: string) {
  if (!type) return '';
  return JOB_LABELS[type] || type;
}

function readPidFile(filePath: string) {
  try {
    const pid = Number(String(fs.readFileSync(filePath, 'utf8')).trim());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function readListenPid(port: number) {
  if (!Number.isFinite(port) || port <= 0) return undefined;
  try {
    const output = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2_500
    });
    const match = output.match(
      new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1?\\]|::):${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i')
    );
    const pid = match ? Number(match[1]) : NaN;
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function probeHttp(
  url: string,
  options?: { headers?: Record<string, string>; expectOk?: boolean }
): Promise<HttpProbe> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: options?.headers,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_MS)
    });
    const latencyMs = Date.now() - started;
    let json: Record<string, unknown> | undefined;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (parsed) json = parsed;
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
    const ok = options?.expectOk === false ? response.status > 0 : response.ok;
    return { reachable: true, ok, status: response.status, latencyMs, json };
  } catch (error) {
    return {
      reachable: false,
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function fileExists(filePath: string) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function venvPythonExists(venvDir: string) {
  return fileExists(path.join(venvDir, 'Scripts', 'python.exe'))
    || fileExists(path.join(venvDir, 'bin', 'python'));
}

function pptVoiceInstalled() {
  const tool = path.join(process.cwd(), 'tools', 'ppt-voice');
  const venv = path.join(process.cwd(), 'tools', 'ppt-voice-venv');
  const envPython = process.env.PPT_VOICE_PYTHON?.trim();
  return fileExists(tool) && Boolean(envPython || venvPythonExists(venv));
}

function mgplanInstalled() {
  return fileExists(resolveMgplanRoot());
}

function sidecarVenvInstalled(toolDir: string, venvName: string) {
  const tool = path.join(process.cwd(), 'tools', toolDir);
  const venv = path.join(process.cwd(), 'tools', venvName);
  return fileExists(tool) && venvPythonExists(venv);
}

function onDemandStatus(installed: boolean, busy: boolean, busyDetail: string, standbyDetail: string): Pick<RuntimeNode, 'status' | 'detail'> {
  if (busy) return { status: 'busy', detail: busyDetail };
  if (installed) return { status: 'standby', detail: standbyDetail };
  return { status: 'missing', detail: 'Not installed or path unavailable' };
}

function node(partial: Omit<RuntimeNode, 'status'> & { status: RuntimeStatus }): RuntimeNode {
  return partial;
}

function mergeLiveChildren(children: RuntimeChild[]): RuntimeNode[] {
  const groups = new Map<string, RuntimeChild[]>();
  for (const child of children) {
    const list = groups.get(child.id) || [];
    list.push(child);
    groups.set(child.id, list);
  }
  return [...groups.values()].map((list) => {
    const first = list[0]!;
    return node({
      id: first.id,
      name: first.name,
      kind: first.kind,
      status: 'busy',
      caption: first.caption,
      detail: list.length > 1 ? `${list.length} live processes` : `PID ${first.pid}`,
      pid: first.pid,
      jobType: first.jobType,
      since: first.startedAt
    });
  });
}

export async function collectRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  const pids = readJson<IntranetPids>(PIDS_PATH);
  const heartbeat = readJson<WorkerHeartbeat>(HEARTBEAT_PATH);
  const sidecar = readJson<SidecarFile>(SIDECAR_PATH);
  const runningJobs = await listJobs({ status: 'running', limit: 20 });
  const queuedJobs = await listJobs({ status: 'queued', limit: 20 });
  const busyTypes = new Set(runningJobs.map((job) => job.type));

  const role = process.env.AI4ES_ROLE || '';
  const split = process.env.AI4ES_SPLIT === '1' || role === 'api';
  const webPort = Number(pids?.ports?.web || process.env.PORT || 3000);
  const apiPort = Number(pids?.ports?.api || process.env.API_PORT || 4000);
  const gatewayUrl = sidecar?.gatewayUrl || `http://127.0.0.1:${process.env.LLM_GATEWAY_PORT || 4098}/v1`;
  const gatewayHealthUrl = gatewayUrl.replace(/\/v1\/?$/, '/health');
  const opencodeUrl = sidecar?.baseUrl || `http://127.0.0.1:${pids?.ports?.opencode || 4097}`;
  const modelicaUrl = process.env.OPENMODELICA_GATEWAY_URL?.trim() || 'http://127.0.0.1:18088';

  const opencodeHeaders = sidecar?.username && sidecar.password
    ? { Authorization: `Basic ${Buffer.from(`${sidecar.username}:${sidecar.password}`).toString('base64')}` }
    : undefined;

  const [webProbe, apiProbe, opencodeProbe, gatewayProbe, modelicaProbe] = await Promise.all([
    probeHttp(`http://127.0.0.1:${webPort}/healthz`),
    split && role === 'api'
      ? Promise.resolve<HttpProbe>({ reachable: true, ok: true, latencyMs: 0, status: 200 })
      : split
        ? probeHttp(`http://127.0.0.1:${apiPort}/api/health`)
        : Promise.resolve<HttpProbe>({ reachable: true, ok: true, latencyMs: 0, status: 200 }),
    sidecar?.baseUrl
      ? probeHttp(`${opencodeUrl.replace(/\/$/, '')}/global/health`, { headers: opencodeHeaders })
      : Promise.resolve<HttpProbe>({ reachable: false, ok: false, latencyMs: 0, error: '无 sidecar 状态' }),
    probeHttp(gatewayHealthUrl),
    probeHttp(`${modelicaUrl.replace(/\/$/, '')}/health`)
  ]);

  const webPid = pids?.web ?? undefined;
  const apiPid = role === 'api' ? process.pid : pids?.api ?? undefined;
  const webUp = webProbe.reachable || isPidAlive(webPid);
  const apiUp = apiProbe.ok || (!split && webUp);

  const workerPid = heartbeat?.pid || pids?.worker || undefined;
  const workerFresh = ageMs(heartbeat?.at) <= WORKER_STALE_MS;
  const workerAlive = isPidAlive(workerPid) || workerFresh;
  const workerBusy = (workerFresh && heartbeat?.status === 'running') || busyTypes.size > 0;
  const workerStatus: RuntimeStatus = !workerAlive
    ? 'down'
    : workerBusy
      ? 'busy'
      : 'up';
  const workerDetail = !workerAlive
    ? 'Process not found'
    : !workerFresh && isPidAlive(workerPid)
      ? 'Process is up, heartbeat is stale'
      : workerBusy
        ? `Running ${jobLabel(heartbeat?.jobType) || `${runningJobs.length} jobs`}`
        : queuedJobs.length
          ? `Idle, ${queuedJobs.length} queued`
          : 'Idle, polling the job queue';

  const opencodePid = sidecar?.pid;
  const opencodeUp = Boolean(opencodeProbe.json?.healthy ?? opencodeProbe.ok) && (isPidAlive(opencodePid) || opencodeProbe.ok);
  const gatewayPid = sidecar?.gatewayPid;
  const gatewayUp = gatewayProbe.ok && (isPidAlive(gatewayPid) || gatewayProbe.ok);
  const modelicaPort = Number(String(modelicaUrl).match(/:(\d+)/)?.[1] || 18088);
  const modelicaFilePid = readPidFile(MODELICA_PID_PATH);
  const modelicaListenPid = readListenPid(modelicaPort);
  const modelicaPid = (isPidAlive(modelicaListenPid) && modelicaListenPid)
    || (isPidAlive(modelicaFilePid) && modelicaFilePid)
    || undefined;
  const modelicaHealthOk = modelicaProbe.ok && modelicaProbe.json?.ok === true;
  const modelicaUp = modelicaHealthOk;
  const modelicaVersion = typeof modelicaProbe.json?.modelica === 'string' ? modelicaProbe.json.modelica : undefined;

  const ppt = onDemandStatus(
    pptVoiceInstalled(),
    busyTypes.has('ppt-voice-build'),
    'Rendering slide narration',
    'On-demand PPT narration sidecar'
  );
  const mgplan = onDemandStatus(
    mgplanInstalled(),
    busyTypes.has('mgplan-solve'),
    'Solving a planning model',
    'On-demand microgrid planning sidecar'
  );
  const esoptInstallation = inspectEsoptInstallation();
  const esopt = onDemandStatus(
    esoptInstallation.ready,
    busyTypes.has('scheme-research'),
    'Solving a DCOPF / LP / MIP model',
    esoptInstallation.detail
  );
  const pdf2md = onDemandStatus(
    Boolean(isPdf2mdAvailable()),
    busyTypes.has('data-import') || busyTypes.has('excel-ingest'),
    'Parsing source documents',
    'On-demand document parser'
  );
  const dispatch = onDemandStatus(
    sidecarVenvInstalled('power-dispatch', 'power-dispatch-venv'),
    busyTypes.has('dispatch-run'),
    'Solving a dispatch model',
    'On-demand power dispatch sidecar'
  );
  const loss = onDemandStatus(
    sidecarVenvInstalled('nwxs-loss', 'nwxs-loss-venv'),
    busyTypes.has('loss-calc'),
    'Calculating theoretical line loss',
    'On-demand line-loss sidecar'
  );
  const forecast = onDemandStatus(
    sidecarVenvInstalled('pv-wind-load-forecast', 'forecast-venv'),
    busyTypes.has('forecast-run'),
    'Running source-load forecast',
    'On-demand PV / wind / load forecast sidecar'
  );

  const nodes: RuntimeNode[] = [
    node({
      id: 'web',
      name: 'Web UI',
      kind: 'process',
      caption: 'Serves the dashboard',
      status: webUp ? 'up' : 'down',
      detail: webUp ? `UI process · :${webPort}` : `Unreachable :${webPort}`,
      pid: webPid,
      port: webPort,
      latencyMs: webProbe.reachable ? webProbe.latencyMs : undefined
    }),
    node({
      id: 'api',
      name: 'API Server',
      kind: 'process',
      caption: 'Handles application requests',
      status: apiUp ? 'up' : 'down',
      detail: apiUp
        ? split
          ? `Request process · :${apiPort}`
          : 'Embedded in the UI process'
        : `Unreachable :${apiPort}`,
      pid: apiPid,
      port: apiPort,
      latencyMs: apiProbe.ok ? apiProbe.latencyMs : undefined
    }),
    node({
      id: 'worker',
      name: 'Job Worker',
      kind: 'worker',
      caption: 'Runs background jobs',
      status: workerStatus,
      detail: workerDetail,
      pid: workerPid,
      jobType: heartbeat?.jobType,
      since: heartbeat?.at
    }),
    node({
      id: 'gateway',
      name: 'LLM Gateway',
      kind: 'gateway',
      caption: 'Proxies chat and image models',
      status: gatewayUp ? 'up' : 'down',
      detail: gatewayUp ? 'Proxies chat and image model calls' : 'Gateway not responding',
      pid: gatewayPid,
      port: Number(String(gatewayHealthUrl).match(/:(\d+)/)?.[1] || 4098),
      latencyMs: gatewayProbe.reachable ? gatewayProbe.latencyMs : undefined
    }),
    node({
      id: 'opencode',
      name: 'OpenCode Agent',
      kind: 'sidecar',
      caption: 'Knowledge-agent sidecar',
      status: opencodeUp ? 'up' : 'down',
      detail: opencodeUp
        ? `OpenCode agent${typeof opencodeProbe.json?.version === 'string' ? ` · v${opencodeProbe.json.version}` : ''}`
        : sidecar
          ? 'State file exists, health check failed'
          : 'OpenCode agent is not running',
      pid: opencodePid,
      port: Number(String(opencodeUrl).match(/:(\d+)/)?.[1] || 4097),
      latencyMs: opencodeProbe.reachable ? opencodeProbe.latencyMs : undefined,
      version: typeof opencodeProbe.json?.version === 'string' ? opencodeProbe.json.version : undefined,
      since: sidecar?.startedAt
    }),
    node({
      id: 'ppt-voice',
      name: 'PPT Voice Sidecar',
      kind: 'sidecar',
      caption: 'Builds slide narration audio',
      status: ppt.status,
      detail: ppt.detail,
      jobType: busyTypes.has('ppt-voice-build') ? 'ppt-voice-build' : undefined
    }),
    node({
      id: 'mgplan',
      name: 'MGPlan Sidecar',
      kind: 'sidecar',
      caption: 'Solves capacity-planning models',
      status: mgplan.status,
      detail: mgplan.detail,
      jobType: busyTypes.has('mgplan-solve') ? 'mgplan-solve' : undefined
    }),
    node({
      id: 'esopt',
      name: 'ESOPT Solver',
      kind: 'sidecar',
      caption: 'Runs DCOPF, LP and MIP models',
      status: esopt.status,
      detail: esopt.detail,
      jobType: busyTypes.has('scheme-research') ? 'scheme-research' : undefined
    }),
    node({
      id: 'pdf2md',
      name: 'PDF Parser',
      kind: 'sidecar',
      caption: 'Converts documents to Markdown',
      status: pdf2md.status,
      detail: pdf2md.detail,
      jobType: busyTypes.has('data-import') || busyTypes.has('excel-ingest') ? 'data-import' : undefined
    }),
    node({
      id: 'dispatch',
      name: 'Power Dispatch',
      kind: 'sidecar',
      caption: 'Optimizes power dispatch',
      status: dispatch.status,
      detail: dispatch.detail,
      jobType: busyTypes.has('dispatch-run') ? 'dispatch-run' : undefined
    }),
    node({
      id: 'loss',
      name: 'Line-Loss Sidecar',
      kind: 'sidecar',
      caption: 'Calculates theoretical line loss',
      status: loss.status,
      detail: loss.detail,
      jobType: busyTypes.has('loss-calc') ? 'loss-calc' : undefined
    }),
    node({
      id: 'forecast',
      name: 'Source-Load Forecast',
      kind: 'sidecar',
      caption: 'Forecasts PV, wind and load',
      status: forecast.status,
      detail: forecast.detail,
      jobType: busyTypes.has('forecast-run') ? 'forecast-run' : undefined
    }),
    node({
      id: 'modelica',
      name: 'OpenModelica Sidecar',
      kind: 'sidecar',
      caption: 'Runs physical model simulation',
      status: modelicaUp
        ? busyTypes.has('modelica-sim') ? 'busy' : 'standby'
        : 'missing',
      detail: modelicaUp
        ? busyTypes.has('modelica-sim')
          ? `Simulating · OpenModelica${modelicaVersion ? ` ${modelicaVersion}` : ''}`
          : `OpenModelica${modelicaVersion ? ` ${modelicaVersion}` : ''}${modelicaProbe.json?.ompython ? ' · OMPython' : ''} · :${modelicaPort}`
        : 'OpenModelica sidecar is not running',
      pid: modelicaPid,
      port: modelicaPort,
      version: modelicaVersion,
      jobType: busyTypes.has('modelica-sim') ? 'modelica-sim' : undefined,
      latencyMs: modelicaProbe.reachable ? modelicaProbe.latencyMs : undefined
    }),
    node({
      id: 'tdmg',
      name: 'TDMG AC-OPF Sidecar',
      kind: 'sidecar',
      caption: 'Solves AC-OPF dispatch models',
      status: busyTypes.has('tdmg-solve') ? 'busy' : 'standby',
      detail: busyTypes.has('tdmg-solve') ? 'Solving AC-OPF dispatch model' : 'On-demand sidecar',
      jobType: busyTypes.has('tdmg-solve') ? 'tdmg-solve' : undefined
    })
  ];

  const byId = new Map(nodes.map((item) => [item.id, item]));
  for (const child of mergeLiveChildren(listLiveRuntimeChildren())) {
    const existing = byId.get(child.id);
    if (existing) {
      existing.status = 'busy';
      existing.pid = child.pid;
      existing.detail = child.detail;
      existing.since = child.since;
      existing.jobType = child.jobType || existing.jobType;
      continue;
    }
    nodes.push(child);
  }

  return {
    updatedAt: new Date().toISOString(),
    mode: pids?.mode,
    split,
    nodes
  };
}
