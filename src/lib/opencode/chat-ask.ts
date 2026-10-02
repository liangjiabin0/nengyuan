/** OpenCode `question` / ASK 工具：结构化提问与用户答复。 */

export const QUESTION_TOOL_NAME = 'question';

export type ChatAskOption = {
  label: string;
  description: string;
};

export type ChatAskQuestion = {
  question: string;
  header: string;
  options: ChatAskOption[];
  multiple: boolean;
  custom: boolean;
};

export type ChatAskRequest = {
  requestID: string;
  sessionID?: string;
  toolCallId?: string;
  questions: ChatAskQuestion[];
  pending: boolean;
  answers?: string[][];
};

function compactText(value: unknown) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function isQuestionToolName(tool?: string) {
  return tool === QUESTION_TOOL_NAME || tool === 'ask';
}

function parseOption(value: unknown): ChatAskOption | null {
  const record = asRecord(value);
  const label = compactText(record?.label || record?.value || record?.title);
  if (!label) return null;
  return {
    label: label.slice(0, 80),
    description: compactText(record?.description || record?.hint || record?.detail).slice(0, 240)
  };
}

function parseQuestion(value: unknown): ChatAskQuestion | null {
  const record = asRecord(value);
  const question = compactText(record?.question || record?.prompt || record?.text || record?.message);
  const header = compactText(record?.header || record?.title || record?.label) || question.slice(0, 30);
  if (!question && !header) return null;
  const options = Array.isArray(record?.options)
    ? record.options.map(parseOption).filter((item): item is ChatAskOption => Boolean(item))
    : [];
  return {
    question: (question || header).slice(0, 500),
    header: (header || question).slice(0, 30),
    options,
    multiple: record?.multiple === true,
    custom: record?.custom === true || options.length === 0
  };
}

function parseQuestions(value: unknown): ChatAskQuestion[] {
  if (Array.isArray(value)) {
    return value.map(parseQuestion).filter((item): item is ChatAskQuestion => Boolean(item));
  }
  const single = parseQuestion(value);
  return single ? [single] : [];
}

function parseAnswers(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const answers = value.map((item) => {
    if (Array.isArray(item)) {
      return item.map((entry) => compactText(entry)).filter(Boolean);
    }
    const text = compactText(item);
    return text ? [text] : [];
  });
  return answers.some((item) => item.length) ? answers : undefined;
}

