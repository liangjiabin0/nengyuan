export type JobType =
  | 'data-import'
  | 'excel-ingest'
  | 'graph-rebuild'
  | 'reindex'
  | 'patent-run'
  | 'grid-guide-task'
  | 'scheme-research'
  | 'ppt-voice-build'
  | 'mgplan-solve'
  | 'tdmg-solve'
  | 'dispatch-run'
  | 'loss-calc'
  | 'modelica-sim'
  | 'forecast-run'
  | 'journal-watch'
  | 'paper-review';

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export type BackgroundJob = {
  id: string;
  type: JobType;
  status: JobStatus;
  payload: Record<string, unknown>;
  progress: Record<string, unknown> | null;
  result: unknown;
  error: string | null;
  attempt: number;
  maxAttempts: number;
  availableAt: string | null;
  lockedBy: string | null;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const SERIAL_JOB_TYPES: ReadonlySet<JobType> = new Set([
  'data-import',
  'excel-ingest',
  'graph-rebuild',
  'reindex',
  'journal-watch'
]);

export const EXCLUSIVE_CLAIM_JOB_TYPES: ReadonlySet<JobType> = new Set([
  ...SERIAL_JOB_TYPES,
  'mgplan-solve',
  'tdmg-solve',
  'dispatch-run',
  'loss-calc',
  'modelica-sim',
  'forecast-run',
  'scheme-research'
]);
