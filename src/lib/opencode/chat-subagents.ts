import { parseChatModelId, type ChatModelId } from '../model-ids';
import type { ChatReproProgress, ChatReproStage } from './chat-repro-types';
import { sortRuntimeAgentSteps } from './agent-step-order';
import type { AgentStepOrigin, RuntimeAgentStep } from './types';

export type ChatAgentNode = {
  nodeId: string;
  title: string;
  sessionId?: string;
  parentToolCallId?: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'stopped';
  durationMs?: number;
  /** 子会话实际用的模型与思考档，由 Gateway 回报后写进 task 步骤的公开 input。 */
  model?: ChatModelId;
  thinking?: string;
};

export type ChatAgentNodeOptions = {
  /** When the parent turn is no longer live, leftover running nodes show as stopped. */
  parentActive?: boolean;
};

export function stopRunningChatAgentNodes(nodes: ChatAgentNode[]): ChatAgentNode[] {
  return nodes.map((node) => (node.status === 'running' ? { ...node, status: 'stopped' } : node));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isTaskToolName(tool?: string) {
  return tool === 'task' || tool === 'subtask';
}

/** Task inputs are account-visible runtime data and remain intact in the transcript. */
export function publicTaskInput(input?: Record<string, unknown>) {
  if (!input) return undefined;
  return { ...input };
}

type ChatAgentIdentity = Pick<ChatAgentNode, 'nodeId' | 'title' | 'sessionId' | 'parentToolCallId'>;

function normalizedPublicTextKey(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function uniquePublicTexts(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizedPublicTextKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function weakIdentityValues(identity: Partial<ChatAgentIdentity>) {
  return [...new Set([identity.nodeId, identity.title]
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean))];
}

function hasWeakIdentityMatch(left: Partial<ChatAgentIdentity>, right: Partial<ChatAgentIdentity>) {
  const rightValues = new Set(weakIdentityValues(right));
  return weakIdentityValues(left).some((value) => rightValues.has(value));
}

function hasStrongIdentityConflict(left: Partial<ChatAgentIdentity>, right: Partial<ChatAgentIdentity>) {
  if (
    left.parentToolCallId
    && right.parentToolCallId
    && left.parentToolCallId !== right.parentToolCallId
  ) return true;
  if (left.sessionId && right.sessionId && left.sessionId !== right.sessionId) return true;
  return false;
}

/** Match stable runtime IDs first. Human-readable labels are safe only when unambiguous. */
function matchingNodeIndex(nodes: ChatAgentNode[], target: Partial<ChatAgentIdentity>) {
  if (target.parentToolCallId) {
    const byCall = nodes.findIndex((node) => node.parentToolCallId === target.parentToolCallId);
    if (byCall >= 0) return byCall;
  }
  if (target.sessionId) {
    const bySession = nodes.findIndex((node) => (
      node.sessionId === target.sessionId
      && !hasStrongIdentityConflict(node, target)
    ));
    if (bySession >= 0) return bySession;
  }
  const weakMatches = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => (
      !hasStrongIdentityConflict(node, target)
      && hasWeakIdentityMatch(node, target)
    ));
  return weakMatches.length === 1 ? weakMatches[0]!.index : -1;
}

function mergeStrongNodeAliases(
  nodes: ChatAgentNode[],
  primaryIndex: number,
  identity: Partial<ChatAgentIdentity>
) {
  if (primaryIndex < 0 || !identity.parentToolCallId || !identity.sessionId) return;
  const aliases = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node, index }) => index !== primaryIndex && (
      (
        node.parentToolCallId === identity.parentToolCallId
        && (!node.sessionId || node.sessionId === identity.sessionId)
      )
      || (
        node.sessionId === identity.sessionId
        && (!node.parentToolCallId || node.parentToolCallId === identity.parentToolCallId)
      )
    ));
  if (!aliases.length) return;

  let primary = nodes[primaryIndex]!;
  for (const { node } of aliases) {
    const aliasIsTerminal = node.status === 'done' || node.status === 'failed';
    const primaryIsTerminal = primary.status === 'done' || primary.status === 'failed';
    primary = {
      ...node,
      ...primary,
      sessionId: primary.sessionId || node.sessionId,
      parentToolCallId: primary.parentToolCallId || node.parentToolCallId,
      durationMs: primary.durationMs ?? node.durationMs,
      status: primaryIsTerminal || !aliasIsTerminal ? primary.status : node.status
    };
  }
  nodes[primaryIndex] = primary;
  for (const { index } of aliases.sort((left, right) => right.index - left.index)) {
    nodes.splice(index, 1);
  }
}

