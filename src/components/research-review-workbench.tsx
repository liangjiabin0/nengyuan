// 【重建说明】线上已无页面引用本组件（/research-review 重定向到 /chat），仅为通过编译补了 userId 参数（null）。
'use client';

import 'katex/dist/katex.min.css';
import {
  ChevronDown,
  Download,
  FileText,
  LoaderCircle,
  MessageSquare,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Send,
  Square,
  Trash2
} from 'lucide-react';
import {
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { flushSync } from 'react-dom';
import { useSearchParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import {
  CompactAttachmentManagerModal,
  CompactMessageAttachments,
  CompactPendingAttachments,
  attachmentTypeLabel,
  formatAttachmentSize
} from '@/components/attachment-chips';
import { useDashboardStats } from '@/components/dashboard-stats-context';
import { useNotifyError } from '@/components/app-notify';
import { usePageContentReady } from '@/components/page-nav-loading';
import { createId } from '@/lib/create-id';
import {
  extractLinkCitations,
  findSourceForPath,
  linkifyOpenCodeCitations,
  normalizeCitationPath,
  normalizeCitationUrl,
  parsePathCitationId,
  resolveLinkCitations
} from '@/lib/opencode/citation-format';
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_FORMAT_HINT,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_UPLOAD_FILES,
  ATTACHMENT_UPLOAD_EXTENSION_SET
} from '@/lib/attachments/policy';
import {
  RESEARCH_REVIEW_DEFAULT_REASONING_RATIO,
  resolveReasoningTier
} from '@/lib/reasoning-tier';
import { ContextUsageIndicator } from '@/components/context-usage-indicator';
import { RagThinkCollapse } from '@/components/rag-think-collapse';
import {
  formatThinkingClock,
  freezeThinkingDurationMs,
  previousUserCreatedAt,
  resolveThinkingDurationMs
} from '@/lib/chat-thinking-duration';
import {
  isInFlightAssistantMessage,
  readActiveConversation,
  writeActiveConversation
} from '@/lib/chat-active-session';
import { contextUsageFromMetrics, hasRecognizedContextUsage } from '@/lib/opencode/context-usage';
import { summarizeWebTool } from '@/lib/opencode/tool-summary';
import type { ModelContextUsage } from '@/lib/opencode/types';

const CHAT_PANEL_STORAGE_KEY = 'rag-research-review-panel-width';
const DEFAULT_CHAT_PANEL_WIDTH = 360;
const MIN_CHAT_PANEL_WIDTH = 300;
const MAX_CHAT_PANEL_WIDTH = 720;
const MIN_WORKSPACE_WIDTH = 680;
const MAX_ATTACHMENT_FILES = ATTACHMENT_MAX_UPLOAD_FILES;
const MAX_ATTACHMENT_BYTES = ATTACHMENT_MAX_BYTES;
const ATTACHMENT_ONLY_QUESTION = '请基于这些文献撰写研究综述';
const ALLOWED_ATTACHMENT_EXTENSIONS = ATTACHMENT_UPLOAD_EXTENSION_SET;
const WELCOME_PROMPTS = [
  '上传文献，开始写综述？',
  '今天要梳理哪个研究方向？',
  '准备好基于文献生成综述了吗？',
  '先上传论文或文献包？',
  '想从哪条研究主线写起？',
  '有哪些缺口值得提炼？'
];

function pickWelcomePrompt() {
  return WELCOME_PROMPTS[Math.floor(Math.random() * WELCOME_PROMPTS.length)];
}

function WelcomeTypewriter({ text, ready }: { text: string; ready: boolean }) {
  const [shown, setShown] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!ready || !text) {
      setShown('');
      setDone(false);
      return;
    }

    setShown('');
    setDone(false);
    let index = 0;
    const timer = window.setInterval(async () => {
      index += 1;
      setShown(text.slice(0, index));
      if (index >= text.length) {
        window.clearInterval(timer);
        setDone(true);
      }
    }, 72);

    return () => window.clearInterval(timer);
  }, [ready, text]);

  if (!ready) return null;

  // Keep the trailing caret/dot glued to the last characters so it never wraps alone.
  const glueCount = Math.min(2, shown.length);
  const head = shown.slice(0, shown.length - glueCount);
  const tail = shown.slice(shown.length - glueCount);

  return (
    <p className="whitespace-nowrap text-xl font-medium tracking-tight text-muted-foreground">
      {head ? <span>{head}</span> : null}
      <span>
        {tail}
        {!done ? (
          <span className="rag-welcome-caret" aria-hidden />
        ) : (
          <span
            className="rag-oc-status-dot ml-2.5 align-middle"
            title="能元已连接"
            aria-label="能元已连接"
          />
        )}
      </span>
    </p>
  );
}

type Source = {
  id?: string;
  label?: string;
  title: string;
  fileName?: string;
  sourceType: string;
  sourceKey: string;
  fileKey?: string;
  filePath?: string;
  fileKind?: 'pdf' | 'markdown' | 'text' | 'none';
  previewUrl?: string;
  snippet: string;
  score: number;
  matchReason?: string;
  corpusPath?: string;
  pathAliases?: string[];
  url?: string;
  evidenceIds?: string[];
};

function isLinkSource(source: Source) {
  return source.sourceType === 'link'
    || /^L\d+$/i.test(String(source.id || ''))
    || /^https?:\/\//i.test(String(source.url || source.previewUrl || source.filePath || ''));
}

function linkSourceUrl(source: Source) {
  const candidate = source.url || source.previewUrl || source.filePath || '';
  return /^https?:\/\//i.test(candidate) ? candidate : '';
}

type ResearchReviewArtifact = {
  id: string;
  conversationId: string;
  messageId: string;
  fileName: string;
  byteSize: number;
  reportTitle: string;
  qualityScore: number;
  qualityMax: number;
  qualityOk: boolean;
  createdAt: string;
  downloadUrl: string;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
  artifacts?: ResearchReviewArtifact[];
  sources?: Source[];
  graphSeedIds?: string[];
  agentSteps?: AgentStep[];
  thinkingDurationMs?: number;
  startedAt?: number;
  createdAt?: string;
  contextUsage?: ModelContextUsage;
  inProgress?: boolean;
};
type Conversation = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messageCount?: number;
  generating?: boolean;
};

type ChatAttachment = {
  id: string;
  conversationId: string;
  messageId?: string;
  name: string;
  mediaType: string;
  extension: string;
  size: number;
  status: 'processing' | 'ready' | 'failed';
  error?: string;
  metadata?: Record<string, unknown>;
  previewUrl: string;
  downloadUrl: string;
  createdAt: string;
  deduplicated?: boolean;
};

type PendingAttachmentStatus = 'queued' | 'uploading' | 'processing' | 'ready' | 'failed' | 'removing';

type PendingAttachment = {
  clientId: string;
  file: File;
  name: string;
  extension: string;
  mediaType: string;
  size: number;
  status: PendingAttachmentStatus;
  progress: number;
  error?: string;
  attachment?: ChatAttachment;
};

type AgentStep = {
  type: 'thought' | 'plan' | 'public_text' | 'tool_call' | 'observation' | 'synthesis';
  step: number;
  tool?: string;
  input?: Record<string, unknown>;
  content: string;
  durationMs?: number;
};

type StreamEvent =
  | {
      type: 'meta';
      conversationId: string;
      title: string;
      sources: Source[];
      graphSeedIds: string[];
      confidence?: 'high' | 'medium' | 'low';
      intent?: string;
      trace?: Partial<ModelContextUsage> & { totalDurationMs?: number };
      agentSteps?: AgentStep[];
    }
  | { type: 'status'; phase: string; detail: string; message?: string }
  | { type: 'agent_step'; step: AgentStep }
  | { type: 'context_usage'; usage: ModelContextUsage }
  | { type: 'chunk'; content: string }
  | { type: 'answer_reset' }
  | { type: 'answer_replace'; content: string }
  | { type: 'artifact'; artifact: ResearchReviewArtifact }
  | {
      type: 'done';
      conversationId?: string;
      metrics?: Partial<ModelContextUsage> & { totalDurationMs?: number };
      artifact?: ResearchReviewArtifact;
    }
  | { type: 'error'; error: string };


const initialMessages: ChatMessage[] = [
  {
    id: 'welcome',
    role: 'assistant',
    content:
      '**科研传承助手**已就绪。\n\n上传文献包后发起综述请求：生成过程会流式展示；完成后对话区只保留简短说明。Word 报告请到右侧「附件查看」下载。'
  }
];

function unescapeLlmMathDelimiters(content: string) {
  return content
    .replace(/\\\\\[/g, '\\[')
    .replace(/\\\\\]/g, '\\]')
    .replace(/\\\\\(/g, '\\(')
    .replace(/\\\\\)/g, '\\)');
}

