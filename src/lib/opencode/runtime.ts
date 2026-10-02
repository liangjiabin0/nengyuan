import fs from 'node:fs';
import path from 'node:path';
import type { Event, Part, Session, SubtaskPart, ToolPart } from '@opencode-ai/sdk/v2';
import { detectModelContext } from '../model-context';
import {
  endpointRoleForChatModel,
  normalizeChatModelId,
  OPENCODE_PROVIDER_ID,
  resolveOpenCodeModelId,
  resolveOpenCodeSmallVariant,
  type ChatModelId
} from '../model-ids';
import {
  compactStatusDetail,
  contextOccupancyRatio,
  markContextCompacted,
  shouldCompactContext
} from './context-compact';
import { getCorpusRoot } from '../corpus/schema';
import { rewriteAllCitationsToLabels } from './citation-format';
import {
  extractLinkCitations,
  extractOpenCodeCitations,
  resolveLinkCitations,
  resolveOpenCodeCitations
} from './citations';
import { chatChartOutputRelative } from '../chat-generated-charts';
import { VISIBLE_THINKING_TRACE } from './thinking-trace';
import { shouldInjectPinnedLearning } from '../self-learning';
import { TECHNICAL_REPORT_PPT_SKILL, bundledSkillMarkdownPath } from '../bundled-skills';
import { isSystemSkillRemoved } from '../skill-removed';
import {
  contextTokensFromOpenCodeTokens,
  modelContextUsageFromRounds
} from './context-usage';
import type {
  AgentStepOrigin,
  ModelContextUsage,
  OpenCodeRunOptions,
  OpenCodeRunResult,
  OpenCodeTraceMetrics,
  RuntimeAgentStep
} from './types';
import { applyCollapseGuard } from './run-guards';
import { formatToolCallContent } from './tool-summary';
import { sortRuntimeAgentSteps } from './agent-step-order';
import {
  describeOpenCodeRetryReason,
  formatGatewayRetryThought,
  GATEWAY_RETRY_MAX_ATTEMPTS,
  isTimeoutLikeError
} from './gateway-retry-trace';
import {
  enrichEmptyTaskOutput,
  isEmptyTaskResult,
  isTaskToolName,
  publicTaskInput,
  salvageChildTranscript,
  salvagePublicAgentResult,
  taskNodeIdFromInput,
  withStepOrigin
} from './chat-subagents';
import {
  formatQuestionAnswers,
  isQuestionToolName,
  mergeQuestionAskInput,
  publicQuestionInput,
  questionRequestFromEvent,
  summarizeQuestionTool,
  type ChatAskRequest
} from './chat-ask';
import {
  cachedSessionRouting,
  fetchSessionRouting,
  prefetchSessionRouting
} from './session-routing';

const DEFAULT_SESSION_FILE = path.join(process.cwd(), 'storage', 'opencode-sessions.json');
const LEARNING_FINGERPRINT_FILE = path.join(process.cwd(), 'storage', 'opencode-learning-fingerprints.json');
const SESSION_MAP_LOCK_TIMEOUT_MS = 5_000;
const SESSION_MAP_LOCK_STALE_MS = 30_000;
const sessionMapSleepBuffer = new Int32Array(new SharedArrayBuffer(4));

type SessionMapEntry = string | { sessionId?: string };
type SessionMap = Record<string, SessionMapEntry>;
type SidecarState = {
  pid: number;
  baseUrl: string;
  username: string;
  password: string;
  executable: string;
  workingDirectory: string;
  startedAt: string;
};
type OpenCodeClient = Awaited<ReturnType<typeof createClient>>;
type TextPart = Extract<Part, { type: 'text' }>;

function technicalReportPptSkillAvailable() {
  return !isSystemSkillRemoved(TECHNICAL_REPORT_PPT_SKILL)
    && Boolean(bundledSkillMarkdownPath(TECHNICAL_REPORT_PPT_SKILL));
}

function sessionMapPath(options?: { sessionMapFile?: string }) {
  if (options?.sessionMapFile?.trim()) {
    return path.isAbsolute(options.sessionMapFile)
      ? options.sessionMapFile
      : path.join(process.cwd(), options.sessionMapFile);
  }
  return DEFAULT_SESSION_FILE;
}

function readSidecarState(): SidecarState {
  try {
    const raw = fs
      .readFileSync(path.join(process.cwd(), 'storage', 'opencode-sidecar.json'), 'utf8')
      .replace(/^\uFEFF/, '');
    const state = JSON.parse(raw) as Partial<SidecarState>;
    if (!state.baseUrl || !state.username || !state.password || !state.workingDirectory) {
      throw new Error('sidecar state fields are incomplete');
    }
    return state as SidecarState;
  } catch (error) {
    throw new Error(
      `能元未启动或状态不可读。请运行 npm run opencode:start。${
        error instanceof Error ? ` ${error.message}` : ''
      }`
    );
  }
}

function withIsolatedWorkingDirectory(
  state: SidecarState,
  requestedDirectory?: string
): SidecarState {
  if (!requestedDirectory?.trim()) return state;
  const allowedRoots = [
    path.resolve(process.cwd(), 'storage', 'patents'),
    path.resolve(process.cwd(), 'storage', 'research-review'),
    path.resolve(process.cwd(), 'storage', 'grid-guides'),
    path.resolve(process.cwd(), 'storage', 'scheme-solve'),
    path.resolve(process.cwd(), 'storage', 'chat-workspaces')
  ];
  const requested = path.resolve(requestedDirectory);
  const allowedRoot = allowedRoots.find(
    (root) => requested === root || requested.startsWith(`${root}${path.sep}`)
  );
  if (!allowedRoot) {
    throw new Error('能元隔离工作目录必须位于 storage/patents、storage/research-review、storage/grid-guides、storage/scheme-solve 或 storage/chat-workspaces 下。');
  }
  fs.mkdirSync(requested, { recursive: true });
  const realDirectory = fs.realpathSync(requested);
  const realRoot = fs.realpathSync(allowedRoot);
  if (realDirectory !== realRoot && !realDirectory.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error('能元工作目录存在符号链接或目录逃逸风险。');
  }
  return { ...state, workingDirectory: realDirectory };
}

function authFetch(state: SidecarState): typeof fetch {
  const authorization = `Basic ${Buffer.from(`${state.username}:${state.password}`).toString('base64')}`;
  return async (input, init = {}) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    headers.set('Authorization', authorization);
    return fetch(input, { ...init, headers });
  };
}

async function createClient(state: SidecarState) {
  const sdk = await import('@opencode-ai/sdk/v2');
  return sdk.createOpencodeClient({
    baseUrl: state.baseUrl,
    directory: state.workingDirectory,
    fetch: authFetch(state),
    throwOnError: true
  });
}

function ensureParent(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readSessionMap(filePath = DEFAULT_SESSION_FILE): SessionMap {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as SessionMap;
  } catch {
    return {};
  }
}

function readLearningFingerprint(conversationId: string) {
  return withSessionMapLock(LEARNING_FINGERPRINT_FILE, () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(LEARNING_FINGERPRINT_FILE, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
      const value = (parsed as Record<string, unknown>)[conversationId];
      return typeof value === 'string' ? value : '';
    } catch {
      return '';
    }
  });
}

function writeLearningFingerprint(conversationId: string, fingerprint: string) {
  withSessionMapLock(LEARNING_FINGERPRINT_FILE, () => {
    let map: Record<string, string> = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(LEARNING_FINGERPRINT_FILE, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        map = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        );
      }
    } catch {
      map = {};
    }
    if (fingerprint) map[conversationId] = fingerprint;
    else delete map[conversationId];
    writeSessionMap(map, LEARNING_FINGERPRINT_FILE);
  });
}

