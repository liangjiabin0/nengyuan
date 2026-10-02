import {
  appendPatentRunEvent,
  claimPatentRun,
  finishPatentRun,
  getPatentRun,
  heartbeatPatentRun,
  recoverStalePatentRuns
} from './run-store';
import { runPatentPipeline } from './pipeline';

type ActiveTask = {
  controller: AbortController;
  promise: Promise<void>;
};

const globalTasks = globalThis as typeof globalThis & {
  __patentGenerationTasks?: Map<string, ActiveTask>;
};

const tasks = globalTasks.__patentGenerationTasks || new Map<string, ActiveTask>();
globalTasks.__patentGenerationTasks = tasks;

function abortError(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || /取消|aborted/i.test(error.message));
}

function startPatentHeartbeat(runId: string, controller: AbortController) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      const run = await getPatentRun(runId);
      if (run?.cancelRequested) {
        controller.abort(new DOMException('用户取消专利生成', 'AbortError'));
        return;
      }
      await heartbeatPatentRun(runId);
    })()
      .catch((error) => console.error('[patent] heartbeat failed', error))
      .finally(() => { running = false; });
  }, 5_000);
  return () => clearInterval(timer);
}

export async function startPatentRun(runId: string, projectId: string) {
  const existing = tasks.get(runId);
  if (existing) return existing.promise;

  await recoverStalePatentRuns();
  if (!await claimPatentRun(runId)) return Promise.resolve();

  const controller = new AbortController();
  const promise = (async () => {
    const stopHeartbeat = startPatentHeartbeat(runId, controller);
    try {
      const project = await runPatentPipeline(
        projectId,
        async (event) => await appendPatentRunEvent(runId, event),
        { signal: controller.signal }
      );
      if (project.status === 'needs_input') {
        await finishPatentRun(runId, 'needs_input', {
          stage: 'questions',
          detail: '请补充必要信息后继续生成'
        });
      } else if (project.status === 'review_required') {
        await finishPatentRun(runId, 'review_required', {
          stage: 'ready',
          detail: project.error || '草稿已生成，仍需人工复核',
          error: project.error
        });
      } else {
        await finishPatentRun(runId, 'completed', {
          stage: 'ready',
          detail: '专利申请草稿已生成并通过自动检查'
        });
      }
    } catch (error) {
      if (controller.signal.aborted || abortError(error)) {
        await finishPatentRun(runId, 'cancelled', {
          detail: '生成已取消，可从检查点重新开始'
        });
      } else {
        const message = error instanceof Error ? error.message : '专利生成失败。';
        await finishPatentRun(runId, 'failed', {
          stage: 'failed',
          detail: '生成失败',
          error: message
        });
      }
      throw error;
    } finally {
      stopHeartbeat();
      tasks.delete(runId);
    }
  })();
  tasks.set(runId, { controller, promise });
  return promise;
}

export async function cancelPatentRun(runId: string) {
  const task = tasks.get(runId);
  if (task) task.controller.abort(new DOMException('用户取消专利生成', 'AbortError'));
  const run = await getPatentRun(runId);
  return Boolean(task || run?.cancelRequested);
}

export function isPatentRunActive(runId: string) {
  return tasks.has(runId);
}
