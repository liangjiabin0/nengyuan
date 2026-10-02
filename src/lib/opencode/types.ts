import type { ChatAttachment } from '../chat-attachments';
import type { DisplaySource } from '../source-files';
import type { ChatModelId } from '../model-ids';

export type RuntimeAgentStep = {
  type: 'thought' | 'plan' | 'public_text' | 'tool_call' | 'observation' | 'synthesis';
  /** Stable node identity. Updates to the same logical node keep this value. */
  step: number;
  /** Monotonic event order used for display; falls back to `step` for older records. */
  sequence?: number;
  tool?: string;
  /** Stable OpenCode call id shared by a tool_call and its observation. */
  toolCallId?: string;
  input?: Record<string, unknown>;
  content: string;
  durationMs?: number;
  /** OpenCode session that produced this step. Parent session when omitted. */
  sessionId?: string;
  /** Task / plan node this step belongs to (child agent). */
  nodeId?: string;
  /** Parent `task` tool call that spawned the child session. */
  parentToolCallId?: string;
};

export type AgentStepOrigin = {
  sessionId?: string;
  nodeId?: string;
  parentToolCallId?: string;
};

export type OpenCodeTraceMetrics = {
  traceId: string;
  sessionId: string;
  modelRounds: number;
  toolCalls: number;
  searchCalls: number;
  duplicateCallsBlocked: number;
  toolDurationMs: number;
  plannerDurationMs: number;
  synthesisDurationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Tokens occupying the context after the latest model round. */
  contextTokens?: number;
  /** Times this OpenCode session was compacted in the current process. */
  compactionCount?: number;
  citationCount: number;
  invalidCitationCount: number;
  unsupportedCitationCount: number;
  rejectedCitationCount: number;
  evidenceSatisfied: boolean;
  evidenceReasons: string[];
  firstEventMs?: number;
  totalDurationMs: number;
  /** Live reasoning token events forwarded from OpenCode (before UI coalescing). */
  reasoningDeltaEvents?: number;
  reasoningDeltaMax?: number;
  gatewayThoughtBound?: boolean;
  gatewayThoughtChars?: number;
};

export type ModelContextUsage = Pick<
  OpenCodeTraceMetrics,
  'contextTokens' | 'promptTokens' | 'completionTokens' | 'totalTokens' | 'modelRounds' | 'compactionCount'
> & {
  compacted?: boolean;
};

export type OpenCodeToolFlags = {
  read?: boolean;
  list?: boolean;
  glob?: boolean;
  grep?: boolean;
  bash?: boolean;
  edit?: boolean;
  write?: boolean;
  task?: boolean;
  webfetch?: boolean;
  websearch?: boolean;
  todowrite?: boolean;
  skill?: boolean;
  lsp?: boolean;
  question?: boolean;
};

export type OpenCodeRunOptions = {
  conversationId?: string;
  conversationContext?: string;
  currentAttachments?: ChatAttachment[];
  attachmentPaths?: Array<{
    attachmentId: string;
    name: string;
    relativePath: string;
    originalRelativePath?: string;
    convertedRelativePath?: string;
    kind?: 'document' | 'inventory' | 'program' | 'binary' | 'text' | 'archive';
  }>;
  /** Image files extracted from paper attachments; sent as visual file parts when supported by the endpoint. */
  imagePaths?: Array<{ path: string; name: string; mime: string }>;
  /** OpenCode agent name; default knowledge-qa */
  agent?: string;
  /** Session create title prefix */
  sessionTitle?: string;
  /** Override session map file (absolute or cwd-relative). Default: storage/opencode-sessions.json */
  sessionMapFile?: string;
  /** Isolated working directory for this run; restricted to storage/patents/*, storage/research-review/*, storage/grid-guides/*, storage/scheme-solve/* or storage/chat-workspaces/*. */
  workingDirectory?: string;
  /** Tool allow-list for promptAsync。未设置 unrestrictedTools 时生效。 */
  tools?: OpenCodeToolFlags;
  /**
   * 不向 sidecar 传 tools 过滤表，沿用 Agent permission（如 knowledge-qa 的 `"*": allow`）。
   * 避免漏掉 MCP 或 sidecar 后续新增的工具。
   */
  unrestrictedTools?: boolean;
  /** Skip knowledge-corpus MANIFEST requirement (patent drafting) */
  skipCorpusCheck?: boolean;
  /** Abort timeout in ms; default 30 minutes. Set to 0 to disable the time limit. */
  timeoutMs?: number;
  /** When true, send question text as-is without knowledge-qa wrapper */
  rawPrompt?: boolean;
  /** default：常规；high：小模型开 xhigh 思考，大模型追加高能量检索提示词 */
  reasoningEffort?: 'default' | 'high';
  /** 小模型思考档；关 / 中 / 超高。low 视为关。未设时按 reasoningEffort 映射。 */
  smallThinking?: 'off' | 'low' | 'medium' | 'xhigh';
  /** small：本地小模型（默认）；large：远程大模型（经 Gateway 按 modelID 路由）；storm：第三档远程模型 */
  modelRole?: 'small' | 'large' | 'storm';
  /** 【按线上版本补回】会话选定的模型（arc / thunder / storm），优先于 modelRole */
  chatModel?: ChatModelId;
  /** 【按线上版本补回】思考档 id（off / low / medium / high / xhigh …），优先于 smallThinking */
  thinkingId?: string;
  /** 【按线上版本补回】子代理路由提示词，追加在系统提示末尾 */
  subagentRouterHint?: string;
  /** 本次对话自动注入的共享技能正文 */
  loadedSkills?: Array<{ name: string; title?: string; description?: string; content: string }>;
  /** 输入框选中「主动生成数据图」后才注入出图指令；未开启时不得出现该能力。 */
  enableChartGeneration?: boolean;
  /** 技能库目录摘要，供智能对话自行读取/安装/修改 */
  skillCatalog?: Array<{ name: string; title?: string; description?: string }>;
  /** 当前用户、当前领域的私有自学习记忆；由服务端完成领域隔离后注入 */
  learningMemoryPrompt?: string;
  /** 【按线上版本补回】钉住记忆的指纹；变化时才重新注入，避免每轮重复 */
  learningMemoryFingerprint?: string;
  /** 【按线上版本补回】本次注入的钉住记忆条数（用于进度提示） */
  learningMemoryCount?: number;
  onStatus?: (status: { phase: string; detail: string }) => void;
  onStep?: (step: RuntimeAgentStep) => void | Promise<void>;
  onTextDelta?: (delta: string) => void | Promise<void>;
  /** Clear previously streamed answer text when earlier public progress is demoted. */
  onAnswerReset?: () => void | Promise<void>;
  /** Replace the visible answer with the authoritative final text after the turn ends. */
  onAnswerReplace?: (content: string) => void | Promise<void>;
  onContextUsage?: (usage: ModelContextUsage) => void | Promise<void>;
  signal?: AbortSignal;
};

export type OpenCodeRunResult = {
  answer: string;
  sources: DisplaySource[];
  graphSeedIds: string[];
  steps: RuntimeAgentStep[];
  metrics: OpenCodeTraceMetrics;
  confidence: 'high' | 'medium' | 'low';
  intent: string;
};