function writeSessionMap(map: SessionMap, filePath = DEFAULT_SESSION_FILE) {
  ensureParent(filePath);
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function withSessionMapLock<T>(filePath: string, operation: () => T): T {
  const lockPath = `${filePath}.lock`;
  ensureParent(lockPath);
  const startedAt = Date.now();
  let descriptor: number | null = null;
  while (descriptor == null) {
    try {
      descriptor = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(descriptor, `${process.pid} ${Date.now()}\n`, 'utf8');
    } catch (error) {
      const code = error instanceof Error && 'code' in error
        ? String((error as NodeJS.ErrnoException).code || '')
        : '';
      if (code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > SESSION_MAP_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - startedAt >= SESSION_MAP_LOCK_TIMEOUT_MS) {
        throw new Error(`等待 OpenCode 会话映射锁超时：${path.basename(filePath)}`);
      }
      Atomics.wait(sessionMapSleepBuffer, 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    try {
      fs.closeSync(descriptor);
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // A stale-lock recovery may already have removed it.
      }
    }
  }
}

function mappedSessionId(conversationId?: string, filePath = DEFAULT_SESSION_FILE) {
  if (!conversationId) return null;
  const entry = readSessionMap(filePath)[conversationId];
  if (typeof entry === 'string') return entry;
  return entry?.sessionId || null;
}

function rememberSession(conversationId: string | undefined, sessionId: string, filePath = DEFAULT_SESSION_FILE) {
  if (!conversationId) return;
  withSessionMapLock(filePath, () => {
    const map = readSessionMap(filePath);
    map[conversationId] = sessionId;
    writeSessionMap(map, filePath);
  });
}

function forgetSession(conversationId?: string, filePath = DEFAULT_SESSION_FILE) {
  if (!conversationId) return;
  withSessionMapLock(filePath, () => {
    const map = readSessionMap(filePath);
    if (!map[conversationId]) return;
    delete map[conversationId];
    writeSessionMap(map, filePath);
  });
}

export function deleteOpenCodeSessionMapping(conversationId: string, sessionMapFile?: string) {
  forgetSession(conversationId, sessionMapPath({ sessionMapFile }));
}

export function setOpenCodeSessionMappingForTest(
  conversationId: string,
  sessionId: string,
  sessionMapFile: string
) {
  rememberSession(conversationId, sessionId, sessionMapPath({ sessionMapFile }));
}

export async function readOpenCodeSessionContextUsage(
  conversationId: string,
  options: { sessionMapFile?: string; workingDirectory?: string } = {}
): Promise<ModelContextUsage | null> {
  const sessionId = mappedSessionId(conversationId, sessionMapPath(options));
  if (!sessionId) return null;
  try {
    const state = withIsolatedWorkingDirectory(readSidecarState(), options.workingDirectory);
    const client = await createClient(state);
    const response = await client.session.messages({
      sessionID: sessionId,
      directory: state.workingDirectory,
      limit: 200
    });
    const rounds = (response.data || [])
      .flatMap((message) => message.info.role === 'assistant' ? message.parts : [])
      .filter((part): part is Extract<Part, { type: 'step-finish' }> => part.type === 'step-finish')
      .map((part) => part.tokens);
    return modelContextUsageFromRounds(rounds);
  } catch {
    return null;
  }
}

function resolveRunChatModel(options: Pick<OpenCodeRunOptions, 'chatModel' | 'modelRole'>): ChatModelId {
  return normalizeChatModelId(options.chatModel || options.modelRole);
}

function resolveRunSmallThinking(options: OpenCodeRunOptions): 'off' | 'medium' | 'xhigh' {
  const requested = options.smallThinking;
  if (requested === 'off' || requested === 'medium' || requested === 'xhigh') {
    return requested;
  }
  if (requested === 'low') return 'off';
  return options.reasoningEffort === 'high' ? 'xhigh' : 'off';
}

function resolveRunThinkingVariant(options: OpenCodeRunOptions): string | undefined {
  return resolveOpenCodeSmallVariant(options.thinkingId || resolveRunSmallThinking(options));
}

export function buildOpenCodePrompt(
  question: string,
  options: OpenCodeRunOptions,
  includeConversationContext: boolean
) {
  if (options.rawPrompt) {
    const sections: string[] = [];
    if (includeConversationContext && options.conversationContext?.trim()) {
      sections.push(options.conversationContext.trim());
    }
    sections.push(VISIBLE_THINKING_TRACE);
    sections.push(question.trim());
    return sections.join('\n\n');
  }

  // Stable policy lives in .opencode/agents/knowledge-qa.md. Only append
  // request-specific context here so the model does not prefill it twice.
  const sections: string[] = [];

  if (options.enableChartGeneration && options.conversationId) {
    sections.push([
      '本轮已开启「主动生成数据图」；有可画数据时按已加载的出图技能执行。',
      `图表写入 charts/；也可使用 ${chatChartOutputRelative(options.conversationId)}/，系统会改写到 charts/。`,
      '对比、趋势、占比、排名、时序、负荷、出力或成本数据应生成实际图表，不要只写 ASCII 图或 spec。'
    ].join('\n'));
  }

  if (options.conversationId) {
    sections.push([
      '【附件交付协议】只有你判断用户确实需要拿走的成品才算交付附件。请把这些成品复制或写入当前工作区的 deliverables/ 目录；不要把中间文件、日志、脚本草稿或输入文件放进去。',
      '可选地在 deliverables/manifest.json 写一个 JSON 数组，使用 {"file":"相对路径","title":"展示名称"} 标注文件。系统也兼容 charts/manifest.json 和你在最终答复中明确写出的 deliverables/、charts/、repro/、outputs/ 或 results/ 路径。',
      '交付文件写完并确认内容完整后，再给出最终答复；不要只在正文里声称“已生成”而不落盘。',
      '生成 Word/Excel/CSV/PDF/PPTX 时先 skill 加载 docx、xlsx、pdf 或 pptx，按该官方技能与 ai4es.md 生成；Word 报告写成 Markdown 后用 docx 技能的 build_docx.py 生成，禁止手写 word/document.xml，禁止把 Markdown 改后缀交差。'
        + (technicalReportPptSkillAvailable() ? `科研母版幻灯片用 ${TECHNICAL_REPORT_PPT_SKILL}。` : '')
    ].join('\n'));
  }

  if (includeConversationContext && options.conversationContext?.trim()) {
    sections.push(`以下历史只用于理解省略和指代；事实仍须重新用当前工具核验：\n${options.conversationContext.trim()}`);
  }

  if (options.skillCatalog) {
    if (options.skillCatalog.length) {
      sections.push(
        [
          `可用共享技能 ${options.skillCatalog.length} 个；仅在与本轮相关时用 skill 加载：`,
          options.skillCatalog
            .slice(0, 40)
            .map((skill) => {
              const title = skill.title && skill.title !== skill.name ? ` ${skill.title}` : '';
              const description = String(skill.description || '').replace(/\s+/g, ' ').trim().slice(0, 240);
              return `- \`${skill.name}\`${title}${description ? `：${description}` : ''}`;
            })
            .join('\n')
        ].join('\n')
      );
    }
  }

  if (options.loadedSkills?.length) {
    const names = options.loadedSkills.map((skill) => `\`${skill.name}\``).join('、');
    const bodies = options.loadedSkills.map((skill) => {
      const heading = skill.title && skill.title !== skill.name ? `${skill.title}（${skill.name}）` : skill.name;
      return [
        `### 技能 ${heading}`,
        skill.description ? `说明：${skill.description}` : '',
        skill.content
      ].filter(Boolean).join('\n');
    });
    const catalogNames = new Set((options.skillCatalog || []).map((skill) => skill.name));
    const needsSkillTool = options.loadedSkills.some((skill) => catalogNames.has(skill.name));
    sections.push(
      [
        `本次对话已自动加载 ${options.loadedSkills.length} 个共享技能（${names}）。请严格按这些技能的说明执行。`,
        needsSkillTool
          ? '如技能要求先用 skill 工具加载，请立即加载同名技能，以便继续读取其 refs / scripts。'
          : '上述说明已写入正文；不要再调用 skill 工具加载这些技能。',
        bodies.join('\n\n')
      ].join('\n\n')
    );
  }

  if (options.learningMemoryPrompt?.trim()) {
    sections.push(options.learningMemoryPrompt.trim());
  }

  if (options.attachmentPaths?.length) {
    const lines = options.attachmentPaths.map((item) => {
      const pointer = item.convertedRelativePath
        || item.originalRelativePath
        || item.relativePath;
      if (item.kind === 'inventory') {
        return `- 清单 ${item.name}: ${pointer}（了解包含哪些文件即可，不必通读）`;
      }
      if (item.kind === 'program') {
        return `- 程序包 ${item.name}: ${pointer}（已加载求解技能则忽略，不要哈希、不要当求解器）`;
      }
      if (item.kind === 'archive') {
        return `- 压缩包 ${item.name}: ${pointer}（未解压，由你决定是否解压以及处理哪些文件）`;
      }
      if (item.convertedRelativePath) {
        return `- ${item.name}: ${item.convertedRelativePath}（已转换，直接 read，不要建 venv，不要 read .orig 二进制）`;
      }
      return `- ${item.name}: ${item.originalRelativePath || item.relativePath}`;
    });
    const hasConverted = options.attachmentPaths.some((item) => item.convertedRelativePath);
    const hasArchive = options.attachmentPaths.some((item) => item.kind === 'archive');
    const intro = [
      hasConverted
        ? '本轮 Office/PDF 若列出 `.converted.md`，直接 read 转换稿，不要读 `.orig` 二进制，不要建 venv。'
        : '本轮 Office/PDF 若尚无 `.converted.md`，按文档读取技能转换后再 read。',
      hasArchive ? 'ZIP 仍未解压，是否解压由你决定。' : '',
      '同目录无 `.orig` 的 `.md` 只是系统说明，不是原文。已加载求解技能时用技能写明的本机路径直接执行，不要哈希附件 exe。'
    ].filter(Boolean).join('');
    sections.push([intro, lines.join('\n')].join('\n'));
  }

  if (options.reasoningEffort === 'high' && resolveRunChatModel(options) !== 'arc') {
    sections.push(
      [
          '【高强度检索】扩大关键词、同义词和候选阅读量并交叉核对；本地不足时联网深读。',
          '证据仍须可核验，最终回答对准用户问题。'
      ].join('\n')
    );
  }

  if (options.subagentRouterHint?.trim()) {
    sections.push(options.subagentRouterHint.trim());
  }

  sections.push(`用户问题：\n${question.trim()}`);
  return sections.join('\n\n');
}

function imageFileParts(options: OpenCodeRunOptions) {
  return (options.imagePaths || []).slice(0, 12).flatMap((image) => {
    try {
      const bytes = fs.readFileSync(image.path);
      if (!bytes.length || bytes.length > 8 * 1024 * 1024) return [];
      return [{
        type: 'file' as const,
        mime: image.mime,
        filename: image.name,
        url: `data:${image.mime};base64,${bytes.toString('base64')}`
      }];
    } catch {
      return [];
    }
  });
}

function partIsPublicText(part: Part): part is TextPart {
  if (part.type !== 'text') return false;
  const flags = part as TextPart & { synthetic?: boolean; ignored?: boolean };
  return !flags.synthetic && !flags.ignored;
}

function partIsAgentCallBoundary(part: Part) {
  return part.type === 'tool' || part.type === 'subtask';
}

/** Final reply = public text after the last agent-call boundary. */
export function finalAnswerFromParts(parts: Part[], parentSessionId?: string) {
  const scoped = parentSessionId
    ? parts.filter((part) => !part.sessionID || part.sessionID === parentSessionId)
    : parts;
  let lastToolIndex = -1;
  for (let index = 0; index < scoped.length; index += 1) {
    if (scoped[index] && partIsAgentCallBoundary(scoped[index])) lastToolIndex = index;
  }
  const raw = scoped
    .slice(lastToolIndex + 1)
    .filter(partIsPublicText)
    .map((part) => part.text)
    .join('');
  return applyCollapseGuard(raw).text;
}

function recoveryContextFromSteps(steps: RuntimeAgentStep[]) {
  const lines = steps
    .filter((step) => step.type === 'tool_call' || step.type === 'observation')
    .map((step) => {
      const content = String(step.content || '').replace(/\s+/g, ' ').trim();
      if (!content) return '';
      return `${step.type === 'tool_call' ? '调用' : '结果'}：${content}`;
    })
    .filter(Boolean)
    .slice(-24);
  return lines.join('\n').slice(0, 8_000);
}

export async function recoverEmptyFinalAnswer(input: {
  client: OpenCodeClient;
  directory: string;
  sessionId: string;
  question: string;
  steps: RuntimeAgentStep[];
  signal?: AbortSignal;
}) {
  const timeoutSignal = AbortSignal.timeout(90_000);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutSignal])
    : timeoutSignal;
  const context = recoveryContextFromSteps(input.steps);
  const created = await input.client.session.create({
    directory: input.directory,
    title: `最终答复恢复 ${input.sessionId.slice(-8)}`
  }, { signal });
  const recoverySessionId = created.data?.id;
  if (!recoverySessionId) throw new Error('能元未能创建最终答复恢复会话。');

  try {
    const response = await input.client.session.prompt({
      sessionID: recoverySessionId,
      directory: input.directory,
      agent: 'finalizer',
      model: {
        providerID: OPENCODE_PROVIDER_ID,
        modelID: resolveOpenCodeModelId('small')
      },
      tools: {
        read: false,
        list: false,
        glob: false,
        grep: false,
        bash: false,
        edit: false,
        write: false,
        task: false,
        webfetch: false,
        websearch: false,
        todowrite: false,
        skill: false,
        lsp: false,
        question: false,
        shared_skills: false,
        save_learning_memory: false,
        search_learning_memory: false
      },
      system: '你是最终答复恢复器。禁止思考、禁止调用工具、禁止复述指令，只输出一段完整、简洁、可直接展示给用户的中文最终答复。',
      parts: [{
        type: 'text',
        text: [
          '上一轮 Agent 已结束，但没有留下可展示的最终正文。',
          '请根据明确给出的原始问题与工具执行记录，立即补写最终答复。',
          `原始用户问题：\n${input.question.trim().slice(0, 12_000)}`,
          context ? `工具执行记录：\n${context}` : '工具执行记录：无'
        ].join('\n\n')
      }]
    }, { signal });
    const parts = response.data?.parts || [];
    return finalAnswerFromParts(parts).trim();
  } finally {
    try {
      await input.client.session.delete({
        sessionID: recoverySessionId,
        directory: input.directory
      }, { signal: AbortSignal.timeout(10_000) });
    } catch {
      // 恢复会话是一次性的；清理失败不能覆盖原始恢复结果或错误。
    }
  }
}

/** Finish reasons that mean more agent steps are expected. Everything else is terminal. */
const CONTINUATION_ASSISTANT_FINISH = new Set([
  'tool-calls',
  'tool_calls'
]);

function isContinuationFinish(finish?: string) {
  return Boolean(finish && CONTINUATION_ASSISTANT_FINISH.has(finish));
}

