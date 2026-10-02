import type { RuntimeAgentStep } from './types';
import {
  extractTaskChildSessionIds,
  isTaskToolName,
  publicTaskInput,
  taskNodeIdFromInput,
  taskResultPublicText,
  taskStatusFromOpenCodeOutput
} from './chat-subagents';

function isTaskStep(step: RuntimeAgentStep) {
  return isTaskToolName(step.tool);
}

export function sanitizeTaskObservation(content: string) {
  const raw = String(content || '').trim();
  // Persist only the explicit public tag body, never surrounding tool output.
  if (/<task_(?:result|error)>/i.test(raw)) {
    const tag = /<task_error>/i.test(raw) ? 'task_error' : 'task_result';
    const failed = tag === 'task_error' || taskStatusFromOpenCodeOutput(raw) === 'failed';
    const state = failed ? 'error' : 'completed';
    const sessionId = extractTaskChildSessionIds(undefined, raw)[0];
    const text = taskResultPublicText(raw);
    const id = sessionId ? ` id="${sessionId}"` : '';
    return `<task${id} state="${state}"><${tag}>${text}</${tag}></task>`;
  }

  const failed = /^工具执行失败/u.test(raw)
    || /\b(?:error|failed|cancelled|canceled|aborted)\b/iu.test(raw);
  return failed ? '子代理执行失败' : '子代理已结束';
}

/** Strip private task orchestration fields before a step crosses the server boundary. */
export function sanitizeAgentStepForClient(step: RuntimeAgentStep): RuntimeAgentStep {
  if (!isTaskStep(step)) return { ...step };

  const input = publicTaskInput(step.input);
  const nodeId = taskNodeIdFromInput(input);
  const sanitized: RuntimeAgentStep = {
    ...step,
    nodeId,
    ...(input ? { input } : {})
  };
  if (!input) delete sanitized.input;
  if (step.type === 'tool_call') {
    sanitized.content = nodeId === 'task' ? '已派子代理' : `已派子代理：${nodeId}`;
  } else if (step.type === 'observation') {
    sanitized.content = sanitizeTaskObservation(step.content);
  }
  return sanitized;
}

function sanitizePersistedStep(step: RuntimeAgentStep): RuntimeAgentStep | null {
  // Model reasoning is ephemeral UI state. It must never enter chat history.
  if (step.type === 'thought' || step.type === 'plan' || step.type === 'synthesis') return null;
  // Ordinary observations are raw tool output and are not rendered after a turn.
  if (step.type === 'observation' && !isTaskStep(step)) return null;

  const sanitized = sanitizeAgentStepForClient(step);
  delete sanitized.input;
  if (isTaskStep(step)) {
    const input = publicTaskInput(step.input);
    if (input) sanitized.input = input;
  } else if (step.type === 'tool_call') {
    sanitized.content = step.tool ? `调用 ${step.tool}` : '调用工具';
  }
  return sanitized;
}

/** Keep only user-safe execution summaries in persisted history and API reads. */
export function sanitizePersistedAgentSteps(steps?: readonly unknown[]) {
  return (steps || [])
    .filter((step): step is RuntimeAgentStep => (
      Boolean(step)
      && typeof step === 'object'
      && typeof (step as Partial<RuntimeAgentStep>).type === 'string'
      && typeof (step as Partial<RuntimeAgentStep>).step === 'number'
      && typeof (step as Partial<RuntimeAgentStep>).content === 'string'
    ))
    .map(sanitizePersistedStep)
    .filter((step): step is RuntimeAgentStep => Boolean(step));
}