export function parseChatAskRequest(input?: Record<string, unknown> | null): ChatAskRequest | null {
  if (!input) return null;
  const questions = parseQuestions(input.questions ?? input.question);
  if (!questions.length) return null;
  const requestID = compactText(input.requestID || input.id || input.requestId);
  const toolCallId = compactText(
    input.toolCallId
    || asRecord(input.tool)?.callID
    || asRecord(input.tool)?.callId
  );
  const sessionID = compactText(input.sessionID || input.sessionId);
  const answers = parseAnswers(input.answers);
  const pending = input.pending !== false && !answers;
  return {
    ...(requestID ? { requestID } : { requestID: toolCallId || '' }),
    ...(sessionID ? { sessionID } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    questions,
    pending,
    ...(answers ? { answers } : {})
  };
}

export function publicQuestionInput(input?: Record<string, unknown> | null) {
  const parsed = parseChatAskRequest(input);
  if (!parsed) return undefined;
  return {
    ...(parsed.requestID ? { requestID: parsed.requestID } : {}),
    ...(parsed.sessionID ? { sessionID: parsed.sessionID } : {}),
    ...(parsed.toolCallId ? { toolCallId: parsed.toolCallId } : {}),
    questions: parsed.questions,
    pending: parsed.pending,
    ...(parsed.answers ? { answers: parsed.answers } : {})
  };
}

export function mergeQuestionAskInput(
  current: Record<string, unknown> | undefined,
  patch: Record<string, unknown>
) {
  const merged = publicQuestionInput({
    ...(current || {}),
    ...patch,
    questions: patch.questions ?? current?.questions,
    answers: patch.answers ?? current?.answers,
    pending: patch.pending ?? current?.pending
  });
  return merged || { ...(current || {}), ...patch };
}

export function summarizeQuestionTool(input?: Record<string, unknown> | null, contentFallback = '') {
  const parsed = parseChatAskRequest(input || undefined);
  if (!parsed) {
    const fallback = compactText(contentFallback);
    return { verb: '询问', detail: fallback };
  }
  const headers = parsed.questions.map((item) => item.header || item.question).filter(Boolean);
  if (!parsed.pending && parsed.answers?.length) {
    const chosen = parsed.answers.flat().filter(Boolean).join('、');
    return { verb: '已确认', detail: chosen || headers.join(' / ') };
  }
  return {
    verb: parsed.pending ? '询问' : '已询问',
    detail: headers.join(' / ')
  };
}

export function formatQuestionAnswers(answers: string[][]) {
  return answers
    .map((item, index) => {
      const chosen = item.map((entry) => compactText(entry)).filter(Boolean);
      return chosen.length ? `问${index + 1}：${chosen.join('、')}` : '';
    })
    .filter(Boolean)
    .join('；');
}

export function questionRequestFromEvent(payload: {
  id?: string;
  requestID?: string;
  sessionID?: string;
  questions?: unknown;
  answers?: unknown;
  tool?: { messageID?: string; callID?: string };
  pending?: boolean;
}): ChatAskRequest | null {
  return parseChatAskRequest({
    requestID: payload.requestID || payload.id,
    sessionID: payload.sessionID,
    questions: payload.questions,
    answers: payload.answers,
    toolCallId: payload.tool?.callID,
    pending: payload.pending,
    tool: payload.tool
  });
}

export function isPendingQuestionStep(
  step: { type?: string; tool?: string; input?: Record<string, unknown> },
  steps: Array<{ type?: string; tool?: string; toolCallId?: string }> = []
) {
  if (!isQuestionToolName(step.tool) || step.type !== 'tool_call') return false;
  const parsed = parseChatAskRequest(step.input);
  if (parsed && parsed.pending === false) return false;
  if (parsed?.answers?.length) return false;
  const callId = parsed?.toolCallId || parsed?.requestID;
  if (callId) {
    return !steps.some((item) => (
      item.type === 'observation'
      && isQuestionToolName(item.tool)
      && item.toolCallId === callId
    ));
  }
  return true;
}

export function pendingChatAskRequests(
  steps: Array<{
    type?: string;
    tool?: string;
    toolCallId?: string;
    input?: Record<string, unknown>;
  }>
) {
  const seen = new Set<string>();
  const pending: ChatAskRequest[] = [];
  for (const step of steps) {
    if (!isPendingQuestionStep(step, steps)) continue;
    const parsed = parseChatAskRequest(step.input);
    if (!parsed?.questions.length) continue;
    const key = parsed.requestID || parsed.toolCallId || String(pending.length);
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push({
      ...parsed,
      toolCallId: parsed.toolCallId || step.toolCallId,
      pending: true
    });
  }
  return pending;
}

export function mergePendingAskIntoSteps<T extends {
  type: string;
  step: number;
  tool?: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
  content: string;
}>(steps: T[], request: ChatAskRequest): T[] {
  if (!request.questions.length) return steps;
  const matchIndex = steps.findIndex((step) => (
    isQuestionToolName(step.tool)
    && step.type === 'tool_call'
    && (
      (request.requestID && (step.input?.requestID === request.requestID || step.toolCallId === request.requestID))
      || (request.toolCallId && (step.toolCallId === request.toolCallId || step.input?.toolCallId === request.toolCallId))
    )
  ));
  const input = publicQuestionInput({
    ...request,
    pending: request.pending
  }) || request;
  const summary = summarizeQuestionTool(input);
  if (matchIndex >= 0) {
    const current = steps[matchIndex];
    const next = [...steps];
    next[matchIndex] = {
      ...current,
      input: mergeQuestionAskInput(current.input, input),
      content: `${summary.verb}：${summary.detail}`.replace(/：$/, '')
    };
    return next;
  }
  const stepNumber = (steps[steps.length - 1]?.step || 0) + 1;
  return [
    ...steps,
    {
      type: 'tool_call',
      step: stepNumber,
      tool: QUESTION_TOOL_NAME,
      toolCallId: request.toolCallId || request.requestID,
      input,
      content: `${summary.verb}：${summary.detail}`.replace(/：$/, ''),
      ...(request.sessionID ? { sessionId: request.sessionID } : {})
    } as unknown as T
  ];
}

export function canSubmitChatAskAnswers(questions: ChatAskQuestion[], answers: string[][]) {
  if (questions.length !== answers.length) return false;
  return questions.every((question, index) => {
    const chosen = (answers[index] || []).map((item) => compactText(item)).filter(Boolean);
    if (question.multiple) return chosen.length > 0;
    return chosen.length === 1;
  });
}