const OPENCODE_TASK_FAIL_STATES = new Set(['error', 'failed', 'cancelled', 'canceled', 'aborted']);

function taskTaggedContent(content?: string) {
  const raw = String(content || '');
  for (const tag of ['task_result', 'task_error'] as const) {
    const opening = new RegExp(`<${tag}>`, 'i').exec(raw);
    const closingAt = raw.toLowerCase().lastIndexOf(`</${tag}>`);
    if (!opening) continue;
    const contentEnd = closingAt >= opening.index + opening[0].length ? closingAt : raw.length;
    return raw
      .slice(opening.index + opening[0].length, contentEnd)
      .replace(/<\/?task_(?:result|error)>/gi, '')
      .trim();
  }
  return '';
}

export function taskResultText(content?: string) {
  const raw = String(content || '');
  const tagged = taskTaggedContent(raw);
  if (/<task_(?:result|error)>/i.test(raw)) return tagged.replace(/\s+/g, ' ').trim();
  return raw.replace(/<\/?task\b[^>]*>/gi, '').replace(/\s+/g, ' ').trim();
}

export function taskResultPublicText(content?: string) {
  const raw = String(content || '');
  if (!/<task_(?:result|error)>/i.test(raw)) return '';
  const tagged = taskTaggedContent(raw);
  return tagged
    .replace(/\r\n?/g, '\n')
    .trim();
}

/** OpenCode copies only the child's last public text part into task_result. */
export function isEmptyTaskResult(content?: string) {
  const raw = String(content || '');
  if (!raw.trim()) return true;
  if (raw.startsWith('工具执行失败：')) return false;
  if (!/<task\b/i.test(raw)) return !raw.trim();
  return !taskResultText(raw);
}

