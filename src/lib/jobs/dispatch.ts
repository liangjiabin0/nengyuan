import { enqueueJob, isJobQueueEnabled } from './queue';
import type { BackgroundJob, JobType } from './types';

export type EnqueueOrRunResult =
  | { mode: 'queued'; job: BackgroundJob }
  | { mode: 'inline'; result: unknown };

/**
 * When AI4ES_USE_JOB_QUEUE=1, enqueue and return the job.
 * Otherwise run the work inline in-process.
 */
export async function enqueueOrRun(
  type: JobType,
  payload: Record<string, unknown>,
  runInline: () => Promise<unknown>
): Promise<EnqueueOrRunResult> {
  if (isJobQueueEnabled()) {
    const job = await enqueueJob(type, payload);
    return { mode: 'queued', job };
  }
  const result = await runInline();
  return { mode: 'inline', result };
}