function parseToolRaw(raw?: string) {
  const text = String(raw || '').trim();
  if (!text) return {} as Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function toolInput(part: ToolPart) {
  const state = part.state as {
    input?: Record<string, unknown>;
    raw?: string;
    metadata?: Record<string, unknown>;
  };
  const fromState = state.input && typeof state.input === 'object' ? state.input : {};
  const fromRaw = parseToolRaw(state.raw);
  const meta = state.metadata && typeof state.metadata === 'object' ? state.metadata : {};
  const extras: Record<string, unknown> = {};
  if (typeof meta.url === 'string' && meta.url.trim()) extras.url = meta.url.trim();
  if (typeof meta.query === 'string' && meta.query.trim()) extras.query = meta.query.trim();
  const merged = { ...fromRaw, ...extras, ...fromState };
  if (isQuestionToolName(part.tool)) {
    return mergeQuestionAskInput(merged, {
      ...merged,
      toolCallId: part.callID || part.id
    });
  }
  return merged;
}

function toolOutput(part: ToolPart) {
  if (part.state.status !== 'completed') return '';
  return String(part.state.output || '');
}

function eventSessionId(event: Event) {
  const properties = event.properties as {
    sessionID?: string;
    part?: { sessionID?: string };
  };
  return properties.sessionID || properties.part?.sessionID || '';
}

function summarizeToolCall(tool: string, input: Record<string, unknown>) {
  if (isTaskToolName(tool)) {
    const title = taskNodeIdFromInput(input);
    return title ? `已派子代理：${title}` : '已派子代理';
  }
  if (isQuestionToolName(tool)) {
    const summary = summarizeQuestionTool(input);
    return summary.detail ? `${summary.verb}：${summary.detail}` : summary.verb;
  }
  if (tool === 'shared_skills') {
    const action = String(input.action || '').trim();
    const name = String(input.name || input.title || '').trim();
    if (action && name) return `技能库：${action} ${name}`;
    return action ? `技能库：${action}` : '调用技能库';
  }
  if (tool === 'save_learning_memory') {
    const instruction = String(input.instruction || '').trim();
    return instruction ? `保存记忆：${instruction}` : '保存自学习记忆';
  }
  if (tool === 'search_learning_memory') {
    const query = String(input.query || '').trim();
    return query ? `检索记忆：${query}` : '检索自学习记忆';
  }
  if (tool === 'write' || tool === 'edit') {
    const target = String(input.path || input.filePath || input.file || '').trim();
    return target ? `${tool}：${target}` : `调用 ${tool}`;
  }
  return formatToolCallContent(tool, input);
}

/**
 * 子代理的档位由 Gateway 回报。父代理写在 task 参数里的 model 只是它的意向，
 * 真实落档以 Gateway 记的为准，所以这里覆盖而不是补空。
 */
function withTaskTier(
  visibleInput: Record<string, unknown> | undefined,
  childSessionIds: string[]
) {
  for (const childId of childSessionIds) {
    const routing = cachedSessionRouting(childId);
    if (!routing) continue;
    return {
      ...(visibleInput || {}),
      model: routing.model,
      ...(routing.thinking ? { thinking: routing.thinking } : {})
    };
  }
  return visibleInput;
}

function visibleToolInput(tool: string, runtimeInput: Record<string, unknown>, pending?: boolean) {
  if (isTaskToolName(tool)) return publicTaskInput(runtimeInput);
  if (isQuestionToolName(tool)) {
    return publicQuestionInput({
      ...runtimeInput,
      ...(pending === undefined ? {} : { pending })
    }) || runtimeInput;
  }
  return runtimeInput;
}

function summarizeObservation(_tool: string, output: string) {
  const compact = output.replace(/\s+/g, ' ').trim();
  if (!compact) return output;
  return compact.length > 420 ? `${compact.slice(0, 420)}…` : compact;
}

function createMetrics(sessionId: string): OpenCodeTraceMetrics {
  return {
    traceId: crypto.randomUUID(),
    sessionId,
    modelRounds: 0,
    toolCalls: 0,
    searchCalls: 0,
    duplicateCallsBlocked: 0,
    toolDurationMs: 0,
    plannerDurationMs: 0,
    synthesisDurationMs: 0,
    compactionCount: 0,
    citationCount: 0,
    invalidCitationCount: 0,
    unsupportedCitationCount: 0,
    rejectedCitationCount: 0,
    evidenceSatisfied: false,
    evidenceReasons: [],
    totalDurationMs: 0,
    reasoningDeltaEvents: 0,
    reasoningDeltaMax: 0,
    gatewayThoughtBound: false,
    gatewayThoughtChars: 0
  };
}

type StreamPayload = {
  sessionID?: string;
  assistantMessageID?: string;
  messageID?: string;
  textID?: string;
  partID?: string;
  reasoningID?: string;
  delta?: string;
  error?: { message?: string };
};

function eventTypeName(event: Record<string, unknown>) {
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : undefined;
  return String(event.type || event.event || data?.type || '');
}

function streamPayload(event: Record<string, unknown>): StreamPayload | undefined {
  const data = event.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (record.delta || record.sessionID || record.reasoningID || record.textID) {
      return record as StreamPayload;
    }
    const nested = record.data;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as StreamPayload;
    }
  }
  const properties = event.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    return properties as StreamPayload;
  }
  if (event.delta || event.sessionID || event.reasoningID || event.textID) {
    return event as StreamPayload;
  }
  return undefined;
}

export type RuntimePartStreamKind = 'text' | 'reasoning';
export type RuntimePartStreamSource = 'v1' | 'v2' | 'snapshot';

export type RuntimePartStreamState = {
  kind?: RuntimePartStreamKind;
  v1Text: string;
  v2Text: string;
  snapshotText: string;
  emittedText: string;
};

export type RuntimePartStreamUpdate = {
  source: RuntimePartStreamSource;
  value: string;
  kind?: RuntimePartStreamKind;
};

/**
 * Reconcile duplicate v1/v2 streams without concatenating one transport onto
 * another. Unknown parts accumulate silently until a typed event arrives.
 */
export function reconcileRuntimePartStream(
  current: RuntimePartStreamState | undefined,
  update: RuntimePartStreamUpdate
): { state: RuntimePartStreamState; kind?: RuntimePartStreamKind; delta: string; conflict?: boolean } {
  const state: RuntimePartStreamState = {
    kind: current?.kind,
    v1Text: current?.v1Text || '',
    v2Text: current?.v2Text || '',
    snapshotText: current?.snapshotText || '',
    emittedText: current?.emittedText || ''
  };

  if (update.source === 'snapshot') state.snapshotText = update.value;
  else if (update.source === 'v2') state.v2Text += update.value;
  else state.v1Text += update.value;

  if (update.kind && state.kind && update.kind !== state.kind && state.emittedText) {
    return { state, kind: state.kind, delta: '', conflict: true };
  }
  if (update.kind) state.kind = update.kind;
  if (!state.kind) return { state, delta: '' };

  const priorities: Record<RuntimePartStreamSource, number> = {
    snapshot: 3,
    v2: 2,
    v1: 1
  };
  const candidates: Array<{ source: RuntimePartStreamSource; text: string }> = [
    { source: 'snapshot', text: state.snapshotText },
    { source: 'v2', text: state.v2Text },
    { source: 'v1', text: state.v1Text }
  ];
  const next = candidates
    .filter((candidate) => candidate.text.startsWith(state.emittedText))
    .sort((left, right) => (
      right.text.length - left.text.length
      || priorities[right.source] - priorities[left.source]
    ))[0]?.text || state.emittedText;
  const delta = next.slice(state.emittedText.length);
  if (delta) state.emittedText = next;
  return { state, kind: state.kind, delta };
}

function normalizedOpenCodeDirectory(value?: string) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = path.normalize(path.resolve(raw));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** The v2 event endpoint is global, so missing or mismatched locations are unsafe. */
export function isOpenCodeEventInDirectory(eventDirectory: unknown, expectedDirectory: string) {
  if (typeof eventDirectory !== 'string' || !eventDirectory.trim()) return false;
  return normalizedOpenCodeDirectory(eventDirectory) === normalizedOpenCodeDirectory(expectedDirectory);
}

const EXPLICIT_SESSION_ID_RE = /ses_[A-Za-z0-9]+/g;

