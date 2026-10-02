import { loadSubagentRouterConfig, routeSubagentTask } from './subagent-router';

export const AI4ES_MODEL_MARKER_RE = /\[\[ai4es-model:(arc|thunder|storm)\]\]/i;
export const AI4ES_THINKING_MARKER_RE = /\[\[ai4es-thinking:(off|none|low|medium|high|xhigh)\]\]/i;
export const AI4ES_MODEL_ROLE_HEADER = 'x-ai4es-model-role';
export const AI4ES_THINKING_HEADER = 'x-ai4es-thinking';

export type TaskChatModelId = 'arc' | 'thunder' | 'storm';
export type TaskThinkingId = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

const SUBAGENT_TARGET = '(?:子代理|子智能体|sub[-_ ]?agent|agent|代理)';
const MODEL_ID = '(arc|thunder|storm)';
const DIRECTIVE_VERB = '(?:请|必须|务必|要求|希望|想要|我要|改用|使用|用|让|派|创建|建立|启动|调用|选择|指定|use|spawn|create|launch|delegate|assign|select)';
const MODEL_VERB = '(?:使用|用|选择|选|指定为?|设为|模型(?:为|是)?|use|select|with|model)';
const DIRECTIVE_SEP = '[\\s`"\'“”‘’:_：=,，-]{0,16}';
const EXPLICIT_SUBAGENT_MODEL_PATTERNS = [
  new RegExp(`${DIRECTIVE_VERB}${DIRECTIVE_SEP}${MODEL_ID}${DIRECTIVE_SEP}(?:模型${DIRECTIVE_SEP})?${SUBAGENT_TARGET}`, 'giu'),
  new RegExp(`${DIRECTIVE_VERB}${DIRECTIVE_SEP}${SUBAGENT_TARGET}${DIRECTIVE_SEP}${MODEL_VERB}${DIRECTIVE_SEP}${MODEL_ID}`, 'giu'),
  new RegExp(`${SUBAGENT_TARGET}${DIRECTIVE_SEP}${MODEL_VERB}${DIRECTIVE_SEP}${MODEL_ID}`, 'giu'),
  new RegExp(`(?:subagent[-_ ]?model|子代理模型)${DIRECTIVE_SEP}(?:为|是|use|select)?${DIRECTIVE_SEP}${MODEL_ID}`, 'giu')
];
const NEGATED_DIRECTIVE_RE = /(?:不要|不准|不得|禁止|别|不许|无需|不用|avoid|never|do\s+not|don't|not)\s*$/iu;
const explicitTurnModelBySession = new Map<string, TaskChatModelId>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseTaskChatModel(value: unknown): TaskChatModelId | null {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'small' || raw === 'gateway/arc' || raw === 'ai4es-small') return 'arc';
  if (raw === 'large' || raw === 'gateway/thunder' || raw === 'ai4es-large') return 'thunder';
  if (raw === 'gateway/storm') return 'storm';
  const slash = raw.split('/').pop() || raw;
  if (slash === 'arc' || slash === 'thunder' || slash === 'storm') return slash;
  const marked = raw.match(AI4ES_MODEL_MARKER_RE);
  if (marked) return marked[1]!.toLowerCase() as TaskChatModelId;
  return null;
}

export function parseTaskThinking(value: unknown): TaskThinkingId | null {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const marked = raw.match(AI4ES_THINKING_MARKER_RE);
  const id = (marked?.[1] || raw).toLowerCase();
  if (id === 'none' || id === 'disabled') return 'off';
  if (id === 'off' || id === 'low' || id === 'medium' || id === 'high' || id === 'xhigh') return id;
  return null;
}

/** 只识别明确要求“哪个模型来当子代理”的措辞，避免把父代理模型讨论误当成子代理指令。 */
export function explicitSubagentModelFromUserText(value: unknown): TaskChatModelId | null {
  const text = String(value || '');
  const found = new Set<TaskChatModelId>();
  for (const pattern of EXPLICIT_SUBAGENT_MODEL_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const prefix = text.slice(Math.max(0, (match.index || 0) - 16), match.index || 0);
      if (NEGATED_DIRECTIVE_RE.test(prefix)) continue;
      const model = parseTaskChatModel(match[1]);
      if (model) found.add(model);
    }
  }
  return found.size === 1 ? [...found][0]! : null;
}