function convertLatexDelimiters(content: string) {
  return content
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `\n$$\n${String(math).trim()}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => `$${String(math).trim()}$`);
}

function protectCurrencyDollars(content: string) {
  return content
    .replace(/\\\$/g, '§DOLLAR§')
    .replace(/(?<!\\)(?<!\$)\$(?=\d)/g, '\\$');
}

function restoreEscapedDollars(content: string) {
  return content.replace(/§DOLLAR§/g, '\\$');
}

function sealIncompleteMathDelimiters(content: string) {
  let open = 0;
  let index = 0;
  while (index < content.length) {
    if (content[index] === '\\' && (content[index + 1] === '$' || content[index + 1] === '(' || content[index + 1] === '[')) {
      index += 2;
      continue;
    }
    if (content[index] === '$') {
      let markerCount = 0;
      while (index < content.length && content[index] === '$') {
        markerCount += 1;
        index += 1;
      }
      if (open === 0) open = markerCount;
      else if (markerCount === open) open = 0;
      continue;
    }
    index += 1;
  }
  let sealed = open > 0 ? `${content}${'$'.repeat(open)}` : content;
  const openParen = (sealed.match(/\\\(/g) || []).length - (sealed.match(/\\\)/g) || []).length;
  if (openParen > 0) sealed += '\\)'.repeat(openParen);
  const openBracket = (sealed.match(/\\\[/g) || []).length - (sealed.match(/\\\]/g) || []).length;
  if (openBracket > 0) sealed += '\\]'.repeat(openBracket);
  return sealed;
}

function prepareMathMarkdown(content: string, streaming = false) {
  let text = unescapeLlmMathDelimiters(content);
  text = protectCurrencyDollars(text);
  text = convertLatexDelimiters(text);
  text = restoreEscapedDollars(text);
  if (streaming) text = sealIncompleteMathDelimiters(text);
  return text;
}

function normalizeMarkdown(content: string, streaming = false) {
  return prepareMathMarkdown(content, streaming)
    .replace(/\*\*\*\*/g, '**')
    .replace(/(\*\*[^*\n]+[：:；;]\*\*)(?=\S)/g, '$1 ');
}

function isMathCodeClass(className: unknown) {
  return typeof className === 'string' && (className.includes('math-inline') || className.includes('math-display') || className.includes('language-math'));
}

/** Ensure web URLs in the answer become L1/L2 sources even if the server missed them. */
function enrichSourcesWithLinks(content: string, sources: Source[] = []): Source[] {
  const urls = extractLinkCitations(content);
  if (!urls.length) return sources;

  const byUrl = new Map<string, Source>();
  let maxL = 0;
  for (const source of sources) {
    const idMatch = String(source.id || '').match(/^L(\d+)$/i);
    if (idMatch) maxL = Math.max(maxL, Number(idMatch[1]));
    if (!isLinkSource(source)) continue;
    const url = normalizeCitationUrl(linkSourceUrl(source));
    if (url) byUrl.set(url, source);
  }

  const extras: Source[] = [];
  for (const url of urls) {
    const key = normalizeCitationUrl(url);
    if (!key || byUrl.has(key)) continue;
    maxL += 1;
    const [built] = resolveLinkCitations([url], maxL);
    if (!built) continue;
    const next: Source = { ...built, id: `L${maxL}`, label: `L${maxL}`, fileKey: `link:L${maxL}`, evidenceIds: [`L${maxL}`] };
    extras.push(next);
    byUrl.set(key, next);
  }
  return extras.length ? [...sources, ...extras] : sources;
}

function linkifyCitations(content: string, sources: Source[] = []) {
  return linkifyOpenCodeCitations(content, enrichSourcesWithLinks(content, sources));
}

function assistantMessageSources(message: Pick<ChatMessage, 'content' | 'sources'>) {
  return enrichSourcesWithLinks(message.content || '', message.sources || []);
}

function truncateTitle(title: string, max = 42) {
  const compact = title.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function findSourceByCitationId(sources: Source[], citationId: string) {
  const normalized = citationId.toUpperCase();
  const direct = sources.find((source) =>
    String(source.id || '').toUpperCase() === normalized
    || (source.evidenceIds || []).some((id) => id.toUpperCase() === normalized)
  );
  if (direct) return direct;

  const pathCite = parsePathCitationId(citationId);
  if (!pathCite) return undefined;
  return findSourceForPath(
    sources,
    pathCite.path,
    String(pathCite.startLine),
    String(pathCite.endLine)
  );
}

function chipLabel(source: Source) {
  return source.fileName || truncateTitle(source.title, 32);
}

function citationLabel(source: Source) {
  if (source.label) return source.label;
  if (source.id) return source.id;
  return isLinkSource(source) ? 'L?' : 'E?';
}

function salvageAnswerFromSteps(steps?: AgentStep[]) {
  if (!steps?.length) return '';
  const texts = steps
    .filter((step) => step.type === 'public_text')
    .map((step) => String(step.content || '').trim())
    .filter(Boolean);
  return texts[texts.length - 1] || '';
}

function normalizeStreamError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err || '查询失败');
  if (
    /failed to fetch|networkerror|network error|load failed|err_network|econnreset|fetch failed|networkerror when attempting to fetch/i.test(message)
    || /^network$/i.test(message.trim())
    || /网络异常|网络请求失败|连接.*中断|ERR_CONNECTION/i.test(message)
  ) {
    return '网络异常，连接已中断。请重试；若长时间工具检索中断开，可再发一次相同问题。';
  }
  if (/aborted|abort/i.test(message) && !/取消|停止/.test(message)) {
    return '请求已中断。';
  }
  return message || '查询失败';
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className={`ml-auto h-3.5 w-3.5 shrink-0 text-slate-400 transition ${expanded ? 'rotate-180' : ''}`}
      aria-hidden
    >
      <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.25a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z" clipRule="evenodd" />
    </svg>
  );
}

function EvidenceChip({ source, onClick, compact = false }: { source: Source; onClick: () => void; compact?: boolean }) {
  const link = isLinkSource(source);
  const badgeClass = link
    ? (compact ? 'text-blue-800' : 'text-blue-300')
    : (compact ? 'text-emerald-800' : 'text-emerald-300');
  if (compact) {
    return (
      <button type="button" onClick={onClick} className="rag-evidence-chip-compact" title={`${citationLabel(source)} · ${source.title}`}>
        <span className={`shrink-0 font-semibold ${badgeClass}`}>{citationLabel(source)}</span>
        <span className="truncate">{chipLabel(source)}</span>
      </button>
    );
  }
  return (
    <button type="button" onClick={onClick} className="rag-evidence-chip" title={`${citationLabel(source)} · ${source.title}`}>
      <span className={`shrink-0 font-semibold ${badgeClass}`}>{citationLabel(source)}</span>
      <span className="truncate text-slate-300">{chipLabel(source)}</span>
    </button>
  );
}

function ResearchArtifactCard({
  artifact,
  onDownload,
  compact = false
}: {
  artifact: ResearchReviewArtifact;
  onDownload: (artifact: ResearchReviewArtifact) => void;
  compact?: boolean;
}) {
  const sizeLabel = formatAttachmentSize(artifact.byteSize);
  return (
    <button
      type="button"
      onClick={() => onDownload(artifact)}
      className={`flex w-full items-start gap-3 rounded-xl border border-border bg-background text-left transition hover:border-primary/40 hover:bg-accent/40 ${
        compact ? 'px-3 py-2.5' : 'px-3.5 py-3'
      }`}
      title={`下载 ${artifact.fileName}`}
    >
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-700">
        <FileText className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {artifact.reportTitle || artifact.fileName}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
          {artifact.fileName} · {sizeLabel}
        </span>
      </span>
      <Download className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function CollapsibleReferences({
  sources,
  onSourceClick
}: {
  sources: Source[];
  onSourceClick: (source: Source) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!sources.length) return null;

  return (
    <div className="rag-refs-block mt-3 border-t border-slate-100 pt-2">
      <button type="button" onClick={() => setExpanded((value) => !value)} className="rag-refs-toggle">
        <span>参考文献</span>
        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{sources.length}</span>
        <ChevronIcon expanded={expanded} />
      </button>
      {!expanded ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {sources.slice(0, 4).map((source) => (
            <EvidenceChip key={`compact-${source.id || source.sourceKey}`} source={source} onClick={() => onSourceClick(source)} compact />
          ))}
          {sources.length > 4 ? <span className="px-1 text-[10px] text-slate-400">+{sources.length - 4}</span> : null}
        </div>
      ) : (
        <div className="mt-2 space-y-1.5">
          {sources.map((source) => (
            <button
              key={`expanded-${source.id || source.sourceKey}`}
              type="button"
              onClick={() => onSourceClick(source)}
              className="rag-evidence-row"
            >
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  isLinkSource(source) ? 'bg-blue-100 text-blue-800' : 'bg-emerald-100 text-emerald-800'
                }`}
              >
                {citationLabel(source)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-slate-800">{chipLabel(source)}</span>
                {source.snippet ? <span className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-slate-500">{source.snippet}</span> : null}
                {source.matchReason ? <span className="mt-0.5 block text-[10px] text-emerald-600">{source.matchReason}</span> : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EvidenceModal({ source, onClose }: { source: Source; onClose: () => void }) {
  const [previewKind, setPreviewKind] = useState<'pdf' | 'markdown' | 'text' | 'loading' | 'error'>('loading');
  const [previewContent, setPreviewContent] = useState('');
  const [previewError, setPreviewError] = useState('');

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    async function loadPreview() {
      if (!source.previewUrl) {
        setPreviewKind('text');
        setPreviewContent(source.snippet || '暂无预览内容。');
        return;
      }

      if (source.fileKind === 'pdf') {
        setPreviewKind('pdf');
        return;
      }

      try {
        const response = await fetch(source.previewUrl);
        if (!response.ok) throw new Error('预览加载失败');
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/pdf')) {
          if (!cancelled) setPreviewKind('pdf');
          return;
        }
        const payload = await response.json() as { kind?: string; content?: string; error?: string };
        if (payload.error) throw new Error(payload.error);
        if (!cancelled) {
          setPreviewKind(payload.kind === 'markdown' ? 'markdown' : 'text');
          setPreviewContent(payload.content || source.snippet || '');
        }
      } catch (error) {
        if (!cancelled) {
          setPreviewKind('error');
          setPreviewError(error instanceof Error ? error.message : '预览失败');
        }
      }
    }

    setPreviewKind('loading');
    setPreviewContent('');
    setPreviewError('');
    loadPreview();
    return () => {
      cancelled = true;
    };
  }, [source]);

  const previewSrc = source.previewUrl || '';

  return (
    <div className="rag-evidence-modal-backdrop" onClick={onClose}>
      <div className="rag-evidence-modal rag-evidence-modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                  isLinkSource(source) ? 'bg-blue-100 text-blue-800' : 'bg-emerald-100 text-emerald-800'
                }`}
              >
                {citationLabel(source)}
              </span>
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-600">{source.fileKind || source.sourceType}</span>
              {source.evidenceIds?.length ? (
                <span className="text-[11px] text-slate-400">引用 {source.evidenceIds.join('、')}</span>
              ) : null}
            </div>
            <h3 className="mt-2 text-base font-semibold leading-6 text-slate-900">{chipLabel(source)}</h3>
            <p className="mt-1 text-xs text-slate-500">{source.title}</p>
            {source.matchReason ? <p className="mt-1 text-xs text-emerald-600">{source.matchReason}</p> : null}
          </div>
          <div className="flex items-center gap-2">
            {previewSrc ? (
              <a href={previewSrc} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">新窗口打开</a>
            ) : null}
            <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-50">关闭</button>
          </div>
        </div>
        <div className="max-h-[calc(min(86vh,820px)-88px)] overflow-hidden">
          {previewKind === 'loading' ? (
            <div className="px-5 py-10 text-center text-sm text-slate-500">正在加载文件预览…</div>
          ) : null}
          {previewKind === 'error' ? (
            <div className="px-5 py-10 text-center text-sm text-rose-600">{previewError}</div>
          ) : null}
          {previewKind === 'pdf' && previewSrc ? (
            <iframe title={source.title} src={previewSrc} className="h-[calc(min(86vh,820px)-88px)] w-full bg-slate-100" />
          ) : null}
          {previewKind === 'markdown' ? (
            <div className="max-h-[calc(min(86vh,820px)-88px)] overflow-y-auto px-5 py-4">
              <MessageContent content={previewContent} />
            </div>
          ) : null}
          {previewKind === 'text' ? (
            <div className="max-h-[calc(min(86vh,820px)-88px)] overflow-y-auto px-5 py-4">
              <pre className="whitespace-pre-wrap text-sm leading-7 text-slate-700">{previewContent}</pre>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function attachmentExtension(name: string) {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

function pendingAttachmentStatusLabel(attachment: PendingAttachment) {
  if (attachment.status === 'queued') return '等待上传';
  if (attachment.status === 'uploading') return `上传中 ${attachment.progress}%`;
  if (attachment.status === 'processing') return '正在解析';
  if (attachment.status === 'ready') return '已就绪';
  if (attachment.status === 'removing') return '正在删除';
  return attachment.error || '上传失败';
}

function AttachmentPreviewModal({ attachment, onClose }: { attachment: ChatAttachment; onClose: () => void }) {
  const [previewKind, setPreviewKind] = useState<'pdf' | 'markdown' | 'text' | 'loading' | 'error'>('loading');
  const [previewContent, setPreviewContent] = useState('');
  const [previewTitle, setPreviewTitle] = useState(attachment.name);
  const [previewError, setPreviewError] = useState('');

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;

    async function loadPreview() {
      if (attachment.status !== 'ready') {
        setPreviewKind('error');
        setPreviewError(attachment.error || '附件尚未准备好。');
        return;
      }
      if (attachment.extension.toLowerCase() === '.pdf') {
        setPreviewKind('pdf');
        return;
      }
      try {
        const response = await fetch(attachment.previewUrl);
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok) {
          const payload = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(payload.error || '附件预览加载失败');
        }
        if (contentType.includes('application/pdf')) {
          if (!cancelled) setPreviewKind('pdf');
          return;
        }
        const payload = await response.json() as {
          kind?: string;
          title?: string;
          fileName?: string;
          content?: string;
          error?: string;
        };
        if (payload.error) throw new Error(payload.error);
        if (!cancelled) {
          setPreviewKind(payload.kind === 'markdown' ? 'markdown' : 'text');
          setPreviewTitle(payload.title || payload.fileName || attachment.name);
          setPreviewContent(payload.content || '');
        }
      } catch (error) {
        if (!cancelled) {
          setPreviewKind('error');
          setPreviewError(error instanceof Error ? error.message : '附件预览失败');
        }
      }
    }

    setPreviewKind('loading');
    setPreviewContent('');
    setPreviewTitle(attachment.name);
    setPreviewError('');
    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [attachment]);

  return (
    <div className="rag-evidence-modal-backdrop" onClick={onClose}>
      <div
        className="rag-evidence-modal rag-evidence-modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={`预览附件 ${attachment.name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700">
                {attachmentTypeLabel(attachment)}
              </span>
              <span className="text-[11px] text-slate-400">{formatAttachmentSize(attachment.size)}</span>
            </div>
            <h3 className="mt-2 truncate text-base font-semibold leading-6 text-slate-900">{previewTitle}</h3>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <a href={attachment.downloadUrl || (attachment.previewUrl.includes('?') ? `${attachment.previewUrl}&download=1` : `${attachment.previewUrl}?download=1`)} className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">
              下载
            </a>
            <a href={attachment.previewUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">
              新窗口打开
            </a>
            <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-50">
              关闭
            </button>
          </div>
        </div>
        <div className="max-h-[calc(min(86vh,820px)-88px)] overflow-hidden">
          {previewKind === 'loading' ? <div className="px-5 py-10 text-center text-sm text-slate-500">正在加载附件预览…</div> : null}
          {previewKind === 'error' ? <div className="px-5 py-10 text-center text-sm text-rose-600">{previewError}</div> : null}
          {previewKind === 'pdf' ? (
            <iframe title={attachment.name} src={attachment.previewUrl} className="h-[calc(min(86vh,820px)-88px)] w-full bg-slate-100" />
          ) : null}
          {previewKind === 'markdown' ? (
            <div className="max-h-[calc(min(86vh,820px)-88px)] overflow-y-auto px-5 py-4">
              <MessageContent content={previewContent} />
            </div>
          ) : null}
          {previewKind === 'text' ? (
            <div className="max-h-[calc(min(86vh,820px)-88px)] overflow-y-auto px-5 py-4">
              <pre className="whitespace-pre-wrap text-sm leading-7 text-slate-700">{previewContent}</pre>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}


/** Excel 式自动列宽：按列内「表头 + 单元格」最宽内容测算，超长列封顶后换行。 */
function autofitMarkdownTable(table: HTMLTableElement, containerWidth: number) {
  table.querySelectorAll('colgroup[data-autofit]').forEach((node) => node.remove());
  table.style.tableLayout = 'auto';
  table.style.width = 'max-content';

  const rows = Array.from(table.rows);
  if (!rows.length) return;

  let colCount = 0;
  for (const row of rows) {
    let count = 0;
    for (const cell of Array.from(row.cells)) count += cell.colSpan || 1;
    colCount = Math.max(colCount, count);
  }
  if (!colCount) return;

  const cells = Array.from(table.querySelectorAll('th, td')) as HTMLTableCellElement[];
  const prevWhiteSpace = cells.map((cell) => cell.style.whiteSpace);
  const prevMaxWidth = cells.map((cell) => cell.style.maxWidth);
  const prevWidth = cells.map((cell) => cell.style.width);

  for (const cell of cells) {
    cell.style.whiteSpace = 'nowrap';
    cell.style.maxWidth = 'none';
    cell.style.width = 'auto';
  }

  const widths = Array.from({ length: colCount }, () => 0);
  for (const row of rows) {
    let colIndex = 0;
    for (const cell of Array.from(row.cells)) {
      const span = cell.colSpan || 1;
      const contentWidth = Math.ceil(cell.scrollWidth);
      if (span <= 1) {
        widths[colIndex] = Math.max(widths[colIndex], contentWidth);
      } else {
        const share = Math.ceil(contentWidth / span);
        for (let i = 0; i < span; i += 1) {
          widths[colIndex + i] = Math.max(widths[colIndex + i], share);
        }
      }
      colIndex += span;
    }
  }

  cells.forEach((cell, index) => {
    cell.style.whiteSpace = prevWhiteSpace[index];
    cell.style.maxWidth = prevMaxWidth[index];
    cell.style.width = prevWidth[index];
  });

  // Excel AutoFit：最小约 2 字符宽，最大约 40 字符宽（随容器收紧）
  const minCol = 40;
  const maxCol = Math.max(120, Math.min(420, Math.floor(Math.max(containerWidth, 240) * 0.56)));
  const breathing = 2;
  let fitted = widths.map((width) => Math.min(maxCol, Math.max(minCol, width + breathing)));

  const total = fitted.reduce((sum, width) => sum + width, 0);
  if (total > 0 && containerWidth > 0 && total < containerWidth) {
    // 总宽不足容器时按比例匀摊多余空间，避免短表右侧留白
    const scale = containerWidth / total;
    fitted = fitted.map((width) => Math.max(minCol, Math.floor(width * scale)));
    const rounded = fitted.reduce((sum, width) => sum + width, 0);
    if (rounded < containerWidth) fitted[fitted.length - 1] += containerWidth - rounded;
  }

  const colgroup = document.createElement('colgroup');
  colgroup.setAttribute('data-autofit', '1');
  for (const width of fitted) {
    const col = document.createElement('col');
    col.style.width = `${width}px`;
    colgroup.appendChild(col);
  }
  table.insertBefore(colgroup, table.firstChild);
  table.style.tableLayout = 'fixed';
  table.style.width = `${fitted.reduce((sum, width) => sum + width, 0)}px`;
}

function MarkdownTable({ children }: { children?: ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  useLayoutEffect(() => {
    const table = tableRef.current;
    const wrap = wrapRef.current;
    if (!table || !wrap) return;

    let frame = 0;
    let fitting = false;

    const run = () => {
      if (fitting) return;
      fitting = true;
      try {
        autofitMarkdownTable(table, wrap.clientWidth);
      } finally {
        fitting = false;
      }
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        run();
      });
    };

    run();

    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(wrap);

    const mutationObserver = new MutationObserver((mutations) => {
      if (mutations.every((mutation) => {
        const target = mutation.target as Node;
        if (target instanceof Element && target.closest('colgroup[data-autofit]')) return true;
        if (mutation.type === 'childList') {
          const nodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
          if (nodes.length && nodes.every((node) => node instanceof Element && node.matches?.('colgroup[data-autofit]'))) {
            return true;
          }
        }
        return false;
      })) {
        return;
      }
      schedule();
    });
    mutationObserver.observe(table, { childList: true, subtree: true, characterData: true });

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [children]);

  return (
    <div ref={wrapRef} className="rag-md-table-wrap">
      <table ref={tableRef} className="rag-md-table text-sm">
        {children}
      </table>
    </div>
  );
}

function MessageContent({
  content,
  streaming = false,
  sources = [],
  onCitationClick
}: {
  content: string;
  streaming?: boolean;
  sources?: Source[];
  onCitationClick?: (id: string) => void;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[[remarkMath, { singleDollarTextMath: true }], remarkGfm]}
      rehypePlugins={[rehypeKatex]}
      components={{
        table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
        thead: ({ children }) => <thead className="bg-slate-50">{children}</thead>,
        th: ({ children }) => (
          <th className="px-3 py-2 text-left text-xs font-semibold text-slate-600">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border-t border-slate-100 px-3 py-2 align-top text-sm">
            {children}
          </td>
        ),
        h1: ({ children }) => <h1 className="mb-2 mt-3 text-base font-semibold leading-7 text-slate-900 first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-3 text-[15px] font-semibold leading-7 text-slate-900 first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-1.5 mt-2.5 text-sm font-semibold leading-6 text-slate-800 first:mt-0">{children}</h3>,
        h4: ({ children }) => <h4 className="mb-1.5 mt-2 text-sm font-medium leading-6 text-slate-800 first:mt-0">{children}</h4>,
        p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0 leading-7">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,
        ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
        a: ({ href, children }) => {
          if (href?.startsWith('#cite-') && onCitationClick) {
            const id = href.replace('#cite-', '');
            const linkCite = /^L\d+$/i.test(id);
            return (
              <button
                type="button"
                onClick={() => onCitationClick(id)}
                className={linkCite ? 'rag-citation-link rag-citation-link-web' : 'rag-citation-link'}
              >
                {children}
              </button>
            );
          }
          if (href && /^https?:\/\//i.test(href)) {
            return (
              <a href={href} target="_blank" rel="noreferrer" className="font-medium text-blue-800 underline">
                {children}
              </a>
            );
          }
          return <a href={href} className="font-medium text-emerald-800 underline">{children}</a>;
        },
        code: ({ className, children, ...props }) => (
          isMathCodeClass(className)
            ? <code className={className} {...props}>{children}</code>
            : <code className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[0.9em] text-emerald-700">{children}</code>
        )
      }}
    >
      {linkifyCitations(normalizeMarkdown(content, streaming), sources)}
    </ReactMarkdown>
  );
}

function maxEvidenceNumber(messages: ChatMessage[]) {
  let max = 0;
  for (const message of messages) {
    for (const source of message.sources || []) {
      const match = String(source.id || '').match(/^E(\d+)$/i);
      if (match) max = Math.max(max, Number(match[1]));
    }
    for (const match of message.content.matchAll(/\[E(\d+)\]/gi)) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max;
}

function TypingIndicator({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const dot = size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2';
  return (
    <span className="inline-flex items-center gap-1.5 py-0.5" role="status" aria-label="正在生成">
      <span className={`${dot} animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.2s]`} />
      <span className={`${dot} animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.1s]`} />
      <span className={`${dot} animate-bounce rounded-full bg-muted-foreground/50`} />
    </span>
  );
}

/** 滑块任意位置；程序按 0–25 关思考 / 25–50 xhigh / 50+ 大模型 四档路由。 */
function ReasoningEffortSlider({
  value,
  onChange,
  locked = false
}: {
  value: number;
  onChange: (value: number) => void;
  locked?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [liveValue, setLiveValue] = useState<number | null>(null);
  const ratio = Math.min(1, Math.max(0, locked ? value : (liveValue ?? value)));
  const high = ratio >= 0.5;

  function ratioFromClientX(clientX: number) {
    const track = trackRef.current;
    if (!track) return ratio;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return ratio;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (locked || event.button !== 0) return;
    event.preventDefault();
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = ratioFromClientX(event.clientX);
    setLiveValue(next);
    onChange(next);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (locked || !draggingRef.current) return;
    const next = ratioFromClientX(event.clientX);
    setLiveValue(next);
    onChange(next);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (locked || !draggingRef.current) return;
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const next = ratioFromClientX(event.clientX);
    setLiveValue(null);
    onChange(next);
  }

  function onPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setLiveValue(null);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (locked) return;
    const step = 0.05;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      onChange(Math.min(1, ratio + step));
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      onChange(Math.max(0, ratio - step));
    } else if (event.key === 'Home') {
      event.preventDefault();
      onChange(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      onChange(1);
    }
  }

  return (
    <div
      className={`rag-reasoning-slot ${locked ? 'rag-reasoning-slot-locked' : ''} ${!locked && liveValue != null ? 'rag-reasoning-slot-dragging' : ''}`}
    >
      <span className="rag-reasoning-slot-title">推理强度</span>
      <div className="rag-reasoning-slot-body">
        <div
          ref={trackRef}
          className="rag-reasoning-slot-track"
          role={locked ? 'progressbar' : 'slider'}
          tabIndex={locked ? -1 : 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
          aria-valuetext={high ? '极高' : '默认'}
          aria-label="推理强度"
          aria-disabled={locked || undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onKeyDown={onKeyDown}
        >
          <div
            className="rag-reasoning-slot-aurora"
            style={locked ? { width: `${ratio * 100}%` } : undefined}
            aria-hidden="true"
          >
            <span className="rag-reasoning-slot-aurora-blob rag-reasoning-slot-aurora-blob-a" />
            <span className="rag-reasoning-slot-aurora-blob rag-reasoning-slot-aurora-blob-b" />
            <span className="rag-reasoning-slot-aurora-blob rag-reasoning-slot-aurora-blob-c" />
          </div>
          {!locked ? (
            <div
              className="rag-reasoning-slot-unfilled"
              style={{ left: `${ratio * 100}%` }}
              aria-hidden="true"
            />
          ) : null}
          {!locked ? (
            <div
              className="rag-reasoning-slot-thumb"
              style={{ left: `clamp(0px, calc(${ratio * 100}% - 11px), calc(100% - 22px))` }}
            />
          ) : null}
        </div>
        {!locked ? (
          <div className="rag-reasoning-slot-ends">
            <span>默认</span>
            <span>极高</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const HIDDEN_THOUGHT_PATTERNS = [
  /启动\s*ReAct\s*循环/,
  /根据会话工作记忆与问题目标/,
  /证据收集完成/,
  /证据账本/,
  /已达步数上限/
];

function normalizeThoughtText(content: string) {
  return content
    .replace(/^规则兜底[:：]\s*/, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain-text display for thinking prose — strip markdown that would look like mixed sizes. */
function sanitizeThoughtDisplay(content: string) {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .trim();
}

function visibleAgentSteps(steps: AgentStep[]) {
  return steps.filter((step) => {
    if (step.type === 'thought' && HIDDEN_THOUGHT_PATTERNS.some((pattern) => pattern.test(step.content))) {
      return false;
    }
    if (step.type === 'tool_call' && !step.tool) return false;
    if (step.type === 'observation' && /^【系统】/.test(step.content)) return false;
    return true;
  });
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function fileLabel(value: string) {
  const normalized = value.replace(/\\/g, '/').trim();
  if (!normalized) return '';
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

function truncateDetail(value: string, max = 56) {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

function summarizeThinkStep(step: AgentStep): { verb: string; detail: string } | null {
  if (step.type === 'tool_call' && step.tool) {
    const input = step.input || {};
    const tool = step.tool;
    const contentFallback = (() => {
      const content = String(step.content || '').replace(/\s+/g, ' ').trim();
      if (!content) return '';
      // Prefer "skill：patent-disclosure" style payload from runtime.
      const stripped = content.replace(new RegExp(`^(调用\\s+)?${tool}：?`, 'i'), '').trim();
      return truncateDetail(stripped || content, 64);
    })();
    if (tool === 'read') {
      const target = fileLabel(String(input.path || input.filePath || input.file || '')) || contentFallback;
      const offset = input.offset != null ? Number(input.offset) : NaN;
      const limit = input.limit != null ? Number(input.limit) : NaN;
      let range = '';
      if (Number.isFinite(offset) && Number.isFinite(limit) && limit > 0) {
        range = ` L${offset}-${offset + limit - 1}`;
      } else if (Number.isFinite(offset)) {
        range = ` L${offset}+`;
      }
      return { verb: '读取', detail: `${target || '文件'}${range}` };
    }
    if (tool === 'grep') {
      const pattern = String(input.pattern || input.query || '') || contentFallback;
      const where = fileLabel(String(input.path || input.include || input.glob || '')) || '工作区';
      return { verb: '检索', detail: `${truncateDetail(pattern, 42)} @ ${where}` };
    }
    if (tool === 'glob') {
      const pattern = String(input.pattern || input.glob || '*') || contentFallback;
      const where = fileLabel(String(input.path || '')) || '工作区';
      return { verb: '匹配', detail: `${truncateDetail(pattern, 42)} @ ${where}` };
    }
    if (tool === 'list') {
      return { verb: '列出', detail: fileLabel(String(input.path || '.')) || contentFallback || '.' };
    }
    if (tool === 'bash') {
      return { verb: '执行', detail: truncateDetail(String(input.command || input.cmd || contentFallback || 'command'), 52) };
    }
    if (tool === 'skill') {
      const name = String(input.name || input.skill || input.id || '') || contentFallback;
      return { verb: '技能', detail: name || 'patent-*' };
    }
    if (tool === 'write' || tool === 'edit') {
      const target = fileLabel(String(input.path || input.filePath || input.file || '')) || contentFallback;
      return { verb: tool === 'write' ? '写入' : '编辑', detail: target || '文件' };
    }
    const web = summarizeWebTool(tool, input, contentFallback);
    if (web) return { verb: web.verb, detail: truncateDetail(web.detail, 96) };
    const fallback = truncateDetail(
      String(input.url || input.path || input.filePath || input.pattern || input.query || input.command || input.name || '')
        || contentFallback,
      48
    );
    return { verb: tool, detail: fallback };
  }

  return null;
}

function thoughtText(step: AgentStep) {
  if (step.type === 'thought') return sanitizeThoughtDisplay(normalizeThoughtText(step.content));
  if (step.type === 'plan' || step.type === 'synthesis' || step.type === 'public_text') {
    return sanitizeThoughtDisplay(step.content);
  }
  return '';
}

function ThinkingStreamLine({ step, active }: { step: AgentStep; active?: boolean }) {
  const prose = thoughtText(step);
  if (prose || (step.type === 'thought' && active)) {
    return (
      <div className={`rag-oc-prose ${active ? 'rag-oc-prose-active' : ''}`}>
        <div className="rag-oc-prose-body" aria-busy={active || undefined}>
          {prose || '正在思考…'}
        </div>
      </div>
    );
  }

  const summary = summarizeThinkStep(step);
  if (!summary) return null;
  return (
    <div className={`rag-oc-tool ${active ? 'rag-oc-tool-active' : ''}`} aria-busy={active || undefined}>
      <span className="rag-oc-tool-verb">{summary.verb}</span>
      {summary.detail ? <span className="rag-oc-tool-detail">{summary.detail}</span> : null}
    </div>
  );
}

function transcriptSteps(steps: AgentStep[]) {
  return visibleAgentSteps(steps)
    .filter((step) => step.type !== 'observation')
    .filter((step) => step.type === 'thought' || thoughtText(step) || summarizeThinkStep(step));
}

/** After the turn: keep tools and process thoughts; drop only the post-tool reply. */
function thinkingStepsAfterTurn(steps: AgentStep[]) {
  let lastToolIndex = -1;
  for (let index = 0; index < steps.length; index += 1) {
    if (steps[index]?.type === 'tool_call') lastToolIndex = index;
  }
  if (lastToolIndex < 0) {
    return steps.filter((step) => step.type === 'thought' || step.type === 'plan');
  }
  return steps.filter((step, index) => {
    if (index <= lastToolIndex) return true;
    if (step.type === 'observation') return true;
    if (step.type === 'thought' || step.type === 'plan') return true;
    return false;
  });
}

/** Live OpenCode-style timeline: text and tools in one stream, no think/answer split. */
function AgentLiveTranscript({
  steps,
  status,
  startedAt,
  createdAt
}: {
  steps: AgentStep[];
  status?: string;
  startedAt?: number;
  createdAt?: string;
}) {
  const now = useNow(true);
  const clock = formatThinkingClock(
    resolveThinkingDurationMs({ startedAt, now, createdAt, running: true }),
    1
  );
  const rendered = transcriptSteps(steps);
  return (
    <div className="rag-oc-live" aria-busy="true">
      <div className="rag-oc-live-label rag-think-label-shimmer">已运行 {clock}</div>
      <div className="rag-oc-stream">
        {rendered.length ? rendered.map((step, index) => (
          <ThinkingStreamLine
            key={`${step.step}-${step.type}-${index}`}
            step={step}
            active={index === rendered.length - 1}
          />
        )) : (
          <div className="rag-oc-prose rag-oc-prose-active">
            <div className="rag-oc-prose-body" aria-busy="true">
              {status || '正在分析…'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * After the turn completes: collapsed chain (everything before the final reply).
 * Split is done server-side as “text after the last tool” — same heuristic as OpenCode’s
 * final assistant message after tool rounds.
 */
function ThinkingBlock({
  steps,
  durationMs,
  startedAt,
  createdAt,
  previousCreatedAt,
  running
}: {
  steps: AgentStep[];
  durationMs?: number;
  startedAt?: number;
  createdAt?: string;
  previousCreatedAt?: string;
  running?: boolean;
}) {
  const rendered = transcriptSteps(steps);
  const [expanded, setExpanded] = useState(false);
  const now = useNow(Boolean(running));

  if (!rendered.length) return null;

  const resolvedMs = resolveThinkingDurationMs({
    durationMs,
    startedAt,
    now,
    createdAt,
    previousCreatedAt,
    running
  });
  const clock = formatThinkingClock(resolvedMs, 1);
  const label = `已运行 ${clock}`;

  return (
    <div className={`rag-think ${expanded ? 'rag-think-open' : ''}`}>
      <button
        type="button"
        className="rag-think-toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={expanded ? `收起思维链，${label}` : `展开思维链，${label}`}
      >
        <span className="rag-think-label">{label}</span>
        <ChevronDown className={`rag-think-chevron ${expanded ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      <RagThinkCollapse open={expanded}>
        <div className="rag-oc-stream rag-think-body">
          {rendered.map((step, index) => (
            <ThinkingStreamLine key={`${step.step}-${step.type}-${index}`} step={step} />
          ))}
        </div>
      </RagThinkCollapse>
    </div>
  );
}

function formatTime(value: string) {
  if (!value) return '';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function uploadAttachmentRequest(
  file: File,
  conversationId: string,
  onProgress: (progress: number) => void,
  onProcessing: () => void
) {
  return new Promise<{
    conversationId: string;
    attachments: ChatAttachment[];
    failed: Array<{ name: string; error: string }>;
  }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const formData = new FormData();
    formData.append('files', file, file.name);
    if (conversationId) formData.append('conversationId', conversationId);

    request.open('POST', '/api/research-review/attachments');
    request.responseType = 'text';
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    });
    request.upload.addEventListener('load', onProcessing);
    request.addEventListener('load', () => {
      let payload: {
        conversationId?: string;
        attachments?: ChatAttachment[];
        failed?: Array<{ name: string; error: string }>;
        error?: string;
      } = {};
      try {
        payload = JSON.parse(request.responseText || '{}') as typeof payload;
      } catch {
        const raw = String(request.responseText || '').trim();
        if (raw.startsWith('<!DOCTYPE') || raw.startsWith('<html')) {
          reject(new Error('服务端返回了 HTML 错误页，请查看终端日志。'));
          return;
        }
        if (request.status === 404 || /^404\b/i.test(raw)) {
          reject(new Error('上传接口不存在（404）。请重启 API/内网服务后再试。'));
          return;
        }
        const preview = raw.replace(/\s+/g, ' ').slice(0, 160);
        reject(new Error(
          preview
            ? `附件上传响应无效（HTTP ${request.status}）：${preview}`
            : `附件上传响应无效（HTTP ${request.status}，空响应）。`
        ));
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(payload.error || `附件上传失败（${request.status}）`));
        return;
      }
      if (!payload.conversationId || !Array.isArray(payload.attachments)) {
        reject(new Error('附件上传响应缺少必要信息。'));
        return;
      }
      resolve({
        conversationId: payload.conversationId,
        attachments: payload.attachments,
        failed: payload.failed || []
      });
    });
    request.addEventListener('error', () => reject(new Error('附件上传网络请求失败。')));
    request.addEventListener('abort', () => reject(new Error('附件上传已取消。')));
    request.send(formData);
  });
}

export function ResearchReviewWorkbench() {
  const searchParams = useSearchParams();
  const { loading: statsLoading } = useDashboardStats();
  const incomingQuestion = searchParams.get('question') || '';
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [question, setQuestion] = useState(incomingQuestion);
  const [loading, setLoading] = useState(false);
  const [listReady, setListReady] = useState(false);
  const [, setError] = useNotifyError();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  usePageContentReady(listReady);
  const [conversationId, setConversationId] = useState('');
  const [conversationTitle, setConversationTitle] = useState('新会话');
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastIncomingQuestionRef = useRef('');
  const controllerRef = useRef<AbortController | null>(null);
  const liveRunsRef = useRef(new Map<string, AbortController>());
  const requestSeqRef = useRef(0);
  const resumePollSeqRef = useRef(0);
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(() => new Set());
  const [streamingMessageId, setStreamingMessageId] = useState('');
  const [modalSource, setModalSource] = useState<Source | null>(null);
  const [modalAttachment, setModalAttachment] = useState<ChatAttachment | null>(null);
  /** 科研传承默认走大模型+高能量，以对齐 Codex 样例质量；用户仍可拖回默认档。 */
  const [reasoningRatio, setReasoningRatio] = useState(RESEARCH_REVIEW_DEFAULT_REASONING_RATIO);
  const reasoningTier = useMemo(() => resolveReasoningTier(reasoningRatio), [reasoningRatio]);
  const [statusDetail, setStatusDetail] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [convSearch, setConvSearch] = useState('');
  const [chatPanelWidth, setChatPanelWidth] = useState(DEFAULT_CHAT_PANEL_WIDTH);
  const [resizingChatPanel, setResizingChatPanel] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [pendingManagerOpen, setPendingManagerOpen] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [welcomeLine, setWelcomeLine] = useState(() => pickWelcomePrompt());
  const [welcomeKey, setWelcomeKey] = useState(0);
  const layoutRef = useRef<HTMLDivElement>(null);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const conversationIdRef = useRef('');
  const resumePollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoredSessionRef = useRef(false);
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  const uploadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const cancelledUploadIdsRef = useRef(new Set<string>());
  const dragDepthRef = useRef(0);

  function clampChatPanelWidth(width: number) {
    const normalizedWidth = Math.min(MAX_CHAT_PANEL_WIDTH, Math.max(MIN_CHAT_PANEL_WIDTH, width));
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 1280px)').matches) {
      return Math.round(normalizedWidth);
    }
    const shellWidth = layoutRef.current?.getBoundingClientRect().width || 0;
    const availableMax = shellWidth > 0
      ? shellWidth - MIN_WORKSPACE_WIDTH - 10
      : MAX_CHAT_PANEL_WIDTH;
    return Math.round(Math.max(MIN_CHAT_PANEL_WIDTH, Math.min(normalizedWidth, availableMax)));
  }

  useEffect(() => {
    const storedWidth = Number(window.localStorage.getItem(CHAT_PANEL_STORAGE_KEY));
    if (Number.isFinite(storedWidth) && storedWidth > 0) {
      setChatPanelWidth(clampChatPanelWidth(storedWidth));
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(CHAT_PANEL_STORAGE_KEY, String(chatPanelWidth));
  }, [chatPanelWidth]);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) return;
    writeActiveConversation(CHAT_PANEL_STORAGE_KEY, null, {
      conversationId,
      kind: 'research-review'
    });
  }, [conversationId]);

  function stopResumePoll() {
    resumePollSeqRef.current += 1;
    if (resumePollRef.current) {
      clearTimeout(resumePollRef.current);
      resumePollRef.current = null;
    }
  }

  function requestStopGeneration(id?: string) {
    const conversation = id || conversationIdRef.current;
    if (!conversation) return;
    void fetch(`/api/chat/conversations/${encodeURIComponent(conversation)}/stop`, { method: 'POST' })
      .catch(() => undefined);
  }

  function markConversationGenerating(id: string, generating: boolean) {
    if (!id) return;
    setGeneratingIds((current) => {
      const has = current.has(id);
      if (generating === has) return current;
      const next = new Set(current);
      if (generating) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function detachInFlight() {
    stopResumePoll();
    const previousId = conversationIdRef.current;
    if (previousId && (loading || controllerRef.current || liveRunsRef.current.has(previousId))) {
      markConversationGenerating(previousId, true);
    }
    controllerRef.current = null;
    setLoading(false);
    setStreamingMessageId('');
    setStatusDetail('');
    if (previousId) void loadConversations();
  }

  function beginChatPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.focus();
    resizeStartRef.current = { x: event.clientX, width: chatPanelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingChatPanel(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function resizeChatPanel(event: ReactPointerEvent<HTMLDivElement>) {
    const start = resizeStartRef.current;
    if (!start) return;
    setChatPanelWidth(clampChatPanelWidth(start.width + start.x - event.clientX));
  }

  function finishChatPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!resizeStartRef.current) return;
    resizeStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizingChatPanel(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  function handleResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 64 : 24;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setChatPanelWidth((current) => clampChatPanelWidth(current + step));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setChatPanelWidth((current) => clampChatPanelWidth(current - step));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setChatPanelWidth(MIN_CHAT_PANEL_WIDTH);
    } else if (event.key === 'End') {
      event.preventDefault();
      setChatPanelWidth(clampChatPanelWidth(MAX_CHAT_PANEL_WIDTH));
    }
  }

  function setPendingAttachmentState(
    updater: PendingAttachment[] | ((current: PendingAttachment[]) => PendingAttachment[])
  ) {
    setPendingAttachments((current) => {
      const next = typeof updater === 'function' ? updater(current) : updater;
      pendingAttachmentsRef.current = next;
      return next;
    });
  }

  function updatePendingAttachment(
    clientId: string,
    updater: (attachment: PendingAttachment) => PendingAttachment
  ) {
    setPendingAttachmentState((current) =>
      current.map((attachment) => attachment.clientId === clientId ? updater(attachment) : attachment)
    );
  }

  async function deletePendingAttachmentFromServer(attachment: ChatAttachment) {
    const params = new URLSearchParams({
      conversationId: attachment.conversationId,
      attachmentId: attachment.id
    });
    const response = await fetch(`/api/research-review/attachments?${params.toString()}`, { method: 'DELETE' });
    const payload = await response.json().catch(() => ({})) as { error?: string; conversationDeleted?: boolean };
    if (!response.ok && response.status !== 404) {
      throw new Error(payload.error || '附件删除失败。');
    }
    if (payload.conversationDeleted && conversationIdRef.current === attachment.conversationId) {
      conversationIdRef.current = '';
      setConversationId('');
      setConversationTitle('新会话');
      void loadConversations();
    }
  }

  async function uploadPendingAttachment(pending: PendingAttachment) {
    if (cancelledUploadIdsRef.current.has(pending.clientId)) {
      cancelledUploadIdsRef.current.delete(pending.clientId);
      return;
    }

    updatePendingAttachment(pending.clientId, (current) => ({
      ...current,
      status: 'uploading',
      progress: 0,
      error: undefined
    }));

    try {
      const result = await uploadAttachmentRequest(
        pending.file,
        conversationIdRef.current,
        (progress) => updatePendingAttachment(pending.clientId, (current) => ({ ...current, progress })),
        () => updatePendingAttachment(pending.clientId, (current) => ({
          ...current,
          status: 'processing',
          progress: 100
        }))
      );
      const readyAttachments = result.attachments.filter((item) => item.status === 'ready');
      if (!readyAttachments.length) {
        throw new Error(result.failed[0]?.error || '服务端未返回已上传的附件。');
      }

      if (cancelledUploadIdsRef.current.has(pending.clientId)) {
        await Promise.all(
          readyAttachments.map((attachment) => deletePendingAttachmentFromServer(attachment).catch(() => undefined))
        );
        cancelledUploadIdsRef.current.delete(pending.clientId);
        return;
      }

      const createdNewConversation = !conversationIdRef.current;
      conversationIdRef.current = result.conversationId;
      setConversationId(result.conversationId);
      if (createdNewConversation) {
        setConversationTitle('新会话');
        setConversations((current) => {
          if (current.some((item) => item.id === result.conversationId)) return current;
          return [
            {
              id: result.conversationId,
              title: '新会话',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              messageCount: 0
            },
            ...current
          ];
        });
      }
      setPendingAttachmentState((current) => {
        const without = current.filter((item) => item.clientId !== pending.clientId);
        const expanded = readyAttachments.map((attachment, index) => ({
          clientId: index === 0 ? pending.clientId : createId(),
          file: pending.file,
          name: attachment.name,
          extension: attachment.extension,
          mediaType: attachment.mediaType,
          size: attachment.size,
          status: 'ready' as const,
          progress: 100,
          attachment
        }));
        return [...without, ...expanded];
      });
      if (result.failed.length) {
        setError(
          `${pending.name}：已解析 ${readyAttachments.length} 篇，${result.failed.length} 篇失败（${result.failed
            .slice(0, 3)
            .map((item) => item.name)
            .join('、')}${result.failed.length > 3 ? '…' : ''}）`
        );
      }
    } catch (error) {
      if (cancelledUploadIdsRef.current.has(pending.clientId)) {
        cancelledUploadIdsRef.current.delete(pending.clientId);
        return;
      }
      const message = error instanceof Error ? error.message : '附件上传失败。';
      updatePendingAttachment(pending.clientId, (current) => ({
        ...current,
        status: 'failed',
        error: message
      }));
      setError(`${pending.name}：${message}`);
    }
  }

  function addAttachmentFiles(fileList: FileList | File[]) {
    if (loading) {
      setError('请等待当前回答完成后再添加附件。');
      return;
    }

    const files = Array.from(fileList);
    if (!files.length) return;
    const current = pendingAttachmentsRef.current;
    const availableSlots = Math.max(0, MAX_ATTACHMENT_FILES - current.length);
    const existingKeys = new Set(current.map((attachment) =>
      `${attachment.name.toLowerCase()}:${attachment.size}:${attachment.file.lastModified}`
    ));
    const accepted: PendingAttachment[] = [];
    const validationErrors: string[] = [];

    for (const file of files) {
      const extension = attachmentExtension(file.name);
      const key = `${file.name.toLowerCase()}:${file.size}:${file.lastModified}`;
      if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(extension)) {
        validationErrors.push(`${file.name}：不支持此文件类型`);
        continue;
      }
      if (!file.size) {
        validationErrors.push(`${file.name}：不能上传空文件`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        validationErrors.push(`${file.name}：超过 200 MB`);
        continue;
      }
      if (existingKeys.has(key)) {
        validationErrors.push(`${file.name}：已添加`);
        continue;
      }
      if (accepted.length >= availableSlots) {
        validationErrors.push(`每条消息最多添加 ${MAX_ATTACHMENT_FILES} 个附件`);
        break;
      }
      existingKeys.add(key);
      accepted.push({
        clientId: createId(),
        file,
        name: file.name,
        extension,
        mediaType: file.type || 'application/octet-stream',
        size: file.size,
        status: 'queued',
        progress: 0
      });
    }

    if (validationErrors.length) setError([...new Set(validationErrors)].join('；'));
    else setError('');
    if (!accepted.length) return;

    setPendingAttachmentState((attachments) => [...attachments, ...accepted]);
    for (const pending of accepted) {
      const task = uploadQueueRef.current
        .catch(() => undefined)
        .then(() => uploadPendingAttachment(pending));
      uploadQueueRef.current = task;
    }
  }

  function removePendingAttachment(clientId: string) {
    const pending = pendingAttachmentsRef.current.find((attachment) => attachment.clientId === clientId);
    if (!pending || pending.status === 'removing') return;
    cancelledUploadIdsRef.current.add(clientId);

    if (!pending.attachment) {
      setPendingAttachmentState((current) => current.filter((attachment) => attachment.clientId !== clientId));
      return;
    }
    if (pending.attachment.deduplicated) {
      cancelledUploadIdsRef.current.delete(clientId);
      setPendingAttachmentState((current) => current.filter((attachment) => attachment.clientId !== clientId));
      return;
    }

    updatePendingAttachment(clientId, (current) => ({ ...current, status: 'removing', error: undefined }));
    void deletePendingAttachmentFromServer(pending.attachment)
      .then(() => {
        cancelledUploadIdsRef.current.delete(clientId);
        setPendingAttachmentState((current) => current.filter((attachment) => attachment.clientId !== clientId));
      })
      .catch((error) => {
        cancelledUploadIdsRef.current.delete(clientId);
        const message = error instanceof Error ? error.message : '附件删除失败。';
        updatePendingAttachment(clientId, (current) => ({ ...current, status: 'failed', error: message }));
        setError(message);
      });
  }

  function discardPendingAttachments() {
    const pending = pendingAttachmentsRef.current;
    if (!pending.length) return;
    for (const attachment of pending) cancelledUploadIdsRef.current.add(attachment.clientId);
    setPendingAttachmentState([]);
    const uploaded = pending.flatMap((attachment) =>
      attachment.attachment && !attachment.attachment.deduplicated ? [attachment.attachment] : []
    );
    if (uploaded.length) {
      void Promise.all(uploaded.map((attachment) => deletePendingAttachmentFromServer(attachment)))
        .catch((error) => setError(error instanceof Error ? error.message : '部分待发送附件删除失败。'));
    }
  }

  function isFileDrag(event: ReactDragEvent<HTMLDivElement>) {
    return Array.from(event.dataTransfer.types).includes('Files');
  }

  function handleFileDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDraggingFiles(true);
  }

  function handleFileDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function handleFileDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (!dragDepthRef.current) setDraggingFiles(false);
  }

  function handleFileDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDraggingFiles(false);
    addAttachmentFiles(event.dataTransfer.files);
  }

  const sourcesById = useMemo(() => {
    const map = new Map<string, Source>();
    const register = (source: Source) => {
      if (source.id) map.set(source.id, source);
      for (const evidenceId of source.evidenceIds || []) map.set(evidenceId, source);
    };
    for (const message of messages) {
      const list = message.role === 'assistant'
        ? assistantMessageSources(message)
        : (message.sources || []);
      for (const source of list) register(source);
    }
    return map;
  }, [messages]);

  const conversationArtifacts = useMemo(() => {
    const map = new Map<string, ResearchReviewArtifact>();
    for (const message of messages) {
      for (const artifact of message.artifacts || []) {
        map.set(artifact.id, artifact);
      }
    }
    return [...map.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }, [messages]);

  function openCitation(id: string) {
    const resolve = () => {
      const direct = sourcesById.get(id);
      if (direct) return direct;
      for (const message of messages) {
        const matched = findSourceByCitationId(message.sources || [], id);
        if (matched) return matched;
      }
      return null;
    };
    const matched = resolve();
    if (!matched) return;
    if (isLinkSource(matched)) {
      const url = linkSourceUrl(matched);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    setModalSource(matched);
  }

  useEffect(() => {
    loadConversations();
  }, []);

  useEffect(() => {
    if (generatingIds.size === 0) return;
    const timer = window.setInterval(() => {
      void loadConversations();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [generatingIds.size]);

  useEffect(() => {
    if (!listReady || restoredSessionRef.current || incomingQuestion) return;
    const active = readActiveConversation(CHAT_PANEL_STORAGE_KEY, null);
    if (!active?.conversationId) {
      restoredSessionRef.current = true;
      return;
    }
    restoredSessionRef.current = true;
    void loadConversation(active.conversationId, { resumeInFlight: true, restore: true });
  }, [incomingQuestion, listReady]);

  useEffect(() => {
    if (pendingManagerOpen && pendingAttachments.length === 0) {
      setPendingManagerOpen(false);
    }
  }, [pendingManagerOpen, pendingAttachments.length]);

  useEffect(() => {
    if (!incomingQuestion || loading || lastIncomingQuestionRef.current === incomingQuestion) return;
    lastIncomingQuestionRef.current = incomingQuestion;
    setQuestion('');
    void ask(undefined, incomingQuestion);
  }, [incomingQuestion, loading]);

  const scrollFingerprint = useMemo(() => {
    const streaming = messages.find((message) => message.id === streamingMessageId);
    const stepCount = streaming?.agentSteps?.length || 0;
    const lastStep = streaming?.agentSteps?.[stepCount - 1];
    const stepSig = lastStep ? `${lastStep.step}:${lastStep.type}:${lastStep.content.length}` : '';
    const contentLen = streaming?.content?.length || 0;
    const sourceCount = streaming?.sources?.length || 0;
    return `${messages.length}:${stepCount}:${stepSig}:${contentLen}:${sourceCount}:${loading ? 1 : 0}`;
  }, [messages, streamingMessageId, loading]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTo({
      top: container.scrollHeight,
      behavior: loading ? 'auto' : 'smooth'
    });
  }, [scrollFingerprint, loading]);

  async function loadConversations() {
    try {
      const response = await fetch('/api/research-review/conversations');
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '加载历史失败');
      const list: Conversation[] = (Array.isArray(data.conversations) ? data.conversations : []).map((item: Conversation) => ({
        ...item,
        generating: Boolean(item.generating)
      }));
      setConversations(list);
      setGeneratingIds((current) => {
        const next = new Set<string>();
        for (const item of list) {
          if (item.generating) next.add(item.id);
        }
        for (const [id, controller] of liveRunsRef.current) {
          if (controller && !controller.signal.aborted) next.add(id);
        }
        if (controllerRef.current && conversationIdRef.current) {
          next.add(conversationIdRef.current);
        }
        for (const id of current) {
          const row = list.find((item) => item.id === id);
          if (!row || row.generating) next.add(id);
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载历史失败');
    } finally {
      setListReady(true);
    }
  }

  function updateMessage(id: string, updater: (message: ChatMessage) => ChatMessage) {
    setMessages((current) => current.map((message) => (message.id === id ? updater(message) : message)));
  }

  function startNewConversation() {
    detachInFlight();
    writeActiveConversation(CHAT_PANEL_STORAGE_KEY, null, null);
    discardPendingAttachments();
    setMessages(initialMessages);
    conversationIdRef.current = '';
    setConversationId('');
    setConversationTitle('新会话');
    setQuestion('');
    setError('');
    setStatusDetail('正在理解问题…');
    setLoading(false);
    setStreamingMessageId('');
    setModalSource(null);
    setModalAttachment(null);
    setStatusDetail('');
    setHistoryOpen(false);
    setWelcomeLine(pickWelcomePrompt());
    setWelcomeKey((key) => key + 1);
    setReasoningRatio(RESEARCH_REVIEW_DEFAULT_REASONING_RATIO);
  }

  function interruptConversation(id: string, options?: { notify?: boolean }) {
    stopResumePoll();
    if (!id) return;
    requestStopGeneration(id);
    markConversationGenerating(id, false);
    liveRunsRef.current.get(id)?.abort();
    liveRunsRef.current.delete(id);
    if (conversationIdRef.current !== id) return;
    if (controllerRef.current) {
      controllerRef.current.abort();
      controllerRef.current = null;
    }
    requestSeqRef.current += 1;
    if (options?.notify && streamingMessageId) {
      updateMessage(streamingMessageId, (message) => ({
        ...message,
        content: message.content || '已停止生成。',
        thinkingDurationMs: freezeThinkingDurationMs(message)
      }));
      setStatusDetail('已停止生成');
    } else {
      setStatusDetail('');
    }
    setLoading(false);
    setStreamingMessageId('');
  }

  function stopGeneration() {
    interruptConversation(conversationIdRef.current, { notify: true });
  }

  async function downloadResearchArtifact(artifact: ResearchReviewArtifact) {
    try {
      const response = await fetch(artifact.downloadUrl, { method: 'GET' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || `下载失败（${response.status}）`);
      }
      const blob = await response.blob();
      // 优先用 AI 起的中文文件名；勿解析 Content-Disposition 的 ASCII filename=（中文会被替换成下划线）
      const rawName = (artifact.fileName || artifact.reportTitle || '科研综述').trim();
      const fileName = /\.docx$/i.test(rawName) ? rawName : `${rawName}.docx`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatusDetail(`已下载 ${fileName}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : '下载 Word 失败。');
    }
  }

  function interruptInFlight() {
    interruptConversation(conversationIdRef.current);
  }

  /** 打断当前生成（如有），从指定用户消息处截断并重新发送。 */
  function resendUserMessage(messageId: string) {
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    const target = messages[index];
    if (target.role !== 'user') return;
    const baseMessages = messages.slice(0, index).filter((message) => message.id !== 'welcome');
    void ask(undefined, target.content, {
      baseMessages,
      attachments: target.attachments || [],
      truncateFromMessageId: target.id,
      truncateKeepCount: baseMessages.length
    });
  }

  function mapLoadedMessages(raw: ChatMessage[]): ChatMessage[] {
    return raw.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      attachments: message.attachments || [],
      artifacts: message.artifacts || [],
      sources: message.sources || [],
      graphSeedIds: message.graphSeedIds || [],
      agentSteps: message.agentSteps || [],
      thinkingDurationMs: message.thinkingDurationMs,
      createdAt: message.createdAt,
      contextUsage: message.contextUsage,
      inProgress: message.inProgress
    }));
  }

  function resumeInFlightIfNeeded(loadedMessages: ChatMessage[], id: string, generating = false) {
    const inflight = [...loadedMessages].reverse().find((message) => isInFlightAssistantMessage(message));
    if (!inflight && !generating) return;
    stopResumePoll();
    const seq = resumePollSeqRef.current;
    setStreamingMessageId(inflight?.id || '');
    setLoading(true);
    setStatusDetail('正在继续生成…');
    const poll = async () => {
      if (resumePollSeqRef.current !== seq || conversationIdRef.current !== id) return;
      try {
        const response = await fetch(`/api/research-review/conversations/${encodeURIComponent(id)}`);
        const data = await response.json().catch(() => ({}));
        if (resumePollSeqRef.current !== seq) return;
        if (response.ok && Array.isArray(data.messages)) {
          const nextMessages = mapLoadedMessages(data.messages);
          setMessages(nextMessages.length ? nextMessages : initialMessages);
          if (!nextMessages.some((message) => isInFlightAssistantMessage(message)) && data.generating !== true) {
            setLoading(false);
            setStreamingMessageId('');
            setStatusDetail('');
            void loadConversations();
            return;
          }
        }
      } catch {
        // keep polling through transient disconnects
      }
      resumePollRef.current = setTimeout(() => {
        void poll();
      }, 2_000);
    };
    resumePollRef.current = setTimeout(() => {
      void poll();
    }, 1_200);
  }

  async function loadConversation(id: string, options?: { resumeInFlight?: boolean; restore?: boolean }) {
    if (!options?.restore && conversationIdRef.current === id) {
      setHistoryOpen(false);
      return;
    }
    if (conversationIdRef.current && conversationIdRef.current !== id) {
      detachInFlight();
    }
    discardPendingAttachments();
    stopResumePoll();
    setError('');
    try {
      const response = await fetch(`/api/research-review/conversations/${encodeURIComponent(id)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 404 && options?.restore) {
          startNewConversation();
          return;
        }
        throw new Error(data.error || '加载会话失败');
      }
      const loadedMessages: ChatMessage[] = Array.isArray(data.messages)
        ? mapLoadedMessages(data.messages)
        : [];
      conversationIdRef.current = data.conversation.id;
      setConversationId(data.conversation.id);
      setConversationTitle(data.conversation.title);
      const savedRatio = Number(data.conversation?.reasoning_ratio);
      setReasoningRatio(
        Number.isFinite(savedRatio)
          ? Math.min(1, Math.max(0, savedRatio))
          : RESEARCH_REVIEW_DEFAULT_REASONING_RATIO
      );
      setMessages(loadedMessages.length ? loadedMessages : initialMessages);
      setQuestion('');
      setStatusDetail('');
      const liveController = liveRunsRef.current.get(data.conversation.id);
      const liveGenerating = Boolean(liveController && !liveController.signal.aborted)
        || generatingIds.has(data.conversation.id)
        || data.generating === true;
      if (liveController && !liveController.signal.aborted) {
        controllerRef.current = liveController;
        setLoading(true);
        const inflight = [...loadedMessages].reverse().find((message) => isInFlightAssistantMessage(message));
        setStreamingMessageId(inflight?.id || '');
        setStatusDetail('正在继续生成…');
      } else if (options?.resumeInFlight !== false && (
        liveGenerating
        || loadedMessages.some((message) => isInFlightAssistantMessage(message))
      )) {
        resumeInFlightIfNeeded(loadedMessages, data.conversation.id, data.generating === true || liveGenerating);
      } else {
        setLoading(false);
        setStreamingMessageId('');
      }
      setHistoryOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载会话失败');
    }
  }

  function isUntitledConversation(title?: string | null) {
    const compact = String(title || '').trim();
    return !compact || compact === '新会话' || compact === '新对话';
  }

  async function ensureConversationTitle(id: string) {
    if (!id) return;
    // Already named in this client session — never re-title mid-conversation.
    if (conversationIdRef.current === id && !isUntitledConversation(conversationTitle)) return;
    const known = conversations.find((item) => item.id === id);
    if (known && !isUntitledConversation(known.title)) {
      setConversationTitle(known.title);
      return;
    }
    try {
      const response = await fetch(`/api/research-review/conversations/${encodeURIComponent(id)}/title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await response.json().catch(() => ({})) as {
        conversation?: { id?: string; title?: string };
        skipped?: boolean;
        error?: string;
      };
      if (!response.ok || !data.conversation?.title) return;
      const nextTitle = data.conversation.title;
      if (data.skipped && isUntitledConversation(nextTitle)) return;
      if (conversationIdRef.current === id) setConversationTitle(nextTitle);
      setConversations((current) =>
        current.map((item) =>
          item.id === id
            ? { ...item, title: nextTitle, updated_at: new Date().toISOString() }
            : item
        )
      );
    } catch {
      // 标题生成失败时保持「新会话」，不影响主对话。
    }
  }

  async function deleteConversation(id: string) {
    setError('');
    try {
      const response = await fetch(`/api/research-review/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '删除会话失败');
      interruptConversation(id);
      if (conversationId === id) startNewConversation();
      await loadConversations();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除会话失败');
    }
  }

  function applyStreamEvent(event: StreamEvent, assistantId: string, runConversationId: string) {
    const viewing = conversationIdRef.current === runConversationId;
    if (event.type === 'meta') {
      if (viewing) {
        setConversationTitle((current) => {
          if (!isUntitledConversation(current)) return current;
          const incoming = event.title || '新会话';
          return isUntitledConversation(incoming) ? current || '新会话' : incoming;
        });
      }
      if (event.conversationId) {
        setConversations((current) => {
          const exists = current.some((item) => item.id === event.conversationId);
          if (!exists) {
            const liveTitle = viewing ? conversationTitle : (event.title || '新会话');
            return [
              {
                id: event.conversationId,
                title: isUntitledConversation(liveTitle) ? (event.title || '新会话') : liveTitle,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                messageCount: 1,
                generating: true
              },
              ...current
            ];
          }
          return current.map((item) =>
            item.id === event.conversationId
              ? {
                  ...item,
                  title: isUntitledConversation(event.title) ? item.title : (event.title || item.title),
                  updated_at: new Date().toISOString(),
                  generating: true
                }
              : item
          );
        });
      }
      if (viewing) {
        updateMessage(assistantId, (message) => ({
          ...message,
          sources: event.sources,
          graphSeedIds: event.graphSeedIds,
          ...(event.agentSteps
            ? { agentSteps: event.agentSteps }
            : { agentSteps: thinkingStepsAfterTurn(message.agentSteps || []) }),
          ...(event.trace?.totalDurationMs != null
            ? { thinkingDurationMs: event.trace.totalDurationMs }
            : {}),
          ...(contextUsageFromMetrics(event.trace)
            ? { contextUsage: contextUsageFromMetrics(event.trace) }
            : {})
        }));
      }
      return false;
    }

    if (event.type === 'status') {
      if (viewing && event.phase !== 'heartbeat') {
        setStatusDetail(event.detail || event.message || '正在处理…');
      }
      return false;
    }

    if (event.type === 'agent_step') {
      if (viewing) {
        const summary = summarizeThinkStep(event.step);
        if (summary) {
          setStatusDetail(`${summary.verb}${summary.detail ? ` ${summary.detail}` : ''}`);
        } else if (event.step.type === 'public_text') {
          setStatusDetail('正在阅读与整理证据…');
        }
        flushSync(() => {
          updateMessage(assistantId, (message) => {
            const current = message.agentSteps || [];
            const next = [...current.filter((item) => item.step !== event.step.step), event.step];
            return {
              ...message,
              agentSteps: next.sort((a, b) => a.step - b.step)
            };
          });
        });
      }
      return false;
    }

    if (event.type === 'context_usage') {
      if (viewing) {
        updateMessage(assistantId, (message) => ({ ...message, contextUsage: event.usage }));
      }
      return false;
    }

    if (event.type === 'chunk') {
      if (viewing) {
        setStatusDetail('正在生成答案…');
        flushSync(() => {
          updateMessage(assistantId, (message) => ({
            ...message,
            content: `${message.content}${event.content}`
          }));
        });
      }
      return true;
    }

    if (event.type === 'answer_reset') {
      if (viewing) {
        flushSync(() => {
          updateMessage(assistantId, (message) => ({
            ...message,
            content: ''
          }));
        });
      }
      return true;
    }

    if (event.type === 'answer_replace') {
      if (viewing) {
        setStatusDetail('正在生成答案…');
        flushSync(() => {
          updateMessage(assistantId, (message) => ({
            ...message,
            content: event.content
          }));
        });
      }
      return true;
    }

    if (event.type === 'error') {
      if (viewing) throw new Error(event.error || '查询失败');
      return false;
    }

    if (event.type === 'artifact') {
      if (viewing) {
        updateMessage(assistantId, (message) => {
          const current = message.artifacts || [];
          const next = [
            ...current.filter((item) => item.id !== event.artifact.id),
            event.artifact
          ];
          return { ...message, artifacts: next, sources: [], graphSeedIds: [] };
        });
        setStatusDetail(`Word 已放到右侧「附件查看」：${event.artifact.fileName}`);
      }
      return false;
    }

    if (event.type === 'done') {
      if (viewing) {
        const totalDurationMs = event.metrics?.totalDurationMs;
        const contextUsage = contextUsageFromMetrics(event.metrics);
        updateMessage(assistantId, (message) => ({
          ...message,
          ...(totalDurationMs != null ? { thinkingDurationMs: totalDurationMs } : {}),
          ...(contextUsage ? { contextUsage } : {}),
          ...(event.artifact
            ? {
                artifacts: [
                  ...(message.artifacts || []).filter((item) => item.id !== event.artifact!.id),
                  event.artifact
                ],
                sources: [],
                graphSeedIds: []
              }
            : {}),
          agentSteps: thinkingStepsAfterTurn(message.agentSteps || [])
        }));
        setStatusDetail(event.artifact ? `已完成，请到右侧「附件查看」下载 ${event.artifact.fileName}` : '回答完成');
      }
    }

    return false;
  }

  async function parseEventLine(line: string, assistantId: string, runConversationId: string) {
    const trimmed = line.trim();
    if (!trimmed) return false;
    const event = JSON.parse(trimmed) as StreamEvent;
    const handled = applyStreamEvent(event, assistantId, runConversationId);
    if (
      conversationIdRef.current === runConversationId
      && (
        event.type === 'agent_step'
        || event.type === 'chunk'
        || event.type === 'answer_replace'
        || event.type === 'answer_reset'
      )
    ) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }
    return handled;
  }

  async function ask(
    event?: FormEvent<HTMLFormElement>,
    overrideQuestion?: string,
    options?: {
      baseMessages?: ChatMessage[];
      attachments?: ChatAttachment[];
      truncateFromMessageId?: string;
      truncateKeepCount?: number;
    }
  ) {
    event?.preventDefault();
    const trimmed = (overrideQuestion ?? question).trim();
    const isResend = options?.baseMessages !== undefined;
    const pending = isResend ? [] : pendingAttachmentsRef.current;
    const uploadsInProgress = pending.some((attachment) =>
      ['queued', 'uploading', 'processing', 'removing'].includes(attachment.status)
    );
    if (uploadsInProgress) {
      setError('请等待附件上传并解析完成后再发送。');
      return;
    }
    const readyPending = isResend
      ? []
      : pending.filter(
          (attachment): attachment is PendingAttachment & { attachment: ChatAttachment } =>
            attachment.status === 'ready' && Boolean(attachment.attachment)
        );
    const messageAttachments = options?.attachments?.length
      ? options.attachments
      : readyPending.map((pendingAttachment) => pendingAttachment.attachment);
    if (!trimmed && !messageAttachments.length) return;

    const boundConversationId = messageAttachments[0]?.conversationId || conversationIdRef.current;
    if (messageAttachments.length && !boundConversationId) {
      setError('附件尚未绑定到会话，请重新添加后再试。');
      return;
    }
    const currentConversationId = boundConversationId || createId();
    if (
      liveRunsRef.current.has(currentConversationId)
      || (
        (conversationIdRef.current === currentConversationId || !conversationIdRef.current)
        && (loading || Boolean(controllerRef.current))
      )
    ) {
      interruptConversation(currentConversationId);
    }
    conversationIdRef.current = currentConversationId;
    setConversationId(currentConversationId);

    stopResumePoll();
    const controller = new AbortController();
    liveRunsRef.current.set(currentConversationId, controller);
    controllerRef.current = controller;

    const displayQuestion = trimmed || ATTACHMENT_ONLY_QUESTION;
    const userMessage: ChatMessage = {
      id: createId(),
      role: 'user',
      content: displayQuestion,
      attachments: messageAttachments,
      createdAt: new Date().toISOString()
    };
    const assistantId = createId();
    const startedAt = Date.now();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      sources: [],
      graphSeedIds: [],
      agentSteps: [],
      startedAt,
      createdAt: new Date(startedAt).toISOString()
    };
    const priorMessages = (options?.baseMessages
      ?? messages.filter((message) => message.id !== 'welcome' && message.id !== streamingMessageId)
    ).filter((message) => message.id !== 'welcome');
    const cleanedPrior = priorMessages.filter((message) =>
      !(message.role === 'assistant' && !message.content && !(message.agentSteps?.length))
    );
    const nextMessages = [...cleanedPrior, userMessage];
    const evidenceOffset = maxEvidenceNumber(cleanedPrior);

    setMessages([...cleanedPrior, userMessage, assistantMessage]);
    setQuestion('');
    if (!isResend) {
      const sentClientIds = new Set(readyPending.map((attachment) => attachment.clientId));
      setPendingAttachmentState((current) => current.filter((attachment) => !sentClientIds.has(attachment.clientId)));
    }
    setStreamingMessageId(assistantId);
    setLoading(true);
    setError('');
    setStatusDetail(isResend ? '正在重新生成…' : '正在理解问题…');
    markConversationGenerating(currentConversationId, true);

    let receivedChunk = false;
    let sawDone = false;

    try {
      const response = await fetch('/api/research-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: trimmed,
          messages: nextMessages,
          conversationId: currentConversationId || undefined,
          userMessageId: userMessage.id,
          assistantMessageId: assistantId,
          attachmentIds: messageAttachments.map((attachment) => attachment.id),
          evidenceOffset,
          mode: 'agent',
          depth: 'deep',
          reasoningEffort: reasoningTier.reasoningEffort,
          modelRole: reasoningTier.modelRole,
          reasoningRatio,
          ...(options?.truncateFromMessageId
            ? {
                truncateFromMessageId: options.truncateFromMessageId,
                truncateKeepCount: options.truncateKeepCount ?? 0
              }
            : {})
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text();
        let data: { error?: string };
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(text.startsWith('<!DOCTYPE') ? '服务端返回了 HTML 错误页，请查看终端日志。' : text || '查询失败');
        }
        throw new Error(data.error || '查询失败');
      }

      if (!response.body) throw new Error('响应流不可用。');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const consumeLine = async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const event = JSON.parse(trimmed) as StreamEvent;
          if (event.type === 'done') sawDone = true;
        } catch {
          // parseEventLine will surface JSON errors
        }
        receivedChunk = (await parseEventLine(line, assistantId, currentConversationId)) || receivedChunk;
      };

      while (true) {
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch (readError) {
          throw new Error(normalizeStreamError(readError));
        }
        const { value, done } = readResult;
        if (controller.signal.aborted) return;

        if (value) buffer += decoder.decode(value, { stream: !done });

        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          await consumeLine(line);
          newlineIndex = buffer.indexOf('\n');
        }

        if (done) break;
      }

      buffer += decoder.decode();
      const tail = buffer.trim();
      if (tail) await consumeLine(tail);

      if (!sawDone) {
        throw new Error('网络异常，回答未完整接收（连接在完成前断开）。');
      }

      const viewing = conversationIdRef.current === currentConversationId;
      if (viewing && !receivedChunk) {
        updateMessage(assistantId, (message) => {
          const salvaged = salvageAnswerFromSteps(message.agentSteps);
          return { ...message, content: salvaged || '没有生成回答。' };
        });
      }
      void ensureConversationTitle(currentConversationId);
      await loadConversations();
      if (conversationIdRef.current === currentConversationId) setStatusDetail('');
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = normalizeStreamError(err);
      if (conversationIdRef.current === currentConversationId) {
        setError(message);
        setStatusDetail(message.includes('网络异常') ? '网络异常' : '查询失败');
        updateMessage(assistantId, (current) => {
          const salvaged = current.content?.trim()
            ? current.content
            : salvageAnswerFromSteps(current.agentSteps);
          const suffix = `\n\n抱歉，查询失败：${message}`;
          return {
            ...current,
            content: salvaged ? `${salvaged}${suffix}` : `抱歉，查询失败：${message}`,
            thinkingDurationMs: freezeThinkingDurationMs(current)
          };
        });
      }
    } finally {
      const stillThisRun = liveRunsRef.current.get(currentConversationId) === controller;
      if (stillThisRun) {
        liveRunsRef.current.delete(currentConversationId);
        markConversationGenerating(currentConversationId, false);
      }
      const viewingNow = conversationIdRef.current === currentConversationId;
      if (viewingNow && (stillThisRun || controllerRef.current === controller)) {
        updateMessage(assistantId, (message) => ({
          ...message,
          thinkingDurationMs: freezeThinkingDurationMs(message)
        }));
        setLoading(false);
        setStreamingMessageId('');
      }
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  const visibleMessages = messages.filter((message) => message.id !== 'welcome');
  const latestContextUsage = [...visibleMessages]
    .reverse()
    .find((message) => message.role === 'assistant' && hasRecognizedContextUsage(message.contextUsage))
    ?.contextUsage;
  const researchMode = visibleMessages.length > 0;
  const attachmentUploadBusy = pendingAttachments.some((attachment) =>
    ['queued', 'uploading', 'processing', 'removing'].includes(attachment.status)
  );
  const readyPendingAttachments = pendingAttachments.filter((attachment) =>
    attachment.status === 'ready' && Boolean(attachment.attachment)
  );
  const canSend = !attachmentUploadBusy
    && (Boolean(question.trim()) || readyPendingAttachments.length > 0);
  const canInterruptAndSend = loading && canSend;
  const filteredConversations = conversations.filter((conversation) => {
    if (!convSearch.trim()) return true;
    return conversation.title.toLowerCase().includes(convSearch.trim().toLowerCase());
  });

  return (
    <div
      ref={layoutRef}
      className="rag-shell relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4"
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
    >
      {draggingFiles ? (
        <div className="pointer-events-none absolute inset-3 z-[250] flex items-center justify-center rounded-xl border-2 border-dashed border-primary/40 bg-muted/90 text-foreground shadow-soft backdrop-blur-sm" role="status" aria-live="polite">
          <div className="flex flex-col items-center gap-2">
            <Paperclip className="h-7 w-7" />
            <span className="text-sm font-semibold">释放以上传附件</span>
            <span className="text-xs text-muted-foreground">{ATTACHMENT_FORMAT_HINT}</span>
          </div>
        </div>
      ) : null}

      <div className="mb-3 shrink-0 md:mb-4">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">Dashboard / Chat</div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">科研传承助手</h1>
        <p className="mt-1 text-sm text-muted-foreground">用于根据文献资料撰写综述，并梳理研究现状与研究问题。</p>
      </div>

      <div className="rag-chat-card min-h-0 flex-1">
        {/* Conversation list */}
        <aside className={`rag-conv-list ${historyOpen ? 'flex' : 'hidden md:flex'}`}>
          <div className="shrink-0 space-y-3 border-b border-border p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={convSearch}
                onChange={(event) => setConvSearch(event.target.value)}
                placeholder="搜索会话..."
                className="ui-input h-9 pl-9"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                startNewConversation();
                setHistoryOpen(false);
              }}
              className="ui-btn-primary h-9 w-full gap-1.5 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              新对话
            </button>
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2">
            {!listReady ? (
              <div className="px-1 py-2" aria-busy="true" aria-label="正在加载会话" />
            ) : filteredConversations.length ? (
              <div className="space-y-0.5">
                {filteredConversations.map((conversation) => {
                  const active = conversation.id === conversationId;
                  return (
                    <div
                      key={conversation.id}
                      className={`group relative ${active ? 'rag-conv-item rag-conv-item-active' : 'rag-conv-item'}`}
                    >
                      <div className="min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={() => {
                            void loadConversation(conversation.id);
                            setHistoryOpen(false);
                          }}
                          className="w-full text-left"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="flex min-w-0 flex-1 items-center gap-1.5">
                              {generatingIds.has(conversation.id) ? (
                                <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-label="生成中" />
                              ) : null}
                              <span className="min-w-0 truncate text-sm font-medium leading-5 text-foreground">{conversation.title}</span>
                            </span>
                            <span className="shrink-0 pt-0.5 text-[10px] leading-4 text-muted-foreground">{formatTime(conversation.updated_at)}</span>
                          </div>
                        </button>
                        <div className="mt-0.5 flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              void loadConversation(conversation.id);
                              setHistoryOpen(false);
                            }}
                            className="min-w-0 flex-1 truncate text-left text-xs leading-4 text-muted-foreground"
                          >
                            {conversation.messageCount ? `${conversation.messageCount} 条消息` : '点击打开会话'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteConversation(conversation.id)}
                            className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100"
                            aria-label="删除会话"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex h-full min-h-48 flex-col items-center justify-center px-4 text-center">
                <MessageSquare className="h-8 w-8 text-muted-foreground/40" strokeWidth={1.4} />
                <p className="mt-3 text-sm font-medium text-foreground">暂无会话</p>
                <p className="mt-1 text-xs text-muted-foreground">开始提问后会显示在这里</p>
              </div>
            )}
          </div>
        </aside>

        {/* Main chat pane */}
        <main className={`min-h-0 min-w-0 flex-1 flex-col ${historyOpen ? 'hidden md:flex' : 'flex'}`}>
          <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent md:hidden"
              aria-label="打开会话列表"
            >
              <MessageSquare className="h-4 w-4" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">{conversationTitle || '新会话'}</div>
              <div className="truncate text-xs text-muted-foreground">
                {loading && statusDetail ? statusDetail : researchMode ? '对话进行中' : '选择或开始一场对话'}
              </div>
            </div>
            <ReasoningEffortSlider
              value={reasoningRatio}
              onChange={setReasoningRatio}
              locked={researchMode}
            />
            <ContextUsageIndicator
              usage={latestContextUsage}
              modelRole={reasoningTier.modelRole}
              conversationId={conversationId}
              conversationKind="research-review"
            />
          </header>

          <div ref={scrollContainerRef} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {!visibleMessages.length ? (
              <div className="flex h-full min-h-72 flex-col items-center justify-center px-4 text-center">
                <WelcomeTypewriter
                  key={welcomeKey}
                  text={welcomeLine}
                  ready={!statsLoading}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {visibleMessages.map((message, messageIndex) => (
                  <div
                    key={message.id}
                    className={`flex w-full ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div className={`${message.role === 'user' ? 'max-w-[75%] items-end' : 'w-full max-w-[90%] items-start'}`}>
                      <div
                        className={
                          message.role === 'user'
                            ? 'rag-user-bubble'
                            : 'rag-assistant-bubble'
                        }
                      >
                        {message.role === 'assistant' ? (
                          <>
                            {(() => {
                              const isStreamingMsg = loading && message.id === streamingMessageId;
                              const live = isStreamingMsg && !message.content;
                              const chainSteps = live
                                ? (message.agentSteps || [])
                                : thinkingStepsAfterTurn(message.agentSteps || []);
                              if (live) {
                                return (
                                  <AgentLiveTranscript
                                    steps={message.agentSteps || []}
                                    status={statusDetail}
                                    startedAt={message.startedAt}
                                    createdAt={message.createdAt}
                                  />
                                );
                              }
                              return (
                                <>
                                  <ThinkingBlock
                                    steps={chainSteps}
                                    durationMs={message.thinkingDurationMs}
                                    startedAt={message.startedAt}
                                    createdAt={message.createdAt}
                                    previousCreatedAt={previousUserCreatedAt(visibleMessages, messageIndex)}
                                    running={isStreamingMsg}
                                  />
                                  {message.content ? (
                                    <div className="mt-1 min-w-0">
                                      <MessageContent
                                        content={message.content}
                                        streaming={isStreamingMsg}
                                        sources={assistantMessageSources(message)}
                                        onCitationClick={openCitation}
                                      />
                                    </div>
                                  ) : !(message.agentSteps?.length) ? (
                                    <TypingIndicator />
                                  ) : null}
                                </>
                              );
                            })()}
                          </>
                        ) : (
                          <div className="group/user-msg relative">
                            <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
                            <button
                              type="button"
                              onClick={() => resendUserMessage(message.id)}
                              className="mt-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-primary-foreground/70 opacity-70 transition hover:bg-primary-foreground/10 hover:opacity-100"
                              title="打断当前生成并从此消息重新发送"
                              aria-label="重新发送此消息"
                            >
                              <RotateCcw className="h-3 w-3" />
                              重新发送
                            </button>
                          </div>
                        )}
                        {message.role === 'user' ? (
                        <CompactMessageAttachments
                          attachments={message.attachments || []}
                          inverted
                          onOpen={setModalAttachment}
                        />
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          <form onSubmit={ask} className="shrink-0 border-t border-border px-4 py-3">
            <input
              ref={fileInputRef}
              type="file"
              accept={ATTACHMENT_ACCEPT}
              multiple
              className="sr-only"
              tabIndex={-1}
              onChange={(event) => {
                if (event.currentTarget.files) addAttachmentFiles(event.currentTarget.files);
                event.currentTarget.value = '';
              }}
            />
            {pendingAttachments.length ? (
              <CompactPendingAttachments
                items={pendingAttachments.map((attachment) => ({
                  key: attachment.clientId,
                  name: attachment.name,
                  size: attachment.size,
                  extension: attachment.extension,
                  mediaType: attachment.mediaType,
                  statusLabel: pendingAttachmentStatusLabel(attachment),
                  typeLabel: attachmentTypeLabel(attachment),
                  ready: attachment.status === 'ready' && Boolean(attachment.attachment),
                  failed: attachment.status === 'failed',
                  busy: ['queued', 'uploading', 'processing', 'removing'].includes(attachment.status),
                  progress: attachment.progress,
                  error: attachment.error,
                  canRemove: attachment.status !== 'removing'
                }))}
                onOpen={(key) => {
                  const pending = pendingAttachments.find((item) => item.clientId === key);
                  if (pending?.attachment?.status === 'ready') setModalAttachment(pending.attachment);
                }}
                onRemove={removePendingAttachment}
                onOpenAll={() => setPendingManagerOpen(true)}
                footer={
                  readyPendingAttachments.length && !question.trim() ? (
                    <p className="px-0.5 text-[10px] text-muted-foreground">
                      未输入问题时将发送“{ATTACHMENT_ONLY_QUESTION}”
                    </p>
                  ) : null
                }
              />
            ) : null}

            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={loading || pendingAttachments.length >= MAX_ATTACHMENT_FILES}
                className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="添加附件"
                title={`添加附件（${ATTACHMENT_FORMAT_HINT}）`}
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    ask();
                  }
                }}
                placeholder="输入你的问题..."
                rows={1}
                className="ui-input max-h-40 min-h-10 flex-1 resize-none py-2.5"
              />
              {loading ? (
                <div className="mb-0.5 flex items-center gap-1.5">
                  {canInterruptAndSend ? (
                    <button
                      type="submit"
                      className="ui-btn-primary h-8 gap-1 px-3 text-xs"
                      aria-label="打断并重新发送"
                      title="打断当前生成并发送新消息"
                    >
                      <RotateCcw className="h-3 w-3" />
                      打断并发送
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={stopGeneration}
                    className="inline-flex h-8 items-center gap-1 rounded-md bg-destructive/10 px-3 text-xs font-medium text-destructive transition hover:bg-destructive/15"
                    aria-label="停止生成"
                  >
                    <Square className="h-2.5 w-2.5 fill-current" />
                    停止
                  </button>
                </div>
              ) : (
                <button
                  type="submit"
                  disabled={!canSend}
                  className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label={question.trim() ? '发送问题' : '发送附件并使用默认问题'}
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </form>
        </main>

        {/* Generated Word artifacts panel */}
        {researchMode ? (
          <aside className="rag-knowledge-panel hidden w-[300px] min-w-0 shrink-0 border-l border-border xl:flex">
            <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-semibold text-foreground">附件查看</span>
              </div>
              {conversationArtifacts.length ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-foreground">
                  {conversationArtifacts.length}
                </span>
              ) : null}
            </header>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3">
              {!conversationArtifacts.length ? (
                <div className="flex h-full min-h-72 flex-col items-center justify-center px-5 text-center">
                  <div className="rag-knowledge-loader">
                    <FileText className={`h-7 w-7 ${loading ? 'animate-pulse' : ''}`} strokeWidth={1.4} />
                  </div>
                  <div className="mt-4 text-sm text-muted-foreground">
                    {loading ? '正在生成 Word 附件…' : '本会话暂无 Word 附件'}
                  </div>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground/80">
                    {loading
                      ? '报告完成后会出现在这里，请从本窗口下载。'
                      : '上传文献并生成综述后，Word 报告会出现在此区域。'}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {conversationArtifacts.map((artifact) => (
                    <ResearchArtifactCard
                      key={artifact.id}
                      artifact={artifact}
                      compact
                      onDownload={(item) => void downloadResearchArtifact(item)}
                    />
                  ))}
                </div>
              )}
            </div>
          </aside>
        ) : null}
      </div>

      {modalSource ? <EvidenceModal source={modalSource} onClose={() => setModalSource(null)} /> : null}
      {modalAttachment ? <AttachmentPreviewModal attachment={modalAttachment} onClose={() => setModalAttachment(null)} /> : null}
      {pendingManagerOpen ? (
        <CompactAttachmentManagerModal
          title="待发送附件"
          items={pendingAttachments.map((attachment) => ({
            key: attachment.clientId,
            name: attachment.name,
            size: attachment.size,
            statusLabel: pendingAttachmentStatusLabel(attachment),
            typeLabel: attachmentTypeLabel(attachment),
            ready: attachment.status === 'ready' && Boolean(attachment.attachment),
            failed: attachment.status === 'failed',
            busy: ['queued', 'uploading', 'processing', 'removing'].includes(attachment.status),
            progress: attachment.progress,
            error: attachment.error,
            canRemove: attachment.status !== 'removing'
          }))}
          onClose={() => setPendingManagerOpen(false)}
          onPreview={(key) => {
            const pending = pendingAttachments.find((item) => item.clientId === key);
            if (pending?.attachment?.status === 'ready') {
              setPendingManagerOpen(false);
              setModalAttachment(pending.attachment);
            }
          }}
          onRemove={(key) => removePendingAttachment(key)}
        />
      ) : null}
    </div>
  );
}
