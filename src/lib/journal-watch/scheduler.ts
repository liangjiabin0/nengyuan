import { get } from '../db';
import { enqueueJob, hasActiveSerialJob } from '../jobs/queue';

const CHECK_INTERVAL_MS = 20 * 60 * 1000;
const RETRY_AFTER_MS = 2 * 60 * 60 * 1000;

type SchedulerState = { started: boolean; timer?: ReturnType<typeof setInterval> };

function schedulerState(): SchedulerState {
  const store = globalThis as typeof globalThis & { __journalWatchScheduler?: SchedulerState };
  store.__journalWatchScheduler ??= { started: false };
  return store.__journalWatchScheduler;
}

export function isJournalWatchEnabled() {
  return process.env.JOURNAL_WATCH_ENABLED !== '0';
}

/** 每天到点（默认凌晨 3 点，本地时间）排一次期刊追踪任务；失败的 2 小时后重试。 */
async function tick() {
  if (!isJournalWatchEnabled()) return;
  const hour = Number(process.env.JOURNAL_WATCH_HOUR ?? 3);
  const now = new Date();
  if (now.getHours() < (Number.isFinite(hour) ? hour : 3)) return;
  if (await hasActiveSerialJob('journal-watch')) return;
  const today = now.toLocaleDateString('sv-SE');
  const last = await get<{ status: string; started_at: string }>(
    `SELECT status, started_at FROM journal_watch_runs ORDER BY started_at DESC LIMIT 1`
  );
  if (last) {
    const startedAt = new Date(last.started_at);
    const sameDay = startedAt.toLocaleDateString('sv-SE') === today;
    if (sameDay && last.status === 'done') return;
    if (Date.now() - startedAt.getTime() < RETRY_AFTER_MS) return;
  }
  const job = await enqueueJob('journal-watch', { trigger: 'schedule' });
  console.log(`[journal-watch] scheduled daily run job=${job.id}`);
}

export function startJournalWatchScheduler() {
  const state = schedulerState();
  if (state.started) return;
  state.started = true;
  const run = () => {
    void tick().catch((error) => console.error('[journal-watch] scheduler failed', error));
  };
  const boot = setTimeout(run, 60_000);
  if (typeof boot.unref === 'function') boot.unref();
  state.timer = setInterval(run, CHECK_INTERVAL_MS);
  if (typeof state.timer.unref === 'function') state.timer.unref();
}