/** buildOpenCodePrompt 将当前原始问题固定放在最后；历史与路由说明不能参与用户硬约束解析。 */
export function currentUserQuestionFromPrompt(value: unknown): string | null {
  const text = collectText(value).join('\n');
  const marker = '用户问题：';
  const index = text.lastIndexOf(marker);
  return index >= 0 ? text.slice(index + marker.length).trim() : null;
}

export function snapTaskThinking(model: TaskChatModelId, thinking: TaskThinkingId): TaskThinkingId {
  if (model !== 'arc') return thinking;
  if (thinking === 'high' || thinking === 'xhigh') return 'xhigh';
  return 'medium';
}

export function defaultTaskThinking(model: TaskChatModelId): TaskThinkingId {
  if (model === 'arc') return 'medium';
  if (model === 'storm') return 'high';
  return 'medium';
}

export function modelMarker(model: TaskChatModelId) {
  return `[[ai4es-model:${model}]]`;
}

export function thinkingMarker(thinking: TaskThinkingId) {
  return `[[ai4es-thinking:${thinking}]]`;
}

export function stripModelMarker(text: string) {
  return String(text || '').replace(/\s*\[\[ai4es-model:(?:arc|thunder|storm)\]\]\s*/gi, ' ').trim();
}

export function stripThinkingMarker(text: string) {
  return String(text || '').replace(/\s*\[\[ai4es-thinking:(?:off|none|low|medium|high|xhigh)\]\]\s*/gi, ' ').trim();
}

export function stripAi4esMarkers(text: string) {
  return stripThinkingMarker(stripModelMarker(text));
}

export function injectModelMarker(text: unknown, model: TaskChatModelId) {
  const body = stripModelMarker(String(text || ''));
  return body ? `${modelMarker(model)}\n${body}` : modelMarker(model);
}

export function injectThinkingMarker(text: unknown, thinking: TaskThinkingId) {
  const body = stripThinkingMarker(String(text || ''));
  return body ? `${thinkingMarker(thinking)}\n${body}` : thinkingMarker(thinking);
}

export function roleHeaderValue(model: TaskChatModelId) {
  if (model === 'thunder') return 'large';
  if (model === 'storm') return 'storm';
  return 'small';
}

export function collectText(value: unknown, into: string[] = []): string[] {
  if (value == null) return into;
  if (typeof value === 'string') {
    if (value) into.push(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, into);
    return into;
  }
  const rec = asRecord(value);
  if (!rec) return into;
  collectText(rec.content, into);
  collectText(rec.text, into);
  collectText(rec.parts, into);
  collectText(rec.prompt, into);
  collectText(rec.description, into);
  collectText(rec.command, into);
  collectText(rec.messages, into);
  return into;
}

export function modelFromText(value: unknown): TaskChatModelId | null {
  for (const chunk of collectText(value)) {
    const found = parseTaskChatModel(chunk.match(AI4ES_MODEL_MARKER_RE)?.[0] || '');
    if (found) return found;
  }
  return null;
}

export function thinkingFromText(value: unknown): TaskThinkingId | null {
  for (const chunk of collectText(value)) {
    const found = parseTaskThinking(chunk.match(AI4ES_THINKING_MARKER_RE)?.[0] || '');
    if (found) return found;
  }
  return null;
}

export function modelFromTaskArgs(args: Record<string, unknown> | undefined): TaskChatModelId | null {
  if (!args) return null;
  return parseTaskChatModel(args.model)
    || parseTaskChatModel(args.chat_model)
    || parseTaskChatModel(args.chatModel)
    || modelFromText(args.command)
    || modelFromText(args.prompt)
    || modelFromText(args.description)
    || explicitSubagentModelFromUserText(
      [args.command, args.prompt, args.description]
        .filter((value): value is string => typeof value === 'string')
        .join('\n')
    );
}

export function thinkingFromTaskArgs(args: Record<string, unknown> | undefined): TaskThinkingId | null {
  if (!args) return null;
  return parseTaskThinking(args.thinking)
    || parseTaskThinking(args.reasoning_effort)
    || parseTaskThinking(args.variant)
    || thinkingFromText(args.command)
    || thinkingFromText(args.prompt)
    || thinkingFromText(args.description);
}