export function salvageChildTranscript(
  steps: RuntimeAgentStep[],
  parentToolCallId?: string,
  childSessionId?: string
) {
  const related = steps.filter((step) => {
    if (isTaskToolName(step.tool)) return false;
    if (parentToolCallId && step.parentToolCallId === parentToolCallId) return true;
    if (childSessionId && step.sessionId === childSessionId) return true;
    return false;
  });
  const publicText = related
    .filter((step) => step.type === 'public_text')
    .map((step) => String(step.content || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  if (publicText) return publicText.slice(0, 1200);
  const toolSummary = related
    .filter((step) => step.type === 'tool_call')
    .map((step) => String(step.content || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-8)
    .join('\n');
  return toolSummary.slice(0, 1200);
}

/** Recover only user-visible child/task output; internal thought is never answer material. */
export function salvagePublicAgentResult(steps: RuntimeAgentStep[], parentSessionId: string) {
  const taskResults = steps
    .filter((step) => (
      step.type === 'observation'
      && isTaskToolName(step.tool)
      && isParentSessionStep(step, parentSessionId)
    ))
    .map((step) => taskResultPublicText(step.content))
    .filter((text) => text && !text.startsWith('子代理已结束，但没有返回公开文本'));
  const childText = steps
    .filter((step) => (
      step.type === 'public_text'
      && Boolean(step.sessionId)
      && step.sessionId !== parentSessionId
    ))
    .map((step) => String(step.content || '').trim())
    .filter(Boolean);
  const unique = uniquePublicTexts([...taskResults, ...childText]);
  return unique.join('\n\n').trim().slice(0, 8_000);
}

export function enrichEmptyTaskOutput(output: string, salvage = '') {
  const body = [
    '子代理已结束，但没有返回公开文本。思考过程不算 <task_result>，请视为失败。',
    salvage ? `子代理过程摘录：\n${salvage}` : ''
  ].filter(Boolean).join('\n\n');
  if (/<task\b/i.test(output)) {
    return output
      .replace(/\bstate\s*=\s*["']completed["']/i, 'state="error"')
      .replace(/<task_result>\s*<\/task_result>/i, `<task_result>\n${body}\n</task_result>`);
  }
  const sessionId = extractTaskChildSessionIds(undefined, output)[0] || '';
  return `<task id="${sessionId}" state="error"><task_result>\n${body}\n</task_result></task>`;
}

/** Prefer OpenCode's `<task state="...">`. Empty completed results are failures. */
export function taskStatusFromOpenCodeOutput(content?: string): ChatAgentNode['status'] {
  const raw = String(content || '');
  if (raw.startsWith('工具执行失败：') || raw.startsWith('子代理执行失败')) return 'failed';
  if (/<task_error>/i.test(raw)) return 'failed';
  const match = raw.match(/<task\b[^>]*\bstate\s*=\s*["']([^"']+)["']/i);
  if (match && OPENCODE_TASK_FAIL_STATES.has(match[1].toLowerCase())) return 'failed';
  if (isEmptyTaskResult(raw)) return 'failed';
  return 'done';
}

export function taskNodeIdFromInput(input?: Record<string, unknown>) {
  const record = publicTaskInput(input) || {};
  const raw = String(
    record.description || record.name || record.title || ''
  ).replace(/\s+/g, ' ').trim();
  return raw.slice(0, 80) || 'task';
}

export function taskTitleFromInput(input?: Record<string, unknown>) {
  return taskNodeIdFromInput(input);
}

/** 档位是标注信息，不参与节点身份匹配，所以单独取，不混进 title / nodeId。 */
export function taskTierFromInput(input?: Record<string, unknown>) {
  const model = parseChatModelId(input?.model);
  const thinking = String(input?.thinking || '').trim().toLowerCase();
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {})
  };
}

export function extractTaskChildSessionIds(
  _input?: Record<string, unknown>,
  output?: string,
  metadata?: Record<string, unknown>
) {
  const ids = new Set<string>();
  const sessionIdPattern = /ses_[A-Za-z0-9_-]+/g;
  const rawOutput = String(output || '');
  for (const match of rawOutput.matchAll(
    /<task\b[^>]*\b(?:id|session(?:id)?)\s*=\s*["']?(ses_[A-Za-z0-9_-]+)["']?/gi
  )) {
    ids.add(match[1]);
  }

  const visitMetadata = (value: unknown, key = '') => {
    if (typeof value === 'string') {
      if (!/session/i.test(key)) return;
      for (const match of value.matchAll(sessionIdPattern)) ids.add(match[0]);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visitMetadata(item, key);
      return;
    }
    for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      visitMetadata(nestedValue, nestedKey);
    }
  };
  visitMetadata(metadata);
  return [...ids];
}

export function originFromTask(
  parentSessionId: string,
  toolCallId: string,
  input?: Record<string, unknown>
): AgentStepOrigin {
  return {
    sessionId: parentSessionId,
    nodeId: taskNodeIdFromInput(input),
    parentToolCallId: toolCallId
  };
}

export function withStepOrigin(step: RuntimeAgentStep, origin?: AgentStepOrigin): RuntimeAgentStep {
  if (!origin) return step;
  return {
    ...step,
    ...(origin.sessionId ? { sessionId: origin.sessionId } : {}),
    ...(origin.nodeId ? { nodeId: origin.nodeId } : {}),
    ...(origin.parentToolCallId ? { parentToolCallId: origin.parentToolCallId } : {})
  };
}

export function isParentSessionStep(
  step: Pick<RuntimeAgentStep, 'sessionId' | 'parentToolCallId' | 'tool'>,
  parentSessionId?: string
) {
  if (step.parentToolCallId && !isTaskToolName(step.tool)) return false;
  if (step.sessionId && parentSessionId && step.sessionId !== parentSessionId) return false;
  if (!step.sessionId || !parentSessionId) return !step.sessionId || step.sessionId === parentSessionId;
  return step.sessionId === parentSessionId;
}

export function parentOnlySteps(steps: RuntimeAgentStep[], parentSessionId?: string) {
  const ordered = sortRuntimeAgentSteps(steps);
  const parentId = parentSessionId || inferParentSessionId(ordered);
  const nodes = collectChatAgentNodes(ordered, parentId);
  return ordered.filter((step) => {
    if (!isParentSessionStep(step, parentId)) return false;
    if (step.sessionId || step.parentToolCallId || !step.nodeId) return true;
    return nodes.filter((node) => hasWeakIdentityMatch(node, {
      nodeId: step.nodeId,
      title: step.nodeId
    })).length === 0;
  });
}

/**
 * Provisional final reply = parent public text after the last tool call.
 * Same boundary as the server's final answer, applied while the turn is still live.
 * Child text and reasoning stay in `chain`.
 */
export function splitTrailingPublicAnswer(steps: RuntimeAgentStep[], parentSessionId?: string) {
  const ordered = sortRuntimeAgentSteps(steps);
  const parent = parentOnlySteps(ordered, parentSessionId);
  let lastToolIndex = -1;
  for (let index = 0; index < parent.length; index += 1) {
    if (parent[index]?.type === 'tool_call') lastToolIndex = index;
  }
  const trailing = parent.slice(lastToolIndex + 1).filter((step) => (
    step.type === 'public_text' && String(step.content || '').trim()
  ));
  const trailingSet = new Set(trailing);
  return {
    chain: ordered.filter((step) => !trailingSet.has(step)),
    answer: trailing.map((step) => String(step.content || '')).join('')
  };
}

export function inferParentSessionId(steps: RuntimeAgentStep[]) {
  const task = steps.find((step) => isTaskToolName(step.tool) && step.type === 'tool_call' && step.sessionId);
  if (task?.sessionId) return task.sessionId;
  const first = steps.find((step) => step.sessionId && !step.parentToolCallId);
  return first?.sessionId;
}

function identityMatchesNode(
  node: Partial<ChatAgentIdentity>,
  identity: Partial<ChatAgentIdentity>,
  allNodes: ChatAgentNode[]
) {
  if (node.parentToolCallId && identity.parentToolCallId) {
    return node.parentToolCallId === identity.parentToolCallId;
  }
  if (node.sessionId && identity.sessionId) {
    return node.sessionId === identity.sessionId;
  }
  if (hasStrongIdentityConflict(node, identity) || !hasWeakIdentityMatch(node, identity)) {
    return false;
  }
  return allNodes.filter((candidate) => hasWeakIdentityMatch(candidate, identity)).length === 1;
}

export function stepsForNode(
  steps: RuntimeAgentStep[],
  node: Pick<ChatAgentNode, 'nodeId' | 'sessionId' | 'parentToolCallId'>,
  parentSessionId?: string
) {
  const ordered = sortRuntimeAgentSteps(steps);
  const parentId = parentSessionId || inferParentSessionId(ordered);
  const allNodes = collectChatAgentNodes(ordered, parentId);
  return ordered.filter((step) => {
    if (isTaskToolName(step.tool)) {
      if (isParentSessionStep(step, parentId)) return false;
      return Boolean(node.sessionId && step.sessionId === node.sessionId);
    }
    if (parentId && step.sessionId === parentId) return false;
    return identityMatchesNode(node, {
      nodeId: step.nodeId,
      title: step.nodeId,
      sessionId: step.sessionId,
      parentToolCallId: step.parentToolCallId
    }, allNodes);
  });
}

/** Resolve the public result displayed in a child-agent detail panel. */
export function publicResultForNode(
  steps: RuntimeAgentStep[],
  node: Pick<ChatAgentNode, 'nodeId' | 'sessionId' | 'parentToolCallId'>,
  parentSessionId?: string
) {
  const ordered = sortRuntimeAgentSteps(steps);
  const parentId = parentSessionId || inferParentSessionId(ordered);
  const allNodes = collectChatAgentNodes(ordered, parentId);
  const taskResult = ordered
    .filter((step) => (
      step.type === 'observation'
      && isTaskToolName(step.tool)
      && isParentSessionStep(step, parentId)
      && identityMatchesNode(node, {
        nodeId: step.nodeId || taskNodeIdFromInput(step.input),
        title: taskTitleFromInput(step.input),
        sessionId: extractTaskChildSessionIds(step.input, step.content)
          .find((id) => id !== parentId),
        parentToolCallId: step.parentToolCallId
      }, allNodes)
    ))
    .map((step) => {
      const content = String(step.content || '');
      if (!/<task_(result|error)>[\s\S]*<\/task_\1>/i.test(content)) return '';
      return taskResultPublicText(content);
    })
    .filter(Boolean)
    .at(-1);
  if (taskResult) return taskResult;

  return uniquePublicTexts(stepsForNode(ordered, node, parentId)
    .filter((step) => step.type === 'public_text')
    .map((step) => String(step.content || '').trim())
    .filter(Boolean))
    .at(-1) || '';
}

/** Keep final public output out of the process stream so the panel renders it once. */
export function childAgentPanelContent(
  steps: RuntimeAgentStep[],
  node: Pick<ChatAgentNode, 'nodeId' | 'sessionId' | 'parentToolCallId'>,
  parentSessionId?: string
) {
  return {
    timelineSteps: stepsForNode(steps, node, parentSessionId)
      .filter((step) => step.type !== 'public_text'),
    publicResult: publicResultForNode(steps, node, parentSessionId)
  };
}

export function collectChatAgentNodes(steps: RuntimeAgentStep[], parentSessionId?: string): ChatAgentNode[] {
  const nodes: ChatAgentNode[] = [];
  for (const step of sortRuntimeAgentSteps(steps)) {
    if (isTaskToolName(step.tool) && step.type === 'tool_call') {
      const nodeId = step.nodeId || taskNodeIdFromInput(step.input);
      const candidate: ChatAgentNode = {
        nodeId,
        title: taskTitleFromInput(step.input) || nodeId,
        parentToolCallId: step.parentToolCallId,
        status: 'running',
        ...taskTierFromInput(step.input)
      };
      const index = matchingNodeIndex(nodes, candidate);
      const existing = index >= 0 ? nodes[index] : undefined;
      const next: ChatAgentNode = {
        ...existing,
        ...candidate,
        sessionId: existing?.sessionId,
        status: existing?.status === 'done' || existing?.status === 'failed'
          ? existing.status
          : 'running'
      };
      if (index >= 0) {
        nodes[index] = next;
        mergeStrongNodeAliases(nodes, index, next);
      }
      else nodes.push(next);
      continue;
    }
    if (isTaskToolName(step.tool) && step.type === 'observation') {
      const childIds = extractTaskChildSessionIds(step.input, step.content);
      const nodeId = step.nodeId || taskNodeIdFromInput(step.input);
      const candidate: ChatAgentNode = {
        nodeId,
        title: taskTitleFromInput(step.input) || nodeId,
        sessionId: childIds.find((id) => id !== parentSessionId),
        parentToolCallId: step.parentToolCallId,
        status: taskStatusFromOpenCodeOutput(step.content),
        durationMs: step.durationMs,
        ...taskTierFromInput(step.input)
      };
      const index = matchingNodeIndex(nodes, candidate);
      const existing = index >= 0 ? nodes[index] : undefined;
      const next: ChatAgentNode = {
        ...existing,
        ...candidate,
        title: existing?.title || candidate.title,
        sessionId: candidate.sessionId || existing?.sessionId,
        parentToolCallId: candidate.parentToolCallId || existing?.parentToolCallId,
        durationMs: candidate.durationMs ?? existing?.durationMs
      };
      if (index >= 0) {
        nodes[index] = next;
        mergeStrongNodeAliases(nodes, index, next);
      }
      else nodes.push(next);
      continue;
    }
    if (
      step.sessionId
      && parentSessionId
      && step.sessionId !== parentSessionId
      && (step.parentToolCallId || step.nodeId)
    ) {
      const candidate: ChatAgentNode = {
        nodeId: step.nodeId || step.sessionId,
        title: step.nodeId || '任务',
        sessionId: step.sessionId,
        parentToolCallId: step.parentToolCallId,
        status: 'running'
      };
      const index = matchingNodeIndex(nodes, candidate);
      const existing = index >= 0 ? nodes[index] : undefined;
      if (!existing) {
        nodes.push(candidate);
      } else {
        nodes[index] = {
          ...existing,
          sessionId: existing.sessionId || candidate.sessionId,
          parentToolCallId: existing.parentToolCallId || candidate.parentToolCallId
        };
      }
      mergeStrongNodeAliases(nodes, index, candidate);
    }
  }
  return nodes;
}

function stageStatus(status?: string): ChatAgentNode['status'] {
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'running') return 'running';
  return 'pending';
}

export function nodesFromProgress(progress: ChatReproProgress | null | undefined): ChatAgentNode[] {
  if (!progress?.stages?.length) return [];
  return progress.stages.map((stage: ChatReproStage) => ({
    nodeId: stage.id,
    title: stage.title || stage.id,
    sessionId: stage.sessionId,
    status: stageStatus(stage.status)
  }));
}

export function nodesFromProgressList(items: ChatReproProgress[] | null | undefined): ChatAgentNode[] {
  return (items || []).flatMap((item) => nodesFromProgress(item));
}

export function mergeChatAgentNodes(fromSteps: ChatAgentNode[], fromProgress: ChatAgentNode[]): ChatAgentNode[] {
  const usedStepIndexes = new Set<number>();
  const out: ChatAgentNode[] = [];
  for (const planned of fromProgress) {
    const available = fromSteps
      .map((node, index) => ({ node, index }))
      .filter(({ index }) => !usedStepIndexes.has(index));
    const availableIndex = matchingNodeIndex(available.map(({ node }) => node), planned);
    const matched = availableIndex >= 0 ? available[availableIndex] : undefined;
    const weakMatchCount = available.filter(({ node }) => hasWeakIdentityMatch(node, planned)).length;
    const hasStrongIdentity = Boolean(planned.parentToolCallId || planned.sessionId);
    const overlay = matched?.node;
    if (overlay) {
      usedStepIndexes.add(matched.index);
      out.push({
        ...planned,
        ...overlay,
        title: overlay.title || planned.title
      });
    } else if (hasStrongIdentity || weakMatchCount < 2) {
      out.push(planned);
    }
  }
  for (const [index, node] of fromSteps.entries()) {
    if (usedStepIndexes.has(index)) continue;
    out.push(node);
  }
  return out;
}

export function collectVisibleChatAgentNodes(
  steps: RuntimeAgentStep[],
  parentSessionId?: string,
  progressItems?: ChatReproProgress[] | null,
  options?: ChatAgentNodeOptions
) {
  const nodes = mergeChatAgentNodes(
    collectChatAgentNodes(steps, parentSessionId || inferParentSessionId(steps)),
    nodesFromProgressList(progressItems)
  );
  return options?.parentActive === false ? stopRunningChatAgentNodes(nodes) : nodes;
}

export function resolveTaskNode(
  step: RuntimeAgentStep,
  allSteps: RuntimeAgentStep[],
  parentSessionId?: string,
  progressItems?: ChatReproProgress[] | null,
  options?: ChatAgentNodeOptions
): ChatAgentNode | null {
  if (!isTaskToolName(step.tool) || step.type !== 'tool_call') return null;
  const parentId = parentSessionId || inferParentSessionId(allSteps);
  const nodes = collectVisibleChatAgentNodes(allSteps, parentId, progressItems, options);
  const fromInput = taskNodeIdFromInput(step.input);
  const index = matchingNodeIndex(nodes, {
    nodeId: step.nodeId || fromInput,
    title: fromInput,
    parentToolCallId: step.parentToolCallId
  });
  return (index >= 0 ? nodes[index] : undefined) || {
    nodeId: step.nodeId || fromInput,
    title: taskTitleFromInput(step.input),
    parentToolCallId: step.parentToolCallId,
    status: options?.parentActive === false ? 'stopped' : 'running'
  };
}

export function parseSessionIdFromUnknown(value: unknown) {
  return extractTaskChildSessionIds(
    asRecord(value) || undefined,
    typeof value === 'string' ? value : undefined
  )[0];
}
