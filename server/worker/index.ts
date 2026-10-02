/**
 * AI4ES background worker — consumes PostgreSQL background_jobs.
 * Nested handlers must run inline (do not re-enqueue).
 *
 * 【重建】按 dist/runtime/worker-app.mjs 中的线上版本还原（异步 PostgreSQL 队列、可取消任务）。
 */
export {};

async function main() {
  const { loadProjectEnv } = await import('../../src/lib/load-env');
  loadProjectEnv();

  process.env.AI4ES_ROLE = 'worker';
  delete process.env.AI4ES_USE_JOB_QUEUE;
  process.env.AI4ES_USE_JOB_QUEUE = '0';

  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { ensureDb } = await import('../../src/lib/db');
  const { cancelJob, claimNextJob, failJob, finishJob, recoverStaleJobs } = await import('../../src/lib/jobs/queue');
  const { executeJob } = await import('../../src/lib/jobs/handlers');

  const WORKER_ID = process.env.WORKER_ID || `${os.hostname()}-${process.pid}`;
  const POLL_MS = Number(process.env.AI4ES_WORKER_POLL_MS || 1000);
  const HEARTBEAT_PATH = path.join(process.cwd(), 'storage', 'worker-heartbeat.json');

  let stopping = false;

  function writeHeartbeat(extra: Record<string, unknown> = {}) {
    try {
      fs.mkdirSync(path.dirname(HEARTBEAT_PATH), { recursive: true });
      fs.writeFileSync(
        HEARTBEAT_PATH,
        JSON.stringify(
          {
            workerId: WORKER_ID,
            role: 'worker',
            at: new Date().toISOString(),
            pid: process.pid,
            ...extra
          },
          null,
          2
        ),
        'utf8'
      );
    } catch (error) {
      console.warn('[ai4es-worker] heartbeat write failed:', error);
    }
  }

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function shutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    console.log(`[ai4es-worker] shutting down (${signal})`);
    writeHeartbeat({ status: 'stopping' });
    setTimeout(() => process.exit(0), 500);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await ensureDb();
  const { startChatWorkspaceRetentionScheduler } = await import('../../src/lib/chat-workspace-retention');
  startChatWorkspaceRetentionScheduler();
  console.log(
    `[ai4es-worker] started id=${WORKER_ID} role=${process.env.AI4ES_ROLE} queue=${process.env.AI4ES_USE_JOB_QUEUE}`
  );
  writeHeartbeat({ status: 'idle' });

  while (!stopping) {
    try {
      await recoverStaleJobs();
      const job = await claimNextJob(WORKER_ID);
      if (!job) {
        writeHeartbeat({ status: 'idle' });
        await sleep(POLL_MS);
        continue;
      }

      console.log(`[ai4es-worker] claim ${job.type} id=${job.id}`);
      writeHeartbeat({ status: 'running', jobId: job.id, jobType: job.type });
      try {
        const result = await executeJob(job);
        await finishJob(job.id, result);
        console.log(`[ai4es-worker] done ${job.type} id=${job.id}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 用户取消的任务标记为 cancelled，其余按失败处理（failJob 会决定重试还是终止）
        if (error instanceof Error && (error.name === 'AbortError' || /取消|aborted/i.test(message))) {
          await cancelJob(job.id);
          console.warn(`[ai4es-worker] cancelled ${job.type} id=${job.id}:`, message);
        } else {
          const outcome = await failJob(job.id, message);
          console.error(`[ai4es-worker] ${outcome} ${job.type} id=${job.id}:`, message);
        }
      }
    } catch (error) {
      console.error('[ai4es-worker] loop error:', error);
      await sleep(POLL_MS);
    }
  }
}

main().catch((error) => {
  console.error('[ai4es-worker] fatal:', error);
  process.exit(1);
});