/** Accept session ids only from a task envelope or session-named metadata fields. */
export function explicitTaskChildSessionIds(output?: string, metadata?: Record<string, unknown>) {
  const ids = new Set<string>();
  const rawOutput = String(output || '');
  for (const match of rawOutput.matchAll(
    /<task\b[^>]*\b(?:id|session(?:id)?)\s*=\s*["']?(ses_[A-Za-z0-9]+)["']?/gi
  )) {
    ids.add(match[1]);
  }

  const visitMetadata = (value: unknown, key = '') => {
    if (typeof value === 'string') {
      if (!/session/i.test(key)) return;
      for (const match of value.matchAll(EXPLICIT_SESSION_ID_RE)) ids.add(match[0]);
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

async function consumeEvents(input: {
  client: OpenCodeClient;
  directory: string;
  sessionId: string;
  userMessageIdRef: { current: string };
  steps: RuntimeAgentStep[];
  metrics: OpenCodeTraceMetrics;
  nextSequence: () => number;
  onStep?: OpenCodeRunOptions['onStep'];
  onTextDelta: (textId: string, delta: string, origin?: AgentStepOrigin) => Promise<void>;
  onReasoningDelta: (reasoningId: string, delta: string, origin?: AgentStepOrigin) => Promise<void>;
  onToolActivity: (phase: 'start' | 'end') => Promise<void>;
  onContextUsage?: OpenCodeRunOptions['onContextUsage'];
  onComplete: () => void;
  onFailure: (error: Error) => void;
  signal: AbortSignal;
  startedAt: number;
}) {
  const controller = new AbortController();
  const partStreams = new Map<string, RuntimePartStreamState>();
  const seenReasoningDeltaEvents = new Set<string>();
  const assistantMessageIds = new Set<string>();
  const userMessageIds = new Set<string>();
  const seenToolStates = new Set<string>();
  const seenTextDeltaEvents = new Set<string>();
  const toolStepIndexes = new Map<string, number>();
  let currentTurnStarted = false;
  let completed = false;
  /** Latest assistant finish/step reason; `tool-calls` means more steps are expected. */
  let lastAssistantFinish: string | undefined;
  /** Tools started but not yet completed/error'd — idle must not finalize while > 0. */
  let outstandingTools = 0;
  const pendingQuestionIds = new Set<string>();
  const seenQuestionEvents = new Set<string>();
  const childBySession = new Map<string, AgentStepOrigin>();
  let idleCompleteTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last time we saw assistant text — prevents finalizing mid-stream. */
  let lastTextAt = 0;
  /**
   * LAN openai-compatible providers often idle briefly between tool rounds and
   * while token batches flush. 800ms was cutting answers mid-citation.
   */
  const IDLE_COMPLETE_MS = 2_500;
  /** Require this much quiet after the latest text delta before completing. */
  const TEXT_QUIET_MS = 1_800;
  /** If still idle after tool-calls with no next busy, finalize instead of hanging forever. */
  const STALL_AFTER_TOOL_CALLS_MS = 60_000;

  const complete = () => {
    if (completed) return;
    // Ignore bare busy→idle wakes that never created an assistant or tool step.
    if (assistantMessageIds.size === 0 && input.steps.length === 0) return;
    completed = true;
    if (idleCompleteTimer) {
      clearTimeout(idleCompleteTimer);
      idleCompleteTimer = null;
    }
    input.onComplete();
  };

  const cancelScheduledComplete = () => {
    if (!idleCompleteTimer) return;
    clearTimeout(idleCompleteTimer);
    idleCompleteTimer = null;
  };

  const noteAssistantFinish = (finish?: string) => {
    if (!finish) return;
    lastAssistantFinish = finish;
    if (isContinuationFinish(finish)) {
      cancelScheduledComplete();
      return;
    }
    // Terminal / unknown provider reasons (stop, end_turn, length, …).
    scheduleCompleteFromIdle();
  };

  /**
   * OpenCode briefly goes idle between tool rounds. Do not finalize while tools
   * are outstanding, text is still arriving, or the last finish was tool-calls
   * (next model step expected).
   *
   * Important: never "return and forget" on missing/unknown finish — that used to
   * hang the UI forever after a half-finished turn.
   */
  const scheduleCompleteFromIdle = () => {
    if (completed || !currentTurnStarted) return;
    cancelScheduledComplete();
    idleCompleteTimer = setTimeout(() => {
      idleCompleteTimer = null;
      if (completed || input.signal.aborted) return;
      if (outstandingTools > 0 || pendingQuestionIds.size > 0) return;
      // Text may still be flushing after session.status=idle; wait for quiet.
      if (lastTextAt > 0 && Date.now() - lastTextAt < TEXT_QUIET_MS) {
        scheduleCompleteFromIdle();
        return;
      }
      if (isContinuationFinish(lastAssistantFinish)) {
        // Expecting another model round; if it never becomes busy, don't hang.
        idleCompleteTimer = setTimeout(() => {
          idleCompleteTimer = null;
          if (completed || input.signal.aborted || outstandingTools > 0 || pendingQuestionIds.size > 0) return;
          if (lastTextAt > 0 && Date.now() - lastTextAt < TEXT_QUIET_MS) {
            scheduleCompleteFromIdle();
            return;
          }
          if (isContinuationFinish(lastAssistantFinish)) {
            complete();
          }
        }, STALL_AFTER_TOOL_CALLS_MS);
        return;
      }
      // Missing finish is common with openai-compatible providers once the
      // session is truly idle — treat as done rather than waiting forever.
      complete();
    }, IDLE_COMPLETE_MS);
  };

  const registerChildSession = (sessionId: string, hint?: { toolCallId?: string; nodeId?: string }) => {
    if (!sessionId || sessionId === input.sessionId) return childBySession.get(sessionId);
    const existing = childBySession.get(sessionId);
    const origin: AgentStepOrigin = {
      sessionId,
      ...(existing?.nodeId || hint?.nodeId ? { nodeId: existing?.nodeId || hint?.nodeId } : {}),
      ...(existing?.parentToolCallId || hint?.toolCallId
        ? { parentToolCallId: existing?.parentToolCallId || hint?.toolCallId }
        : {})
    };
    childBySession.set(sessionId, origin);
    return origin;
  };

  const registerVerifiedChildSession = (sessionId: string, parentSessionId?: string) => {
    if (!sessionId || !parentSessionId || sessionId === input.sessionId) return false;
    if (parentSessionId !== input.sessionId && !childBySession.has(parentSessionId)) return false;
    registerChildSession(sessionId);
    return true;
  };

  const originForSession = (sessionId?: string): AgentStepOrigin => {
    if (!sessionId || sessionId === input.sessionId) return { sessionId: input.sessionId };
    return childBySession.get(sessionId) || { sessionId };
  };

  const emitQuestionStep = async (request: ChatAskRequest, origin: AgentStepOrigin) => {
    const toolCallId = request.toolCallId || request.requestID;
    const visibleInput = publicQuestionInput({
      requestID: request.requestID,
      sessionID: request.sessionID,
      toolCallId,
      questions: request.questions,
      pending: request.pending,
      ...(request.answers ? { answers: request.answers } : {})
    }) || {};
    const existingIndex = toolCallId ? toolStepIndexes.get(toolCallId) : undefined;
    const callStep = withStepOrigin({
      type: 'tool_call' as const,
      step: existingIndex === undefined ? input.steps.length + 1 : input.steps[existingIndex].step,
      sequence: existingIndex === undefined ? input.nextSequence() : input.steps[existingIndex].sequence,
      tool: 'question',
      toolCallId,
      input: mergeQuestionAskInput(
        existingIndex === undefined ? undefined : input.steps[existingIndex].input,
        visibleInput
      ),
      content: summarizeToolCall('question', visibleInput)
    }, origin);
    if (existingIndex === undefined) {
      input.steps.push(callStep);
      if (toolCallId) toolStepIndexes.set(toolCallId, input.steps.length - 1);
      input.metrics.toolCalls += 1;
    } else {
      input.steps[existingIndex] = callStep;
    }
    await input.onStep?.(callStep);
  };

  const ingestQuestionEvent = async (
    type: string,
    payload: Record<string, unknown>,
    fallbackSessionId?: string
  ) => {
    const sessionID = String(payload.sessionID || fallbackSessionId || '');
    if (!trackSession(sessionID)) return false;
    const tool = payload.tool && typeof payload.tool === 'object' && !Array.isArray(payload.tool)
      ? payload.tool as { messageID?: string; callID?: string }
      : undefined;
    if (type === 'question.asked' || type === 'question.v2.asked') {
      const request = questionRequestFromEvent({
        id: String(payload.id || ''),
        sessionID,
        questions: payload.questions,
        tool,
        pending: true
      });
      if (!request?.requestID || !request.questions.length) return true;
      const seenKey = `asked:${request.requestID}`;
      if (seenQuestionEvents.has(seenKey)) return true;
      seenQuestionEvents.add(seenKey);
      pendingQuestionIds.add(request.requestID);
      currentTurnStarted = true;
      cancelScheduledComplete();
      if (!childBySession.has(sessionID) && sessionID !== input.sessionId) {
        registerChildSession(sessionID, { toolCallId: request.toolCallId || request.requestID });
      }
      await emitQuestionStep(request, originForSession(sessionID));
      return true;
    }
    if (type === 'question.replied' || type === 'question.v2.replied') {
      const requestID = String(payload.requestID || payload.id || '');
      if (!requestID) return true;
      const seenKey = `replied:${requestID}`;
      if (seenQuestionEvents.has(seenKey)) return true;
      seenQuestionEvents.add(seenKey);
      pendingQuestionIds.delete(requestID);
      const answers = Array.isArray(payload.answers) ? payload.answers as string[][] : [];
      const existingIndex = toolStepIndexes.get(requestID)
        ?? [...toolStepIndexes.entries()].find(([, index]) => (
          input.steps[index]?.input?.requestID === requestID
        ))?.[1];
      const current = existingIndex === undefined ? undefined : input.steps[existingIndex];
      const toolCallId = current?.toolCallId || requestID;
      seenToolStates.add(`${requestID}:completed`);
      seenToolStates.add(`${toolCallId}:completed`);
      outstandingTools = Math.max(0, outstandingTools - 1);
      const visibleInput = mergeQuestionAskInput(current?.input, {
        requestID,
        sessionID,
        pending: false,
        answers,
        questions: current?.input?.questions
      });
      if (existingIndex !== undefined) {
        const updated = withStepOrigin({
          ...input.steps[existingIndex],
          input: visibleInput,
          content: summarizeToolCall('question', visibleInput)
        }, originForSession(sessionID));
        input.steps[existingIndex] = updated;
        await input.onStep?.(updated);
      }
      const observation = withStepOrigin({
        type: 'observation' as const,
        step: input.steps.length + 1,
        sequence: input.nextSequence(),
        tool: 'question',
        toolCallId,
        input: visibleInput,
        content: formatQuestionAnswers(answers) || '已确认'
      }, originForSession(sessionID));
      input.steps.push(observation);
      await input.onStep?.(observation);
      return true;
    }
    if (type === 'question.rejected' || type === 'question.v2.rejected') {
      const requestID = String(payload.requestID || payload.id || '');
      if (!requestID) return true;
      const seenKey = `rejected:${requestID}`;
      if (seenQuestionEvents.has(seenKey)) return true;
      seenQuestionEvents.add(seenKey);
      pendingQuestionIds.delete(requestID);
      seenToolStates.add(`${requestID}:completed`);
      outstandingTools = Math.max(0, outstandingTools - 1);
      return true;
    }
    return false;
  };

  const seenReconnectKeys = new Set<string>();
  const emitReconnectThought = async (thought: {
    attempt: number;
    reason: string;
    tool?: string;
  }) => {
    const content = formatGatewayRetryThought({
      attempt: thought.attempt,
      maxAttempts: GATEWAY_RETRY_MAX_ATTEMPTS,
      reason: thought.reason,
      tool: thought.tool
    });
    const key = `${thought.tool || 'model'}:${thought.attempt}:${thought.reason}`;
    if (seenReconnectKeys.has(key)) return;
    seenReconnectKeys.add(key);
    const step = withStepOrigin({
      type: 'thought',
      step: input.steps.length + 1,
      sequence: input.nextSequence(),
      content
    }, originForSession(input.sessionId));
    input.steps.push(step);
    await input.onStep?.(step);
  };

  const isParentSession = (sessionId?: string) => sessionId === input.sessionId;

  const trackSession = (sessionId?: string) => {
    return Boolean(sessionId && (sessionId === input.sessionId || childBySession.has(sessionId)));
  };

  const resolveTaskChildren = (
    toolCallId: string,
    toolInputValue: Record<string, unknown>,
    output?: string,
    metadata?: Record<string, unknown>,
    ownerSessionId = input.sessionId
  ) => {
    const nodeId = taskNodeIdFromInput(toolInputValue);
    for (const childId of explicitTaskChildSessionIds(output, metadata)) {
      if (childId !== input.sessionId && childId !== ownerSessionId) {
        registerChildSession(childId, { toolCallId, nodeId });
      }
    }
    return nodeId;
  };

  const abort = () => {
    cancelScheduledComplete();
    controller.abort();
  };
  input.signal.addEventListener('abort', abort, { once: true });

  let livenessTimer: ReturnType<typeof setInterval> | undefined;
  try {
    const subscription = await input.client.event.subscribe(
      { directory: input.directory },
      { signal: controller.signal }
    );
    const nativeSubscription = await input.client.v2.event.subscribe({
      signal: controller.signal
    });

    const acceptAssistantMessage = (messageID: string) => {
      if (!messageID || userMessageIds.has(messageID)) return false;
      const isNew = !assistantMessageIds.has(messageID);
      assistantMessageIds.add(messageID);
      currentTurnStarted = true;
      // New assistant step clears prior finish while the next step streams.
      if (isNew) lastAssistantFinish = undefined;
      return true;
    };

    const noteLiveTokens = () => {
      input.metrics.firstEventMs ??= Date.now() - input.startedAt;
      currentTurnStarted = true;
      lastTextAt = Date.now();
      if (idleCompleteTimer) scheduleCompleteFromIdle();
    };

    const emitPartUpdate = async (
      partID: string,
      update: RuntimePartStreamUpdate,
      origin: AgentStepOrigin
    ) => {
      const reconciled = reconcileRuntimePartStream(partStreams.get(partID), update);
      partStreams.set(partID, reconciled.state);
      if (!reconciled.delta || !reconciled.kind) return;
      noteLiveTokens();
      if (reconciled.kind === 'text') {
        await input.onTextDelta(partID, reconciled.delta, origin);
      } else {
        await input.onReasoningDelta(partID, reconciled.delta, origin);
      }
    };

    const emitNativeTextDelta = async (
      eventId: string,
      properties: {
        sessionID?: string;
        assistantMessageID?: string;
        messageID?: string;
        textID?: string;
        partID?: string;
        delta?: string;
      }
    ) => {
      const sessionID = properties.sessionID || '';
      const delta = properties.delta || '';
      const textID = properties.textID || properties.partID || '';
      const messageID = properties.assistantMessageID || properties.messageID || '';
      if (!trackSession(sessionID) || !delta || !textID) return;
      if (messageID && userMessageIds.has(messageID)) return;
      if (seenTextDeltaEvents.has(eventId)) return;

      // Only forward assistant text. Never treat the user prompt payload as an answer.
      if (properties.assistantMessageID) {
        acceptAssistantMessage(properties.assistantMessageID);
      } else if (messageID) {
        acceptAssistantMessage(messageID);
      }

      seenTextDeltaEvents.add(eventId);
      await emitPartUpdate(textID, { source: 'v2', value: delta, kind: 'text' }, originForSession(sessionID));
    };

    const emitNativeReasoningDelta = async (
      eventId: string,
      properties: {
        sessionID?: string;
        assistantMessageID?: string;
        messageID?: string;
        reasoningID?: string;
        partID?: string;
        delta?: string;
      }
    ) => {
      const sessionID = properties.sessionID || '';
      const delta = properties.delta || '';
      const reasoningID = properties.reasoningID || properties.partID || '';
      const messageID = properties.assistantMessageID || properties.messageID || '';
      if (!trackSession(sessionID) || !reasoningID) return;
      if (messageID && userMessageIds.has(messageID)) return;
      if (seenReasoningDeltaEvents.has(eventId)) return;

      if (properties.assistantMessageID) {
        acceptAssistantMessage(properties.assistantMessageID);
      } else if (messageID) {
        acceptAssistantMessage(messageID);
      }

      seenReasoningDeltaEvents.add(eventId);
      await emitPartUpdate(
        reasoningID,
        { source: 'v2', value: delta, kind: 'reasoning' },
        originForSession(sessionID)
      );
    };

    let nativeError: unknown;
    let nativeEventSeq = 0;
    let sidecarUnhealthyHits = 0;
    livenessTimer = setInterval(() => {
      if (completed || controller.signal.aborted || input.signal.aborted) return;
      void getOpenCodeHealth()
        .then((health) => {
          if (health.healthy) {
            sidecarUnhealthyHits = 0;
            return;
          }
          sidecarUnhealthyHits += 1;
          if (sidecarUnhealthyHits < 2) return;
          input.onFailure(new Error('能元服务已断开，本轮中止。'));
          abort();
        })
        .catch(() => {
          sidecarUnhealthyHits += 1;
          if (sidecarUnhealthyHits < 2) return;
          input.onFailure(new Error('能元服务已断开，本轮中止。'));
          abort();
        });
    }, 15_000);
    const nativeTask = (async () => {
      for await (const event of nativeSubscription.stream) {
        if (input.signal.aborted) break;
        const rawEvent = event as unknown as Record<string, unknown> & { id?: string };
        const location = rawEvent.location && typeof rawEvent.location === 'object'
          ? rawEvent.location as { directory?: string }
          : undefined;
        if (!isOpenCodeEventInDirectory(location?.directory, input.directory)) continue;
        const type = eventTypeName(rawEvent);
        const payload = streamPayload(rawEvent);
        const data = rawEvent.data && typeof rawEvent.data === 'object'
          ? rawEvent.data as { info?: Session; sessionID?: string }
          : undefined;
        if ((type === 'session.created' || type === 'session.updated') && data?.info?.parentID) {
          registerVerifiedChildSession(data.sessionID || data.info.id, data.info.parentID);
        }
        if (!payload || !trackSession(payload.sessionID)) continue;
        const durableSeq = (
          rawEvent.durable && typeof rawEvent.durable === 'object'
            ? (rawEvent.durable as { seq?: number }).seq
            : undefined
        );
        const eventId = `${type || 'evt'}:${payload.reasoningID || payload.textID || ''}:${durableSeq ?? ++nativeEventSeq}:${rawEvent.id || ''}`;
        if (type.endsWith('text.delta') || (payload.textID && payload.delta && !payload.reasoningID)) {
          await emitNativeTextDelta(eventId, payload);
        } else if (type.endsWith('reasoning.delta') || (payload.reasoningID && payload.delta)) {
          await emitNativeReasoningDelta(eventId, {
            ...payload,
            partID: payload.partID || payload.reasoningID
          });
        } else if (type.endsWith('reasoning.started') && payload.reasoningID) {
          await emitNativeReasoningDelta(`${eventId}:started`, {
            ...payload,
            partID: payload.partID || payload.reasoningID,
            delta: ''
          });
        } else if (type.endsWith('step.failed')) {
          input.onFailure(new Error(payload.error?.message || '能元步骤失败'));
        } else if (type.includes('question.')) {
          const dataRecord = rawEvent.data && typeof rawEvent.data === 'object' && !Array.isArray(rawEvent.data)
            ? rawEvent.data as Record<string, unknown>
            : undefined;
          const nested = dataRecord?.data && typeof dataRecord.data === 'object' && !Array.isArray(dataRecord.data)
            ? dataRecord.data as Record<string, unknown>
            : undefined;
          const questionPayload = Array.isArray(dataRecord?.questions)
            ? dataRecord
            : Array.isArray(nested?.questions)
              ? nested
              : (payload as unknown as Record<string, unknown>);
          await ingestQuestionEvent(type, questionPayload, payload.sessionID || questionPayload.sessionID as string);
        }
      }
    })().catch((error) => {
      if (!controller.signal.aborted && !input.signal.aborted) nativeError = error;
    });

    for await (const event of subscription.stream) {
      if (input.signal.aborted) break;
      const eventSid = eventSessionId(event);
      if (event.type === 'session.created' || event.type === 'session.updated') {
        const info = (event.properties as { info?: Session }).info;
        if (info?.parentID) registerVerifiedChildSession(info.id || eventSid, info.parentID);
        continue;
      }
      if (!trackSession(eventSid)) continue;
      const childEvent = !isParentSession(eventSid);
      input.metrics.firstEventMs ??= Date.now() - input.startedAt;

      if (event.type === 'session.compacted') {
        if (childEvent) continue;
        input.metrics.compactionCount = (input.metrics.compactionCount || 0) + 1;
        markContextCompacted(input.sessionId);
        if (input.metrics.contextTokens) {
          await input.onContextUsage?.({
            contextTokens: input.metrics.contextTokens,
            promptTokens: input.metrics.promptTokens,
            completionTokens: input.metrics.completionTokens,
            totalTokens: input.metrics.totalTokens,
            modelRounds: input.metrics.modelRounds,
            compactionCount: input.metrics.compactionCount,
            compacted: true
          });
        }
        continue;
      }
      if (event.type === 'session.status') {
        const status = event.properties.status as {
          type: string;
          attempt?: number;
          message?: string;
        };
        if (status.type === 'busy') {
          currentTurnStarted = true;
          cancelScheduledComplete();
        } else if (status.type === 'retry') {
          // OpenCode keeps the session "busy-like" while retrying provider errors.
          // Without this, the UI hangs after tools while attempt 1..N never goes idle.
          currentTurnStarted = true;
          cancelScheduledComplete();
          const attempt = Number(status.attempt || 0);
          const detail = String(status.message || '模型调用失败').trim();
          if (!childEvent && attempt <= GATEWAY_RETRY_MAX_ATTEMPTS) {
            await emitReconnectThought({
              attempt: Math.max(1, attempt),
              reason: describeOpenCodeRetryReason(detail)
            });
          }
          if (attempt > GATEWAY_RETRY_MAX_ATTEMPTS) {
            input.onFailure(
              new Error(`能元模型调用连续失败（第 ${attempt} 次）：${detail}`)
            );
          }
        } else if (status.type === 'idle' && currentTurnStarted && !childEvent) {
          scheduleCompleteFromIdle();
        }
        continue;
      }
      if (event.type === 'session.idle') {
        if (currentTurnStarted && !childEvent) scheduleCompleteFromIdle();
        continue;
      }
      if (event.type === 'session.error') {
        const error = event.properties.error;
        if (error && !childEvent) input.onFailure(new Error(JSON.stringify(error)));
        continue;
      }
      if (event.type === 'message.updated') {
        const info = event.properties.info as {
          id: string;
          role: string;
          parentID?: string;
          finish?: string;
          error?: unknown;
        };
        if (info.role === 'user') {
          // Let OpenCode assign IDs. Custom messageID breaks subsequent turns on 1.18.x.
          userMessageIds.add(info.id);
          if (!childEvent) input.userMessageIdRef.current = info.id;
          currentTurnStarted = true;
          continue;
        }
        if (info.role === 'assistant') {
          const expectedParent = input.userMessageIdRef.current;
          if (!childEvent && expectedParent && info.parentID && info.parentID !== expectedParent) continue;
          acceptAssistantMessage(info.id);
          if (!childEvent && typeof info.finish === 'string' && info.finish) {
            noteAssistantFinish(info.finish);
          }
          if (info.error && !childEvent) input.onFailure(new Error(JSON.stringify(info.error)));
        }
        continue;
      }
      if (event.type === 'question.asked' || event.type === 'question.replied' || event.type === 'question.rejected') {
        await ingestQuestionEvent(
          event.type,
          event.properties as unknown as Record<string, unknown>,
          eventSid
        );
        continue;
      }
      if (event.type === 'message.part.delta') {
        // Incremental tokens for both text and reasoning parts. The `field` is
        // usually "text" even for reasoning (the part object stores `.text`),
        // so field="text" must not be treated as public answer text.
        const properties = event.properties as {
          sessionID?: string;
          messageID?: string;
          partID?: string;
          field?: string;
          delta?: string;
        };
        const messageID = properties.messageID || '';
        const partID = properties.partID || '';
        const delta = properties.delta || '';
        if (!trackSession(properties.sessionID || eventSid)) continue;
        if (!messageID || !partID || !delta || userMessageIds.has(messageID)) continue;
        acceptAssistantMessage(messageID);
        const deltaOrigin = originForSession(properties.sessionID || eventSid);
        const knownKind = partStreams.get(partID)?.kind;
        const kind = knownKind || (properties.field === 'reasoning' ? 'reasoning' : undefined);
        await emitPartUpdate(partID, { source: 'v1', value: delta, kind }, deltaOrigin);
        continue;
      }
      if (event.type !== 'message.part.updated') continue;
      const part = event.properties.part as Part;
      if (userMessageIds.has(part.messageID)) continue;
      acceptAssistantMessage(part.messageID);
      const partOrigin = originForSession(part.sessionID || eventSid);
      const childPart = !isParentSession(part.sessionID || eventSid);

      if (part.type === 'subtask') {
        const subtask = part as SubtaskPart;
        const runtimeInput = {
          description: subtask.description,
          prompt: subtask.prompt,
          agent: subtask.agent
        };
        const visibleInput = publicTaskInput(runtimeInput);
        const startedKey = `${subtask.id}:started`;
        if (seenToolStates.has(startedKey)) continue;
        seenToolStates.add(startedKey);
        const callStep = withStepOrigin({
          type: 'tool_call',
          step: input.steps.length + 1,
          sequence: input.nextSequence(),
          tool: 'task',
          toolCallId: subtask.id,
          input: visibleInput,
          content: summarizeToolCall('task', visibleInput || {}),
          parentToolCallId: subtask.id,
          nodeId: taskNodeIdFromInput(runtimeInput)
        }, { ...partOrigin, nodeId: taskNodeIdFromInput(runtimeInput), parentToolCallId: subtask.id });
        input.steps.push(callStep);
        toolStepIndexes.set(subtask.id, input.steps.length - 1);
        await input.onStep?.(callStep);
        continue;
      }

      if (part.type === 'step-finish') {
        // Prefer step-finish.reason — more reliable than message.updated.finish
        // for openai-compatible providers that omit assistant finish.
        if (childPart) continue;
        noteAssistantFinish(part.reason);
        input.metrics.modelRounds += 1;
        input.metrics.promptTokens = (input.metrics.promptTokens || 0) + part.tokens.input;
        input.metrics.completionTokens = (input.metrics.completionTokens || 0)
          + part.tokens.output
          + part.tokens.reasoning;
        input.metrics.totalTokens = (input.metrics.promptTokens || 0)
          + (input.metrics.completionTokens || 0);
        // Latest-round occupancy, including cached prefix tokens when present.
        // Providers that omit usage leave every field at 0; skip those readings.
        const contextTokens = contextTokensFromOpenCodeTokens(part.tokens);
        if (contextTokens != null) {
          input.metrics.contextTokens = contextTokens;
          await input.onContextUsage?.({
            contextTokens,
            promptTokens: input.metrics.promptTokens,
            completionTokens: input.metrics.completionTokens,
            totalTokens: input.metrics.totalTokens,
            modelRounds: input.metrics.modelRounds,
            compactionCount: input.metrics.compactionCount
          });
        }
        continue;
      }

      if (partIsPublicText(part)) {
        await emitPartUpdate(
          part.id,
          { source: 'snapshot', value: part.text, kind: 'text' },
          partOrigin
        );
        continue;
      }

      if (part.type === 'reasoning') {
        await emitPartUpdate(
          part.id,
          { source: 'snapshot', value: part.text, kind: 'reasoning' },
          partOrigin
        );
        continue;
      }

      if (part.type !== 'tool') continue;
      const toolId = part.callID || part.id;
      if (part.state.status === 'pending' || part.state.status === 'running') {
        if (!childPart) await input.onToolActivity('start');
        const key = `${toolId}:started`;
        const runtimeInput = toolInput(part);
        let visibleInput = visibleToolInput(part.tool, runtimeInput, true);
        if (isTaskToolName(part.tool)) {
          const ownerSessionId = partOrigin.sessionId || part.sessionID;
          const meta = part.state.status === 'running' ? part.state.metadata : undefined;
          const childIds = explicitTaskChildSessionIds(undefined, meta)
            .filter((childId) => childId !== input.sessionId && childId !== ownerSessionId);
          for (const childId of childIds) {
            registerChildSession(childId, { toolCallId: toolId, nodeId: taskNodeIdFromInput(runtimeInput) });
          }
          // 派发瞬间子会话还没发过模型请求，先暖缓存，档位跟着后续这条步骤的更新补上。
          prefetchSessionRouting(childIds);
          visibleInput = withTaskTier(visibleInput, childIds);
        }
        const taskOrigin = isTaskToolName(part.tool)
          ? { ...partOrigin, nodeId: taskNodeIdFromInput(runtimeInput), parentToolCallId: toolId }
          : partOrigin;
        const existingIndex = toolStepIndexes.get(toolId);
        if (existingIndex !== undefined) {
          const updatedStep = withStepOrigin({
            ...input.steps[existingIndex],
            toolCallId: toolId,
            input: visibleInput,
            content: summarizeToolCall(part.tool, visibleInput || {})
          }, taskOrigin);
          input.steps[existingIndex] = updatedStep;
          await input.onStep?.(updatedStep);
          continue;
        }
        if (seenToolStates.has(key)) continue;
        seenToolStates.add(key);
        outstandingTools += 1;
        cancelScheduledComplete();
        const callStep = withStepOrigin({
          type: 'tool_call',
          step: input.steps.length + 1,
          sequence: input.nextSequence(),
          tool: part.tool,
          toolCallId: toolId,
          input: visibleInput,
          content: summarizeToolCall(part.tool, visibleInput || {})
        }, taskOrigin);
        input.steps.push(callStep);
        toolStepIndexes.set(toolId, input.steps.length - 1);
        input.metrics.toolCalls += 1;
        if (['grep', 'glob', 'read', 'list', 'bash'].includes(part.tool)) {
          input.metrics.searchCalls += 1;
        }
        await input.onStep?.(callStep);
        continue;
      }
      if (part.state.status === 'completed') {
        const key = `${toolId}:completed`;
        if (seenToolStates.has(key)) continue;
        seenToolStates.add(key);
        outstandingTools = Math.max(0, outstandingTools - 1);
        if (!childPart) await input.onToolActivity('end');
        const durationMs = Math.max(0, part.state.time.end - part.state.time.start);
        const runtimeInput = toolInput(part);
        let visibleInput = visibleToolInput(part.tool, runtimeInput, false);
        const rawOutput = toolOutput(part);
        const nodeId = isTaskToolName(part.tool)
          ? resolveTaskChildren(
              toolId,
              runtimeInput,
              rawOutput,
              part.state.metadata,
              partOrigin.sessionId || part.sessionID
            )
          : partOrigin.nodeId;
        if (isTaskToolName(part.tool)) {
          // 子代理已经跑完，Gateway 这时一定记下了它的落档；这条会入库，标注要在这里定下来。
          const childIds = explicitTaskChildSessionIds(rawOutput, part.state.metadata)
            .filter((childId) => childId !== input.sessionId);
          await fetchSessionRouting(childIds);
          visibleInput = withTaskTier(visibleInput, childIds);
          const callIndex = toolStepIndexes.get(toolId);
          if (callIndex !== undefined) {
            input.steps[callIndex] = { ...input.steps[callIndex], input: visibleInput };
          }
        }
        let observationContent = summarizeObservation(part.tool, rawOutput);
        if (isTaskToolName(part.tool) && isEmptyTaskResult(rawOutput)) {
          const childIds = explicitTaskChildSessionIds(rawOutput, part.state.metadata);
          const salvage = salvageChildTranscript(
            input.steps,
            toolId,
            childIds.find((id) => id !== input.sessionId)
          );
          observationContent = enrichEmptyTaskOutput(rawOutput, salvage);
        }
        const observation = withStepOrigin({
          type: 'observation',
          step: input.steps.length + 1,
          sequence: input.nextSequence(),
          tool: part.tool,
          toolCallId: toolId,
          input: visibleInput,
          content: observationContent,
          durationMs
        }, isTaskToolName(part.tool)
          ? { ...partOrigin, nodeId, parentToolCallId: toolId }
          : partOrigin);
        input.steps.push(observation);
        input.metrics.toolDurationMs += durationMs;
        await input.onStep?.(observation);
        if (outstandingTools === 0 && !childPart) scheduleCompleteFromIdle();
        continue;
      }
      if (part.state.status === 'error') {
        const key = `${toolId}:error`;
        if (seenToolStates.has(key)) continue;
        seenToolStates.add(key);
        outstandingTools = Math.max(0, outstandingTools - 1);
        if (!childPart) await input.onToolActivity('end');
        const durationMs = Math.max(0, part.state.time.end - part.state.time.start);
        const runtimeInput = toolInput(part);
        const visibleInput = visibleToolInput(part.tool, runtimeInput, false);
        if (isTaskToolName(part.tool)) {
          resolveTaskChildren(
            toolId,
            runtimeInput,
            part.state.error,
            part.state.metadata,
            partOrigin.sessionId || part.sessionID
          );
        }
        const observation = withStepOrigin({
          type: 'observation',
          step: input.steps.length + 1,
          sequence: input.nextSequence(),
          tool: part.tool,
          toolCallId: toolId,
          input: visibleInput,
          content: `工具执行失败：${part.state.error}`,
          durationMs
        }, isTaskToolName(part.tool)
          ? { ...partOrigin, nodeId: taskNodeIdFromInput(runtimeInput), parentToolCallId: toolId }
          : partOrigin);
        input.steps.push(observation);
        input.metrics.toolDurationMs += durationMs;
        await input.onStep?.(observation);
        if (!childPart && isTimeoutLikeError(part.state.error)) {
          await emitReconnectThought({
            attempt: 1,
            tool: part.tool,
            reason: describeOpenCodeRetryReason(part.state.error)
          });
        }
        if (outstandingTools === 0 && !childPart) scheduleCompleteFromIdle();
      }
    }
    await nativeTask;
    if (nativeError) throw nativeError;
  } catch (error) {
    if (!controller.signal.aborted && !input.signal.aborted) throw error;
  } finally {
    if (livenessTimer) clearInterval(livenessTimer);
    cancelScheduledComplete();
    input.signal.removeEventListener('abort', abort);
    controller.abort();
  }
}

const CORE_TOOL_PERMISSIONS = [
  'read',
  'list',
  'glob',
  'grep',
  'bash',
  'edit',
  'write',
  'task'
] as const;

function isGlobalPermissionPattern(pattern: string) {
  return pattern === '*' || pattern === '**';
}

/** OpenCode 1.18.x may persist prompt-level tool filters onto a reused session. */
export function sessionHasPersistedToolDenials(
  session: Pick<Session, 'agent' | 'permission'>
) {
  if (session.agent?.trim().toLowerCase() === 'finalizer') return true;
  const rules = Array.isArray(session.permission) ? session.permission : [];
  return CORE_TOOL_PERMISSIONS.every((tool) => rules.some((rule) => (
    rule.action === 'deny'
    && isGlobalPermissionPattern(String(rule.pattern || '').trim())
    && (rule.permission === tool || rule.permission === '*')
  )));
}

async function resolveSession(
  client: OpenCodeClient,
  state: SidecarState,
  options: OpenCodeRunOptions
) {
  const mapFile = sessionMapPath(options);
  const existing = mappedSessionId(options.conversationId, mapFile);
  if (existing) {
    try {
      const response = await client.session.get(
        {
          sessionID: existing,
          directory: state.workingDirectory
        },
        { signal: AbortSignal.timeout(20_000) }
      );
      if (!response.data) throw new Error('能元会话不存在。');
      if (sessionHasPersistedToolDenials(response.data)) {
        console.warn(`[opencode] replacing tool-denied session ${response.data.id}`);
        forgetSession(options.conversationId, mapFile);
      } else {
        try {
          await client.session.abort(
            {
              sessionID: response.data.id,
              directory: state.workingDirectory
            },
            { signal: AbortSignal.timeout(10_000) }
          );
        } catch {
          // 复用会话前清掉上次中断留下的 busy，避免 prompt 一直挂起。
        }
        return { sessionId: response.data.id, created: false };
      }
    } catch {
      forgetSession(options.conversationId, mapFile);
    }
  }

  const titlePrefix = options.sessionTitle?.trim() || '知识问答';
  const created = await client.session.create({
    directory: state.workingDirectory,
    title: options.conversationId
      ? `${titlePrefix} ${options.conversationId.slice(0, 8)}`
      : titlePrefix
  });
  if (!created.data) throw new Error('能元未能创建会话。');
  rememberSession(options.conversationId, created.data.id, mapFile);
  return { sessionId: created.data.id, created: true };
}

async function maybeCompactOpenCodeSession(input: {
  client: OpenCodeClient;
  state: SidecarState;
  sessionId: string;
  created: boolean;
  conversationId?: string;
  sessionMapFile?: string;
  workingDirectory?: string;
  modelRole?: 'small' | 'large' | 'storm';
  chatModel?: ChatModelId;
  onStatus?: OpenCodeRunOptions['onStatus'];
  onContextUsage?: OpenCodeRunOptions['onContextUsage'];
  metrics: OpenCodeTraceMetrics;
}) {
  if (input.created || !input.conversationId) return;
  const usage = await readOpenCodeSessionContextUsage(input.conversationId, {
    sessionMapFile: input.sessionMapFile,
    workingDirectory: input.workingDirectory
  });
  const occupied = usage?.contextTokens || input.metrics.contextTokens;
  if (!occupied) return;
  const window = (await detectModelContext(
    endpointRoleForChatModel(normalizeChatModelId(input.chatModel || input.modelRole))
  )).contextWindow;
  const ratio = contextOccupancyRatio(occupied, window);
  if (!shouldCompactContext(occupied, window, { sessionId: input.sessionId })) return;

  input.onStatus?.({
    phase: 'context_compact',
    detail: compactStatusDetail(ratio, false)
  });
  const modelID = resolveOpenCodeModelId(input.chatModel || input.modelRole);
  try {
    await Promise.race([
      input.client.session.summarize({
        sessionID: input.sessionId,
        directory: input.state.workingDirectory,
        providerID: OPENCODE_PROVIDER_ID,
        modelID,
        auto: true
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('上下文压缩超时')), 90_000);
      })
    ]);
  } catch {
    input.onStatus?.({
      phase: 'context_compact',
      detail: '上下文压缩暂未完成，本轮仍继续作答'
    });
    return;
  }

  markContextCompacted(input.sessionId);
  input.metrics.compactionCount = (input.metrics.compactionCount || 0) + 1;
  const nextUsage = await readOpenCodeSessionContextUsage(input.conversationId, {
    sessionMapFile: input.sessionMapFile,
    workingDirectory: input.workingDirectory
  });
  const nextOccupied = nextUsage?.contextTokens || occupied;
  if (nextUsage) {
    input.metrics.contextTokens = nextUsage.contextTokens;
    await input.onContextUsage?.({
      ...nextUsage,
      compactionCount: input.metrics.compactionCount,
      compacted: true
    });
  }
  input.onStatus?.({
    phase: 'context_compact',
    detail: compactStatusDetail(contextOccupancyRatio(nextOccupied, window), true)
  });
}

export async function getOpenCodeHealth() {
  try {
    const state = readSidecarState();
    const client = await createClient(state);
    const response = await client.global.health();
    const data = response.data as { healthy?: boolean; version?: string };
    return {
      healthy: Boolean(data.healthy),
      version: data.version || null,
      url: state.baseUrl
    };
  } catch (error) {
    return {
      healthy: false,
      version: null,
      url: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function rejectPendingOpenCodeQuestions(
  client: OpenCodeClient,
  directory: string,
  sessionIds: Set<string>
) {
  try {
    const listed = await client.question.list({ directory });
    const pending = listed.data || [];
    await Promise.allSettled(
      pending
        .filter((item) => sessionIds.has(item.sessionID))
        .map((item) => client.question.reject({ requestID: item.id, directory }))
    );
  } catch {
    // Rejecting leftover ASK prompts is best-effort before abort.
  }
}

async function abortSessionAndChildren(
  client: OpenCodeClient,
  directory: string,
  sessionId: string
) {
  const ids = new Set<string>([sessionId]);
  try {
    const children = await client.session.children({ sessionID: sessionId, directory });
    for (const child of children.data || []) {
      if (child?.id) ids.add(child.id);
    }
  } catch {
    // Listing children is best-effort; still abort the parent session.
  }
  await rejectPendingOpenCodeQuestions(client, directory, ids);
  await Promise.allSettled(
    [...ids].map((id) => client.session.abort({ sessionID: id, directory }))
  );
}

export async function abortOpenCodeSession(sessionId: string) {
  const state = readSidecarState();
  const client = await createClient(state);
  try {
    await abortSessionAndChildren(client, state.workingDirectory, sessionId);
  } catch {
    // The session may already be idle or gone.
  }
}

export async function abortOpenCodeConversation(
  conversationId: string,
  options: { sessionMapFile?: string; workingDirectory?: string } = {}
) {
  const sessionId = mappedSessionId(conversationId, sessionMapPath(options));
  if (!sessionId) return false;
  try {
    const state = withIsolatedWorkingDirectory(readSidecarState(), options.workingDirectory);
    const client = await createClient(state);
    await abortSessionAndChildren(client, state.workingDirectory, sessionId);
    return true;
  } catch {
    return false;
  }
}

async function openCodeConversationClient(
  conversationId: string,
  options: { sessionMapFile?: string; workingDirectory?: string } = {}
) {
  const sessionId = mappedSessionId(conversationId, sessionMapPath(options));
  if (!sessionId) return null;
  const state = withIsolatedWorkingDirectory(readSidecarState(), options.workingDirectory);
  const client = await createClient(state);
  return { client, sessionId, directory: state.workingDirectory };
}

export async function listOpenCodeConversationQuestions(
  conversationId: string,
  options: { sessionMapFile?: string; workingDirectory?: string } = {}
): Promise<ChatAskRequest[]> {
  const opened = await openCodeConversationClient(conversationId, options);
  if (!opened) return [];
  try {
    const listed = await opened.client.question.list({ directory: opened.directory });
    return (listed.data || [])
      .filter((item) => item.sessionID === opened.sessionId)
      .map((item) => questionRequestFromEvent({
        id: item.id,
        sessionID: item.sessionID,
        questions: item.questions,
        tool: item.tool,
        pending: true
      }))
      .filter((item): item is ChatAskRequest => Boolean(item?.questions.length));
  } catch {
    return [];
  }
}

export async function replyOpenCodeConversationQuestion(
  conversationId: string,
  requestID: string,
  answers: string[][],
  options: { sessionMapFile?: string; workingDirectory?: string } = {}
) {
  const opened = await openCodeConversationClient(conversationId, options);
  if (!opened) throw new Error('当前会话还没有能元执行上下文。');
  await opened.client.question.reply({
    requestID,
    directory: opened.directory,
    answers
  });
}

export async function rejectOpenCodeConversationQuestion(
  conversationId: string,
  requestID: string,
  options: { sessionMapFile?: string; workingDirectory?: string } = {}
) {
  const opened = await openCodeConversationClient(conversationId, options);
  if (!opened) throw new Error('当前会话还没有能元执行上下文。');
  await opened.client.question.reject({
    requestID,
    directory: opened.directory
  });
}

function openCodeUserPromptText(parts: Part[]) {
  return parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => String(part.text || ''))
    .join('\n');
}

function normalizeOpenCodePrompt(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function findOpenCodeRevertMessage(
  messages: Array<{ info: { id: string; role: string }; parts: Part[] }>,
  userPrompt: string
) {
  const users = messages.filter((message) => message.info.role === 'user');
  if (!users.length) return null;
  const needle = normalizeOpenCodePrompt(userPrompt);
  if (!needle) return users[users.length - 1];

  const texts = users.map((message) => ({
    message,
    text: normalizeOpenCodePrompt(openCodeUserPromptText(message.parts))
  }));
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    if (texts[i].text.endsWith(needle)) return texts[i].message;
  }
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    if (texts[i].text.includes(needle)) return texts[i].message;
  }
  return null;
}

/**
 * Restore the isolated conversation workspace to the state before the given
 * user prompt, matching OpenCode session.revert. Call before dropping the
 * session mapping. Does not restore files for a single-message delete.
 */
export async function revertOpenCodeConversationWorkspace(
  conversationId: string,
  options: {
    userPrompt?: string;
    workingDirectory?: string;
    sessionMapFile?: string;
  } = {}
) {
  const sessionId = mappedSessionId(conversationId, sessionMapPath(options));
  if (!sessionId) return false;
  try {
    const state = withIsolatedWorkingDirectory(readSidecarState(), options.workingDirectory);
    const client = await createClient(state);
    try {
      await abortSessionAndChildren(client, state.workingDirectory, sessionId);
    } catch {
      // Session may already be idle.
    }
    const response = await client.session.messages({
      sessionID: sessionId,
      directory: state.workingDirectory,
      limit: 500
    });
    const target = findOpenCodeRevertMessage(response.data || [], options.userPrompt || '');
    if (!target) return false;

    try {
      await client.session.revert({
        sessionID: sessionId,
        directory: state.workingDirectory,
        messageID: target.info.id
      });
    } catch {
      await client.v2.session.revert.stage({
        sessionID: sessionId,
        messageID: target.info.id,
        files: true
      });
    }
    try {
      await client.v2.session.revert.commit({ sessionID: sessionId });
    } catch {
      // Files are already restored on disk; commit is best-effort before we drop the mapping.
    }
    return true;
  } catch (error) {
    console.warn('[opencode] workspace revert skipped', error);
    return false;
  }
}

function isUnauthorizedOpenCodeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /401|Unauthorized|authentication|not authorized/i.test(message);
}

export async function runOpenCodeQuestion(
  question: string,
  options: OpenCodeRunOptions = {}
): Promise<OpenCodeRunResult> {
  if (!options.skipCorpusCheck && !fs.existsSync(path.join(getCorpusRoot(), 'MANIFEST.md'))) {
    throw new Error('Markdown 知识语料尚未生成，请先运行 npm run corpus:export。');
  }

  const startedAt = Date.now();
  // 每次执行前重新读 sidecar 状态，避免重启后仍用内存外的旧密码导致“工具全失败/401”
  let state = withIsolatedWorkingDirectory(readSidecarState(), options.workingDirectory);
  let client = await createClient(state);
  let session: { sessionId: string; created: boolean };
  try {
    session = await resolveSession(client, state, options);
  } catch (error) {
    if (!isUnauthorizedOpenCodeError(error)) throw error;
    forgetSession(options.conversationId, sessionMapPath(options));
    state = withIsolatedWorkingDirectory(readSidecarState(), options.workingDirectory);
    client = await createClient(state);
    session = await resolveSession(client, state, options);
  }
  const { sessionId, created } = session;
  const userMessageIdRef = { current: '' };
  const metrics = createMetrics(sessionId);
  await maybeCompactOpenCodeSession({
    client,
    state,
    sessionId,
    created,
    conversationId: options.conversationId,
    sessionMapFile: options.sessionMapFile,
    workingDirectory: options.workingDirectory,
    modelRole: options.modelRole,
    chatModel: options.chatModel,
    onStatus: options.onStatus,
    onContextUsage: options.onContextUsage,
    metrics
  });
  const steps: RuntimeAgentStep[] = [];
  const timeout = new AbortController();
  let didTimeOut = false;
  const timeoutMs = options.timeoutMs === 0
    ? null
    : options.timeoutMs && options.timeoutMs > 0
      ? options.timeoutMs
      : 30 * 60 * 1000;
  // Safety net only for hung sessions; selected long-running workflows can disable it.
  const timer = timeoutMs === null
    ? null
    : setTimeout(() => {
        didTimeOut = true;
        timeout.abort();
      }, timeoutMs);
  const relay = () => timeout.abort();
  options.signal?.addEventListener('abort', relay, { once: true });

  let answer = '';
  let eventSequence = 0;
  const nextEventSequence = () => {
    eventSequence += 1;
    return eventSequence;
  };
  const streamedTextById = new Map<string, string>();
  const streamedReasoningById = new Map<string, string>();
  const publicTextSequences = new Map<string, number>();
  const thoughtSequences = new Map<string, number>();
  const publicStepsByTextId = new Map<string, number>();
  const thoughtStepsById = new Map<string, number>();
  const textOrigins = new Map<string, AgentStepOrigin>();
  const thoughtOrigins = new Map<string, AgentStepOrigin>();
  const collapsedTextIds = new Set<string>();
  const demotedTextIds = new Set<string>();
  const publicTextFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const thoughtFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const thoughtFirstFlush = new Set<string>();
  const PUBLIC_TEXT_TRACE_MS = 80;
  const THOUGHT_TRACE_MS = 16;
  let traceWritesOpen = true;
  const pendingTraceWrites = new Set<Promise<void>>();

  const queueTraceWrite = (write: () => void | Promise<void>) => {
    if (!traceWritesOpen) return Promise.resolve();
    const pending = (async () => {
      if (traceWritesOpen) await write();
    })();
    pendingTraceWrites.add(pending);
    void pending.then(
      () => pendingTraceWrites.delete(pending),
      () => pendingTraceWrites.delete(pending)
    );
    return pending;
  };

  const upsertPublicTextStep = async (textId: string, fullText: string, sequence?: number) => {
    let stepIndex = publicStepsByTextId.get(textId);
    const origin = textOrigins.get(textId);
    if (stepIndex === undefined) {
      stepIndex = steps.length;
      publicStepsByTextId.set(textId, stepIndex);
      steps.push(withStepOrigin({
        type: 'public_text',
        step: stepIndex + 1,
        sequence: sequence ?? nextEventSequence(),
        content: fullText
      }, origin));
    } else {
      const previous = steps[stepIndex];
      const contentChanged = previous.content !== fullText;
      steps[stepIndex] = withStepOrigin({
        ...previous,
        ...(contentChanged && sequence !== undefined ? { sequence } : {}),
        content: fullText
      }, origin);
    }
    await options.onStep?.({ ...steps[stepIndex] });
  };

  const upsertThoughtStep = async (reasoningId: string, fullText: string, sequence?: number) => {
    const content = applyCollapseGuard(fullText).text.trim();
    if (!content) return;
    let stepIndex = thoughtStepsById.get(reasoningId);
    const origin = thoughtOrigins.get(reasoningId);
    if (stepIndex === undefined) {
      stepIndex = steps.length;
      thoughtStepsById.set(reasoningId, stepIndex);
      steps.push(withStepOrigin({
        type: 'thought',
        step: stepIndex + 1,
        sequence: sequence ?? nextEventSequence(),
        content
      }, origin));
    } else {
      const previous = steps[stepIndex];
      const contentChanged = previous.content !== content;
      steps[stepIndex] = withStepOrigin({
        ...previous,
        ...(contentChanged && sequence !== undefined ? { sequence } : {}),
        content
      }, origin);
    }
    await options.onStep?.({ ...steps[stepIndex] });
  };

  const flushPublicTextStep = async (textId: string) => {
    const timer = publicTextFlushTimers.get(textId);
    if (timer) {
      clearTimeout(timer);
      publicTextFlushTimers.delete(textId);
    }
    const fullText = streamedTextById.get(textId);
    if (fullText !== undefined) {
      await queueTraceWrite(() => upsertPublicTextStep(
        textId,
        fullText,
        publicTextSequences.get(textId)
      ));
    }
  };

  const schedulePublicTextStep = (textId: string, fullText: string, sequence: number) => {
    streamedTextById.set(textId, fullText);
    publicTextSequences.set(textId, sequence);
    if (publicTextFlushTimers.has(textId)) return;
    publicTextFlushTimers.set(
      textId,
      setTimeout(() => {
        publicTextFlushTimers.delete(textId);
        const latest = streamedTextById.get(textId);
        if (latest !== undefined) {
          void queueTraceWrite(() => upsertPublicTextStep(
            textId,
            latest,
            publicTextSequences.get(textId)
          ));
        }
      }, PUBLIC_TEXT_TRACE_MS)
    );
  };

  const flushThoughtStep = async (reasoningId: string) => {
    const timer = thoughtFlushTimers.get(reasoningId);
    if (timer) {
      clearTimeout(timer);
      thoughtFlushTimers.delete(reasoningId);
    }
    const fullText = streamedReasoningById.get(reasoningId);
    if (fullText !== undefined) {
      await queueTraceWrite(() => upsertThoughtStep(
        reasoningId,
        fullText,
        thoughtSequences.get(reasoningId)
      ));
    }
  };

  const scheduleThoughtStep = (reasoningId: string, fullText: string, sequence: number) => {
    streamedReasoningById.set(reasoningId, fullText);
    thoughtSequences.set(reasoningId, sequence);
    if (!thoughtFirstFlush.has(reasoningId)) {
      thoughtFirstFlush.add(reasoningId);
      void queueTraceWrite(() => upsertThoughtStep(reasoningId, fullText, sequence));
      return;
    }
    if (thoughtFlushTimers.has(reasoningId)) return;
    thoughtFlushTimers.set(
      reasoningId,
      setTimeout(() => {
        thoughtFlushTimers.delete(reasoningId);
        const latest = streamedReasoningById.get(reasoningId);
        if (latest !== undefined) {
          void queueTraceWrite(() => upsertThoughtStep(
            reasoningId,
            latest,
            thoughtSequences.get(reasoningId)
          ));
        }
      }, THOUGHT_TRACE_MS)
    );
  };

  const settleTraceWrites = async () => {
    while (pendingTraceWrites.size > 0) {
      await Promise.allSettled([...pendingTraceWrites]);
    }
  };

  const flushTraceTimers = async () => {
    if (!traceWritesOpen) return;
    for (const textId of [...publicTextFlushTimers.keys()]) {
      await flushPublicTextStep(textId);
    }
    for (const reasoningId of [...thoughtFlushTimers.keys()]) {
      await flushThoughtStep(reasoningId);
    }
    await settleTraceWrites();
  };

  const closeTraceWrites = async () => {
    traceWritesOpen = false;
    for (const timerId of publicTextFlushTimers.values()) clearTimeout(timerId);
    publicTextFlushTimers.clear();
    for (const timerId of thoughtFlushTimers.values()) clearTimeout(timerId);
    thoughtFlushTimers.clear();
    await settleTraceWrites();
  };

  const demoteAnswerProgress = async () => {
    for (const textId of [...publicTextFlushTimers.keys()]) {
      await flushPublicTextStep(textId);
    }
    // Mid-turn prose stays in the agent transcript only; never promote to the
    // answer bubble until the whole turn finishes (answer_replace).
    for (const textId of streamedTextById.keys()) {
      demotedTextIds.add(textId);
    }
    if (answer) {
      answer = '';
      await options.onAnswerReset?.();
    }
  };

  const looksLikeInjectedPrompt = (text: string) => (
    text.includes('请直接处理下面的问题')
    || text.includes('你完全负责检索步骤、工具选择和最终回答')
    || text.includes('不要输出 JSON 或 answer/citations/limitations envelope')
  );

  const emitTextDelta = async (textId: string, delta: string, origin?: AgentStepOrigin) => {
    if (!traceWritesOpen || !delta) return;
    if (origin) textOrigins.set(textId, origin);
    if (collapsedTextIds.has(textId)) return;
    const nextText = `${streamedTextById.get(textId) || ''}${delta}`;
    const guarded = applyCollapseGuard(nextText);
    streamedTextById.set(textId, guarded.text);
    if (guarded.collapsed) collapsedTextIds.add(textId);

    if (looksLikeInjectedPrompt(guarded.text)) {
      demotedTextIds.add(textId);
      return;
    }

    // Live transcript only (agent_step / public_text). Do not call onTextDelta
    // here — streaming into the answer bubble mid-turn leaks thinking into 正文.
    // Final reply is published once via onAnswerReplace after the turn completes.
    schedulePublicTextStep(textId, guarded.text, nextEventSequence());
  };

  const emitReasoningDelta = async (reasoningId: string, delta: string, origin?: AgentStepOrigin) => {
    if (!traceWritesOpen) return;
    if (origin) thoughtOrigins.set(reasoningId, origin);
    const nextText = `${streamedReasoningById.get(reasoningId) || ''}${delta}`;
    if (!delta && streamedReasoningById.has(reasoningId)) return;
    if (delta) {
      metrics.reasoningDeltaEvents = (metrics.reasoningDeltaEvents || 0) + 1;
      metrics.reasoningDeltaMax = Math.max(metrics.reasoningDeltaMax || 0, delta.length);
    }
    scheduleThoughtStep(reasoningId, nextText, nextEventSequence());
  };

  options.onStatus?.({ phase: 'opencode_session', detail: '正在分析…' });

  try {
    let eventError: unknown;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const abortCompletion = () => rejectCompletion(new Error('能元执行已中止。'));
    const eventTask = consumeEvents({
      client,
      directory: state.workingDirectory,
      sessionId,
      userMessageIdRef,
      steps,
      metrics,
      nextSequence: nextEventSequence,
      onStep: (step) => queueTraceWrite(() => options.onStep?.(step)),
      onTextDelta: emitTextDelta,
      onReasoningDelta: emitReasoningDelta,
      onContextUsage: options.onContextUsage,
      onToolActivity: async (phase) => {
        if (phase === 'start') await demoteAnswerProgress();
      },
      onComplete: resolveCompletion,
      onFailure: rejectCompletion,
      signal: timeout.signal,
      startedAt
    }).catch((error) => {
      eventError = error;
      rejectCompletion(error instanceof Error ? error : new Error(String(error)));
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    const thinkingVariant = resolveRunThinkingVariant(options);
    const learningFingerprint = String(options.learningMemoryFingerprint || '');
    const previousLearningFingerprint = options.conversationId
      ? readLearningFingerprint(options.conversationId)
      : '';
    const injectPinnedLearning = shouldInjectPinnedLearning({
      created,
      compacted: (metrics.compactionCount || 0) > 0,
      fingerprint: learningFingerprint,
      previousFingerprint: previousLearningFingerprint
    });
    if (options.conversationId && learningFingerprint !== previousLearningFingerprint) {
      writeLearningFingerprint(options.conversationId, learningFingerprint);
    }
    if (injectPinnedLearning) {
      options.onStatus?.({
        phase: 'learning-memory',
        detail: `已写入 ${options.learningMemoryCount || 0} 条始终生效的偏好`
      });
    }
    const promptOptions = injectPinnedLearning
      ? options
      : { ...options, learningMemoryPrompt: undefined };
    // Do not pass a custom messageID: OpenCode 1.18.x accepts it on the first turn,
    // but subsequent prompt_async calls then go busy→idle without creating an assistant.
    await client.session.promptAsync(
      {
        sessionID: sessionId,
        directory: state.workingDirectory,
        agent: options.agent?.trim() || 'knowledge-qa',
        model: {
          providerID: OPENCODE_PROVIDER_ID,
          // 一律使用中性别名；真实模型名仅在 Gateway 改写后发往上游
          modelID: resolveOpenCodeModelId(resolveRunChatModel(options))
        },
        ...(thinkingVariant ? { variant: thinkingVariant } : {}),
        parts: [
          { type: 'text', text: buildOpenCodePrompt(question, promptOptions, created) },
          ...imageFileParts(options)
        ],
        ...(options.unrestrictedTools
          ? {}
          : {
              tools: {
                read: options.tools?.read ?? true,
                list: options.tools?.list ?? true,
                glob: options.tools?.glob ?? true,
                grep: options.tools?.grep ?? true,
                bash: options.tools?.bash ?? true,
                edit: options.tools?.edit ?? false,
                write: options.tools?.write ?? false,
                task: options.tools?.task ?? false,
                webfetch: options.tools?.webfetch ?? true,
                websearch: options.tools?.websearch ?? false,
                todowrite: options.tools?.todowrite ?? false,
                skill: options.tools?.skill ?? false,
                lsp: options.tools?.lsp ?? false,
                question: options.tools?.question ?? false
              }
            })
      },
      { signal: timeout.signal }
    );
    timeout.signal.addEventListener('abort', abortCompletion, { once: true });
    if (timeout.signal.aborted) abortCompletion();
    await completion;
    timeout.signal.removeEventListener('abort', abortCompletion);

    await new Promise((resolve) => setTimeout(resolve, 75));
    timeout.abort();
    await eventTask;
    if (eventError) throw eventError;
    await flushTraceTimers();

    const userMessageId = userMessageIdRef.current;
    if (!userMessageId) throw new Error('能元未记录本轮用户消息。');
    let messagesResponse;
    try {
      messagesResponse = await client.session.messages({
        sessionID: sessionId,
        directory: state.workingDirectory,
        limit: 100
      });
    } catch (error) {
      if (!isUnauthorizedOpenCodeError(error)) throw error;
      // sidecar 重启换密后，用最新凭据再读一次；仍失败则清会话映射
      state = readSidecarState();
      client = await createClient(state);
      try {
        messagesResponse = await client.session.messages({
          sessionID: sessionId,
          directory: state.workingDirectory,
          limit: 100
        });
      } catch (retryError) {
        forgetSession(options.conversationId, sessionMapPath(options));
        throw new Error(
          `能元鉴权失败（多为服务重启换密）。请重试生成。原始错误：${
            retryError instanceof Error ? retryError.message : String(retryError)
          }`
        );
      }
    }
    const assistantMessages = (messagesResponse.data || []).filter(
      (message) => message.info.role === 'assistant' && message.info.parentID === userMessageId
    );
    for (const message of assistantMessages) {
      if ('error' in message.info && message.info.error) {
        throw new Error(JSON.stringify(message.info.error));
      }
    }
    const allParts = assistantMessages.flatMap((message) =>
      message.info.role === 'assistant' ? message.parts : []
    );
    let lastToolIndex = -1;
    allParts.forEach((part, index) => {
      if (part.sessionID && part.sessionID !== sessionId) return;
      if (partIsAgentCallBoundary(part)) lastToolIndex = index;
    });
    for (let index = 0; index < allParts.length; index += 1) {
      const part = allParts[index];
      if (!partIsPublicText(part)) continue;
      if (part.sessionID && part.sessionID !== sessionId) continue;
      if (looksLikeInjectedPrompt(part.text)) {
        demotedTextIds.add(part.id);
        continue;
      }
      if (index <= lastToolIndex) {
        demotedTextIds.add(part.id);
        streamedTextById.set(part.id, part.text);
        await queueTraceWrite(() => upsertPublicTextStep(part.id, part.text));
      }
    }
    for (const part of allParts) {
      if (part.type !== 'reasoning') continue;
      if (!thoughtStepsById.has(part.id)) continue;
      const text = String(part.text || '').trim();
      if (!text) continue;
      streamedReasoningById.set(part.id, part.text);
      await queueTraceWrite(() => upsertThoughtStep(part.id, part.text));
    }
    await settleTraceWrites();
    traceWritesOpen = false;

    let projectedAnswer = finalAnswerFromParts(allParts, sessionId);
    if (looksLikeInjectedPrompt(projectedAnswer)) {
      projectedAnswer = '';
    }
    // If messages API lost the final text part (abort race), fall back to streamed deltas.
    if (!projectedAnswer.trim()) {
      const streamedAfterTools: string[] = [];
      for (let index = lastToolIndex + 1; index < allParts.length; index += 1) {
        const part = allParts[index];
        if (!partIsPublicText(part)) continue;
        if (part.sessionID && part.sessionID !== sessionId) continue;
        const streamed = streamedTextById.get(part.id);
        if (streamed) streamedAfterTools.push(streamed);
      }
      // Also pick up text ids that streamed but never landed in parts.
      for (const [textId, text] of streamedTextById.entries()) {
        if (demotedTextIds.has(textId)) continue;
        if (looksLikeInjectedPrompt(text)) continue;
        const origin = textOrigins.get(textId);
        if (origin?.sessionId && origin.sessionId !== sessionId) continue;
        if (!allParts.some((part) => part.id === textId) && text.trim()) {
          streamedAfterTools.push(text);
        }
      }
      projectedAnswer = applyCollapseGuard(streamedAfterTools.join('')).text;
    }
    if (!projectedAnswer.trim()) {
      const salvaged = applyCollapseGuard(salvagePublicAgentResult(steps, sessionId)).text;
      if (salvaged) {
        projectedAnswer = salvaged;
      } else {
        options.onStatus?.({ phase: 'final_recovery', detail: '正在恢复最终答复…' });
        try {
          projectedAnswer = await recoverEmptyFinalAnswer({
            client,
            directory: state.workingDirectory,
            sessionId,
            question,
            steps,
            signal: options.signal
          });
        } catch (recoveryError) {
          console.error('[opencode] final answer recovery failed', recoveryError);
        }
      }
    }
    if (!projectedAnswer.trim()) {
      if (options.rawPrompt && (options.agent || '').includes('patent')) {
        projectedAnswer = '（专利工作区文件已由工具写入，详见 STATUS.json）';
      } else if (options.rawPrompt && (options.agent || '').includes('grid-guide')) {
        projectedAnswer = '本轮未返回公开摘要。请按任务文件夹已落盘文件继续核对和补齐。';
      } else {
        throw new Error('能元未返回最终公开文本。');
      }
    }

    // Drop any public_text that duplicates the final answer (especially no-tool turns).
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index];
      if (step?.type !== 'public_text') continue;
      if (step.sessionId && step.sessionId !== sessionId) continue;
      const text = String(step.content || '').trim();
      if (!text) {
        steps.splice(index, 1);
        continue;
      }
      if (lastToolIndex < 0 || projectedAnswer.includes(text) || text.includes(projectedAnswer.slice(0, 80))) {
        steps.splice(index, 1);
      }
    }

    const citations = extractOpenCodeCitations(projectedAnswer);
    const resolved = resolveOpenCodeCitations(citations, {
      workingDirectory: state.workingDirectory
    });
    const linkSources = resolveLinkCitations(extractLinkCitations(projectedAnswer));
    const sources = [...resolved.sources, ...linkSources];
    answer = rewriteAllCitationsToLabels(projectedAnswer, sources);

    // Publish the final reply once the turn is complete (no artificial chunk replay).
    await options.onAnswerReplace?.(answer);

    metrics.citationCount = sources.length;
    metrics.invalidCitationCount = resolved.invalid.length;
    metrics.unsupportedCitationCount = 0;
    metrics.rejectedCitationCount = resolved.invalid.length;
    metrics.evidenceSatisfied = resolved.sources.length > 0 && resolved.invalid.length === 0;
    metrics.evidenceReasons = resolved.invalid;
    metrics.totalDurationMs = Date.now() - startedAt;
    const confidence = metrics.evidenceSatisfied ? 'high' : sources.length ? 'medium' : 'low';

    return {
      answer,
      sources,
      graphSeedIds: [],
      steps: sortRuntimeAgentSteps(steps),
      metrics,
      confidence,
      intent: 'opencode'
    };
  } catch (error) {
    timeout.abort();
    await closeTraceWrites();
    await abortOpenCodeSession(sessionId);
    if (options.signal?.aborted) throw new Error('请求已取消。');
    if (didTimeOut) throw new Error('能元执行超时。');
    throw error;
  } finally {
    await closeTraceWrites();
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', relay);
  }
}