/**
 * 标记只进 prompt。description 是子代理节点的标题和会话名，也是 UI 侧的节点身份，
 * 掺进标记会既难看又打乱节点匹配。
 */
export function applyTaskModelArg(args: Record<string, unknown>, model: TaskChatModelId) {
  args.model = model;
  args.prompt = injectModelMarker(
    typeof args.prompt === 'string' && args.prompt.trim()
      ? args.prompt
      : args.description || args.command || '',
    model
  );
  return args;
}

export function applyTaskThinkingArg(args: Record<string, unknown>, thinking: TaskThinkingId) {
  args.thinking = thinking;
  if (thinking !== 'off') args.variant = thinking;
  else delete args.variant;
  args.prompt = injectThinkingMarker(
    typeof args.prompt === 'string' && args.prompt.trim()
      ? args.prompt
      : args.description || args.command || '',
    thinking
  );
  return args;
}

/** OpenCode 的 task 工具用 subagent_type 传子代理名。 */
export function agentFromTaskArgs(args: Record<string, unknown> | undefined) {
  return String(args?.subagent_type || args?.agent || args?.subagent || '').trim();
}

async function routeTaskArgs(args: Record<string, unknown>) {
  const config = loadSubagentRouterConfig();
  if (!config?.enabled) return { model: null as TaskChatModelId | null, thinking: null as TaskThinkingId | null };
  const agent = agentFromTaskArgs(args);
  const text = collectText(args).map((chunk) => stripAi4esMarkers(chunk)).filter(Boolean).join('\n');
  const decision = await routeSubagentTask({ agent, text, config });
  return {
    model: decision.model as TaskChatModelId,
    thinking: parseTaskThinking(decision.thinking)
  };
}

type ToolBeforeInput = {
  tool: string;
  sessionID?: string;
  callID?: string;
};

type ToolBeforeOutput = {
  args: Record<string, unknown>;
};

/**
 * OpenCode 只认对 output.args 的就地修改：触发钩子时传的 `{ args }` 是临时包装对象，
 * 之后执行工具用的仍是原来那个参数对象，整体替换 output.args 会被丢掉。
 * 落档靠 prompt 里的 [[ai4es-model]] / [[ai4es-thinking]] 标记，本机 Gateway 据此换上游。
 * 父代理写在 task 参数或提示里的模型和思考档不采用。用户本轮点名的模型优先；
 * esopt-mcp / finalizer 固定 Arc 且关闭思考；其余子任务交给 Arc 短调用分级。
 */
export const createTaskModelPlugin = async () => ({
  'chat.message': async (
    input: { sessionID: string },
    output: { message: unknown; parts: unknown[] }
  ) => {
    const question = currentUserQuestionFromPrompt(output.parts);
    if (question === null) return;
    const explicit = explicitSubagentModelFromUserText(question);
    if (explicit) explicitTurnModelBySession.set(input.sessionID, explicit);
    else explicitTurnModelBySession.delete(input.sessionID);
  },
  'tool.execute.before': async (input: ToolBeforeInput, output: ToolBeforeOutput) => {
    if (input.tool !== 'task' && input.tool !== 'subtask') return;
    const args = output.args;
    if (!args || typeof args !== 'object') return;
    const agent = agentFromTaskArgs(args).toLowerCase();
    const thinkingLockedOff = agent === 'esopt-mcp' || agent === 'finalizer';
    const userDirectedModel = input.sessionID
      ? explicitTurnModelBySession.get(input.sessionID) || null
      : null;
    if (thinkingLockedOff) {
      applyTaskModelArg(args, userDirectedModel || 'arc');
      applyTaskThinkingArg(args, 'off');
      return;
    }
    if (userDirectedModel) {
      applyTaskModelArg(args, userDirectedModel);
      applyTaskThinkingArg(args, snapTaskThinking(userDirectedModel, defaultTaskThinking(userDirectedModel)));
      return;
    }
    const routed = await routeTaskArgs(args);
    let model = routed.model;
    let thinking = routed.thinking;
    if (!thinking && model) thinking = defaultTaskThinking(model);
    if (model && thinking) thinking = snapTaskThinking(model, thinking);
    if (model) applyTaskModelArg(args, model);
    if (thinking) applyTaskThinkingArg(args, thinking);
  }
});
