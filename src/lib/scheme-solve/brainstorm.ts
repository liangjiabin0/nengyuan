import { runSchemeBrainstorm } from '@/lib/opencode/scheme-solve';
import type { RuntimeAgentStep } from '@/lib/opencode/types';
import { formatRuntimeStep } from './agent-trace';
import { listReadySchemeSolveAttachmentRows } from './attachments';
import { parseBrainstormPayload } from './parse-brainstorm';
import {
  appendSchemeEvent,
  getSchemeSession,
  replaceBrainstormTree,
  setSchemeSessionProgress,
  setSchemeSessionStatus
} from './store';
import { prepareSchemeSessionWorkspace } from './workspace';

export async function runSchemeBrainstormJob(
  sessionId: string,
  hooks?: {
    onStatus?: (detail: string) => void;
    onStep?: (step: RuntimeAgentStep) => void | Promise<void>;
    signal?: AbortSignal;
  }
) {
  const session = await getSchemeSession(sessionId);
  if (!session) throw new Error('方案不存在。');
  await setSchemeSessionStatus(sessionId, 'brainstorming', {
    progress: 4,
    detail: '正在启动头脑风暴',
    error: null
  });
  await appendSchemeEvent({ sessionId, stage: 'brainstorm', text: '启动 scheme-brainstorm（大模型）' });

  const rows = await listReadySchemeSolveAttachmentRows(sessionId);
  const { workingDirectory, attachmentPaths } = prepareSchemeSessionWorkspace(
    sessionId,
    session.seedIdea,
    rows,
    (status) => {
      void setSchemeSessionProgress(sessionId, 8, status.detail);
      hooks?.onStatus?.(status.detail);
    }
  );

  const pendingThoughts = new Map<number, string>();
  const flushedThoughts = new Set<number>();
  const flushedTools = new Set<string>();

  const persistStep = async (step: RuntimeAgentStep) => {
    const formatted = formatRuntimeStep(step);
    if (!formatted) return;
    if (step.type === 'thought' || step.type === 'plan' || step.type === 'public_text') {
      pendingThoughts.set(step.step, formatted.stored.content);
      return;
    }
    const key = `${step.type}:${step.step}:${step.tool || ''}`;
    if (flushedTools.has(key)) return;
    flushedTools.add(key);
    await appendSchemeEvent({
      sessionId,
      stage: 'brainstorm',
      level: 'info',
      text: formatted.eventText
    });
  };

  const flushThoughts = async (exclude = '') => {
    const skip = exclude.trim();
    for (const [step, text] of pendingThoughts) {
      if (flushedThoughts.has(step) || !text || text === skip) continue;
      flushedThoughts.add(step);
      await appendSchemeEvent({ sessionId, stage: 'brainstorm', level: 'thought', text: `[thought] ${text}` });
    }
  };

  const result = await runSchemeBrainstorm({
    seedIdea: session.seedIdea,
    hooks: {
      workingDirectory,
      conversationId: `scheme-brainstorm:${sessionId}`,
      attachmentPaths,
      onStatus: async ({ detail }) => {
        await setSchemeSessionProgress(sessionId, 12, detail);
        hooks?.onStatus?.(detail);
        if (/ses_[A-Za-z0-9]+/.test(detail)) {
          await appendSchemeEvent({ sessionId, stage: 'brainstorm', text: detail });
        }
      },
      onStep: async (step) => {
        await persistStep(step);
        if (step.type === 'tool_call' || step.type === 'observation') await flushThoughts();
        await hooks?.onStep?.(step);
      },
      signal: hooks?.signal
    }
  });

  for (const step of result.steps || []) await persistStep(step);

  if (result.answer.trim()) {
    await appendSchemeEvent({
      sessionId,
      stage: 'brainstorm',
      level: 'output',
      text: result.answer.trim().slice(0, 4000)
    });
  }
  const payload = parseBrainstormPayload(result.answer);
  await replaceBrainstormTree(sessionId, payload);
  await flushThoughts(result.answer);
  await appendSchemeEvent({
    sessionId,
    stage: 'brainstorm',
    text: `形成 ${payload.ideas.length} 条可研究想法，${payload.rejected.length} 条不可研究`
  });
  return payload;
}
