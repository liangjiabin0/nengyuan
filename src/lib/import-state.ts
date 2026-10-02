import fs from 'node:fs';
import path from 'node:path';

export type ImportPhase =
  | 'idle'
  | 'preparing'
  | 'converting'
  | 'papers'
  | 'patents'
  | 'books'
  | 'funds'
  | 'nkrd'
  | 'mentors'
  | 'indexing'
  | 'done'
  | 'error';

export type ImportJobState = {
  status: 'idle' | 'running' | 'done' | 'error';
  phase: ImportPhase;
  message: string;
  rootDir: string;
  progress: { current: number; total: number };
  startedAt: string | null;
  updatedAt: string;
  result?: unknown;
  error?: string;
};

const statePath = path.join(process.cwd(), 'storage', 'import-job.json');

const defaultState = (): ImportJobState => ({
  status: 'idle',
  phase: 'idle',
  message: '',
  rootDir: '',
  progress: { current: 0, total: 0 },
  startedAt: null,
  updatedAt: new Date().toISOString()
});

let memoryState: ImportJobState = defaultState();
let activeJob: Promise<unknown> | null = null;

function persist(state: ImportJobState) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function loadPersisted(): ImportJobState | null {
  try {
    if (!fs.existsSync(statePath)) return null;
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as ImportJobState;
  } catch {
    return null;
  }
}

export function getImportJobState(): ImportJobState {
  if (memoryState.status !== 'idle') return memoryState;
  return loadPersisted() || memoryState;
}

export function updateImportJobState(patch: Partial<ImportJobState>) {
  memoryState = {
    ...memoryState,
    ...patch,
    progress: patch.progress ? { ...memoryState.progress, ...patch.progress } : memoryState.progress,
    updatedAt: new Date().toISOString()
  };
  persist(memoryState);
  return memoryState;
}

export function resetImportJobState() {
  memoryState = defaultState();
  persist(memoryState);
  return memoryState;
}

export function isImportJobRunning() {
  return Boolean(activeJob) || getImportJobState().status === 'running';
}

export function setActiveImportJob(job: Promise<unknown> | null) {
  activeJob = job;
}

export function getActiveImportJob() {
  return activeJob;
}
