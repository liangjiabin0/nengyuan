'use client';

import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Database,
  Download,
  Globe2,
  Lightbulb,
  ListTree,
  LoaderCircle,
  MessageSquareText,
  PanelLeft,
  Paperclip,
  Plus,
  Quote,
  Search,
  Send,
  Sparkles,
  Trash2,
  X
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react';
import { useNotifyError } from '@/components/app-notify';
import { usePageContentReady } from '@/components/page-nav-loading';
import { readDashboardListCache } from '@/lib/dashboard-list-cache';
import {
  diffChangedPaths,
  locateSelectionTargets,
  pathKey as toPathKey,
  type DocumentPath
} from '@/lib/grid-guide/document-paths';
import {
  attachmentTypeLabel,
  formatAttachmentSize
} from '@/components/attachment-chips';
import {
  GRID_GUIDE_ATTACHMENT_ACCEPT,
  GRID_GUIDE_ATTACHMENT_EXTENSIONS,
  GRID_GUIDE_ATTACHMENT_HINT,
  GRID_GUIDE_ATTACHMENT_MAX_BYTES,
  GRID_GUIDE_ATTACHMENT_MAX_FILES
} from '@/lib/grid-guide/constants';
import { GridGuideFilePreview } from '@/components/grid-guide-file-preview';
import { firstGridGuideFilePath, GridGuideFileTree } from '@/components/grid-guide-file-tree';
import type {
  GridGuideDocument,
  GridGuideFileNode,
  GridGuideProject,
  TechLandscape
} from '@/lib/grid-guide/types';

type PendingCreateAttachment = {
  clientId: string;
  file: File;
  name: string;
  size: number;
  extension: string;
};

type ProjectSummary = Pick<
  GridGuideProject,
  'id' | 'title' | 'idea' | 'status' | 'progress' | 'progressDetail' | 'error' | 'createdAt' | 'updatedAt'
>;

const STARTERS = [
  {
    label: '配电网韧性与自主恢复',
    value: '面向高比例新能源配电网，研究极端天气下的韧性提升与自主恢复技术'
  },
  {
    label: '变电设备智能诊断',
    value: '利用多模态大模型提升变电设备缺陷诊断与检修决策能力'
  },
  {
    label: '构网型储能稳定支撑',
    value: '研究构网型储能参与电网稳定支撑的评估、控制与示范技术'
  }
];

function formatTime(value: string) {
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}

function statusLabel(status: GridGuideProject['status']) {
  if (status === 'generating') return '正在设计';
  if (status === 'ready') return '已生成';
  if (status === 'failed') return '需要重试';
  return '构思中';
}

function hasTechLandscapeContent(landscape?: TechLandscape) {
  if (!landscape) return false;
  return Boolean(
    landscape.overview.trim() ||
      landscape.differentiations.length ||
      landscape.existingInCorpus.length ||
      landscape.latestOnline.length
  );
}

function messageLooksLikeTechComparison(content: string) {
  return /【本指南提出的新内容】|【库内已有相关技术】|【网络最新技术方向】|【对标总览】/.test(content);
}

type TechLandscapeTocItem = {
  id: string;
  label: string;
  children?: Array<{ id: string; label: string }>;
};

function buildTechLandscapeToc(landscape: TechLandscape): TechLandscapeTocItem[] {
  const items: TechLandscapeTocItem[] = [];
  if (landscape.overview.trim()) {
    items.push({ id: 'tl-overview', label: '对标总览' });
  }
  if (landscape.differentiations.length) {
    items.push({
      id: 'tl-diff',
      label: '本指南提出的新内容',
      children: landscape.differentiations.map((item, index) => ({
        id: `tl-diff-${index}`,
        label: `${index + 1}. ${item.proposedInnovation.slice(0, 28)}${item.proposedInnovation.length > 28 ? '…' : ''}`
      }))
    });
  }
  if (landscape.existingInCorpus.length) {
    items.push({
      id: 'tl-corpus',
      label: '库内已有相关技术',
      children: landscape.existingInCorpus.map((item, index) => ({
        id: `tl-corpus-${index}`,
        label: `${index + 1}. ${item.title.slice(0, 28)}${item.title.length > 28 ? '…' : ''}`
      }))
    });
  }
  if (landscape.latestOnline.length) {
    items.push({
      id: 'tl-online',
      label: '网络最新技术方向',
      children: landscape.latestOnline.map((item, index) => ({
        id: `tl-online-${index}`,
        label: `${index + 1}. ${item.title.slice(0, 28)}${item.title.length > 28 ? '…' : ''}`
      }))
    });
  }
  return items;
}

function TechLandscapeModal({
  landscape,
  onClose
}: {
  landscape: TechLandscape;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState('tl-overview');
  const toc = useMemo(() => buildTechLandscapeToc(landscape), [landscape]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (toc[0]?.id) setActiveId(toc[0].id);
  }, [toc]);

  const scrollToSection = (id: string) => {
    setActiveId(id);
    const root = bodyRef.current;
    const target = root?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/40 p-3 backdrop-blur-[2px] md:p-6">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="关闭对标总览" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="技术对标总览"
        className="relative flex h-[min(88vh,900px)] w-full max-w-5xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
      >
        <aside className="flex w-[220px] shrink-0 flex-col border-r border-border bg-muted/30 md:w-[260px]">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
            <ListTree className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">目录</span>
          </div>
          <nav className="scrollbar-thin min-h-0 flex-1 space-y-1 overflow-y-auto p-2 text-[12px]">
            {toc.map((item) => (
              <div key={item.id}>
                <button
                  type="button"
                  onClick={() => scrollToSection(item.id)}
                  className={`flex w-full rounded-lg px-2.5 py-2 text-left font-medium transition ${
                    activeId === item.id || item.children?.some((child) => child.id === activeId)
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground hover:bg-accent'
                  }`}
                >
                  {item.label}
                </button>
                {item.children?.length ? (
                  <div className="mt-0.5 space-y-0.5 border-l border-border/70 ml-3 pl-2">
                    {item.children.map((child) => (
                      <button
                        key={child.id}
                        type="button"
                        onClick={() => scrollToSection(child.id)}
                        className={`flex w-full rounded-md px-2 py-1.5 text-left leading-4 transition ${
                          activeId === child.id
                            ? 'bg-primary/10 text-primary'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                        }`}
                      >
                        {child.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-foreground">技术对标总览</div>
              <div className="truncate text-[10px] text-muted-foreground">拟议新内容 · 库内已有 · 网络最新方向</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div ref={bodyRef} className="scrollbar-thin min-h-0 flex-1 space-y-8 overflow-y-auto px-5 py-5 text-sm leading-6 text-foreground md:px-7">
            {landscape.overview.trim() ? (
              <section id="tl-overview" className="scroll-mt-4">
                <div className="mb-2 flex items-center gap-2 text-base font-semibold">
                  <Sparkles className="h-4 w-4 text-primary" />
                  对标总览
                </div>
                <p className="text-muted-foreground">{landscape.overview}</p>
              </section>
            ) : null}

            {landscape.differentiations.length ? (
              <section id="tl-diff" className="scroll-mt-4">
                <div className="mb-3 flex items-center gap-2 text-base font-semibold">
                  <Lightbulb className="h-4 w-4 text-amber-600" />
                  本指南提出的新内容
                </div>
                <div className="space-y-3">
                  {landscape.differentiations.map((item, index) => (
                    <article
                      key={`diff-${index}`}
                      id={`tl-diff-${index}`}
                      className="scroll-mt-4 rounded-xl border border-border bg-background/80 p-4"
                    >
                      <h4 className="font-medium text-foreground">
                        {index + 1}. {item.proposedInnovation}
                      </h4>
                      <div className="mt-2 space-y-1.5 text-[13px] leading-6 text-muted-foreground">
                        <p>
                          <span className="font-medium text-foreground/85">相对库内已有：</span>
                          {item.differenceFromExisting}
                        </p>
                        <p>
                          <span className="font-medium text-foreground/85">相对最新方向：</span>
                          {item.differenceFromLatest}
                        </p>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            {landscape.existingInCorpus.length ? (
              <section id="tl-corpus" className="scroll-mt-4">
                <div className="mb-3 flex items-center gap-2 text-base font-semibold">
                  <Database className="h-4 w-4 text-primary" />
                  库内已有相关技术
                </div>
                <div className="space-y-3">
                  {landscape.existingInCorpus.map((item, index) => (
                    <article
                      key={`corpus-${index}`}
                      id={`tl-corpus-${index}`}
                      className="scroll-mt-4 rounded-xl border border-border bg-background/80 p-4"
                    >
                      <h4 className="font-medium">
                        {index + 1}. {item.title}
                        {item.sourceLabel ? (
                          <span className="ml-1 font-normal text-muted-foreground">（{item.sourceLabel}）</span>
                        ) : null}
                      </h4>
                      <p className="mt-1.5 text-[13px] leading-6 text-muted-foreground">要点：{item.gist}</p>
                      {item.gapOrDifference ? (
                        <p className="mt-1 text-[13px] leading-6 text-muted-foreground">
                          与本指南的区别：{item.gapOrDifference}
                        </p>
                      ) : null}
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            {landscape.latestOnline.length ? (
              <section id="tl-online" className="scroll-mt-4">
                <div className="mb-3 flex items-center gap-2 text-base font-semibold">
                  <Globe2 className="h-4 w-4 text-sky-600" />
                  网络最新技术方向
                </div>
                <div className="space-y-3">
                  {landscape.latestOnline.map((item, index) => (
                    <article
                      key={`web-${index}`}
                      id={`tl-online-${index}`}
                      className="scroll-mt-4 rounded-xl border border-border bg-background/80 p-4"
                    >
                      <h4 className="font-medium">
                        {index + 1}. {item.title}
                        {item.sourceLabel ? (
                          <span className="ml-1 font-normal text-muted-foreground">（{item.sourceLabel}）</span>
                        ) : null}
                      </h4>
                      <p className="mt-1.5 text-[13px] leading-6 text-muted-foreground">要点：{item.gist}</p>
                      {item.gapOrDifference ? (
                        <p className="mt-1 text-[13px] leading-6 text-muted-foreground">
                          与本指南的区别：{item.gapOrDifference}
                        </p>
                      ) : null}
                      {item.url ? (
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 inline-block break-all text-[12px] text-primary hover:underline"
                        >
                          {item.url}
                        </a>
                      ) : null}
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function AssistantMessageBody({
  content,
  landscape
}: {
  content: string;
  landscape?: TechLandscape;
}) {
  const [landscapeOpen, setLandscapeOpen] = useState(false);
  const showEntry =
    hasTechLandscapeContent(landscape) && messageLooksLikeTechComparison(content);

  if (showEntry && landscape) {
    const lead = content.split(/\n{2,}/)[0]?.trim();
    return (
      <div>
        {lead ? <p className="whitespace-pre-wrap">{lead}</p> : null}
        <button
          type="button"
          onClick={() => setLandscapeOpen(true)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-[12px] font-medium text-primary transition hover:border-primary/40 hover:bg-primary/10"
        >
          <ListTree className="h-3.5 w-3.5" />
          查看技术对标总览
        </button>
        {landscapeOpen ? (
          <TechLandscapeModal landscape={landscape} onClose={() => setLandscapeOpen(false)} />
        ) : null}
      </div>
    );
  }
  return <p className="whitespace-pre-wrap">{content}</p>;
}

function GenerationProgress({ project, compact = false }: { project: GridGuideProject; compact?: boolean }) {
  const progress = Math.max(2, Math.min(99, project.progress || 2));
  return (
    <div className={compact ? 'w-full' : 'mt-5'}>
      <div className="mb-1.5 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span className="truncate">{project.progressDetail || '正在准备生成任务'}</span>
        <span className="shrink-0 font-medium tabular-nums text-foreground">{progress}%</span>
      </div>
      <div
        role="progressbar"
        aria-label="项目指南生成进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 contentEditable={false} className="mt-8 text-[17px] font-bold leading-8 text-slate-950 first:mt-0">
      {children}
    </h3>
  );
}

type DocumentEdit = { path: DocumentPath; value: string };
type CommitEdits = (edits: DocumentEdit[]) => void | Promise<void>;
type FlushDocumentEdits = () => Promise<void>;

function pathKey(path: DocumentPath) {
  return toPathKey(path);
}

function normalizeEditorText(value: string) {
  return value.replace(/\u00A0/g, ' ').replace(/\r\n?/g, '\n').trim();
}

function fieldToneClass(path: DocumentPath, lockedPaths: string[], glowPaths: string[], flashPaths: string[]) {
  const key = pathKey(path);
  if (flashPaths.includes(key)) return 'guide-field-flash';
  if (glowPaths.includes(key)) return 'guide-field-glow';
  if (lockedPaths.includes(key)) return 'guide-field-locked';
  return '';
}

function applyEditsLocally(document: GridGuideDocument, edits: DocumentEdit[]): GridGuideDocument {
  const next = structuredClone(document);
  for (const edit of edits) {
    let parent: unknown = next;
    for (const part of edit.path.slice(0, -1)) {
      if (typeof parent !== 'object' || parent === null || !(part in parent)) break;
      parent = (parent as Record<string | number, unknown>)[part];
    }
    const leaf = edit.path.at(-1);
    if (
      leaf === undefined ||
      typeof parent !== 'object' ||
      parent === null ||
      !(leaf in parent) ||
      typeof (parent as Record<string | number, unknown>)[leaf] !== 'string'
    ) {
      continue;
    }
    (parent as Record<string | number, unknown>)[leaf] = edit.value;
    if (edit.path.length === 1 && edit.path[0] === 'projectTitle') {
      next.explanation.planningCorrespondence.guideName = edit.value;
    }
    if (edit.path[0] === 'guide' && edit.path[1] === 'topicSetup' && typeof edit.path[2] === 'number') {
      if (next.guide.topics[edit.path[2]]) next.guide.topics[edit.path[2]].title = edit.value;
    }
    if (
      edit.path[0] === 'guide' &&
      edit.path[1] === 'topics' &&
      typeof edit.path[2] === 'number' &&
      edit.path[3] === 'title'
    ) {
      if (next.guide.topicSetup[edit.path[2]] !== undefined) {
        next.guide.topicSetup[edit.path[2]] = edit.value;
      }
    }
  }
  return next;
}

function splitFormalParagraphs(value: string) {
  const parts = value
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map((part) => part.replace(/^[　\s]+/, '').trimEnd());
  const nonempty = parts.filter((part) => part.length > 0);
  return nonempty.length ? nonempty : [''];
}

function Field({
  path,
  value,
  multiline = true,
  className = '',
  as: Tag = 'span',
  locked = false,
  toneClass = ''
}: {
  path: DocumentPath;
  value: string;
  multiline?: boolean;
  className?: string;
  as?: 'span' | 'p';
  locked?: boolean;
  toneClass?: string;
}) {
  return (
    <Tag
      contentEditable={locked ? false : undefined}
      suppressContentEditableWarning
      data-edit-path={pathKey(path)}
      data-multiline={multiline ? '1' : '0'}
      data-original={value}
      className={`whitespace-pre-wrap outline-none transition-[box-shadow,background-color] duration-300 ${toneClass} ${className}`}
    >
      {value}
    </Tag>
  );
}

function FormalParagraph({
  path,
  value,
  locked = false,
  toneClass = ''
}: {
  path: DocumentPath;
  value: string;
  locked?: boolean;
  toneClass?: string;
}) {
  const paragraphs = splitFormalParagraphs(value);
  return (
    <div
      contentEditable={locked ? false : undefined}
      suppressContentEditableWarning
      data-edit-path={pathKey(path)}
      data-multiline="1"
      data-original={value}
      className={`guide-formal-field outline-none transition-[box-shadow,background-color] duration-300 ${toneClass}`}
    >
      {paragraphs.map((paragraph, index) => (
        <p
          key={index}
          className="mt-2 text-justify text-[15px] leading-8 text-slate-800 [text-indent:2em]"
        >
          {paragraph || '\u00A0'}
        </p>
      ))}
    </div>
  );
}

function NumberedList({
  items,
  basePath,
  parenthesized = false,
  lockedPaths = [],
  glowPaths = [],
  flashPaths = []
}: {
  items: string[];
  basePath: DocumentPath;
  parenthesized?: boolean;
  lockedPaths?: string[];
  glowPaths?: string[];
  flashPaths?: string[];
}) {
  return (
    <div className="mt-2 text-[15px] leading-8 text-slate-800">
      {items.map((item, index) => {
        const path = [...basePath, index] as DocumentPath;
        const key = pathKey(path);
        return (
          <p key={index} className="text-justify">
            <span contentEditable={false} className="select-none">
              {parenthesized ? `（${index + 1}）` : `${index + 1}.`}
            </span>
            <Field
              path={path}
              value={item}
              locked={lockedPaths.includes(key)}
              toneClass={fieldToneClass(path, lockedPaths, glowPaths, flashPaths)}
            />
          </p>
        );
      })}
    </div>
  );
}

function LockedLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span contentEditable={false} className={className}>
      {children}
    </span>
  );
}

function collectDocumentEdits(root: HTMLElement): DocumentEdit[] {
  const edits: DocumentEdit[] = [];
  root.querySelectorAll<HTMLElement>('[data-edit-path]').forEach((node) => {
    const rawPath = node.getAttribute('data-edit-path');
    if (!rawPath) return;
    let path: DocumentPath;
    try {
      path = JSON.parse(rawPath) as DocumentPath;
    } catch {
      return;
    }
    const next = normalizeEditorText(node.innerText || '');
    const original = node.getAttribute('data-original') ?? '';
    if (!next) {
      node.innerText = original;
      return;
    }
    if (next !== original) edits.push({ path, value: next });
  });
  return edits;
}

function mergeDocumentEdits(base: DocumentEdit[], incoming: DocumentEdit[]) {
  const map = new Map<string, DocumentEdit>();
  for (const edit of base) map.set(pathKey(edit.path), edit);
  for (const edit of incoming) map.set(pathKey(edit.path), edit);
  return Array.from(map.values());
}

const AUTO_SAVE_DEBOUNCE_MS = 500;

function GuideDocument({
  document: guideDocument,
  onCommit,
  onRegisterFlush,
  disabled = false,
  lockedPaths = [],
  glowPaths = [],
  flashPaths = [],
  preferredPart
}: {
  document: GridGuideDocument;
  onCommit: CommitEdits;
  onRegisterFlush?: (flush: FlushDocumentEdits | null) => void;
  disabled?: boolean;
  lockedPaths?: string[];
  glowPaths?: string[];
  flashPaths?: string[];
  preferredPart?: 'guide' | 'explanation';
}) {
  const [part, setPart] = useState<'guide' | 'explanation'>('guide');
  const articleRef = useRef<HTMLElement>(null);
  const editingRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const viewStampRef = useRef(JSON.stringify(guideDocument));
  const [viewDoc, setViewDoc] = useState(guideDocument);
  const viewDocRef = useRef(guideDocument);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const guide = viewDoc.guide;
  const explanation = viewDoc.explanation;
  const documentStamp = useMemo(() => JSON.stringify(guideDocument), [guideDocument]);

  useEffect(() => {
    viewDocRef.current = viewDoc;
  }, [viewDoc]);

  useEffect(() => {
    if (preferredPart) setPart(preferredPart);
  }, [preferredPart]);

  useEffect(() => {
    if (viewStampRef.current === documentStamp) return;
    const root = articleRef.current;
    const active = window.document.activeElement;
    const typingInEditor = Boolean(root && active && root.contains(active) && editingRef.current);
    // 自动保存回写时若仍在输入，只同步快照，避免 React 重绘打乱光标。
    if (typingInEditor) {
      viewStampRef.current = documentStamp;
      viewDocRef.current = guideDocument;
      return;
    }
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    viewStampRef.current = documentStamp;
    editingRef.current = false;
    viewDocRef.current = guideDocument;
    setViewDoc(guideDocument);
    setEditorEpoch((value) => value + 1);
  }, [guideDocument, documentStamp]);

  const toneOf = (path: DocumentPath) => fieldToneClass(path, lockedPaths, glowPaths, flashPaths);
  const lockedOf = (path: DocumentPath) => lockedPaths.includes(pathKey(path));

  const flushEdits = useCallback(async () => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const root = articleRef.current;
    if (!root || disabled) return;
    const edits = collectDocumentEdits(root).filter((edit) => !lockedOf(edit.path));
    if (!edits.length) return;
    edits.forEach((edit) => {
      root.querySelectorAll<HTMLElement>('[data-edit-path]').forEach((node) => {
        if (node.getAttribute('data-edit-path') === pathKey(edit.path)) {
          node.setAttribute('data-original', edit.value);
        }
      });
    });
    const next = applyEditsLocally(viewDocRef.current, edits);
    viewDocRef.current = next;
    viewStampRef.current = JSON.stringify(next);
    // 输入过程中不要 setState 回写正文，否则 contentEditable 会被 React 重绘，光标会跳走。
    const active = window.document.activeElement;
    const stillEditing = Boolean(active && root.contains(active));
    if (!stillEditing) {
      setViewDoc(next);
    }
    await onCommit(edits);
  }, [disabled, lockedPaths, onCommit]);

  const scheduleFlush = useCallback(() => {
    if (disabled) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushEdits();
    }, AUTO_SAVE_DEBOUNCE_MS);
  }, [disabled, flushEdits]);

  useEffect(() => {
    onRegisterFlush?.(flushEdits);
    return () => onRegisterFlush?.(null);
  }, [flushEdits, onRegisterFlush]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    },
    []
  );

  const onEditorInput = () => {
    editingRef.current = true;
    scheduleFlush();
  };

  const onEditorBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    editingRef.current = false;
    void flushEdits();
  };

  const onEditorKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      const root = articleRef.current;
      if (!root) return;
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      root.querySelectorAll<HTMLElement>('[data-edit-path]').forEach((node) => {
        node.innerText = node.getAttribute('data-original') ?? '';
      });
      editingRef.current = false;
      (event.currentTarget as HTMLElement).blur();
      return;
    }

    // Tab 默认会把焦点跳到页签/按钮；改为在正文插入缩进空格。
    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      window.document.execCommand('insertText', false, '　　');
      scheduleFlush();
      return;
    }

    // 避免空格在焦点落到按钮时变成“点击/翻页”。
    if (event.key === ' ' || event.code === 'Space') {
      event.stopPropagation();
      // 不 preventDefault，让 contentEditable 正常插入空格
      return;
    }

    if (event.key !== 'Enter') return;
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    const field =
      anchor instanceof HTMLElement
        ? anchor.closest('[data-edit-path]')
        : anchor?.parentElement?.closest('[data-edit-path]');
    if (!field) return;
    if (field.getAttribute('data-multiline') !== '1') {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    // 正式段落块用新段落，才能带上首行缩进；列表项等仍用软换行。
    if (field.classList.contains('guide-formal-field')) {
      window.document.execCommand('insertParagraph');
    } else {
      window.document.execCommand('insertLineBreak');
    }
    scheduleFlush();
  };

  const onEditorPaste = (event: ClipboardEvent<HTMLElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
    window.document.execCommand('insertText', false, text);
    scheduleFlush();
  };

  return (
    <div>
      <div
        contentEditable={false}
        className="sticky top-0 z-10 -mx-10 -mt-6 mb-6 flex items-center justify-center px-4 py-2 md:-mt-8"
      >
        <div className="flex rounded-lg bg-slate-100 p-1 text-xs font-medium">
          <button
            type="button"
            tabIndex={-1}
            onClick={() => {
              void flushEdits();
              setPart('guide');
            }}
            className={`rounded-md px-3 py-1.5 transition ${part === 'guide' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
          >
            项目申报指南
          </button>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => {
              void flushEdits();
              setPart('explanation');
            }}
            className={`rounded-md px-3 py-1.5 transition ${part === 'explanation' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
          >
            编制说明
          </button>
        </div>
      </div>

      {part === 'guide' ? (
        <article
          key={`guide-${editorEpoch}`}
          ref={articleRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          spellCheck={false}
          onFocus={() => {
            editingRef.current = true;
          }}
          onInput={onEditorInput}
          onBlur={onEditorBlur}
          onKeyDown={onEditorKeyDown}
          onPaste={onEditorPaste}
          className="cursor-text caret-slate-900 outline-none"
        >
          <h2 contentEditable={false} className="mb-10 text-center font-serif text-2xl font-bold leading-10 text-slate-950">
            <LockedLabel>《</LockedLabel>
            <span
              contentEditable={disabled || lockedOf(['projectTitle']) ? false : undefined}
              suppressContentEditableWarning
              data-edit-path={pathKey(['projectTitle'])}
              data-multiline="0"
              data-original={viewDoc.projectTitle}
              className={`outline-none ${toneOf(['projectTitle'])}`}
            >
              {viewDoc.projectTitle}
            </span>
            <LockedLabel>》项目申报指南</LockedLabel>
          </h2>
          <SectionTitle>一、技术类别</SectionTitle>
          <FormalParagraph
            value={guide.technicalCategory}
            path={['guide', 'technicalCategory']}
            locked={lockedOf(['guide', 'technicalCategory'])}
            toneClass={toneOf(['guide', 'technicalCategory'])}
          />
          <SectionTitle>二、总体目标</SectionTitle>
          <FormalParagraph
            value={guide.overallObjective}
            path={['guide', 'overallObjective']}
            locked={lockedOf(['guide', 'overallObjective'])}
            toneClass={toneOf(['guide', 'overallObjective'])}
          />
          <SectionTitle>三、课题设置情况</SectionTitle>
          <NumberedList
            items={guide.topicSetup}
            basePath={['guide', 'topicSetup']}
            lockedPaths={lockedPaths}
            glowPaths={glowPaths}
            flashPaths={flashPaths}
          />
          <SectionTitle>四、项目实施期限</SectionTitle>
          <FormalParagraph
            value={guide.implementationPeriod}
            path={['guide', 'implementationPeriod']}
            locked={lockedOf(['guide', 'implementationPeriod'])}
            toneClass={toneOf(['guide', 'implementationPeriod'])}
          />
          <SectionTitle>五、课题内容</SectionTitle>
          {guide.topics.map((topic, topicIndex) => (
            <section key={topicIndex} className="mt-6">
              <h4 contentEditable={false} className="text-[16px] font-bold leading-8 text-slate-950">
                <LockedLabel>{`课题${topicIndex + 1}：`}</LockedLabel>
                <span
                  contentEditable={
                    disabled || lockedOf(['guide', 'topics', topicIndex, 'title']) ? false : undefined
                  }
                  suppressContentEditableWarning
                  data-edit-path={pathKey(['guide', 'topics', topicIndex, 'title'])}
                  data-multiline="0"
                  data-original={topic.title}
                  className={`outline-none ${toneOf(['guide', 'topics', topicIndex, 'title'])}`}
                >
                  {topic.title}
                </span>
              </h4>
              <h5 contentEditable={false} className="mt-3 text-[15px] font-semibold leading-8 text-slate-900">
                主要研究内容：
              </h5>
              <NumberedList
                items={topic.researchContent}
                basePath={['guide', 'topics', topicIndex, 'researchContent']}
                parenthesized
                lockedPaths={lockedPaths}
                glowPaths={glowPaths}
                flashPaths={flashPaths}
              />
              <h5 contentEditable={false} className="mt-3 text-[15px] font-semibold leading-8 text-slate-900">
                预期目标：
              </h5>
              <FormalParagraph
                value={topic.expectedGoal}
                path={['guide', 'topics', topicIndex, 'expectedGoal']}
                locked={lockedOf(['guide', 'topics', topicIndex, 'expectedGoal'])}
                toneClass={toneOf(['guide', 'topics', topicIndex, 'expectedGoal'])}
              />
              <h5 contentEditable={false} className="mt-3 text-[15px] font-semibold leading-8 text-slate-900">
                考核指标：
              </h5>
              <NumberedList
                items={topic.assessmentIndicators}
                basePath={['guide', 'topics', topicIndex, 'assessmentIndicators']}
                parenthesized
                lockedPaths={lockedPaths}
                glowPaths={glowPaths}
                flashPaths={flashPaths}
              />
            </section>
          ))}
          <SectionTitle>六、技术成熟度及成果应用</SectionTitle>
          <FormalParagraph
            value={guide.maturityAndApplication}
            path={['guide', 'maturityAndApplication']}
            locked={lockedOf(['guide', 'maturityAndApplication'])}
            toneClass={toneOf(['guide', 'maturityAndApplication'])}
          />
          <SectionTitle>七、支持经费限额</SectionTitle>
          <FormalParagraph
            value={guide.budgetLimit}
            path={['guide', 'budgetLimit']}
            locked={lockedOf(['guide', 'budgetLimit'])}
            toneClass={toneOf(['guide', 'budgetLimit'])}
          />
        </article>
      ) : (
        <article
          key={`explanation-${editorEpoch}`}
          ref={articleRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          spellCheck={false}
          onFocus={() => {
            editingRef.current = true;
          }}
          onInput={onEditorInput}
          onBlur={onEditorBlur}
          onKeyDown={onEditorKeyDown}
          onPaste={onEditorPaste}
          className="cursor-text caret-slate-900 outline-none"
        >
          <h2 contentEditable={false} className="mb-10 text-center font-serif text-2xl font-bold leading-10 text-slate-950">
            <LockedLabel>《</LockedLabel>
            <span
              contentEditable={disabled || lockedOf(['projectTitle']) ? false : undefined}
              suppressContentEditableWarning
              data-edit-path={pathKey(['projectTitle'])}
              data-multiline="0"
              data-original={viewDoc.projectTitle}
              className={`outline-none ${toneOf(['projectTitle'])}`}
            >
              {viewDoc.projectTitle}
            </span>
            <LockedLabel>》项目申报指南编制说明</LockedLabel>
          </h2>
          <SectionTitle>一、技术需求分析</SectionTitle>
          <FormalParagraph
            value={explanation.technicalDemandAnalysis}
            path={['explanation', 'technicalDemandAnalysis']}
            locked={lockedOf(['explanation', 'technicalDemandAnalysis'])}
            toneClass={toneOf(['explanation', 'technicalDemandAnalysis'])}
          />
          <SectionTitle>二、技术现状分析及需要开展的研究工作</SectionTitle>
          <FormalParagraph
            value={explanation.currentStatusAndResearchWork}
            path={['explanation', 'currentStatusAndResearchWork']}
            locked={lockedOf(['explanation', 'currentStatusAndResearchWork'])}
            toneClass={toneOf(['explanation', 'currentStatusAndResearchWork'])}
          />
          <SectionTitle>三、课题设置说明</SectionTitle>
          <FormalParagraph
            value={explanation.topicSetupExplanation}
            path={['explanation', 'topicSetupExplanation']}
            locked={lockedOf(['explanation', 'topicSetupExplanation'])}
            toneClass={toneOf(['explanation', 'topicSetupExplanation'])}
          />
          <SectionTitle>四、项目与规划/需求的对应性</SectionTitle>
          <div contentEditable={false} className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse text-center text-xs leading-5 text-slate-700">
              <thead>
                <tr>
                  {['指南名称', '规划/需求编号', '规划/需求名称', '技术领域', '提出单位'].map((value) => (
                    <th key={value} className="border border-slate-300 bg-slate-50 p-2 font-semibold text-slate-900">
                      {value}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {Object.entries(explanation.planningCorrespondence).map(([key, value]) => {
                    const path = ['explanation', 'planningCorrespondence', key] as DocumentPath;
                    return (
                      <td key={key} className="border border-slate-300 p-2 align-top">
                        <span
                          contentEditable={disabled || lockedOf(path) ? false : undefined}
                          suppressContentEditableWarning
                          data-edit-path={pathKey(path)}
                          data-multiline="1"
                          data-original={value}
                          className={`inline-block min-h-[1.25rem] w-full whitespace-pre-wrap text-left outline-none ${toneOf(path)}`}
                        >
                          {value}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
          <SectionTitle>五、承担主体及说明</SectionTitle>
          <FormalParagraph
            value={explanation.undertakingEntity}
            path={['explanation', 'undertakingEntity']}
            locked={lockedOf(['explanation', 'undertakingEntity'])}
            toneClass={toneOf(['explanation', 'undertakingEntity'])}
          />
        </article>
      )}
    </div>
  );
}

function ChatPanel({
  project,
  selectedText,
  busy,
  onClearSelection,
  onSend,
  focusToken = 0
}: {
  project: GridGuideProject;
  selectedText: string;
  busy: boolean;
  onClearSelection: () => void;
  onSend: (message: string) => Promise<void>;
  focusToken?: number;
}) {
  const [message, setMessage] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [project.messages.length, busy]);

  useEffect(() => {
    if (!selectedText && focusToken <= 0) return;
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      const length = inputRef.current?.value.length || 0;
      inputRef.current?.setSelectionRange(length, length);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedText, focusToken]);

  const send = async () => {
    if (!message.trim() || busy) return;
    const value = message.trim();
    setMessage('');
    await onSend(value);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <header className="flex h-[57px] shrink-0 items-center gap-2 border-b border-border px-4">
        <MessageSquareText className="h-4 w-4 text-primary" />
        <div>
          <div className="text-sm font-semibold text-foreground">设计对话</div>
          <div className="text-[10px] text-muted-foreground">提出意见，整份文档会保持一致更新</div>
        </div>
      </header>
      <div className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="rounded-xl border border-primary/15 bg-primary/5 p-3 text-xs leading-5 text-muted-foreground">
          <div className="mb-1 flex items-center gap-1.5 font-semibold text-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            指南设计助手
          </div>
          我会检索库内与网络证据，在本次任务文件夹中写入指南成果树；你可在左侧打开文件预览并直接编辑，或在对话里要求修订。
        </div>
        {project.attachments?.length ? (
          <div className="rounded-xl border border-border/70 bg-muted/30 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-foreground">
              <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
              创建时参考附件（后续对话不可再添加）
            </div>
            <div className="flex flex-wrap gap-1.5">
              {project.attachments.map((item) => (
                <a
                  key={item.id}
                  href={item.previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border/70 bg-background px-2 py-1 text-[11px] text-foreground transition hover:border-primary/30"
                  title={`${item.name} · ${formatAttachmentSize(item.size)}`}
                >
                  <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                    {attachmentTypeLabel(item)}
                  </span>
                  <span className="min-w-0 truncate">{item.name}</span>
                </a>
              ))}
            </div>
          </div>
        ) : null}
        {project.messages.map((item, index) => {
          const isLatestComparison =
            item.role === 'assistant' &&
            messageLooksLikeTechComparison(item.content) &&
            !project.messages
              .slice(index + 1)
              .some((later) => later.role === 'assistant' && messageLooksLikeTechComparison(later.content));
          return (
          <div key={item.id} className={`flex ${item.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={item.role === 'user' ? 'rag-user-bubble max-w-[88%]' : 'rag-assistant-bubble max-w-[95%]'}>
              {item.selection ? (
                <div className="mb-2 border-l-2 border-current/25 pl-2 text-[11px] opacity-70">
                  “{item.selection.length > 180 ? `${item.selection.slice(0, 180)}…` : item.selection}”
                </div>
              ) : null}
              {item.role === 'assistant' ? (
                <AssistantMessageBody
                  content={item.content}
                  landscape={isLatestComparison ? project.document?.techLandscape : undefined}
                />
              ) : (
                <p className="whitespace-pre-wrap">{item.content}</p>
              )}
            </div>
          </div>
          );
        })}
        {busy ? (
          <div className="flex justify-start">
            <div className="rag-assistant-bubble w-[95%]">
              <div className="flex items-center gap-2 text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin text-primary" />
                <span>本轮正在处理中</span>
              </div>
              <GenerationProgress project={project} />
            </div>
          </div>
        ) : null}
        <div ref={endRef} />
      </div>
      <div className="shrink-0 border-t border-border p-3">
        {selectedText ? (
          <div className="mb-2 rounded-lg border border-primary/20 bg-primary/5 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1 text-[10px] font-semibold text-primary">
                <Quote className="h-3 w-3" /> 已引用选文
              </span>
              <button type="button" onClick={onClearSelection} className="text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{selectedText}</p>
          </div>
        ) : null}
        <div className="rounded-xl border border-border bg-background p-2 focus-within:border-primary/40">
          <textarea
            ref={inputRef}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            disabled={busy}
            rows={3}
            placeholder={selectedText ? '说明希望如何修改这段内容…' : '继续优化课题、指标或应用场景…'}
            className="w-full resize-none bg-transparent px-1 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">Enter 发送 · Shift+Enter 换行</span>
            <button
              type="button"
              onClick={() => void send()}
              disabled={!message.trim() || busy}
              className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:opacity-30"
              aria-label="发送"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function GridGuideWorkbench() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<GridGuideProject | null>(null);
  const [idea, setIdea] = useState('');
  const [createAttachments, setCreateAttachments] = useState<PendingCreateAttachment[]>([]);
  const createFileInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [, setError] = useNotifyError();
  const [selectedText, setSelectedText] = useState('');
  const [pendingSelectedText, setPendingSelectedText] = useState('');
  const [selectionPosition, setSelectionPosition] = useState<{ left: number; top: number } | null>(null);
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  const [aiTargetPaths, setAiTargetPaths] = useState<string[]>([]);
  const [flashPaths, setFlashPaths] = useState<string[]>([]);
  const [preferredPart, setPreferredPart] = useState<'guide' | 'explanation' | undefined>(undefined);
  const previousDocumentRef = useRef<GridGuideDocument | undefined>(undefined);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  /** 仅画布页使用：浮层项目列表是否展开；新建设计页左侧为同平面常驻展开。 */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [listReady, setListReady] = useState(false);
  const [workspaceEnterKey, setWorkspaceEnterKey] = useState(0);
  const [fileTree, setFileTree] = useState<GridGuideFileNode[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const paperRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const documentFlushRef = useRef<FlushDocumentEdits | null>(null);
  const pendingEditsRef = useRef<DocumentEdit[]>([]);
  const savingEditRef = useRef(false);
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  usePageContentReady(listReady);

  const refreshProjects = useCallback(async (force = false) => {
    const projects = await readDashboardListCache('/api/grid-guides', async () => {
      const response = await fetch('/api/grid-guides');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '读取指南项目失败。');
      return data.projects || [];
    }, { force });
    setProjects(projects);
  }, []);

  const loadProject = useCallback(async (id: string) => {
    setError('');
    const response = await fetch(`/api/grid-guides/${encodeURIComponent(id)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取指南项目失败。');
    const switched = projectRef.current?.id !== data.project.id;
    const enteredWorkspace = !projectRef.current && Boolean(data.project);
    setProject(data.project);
    if (switched || enteredWorkspace) {
      setSelectedFilePath('');
      setFileTree([]);
    }
    setSelectedText('');
    setSelectionPosition(null);
    setSidebarOpen(false);
    if (switched || enteredWorkspace) {
      setWorkspaceEnterKey((value) => value + 1);
    }
  }, []);

  useEffect(() => {
    void refreshProjects()
      .catch((reason) => setError(reason instanceof Error ? reason.message : '读取失败。'))
      .finally(() => setListReady(true));
  }, [refreshProjects]);

  const refreshFiles = useCallback(async (id: string) => {
    const response = await fetch(`/api/grid-guides/${encodeURIComponent(id)}/files`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return;
    setFileTree(Array.isArray(data.tree) ? data.tree : []);
  }, []);

  const isLegacyCanvas = Boolean(project?.document) && !project?.taskFolder && !project?.hasWorkspace;
  const isFileWorkspace = Boolean(project) && !isLegacyCanvas;

  useEffect(() => {
    if (project?.status !== 'generating' || busy) return;
    void loadProject(project.id).catch(() => undefined);
    const timer = window.setInterval(async () => {
      void loadProject(project.id).then(() => refreshProjects(true)).catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [busy, loadProject, project?.id, project?.status, refreshProjects]);

  useEffect(() => {
    if (!project || isLegacyCanvas) return;
    void refreshFiles(project.id).catch(() => undefined);
    if (project.status !== 'generating') return;
    const timer = window.setInterval(async () => {
      void refreshFiles(project.id).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [isLegacyCanvas, project?.id, project?.status, refreshFiles]);

  useEffect(() => {
    if (!isFileWorkspace || selectedFilePath || !fileTree.length) return;
    const next = firstGridGuideFilePath(fileTree);
    if (next) setSelectedFilePath(next);
  }, [fileTree, isFileWorkspace, selectedFilePath]);

  useEffect(() => {
    const current = project?.document;
    const previous = previousDocumentRef.current;
    if (current && previous && project?.status === 'ready') {
      const changed = diffChangedPaths(previous, current);
      if (changed.length) {
        const keys = changed.map((path) => pathKey(path));
        setFlashPaths(keys);
        if (changed.some((path) => path[0] === 'explanation')) setPreferredPart('explanation');
        else if (changed.some((path) => path[0] === 'guide' || path[0] === 'projectTitle')) {
          setPreferredPart('guide');
        }
        const timer = window.setTimeout(() => setFlashPaths([]), 3200);
        previousDocumentRef.current = current;
        return () => window.clearTimeout(timer);
      }
    }
    previousDocumentRef.current = current;
    return undefined;
  }, [project?.document, project?.status, project?.updatedAt]);

  useEffect(() => {
    if (project?.status !== 'generating') setAiTargetPaths([]);
  }, [project?.status]);

  useEffect(() => {
    if (!project || !sidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [project, sidebarOpen]);

  const filteredProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? projects.filter((item) => item.title.toLowerCase().includes(query)) : projects;
  }, [projects, search]);

  function addCreateAttachments(fileList: FileList | File[] | null) {
    if (!fileList) return;
    const incoming = Array.from(fileList);
    if (!incoming.length) return;
    setError('');
    setCreateAttachments((current) => {
      const next = [...current];
      for (const file of incoming) {
        if (next.length >= GRID_GUIDE_ATTACHMENT_MAX_FILES) {
          setError(`创建时最多上传 ${GRID_GUIDE_ATTACHMENT_MAX_FILES} 个附件。`);
          break;
        }
        const extension = (file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '') as string;
        if (!GRID_GUIDE_ATTACHMENT_EXTENSIONS.has(extension)) {
          setError('仅支持文档、表格、图片或 ZIP（ZIP 会自动解压并抽取全文）。');
          continue;
        }
        if (file.size > GRID_GUIDE_ATTACHMENT_MAX_BYTES) {
          setError('单个附件不能超过 200 MB。');
          continue;
        }
        if (next.some((item) => item.name === file.name && item.size === file.size)) continue;
        next.push({
          clientId: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          name: file.name,
          size: file.size,
          extension
        });
      }
      return next;
    });
  }

  async function generateInitial() {
    const value = idea.trim();
    if (!value || busy) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('idea', value);
      for (const item of createAttachments) {
        form.append('files', item.file, item.name);
      }
      const createResponse = await fetch('/api/grid-guides', {
        method: 'POST',
        body: form
      });
      const created = await createResponse.json();
      if (!createResponse.ok) throw new Error(created.error || '创建项目失败。');
      setProject(created.project);
      setIdea('');
      setCreateAttachments([]);
      setSidebarOpen(false);
      setWorkspaceEnterKey((key) => key + 1);
      await refreshProjects(true);
      const response = await fetch(`/api/grid-guides/${created.project.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initial: true,
          message: '请按 sgcc-tech-guide 编制。若附件含原稿与文献包：先读 literature/extracted 与任务文件夹中的原稿.md、01_全文提取，按证据重写原稿第一、二章并写入 05_正式成果/重写稿.md（综述级深度，禁止页眉或基金项目切片）；同时一次性逐一编制 V7 全量成果树。guide.json 必须使用 functional_requirements、topics[].metrics.performance|validation|outputs。'
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '指南设计失败。');
      setProject(data.project);
      await refreshProjects(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '指南设计失败。');
      await refreshProjects(true).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function sendRevision(message: string) {
    if (!project || busy) return;
    await flushPendingDocumentEdits();
    setBusy(true);
    setError('');
    const selection = selectedText;
    if (project.document && selection) {
      const targets = locateSelectionTargets(project.document, selection);
      const keys = targets.map((item) => pathKey(item.path));
      setAiTargetPaths(keys);
      if (targets.some((item) => item.path[0] === 'explanation')) setPreferredPart('explanation');
      else if (targets.length) setPreferredPart('guide');
    } else {
      setAiTargetPaths([]);
    }
    setSelectionPosition(null);
    try {
      const response = await fetch(`/api/grid-guides/${project.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, selection: selection || undefined })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '修订指南失败。');
      setProject(data.project);
      setSelectedText('');
      await refreshProjects(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '修订指南失败。');
      await loadProject(project.id).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const editDocument = useCallback(async (edits: DocumentEdit[]) => {
    const current = projectRef.current;
    if (!current || !edits.length) return;
    if (current.status === 'generating' && !current.document) return;
    const locked = new Set(aiTargetPaths);
    const allowed = edits.filter((edit) => !locked.has(pathKey(edit.path)));
    if (!allowed.length) return;

    pendingEditsRef.current = mergeDocumentEdits(pendingEditsRef.current, allowed);

    const runSaveLoop = async () => {
      savingEditRef.current = true;
      setSavingEdit(true);
      setError('');
      try {
        while (pendingEditsRef.current.length) {
          const batch = pendingEditsRef.current;
          pendingEditsRef.current = [];
          const targetId = projectRef.current?.id;
          if (!targetId) break;
          const response = await fetch(`/api/grid-guides/${encodeURIComponent(targetId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ edits: batch })
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || '保存画布编辑失败。');
          if (projectRef.current?.id === targetId) {
            setProject(data.project);
          }
          await refreshProjects(true);
        }
      } catch (reason) {
        pendingEditsRef.current = [];
        setError(reason instanceof Error ? reason.message : '保存画布编辑失败。');
        const id = projectRef.current?.id;
        if (id) await loadProject(id).catch(() => undefined);
      } finally {
        savingEditRef.current = false;
        setSavingEdit(false);
        savePromiseRef.current = null;
      }
      if (pendingEditsRef.current.length) {
        savePromiseRef.current = runSaveLoop();
        await savePromiseRef.current;
      }
    };

    if (!savePromiseRef.current) {
      savePromiseRef.current = runSaveLoop();
    }
    await savePromiseRef.current;
  }, [aiTargetPaths, loadProject, refreshProjects]);

  const registerDocumentFlush = useCallback((flush: FlushDocumentEdits | null) => {
    documentFlushRef.current = flush;
  }, []);

  async function flushPendingDocumentEdits() {
    await documentFlushRef.current?.();
    while (savingEditRef.current || pendingEditsRef.current.length) {
      if (savePromiseRef.current) await savePromiseRef.current;
      else await new Promise((resolve) => window.setTimeout(resolve, 20));
    }
  }

  async function removeProject(id: string) {
    const response = await fetch(`/api/grid-guides/${id}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || '删除失败。');
      return;
    }
    if (project?.id === id) {
      setProject(null);
      setSidebarOpen(false);
    }
    await refreshProjects(true);
  }

  function startNewProject() {
    setProject(null);
    setIdea('');
    setSelectedText('');
    setSelectionPosition(null);
    setSidebarOpen(false);
    setMobileChatOpen(false);
    setAiTargetPaths([]);
    setFlashPaths([]);
    setError('');
    setFileTree([]);
    setSelectedFilePath('');
    setWorkspaceEnterKey((value) => value + 1);
  }

  async function download() {
    if (!project) return;
    if (!isFileWorkspace && !project.document) return;
    const response = await fetch(`/api/grid-guides/${project.id}/download`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setError(data.error || (isFileWorkspace ? '导出成果包失败。' : '导出 Word 失败。'));
      return;
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = encoded
      ? decodeURIComponent(encoded)
      : isFileWorkspace
        ? '国网指南成果.zip'
        : '国家电网项目指南.docx';
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  function captureSelection() {
    const selection = window.getSelection();
    const value = selection?.toString().replace(/\s+/g, ' ').trim() || '';
    const root = paperRef.current || previewRef.current;
    if (!value || value.length < 2 || !root || !selection?.rangeCount) {
      setSelectionPosition(null);
      setPendingSelectedText('');
      return;
    }
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;
    const rect = range.getBoundingClientRect();
    setSelectionPosition({
      left: Math.min(window.innerWidth - 160, Math.max(12, rect.left + rect.width / 2 - 70)),
      top: Math.max(12, rect.top - 44)
    });
    setPendingSelectedText(value.slice(0, 20_000));
  }

  const inWorkspace = Boolean(project);

  const projectListPanel = (
    <>
      <div className="shrink-0 space-y-3 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索设计..."
              className="ui-input h-9 pl-9"
            />
          </div>
          {inWorkspace ? (
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="收起项目列表"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={startNewProject}
          disabled={busy}
          className="ui-btn-primary h-9 w-full gap-1.5 text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          新建设计
        </button>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2">
        {filteredProjects.length ? (
          <div className="space-y-0.5">
            {filteredProjects.map((item) => {
              const active = item.id === project?.id;
              return (
                <div
                  key={item.id}
                  className={`group relative ${active ? 'rag-conv-item rag-conv-item-active' : 'rag-conv-item'}`}
                >
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => void loadProject(item.id)}
                      className="w-full text-left"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5 text-foreground">
                          {item.title}
                        </span>
                        <span className="shrink-0 pt-0.5 text-[10px] leading-4 text-muted-foreground">
                          {formatTime(item.updatedAt)}
                        </span>
                      </div>
                    </button>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => void loadProject(item.id)}
                        className={`min-w-0 flex-1 truncate text-left text-xs leading-4 ${
                          item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
                        }`}
                      >
                        {statusLabel(item.status)}
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeProject(item.id)}
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground opacity-100 transition hover:text-destructive focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                        aria-label="删除设计"
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
            <BookOpen className="h-8 w-8 text-muted-foreground/40" strokeWidth={1.4} />
            <p className="mt-3 text-sm font-medium text-foreground">尚无指南设计</p>
            <p className="mt-1 text-xs text-muted-foreground">新建后会出现在这里</p>
          </div>
        )}
      </div>
    </>
  );

  return (
    <div className="rag-shell relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4">
      <div className="mb-3 shrink-0 md:mb-4">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          Dashboard / Grid Guide
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">国网指南设计</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          用于设计国网指南项目，并组织相关资料、方案和成果文件。
        </p>
      </div>

      <div className="rag-chat-card relative min-h-0 flex-1">
        {!inWorkspace ? (
          <aside className="rag-conv-list md:w-[280px]">{projectListPanel}</aside>
        ) : (
          <>
            {sidebarOpen ? (
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                className="grid-guide-sidebar-backdrop absolute inset-0 z-[80] cursor-default bg-slate-950/25"
                aria-label="收起项目列表"
              />
            ) : null}
            <aside
              className={`absolute left-0 top-0 z-[90] flex h-full w-[min(100%,280px)] shrink-0 flex-col border-r border-border bg-card shadow-2xl transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] md:w-[280px] ${
                sidebarOpen ? 'translate-x-0' : 'pointer-events-none -translate-x-full'
              }`}
              aria-hidden={!sidebarOpen}
            >
              {projectListPanel}
            </aside>
          </>
        )}

        {isFileWorkspace ? (
          <aside className="flex w-[min(42%,260px)] shrink-0 flex-col border-r border-border bg-card">
            <GridGuideFileTree
              tree={fileTree}
              selectedPath={selectedFilePath}
              onSelect={(node) => setSelectedFilePath(node.path)}
              emptyHint={
                project?.status === 'generating' ? '正在创建任务文件夹并写入成果…' : '尚无成果文件，可在右侧对话中重新生成。'
              }
            />
          </aside>
        ) : null}

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
            {inWorkspace ? (
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="展开项目列表"
                aria-expanded={sidebarOpen}
              >
                <PanelLeft className="h-4 w-4" />
              </button>
            ) : null}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">
                {project?.title || '新建设计'}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {project?.status === 'generating'
                  ? `${project.progress || 2}% · ${project.progressDetail || '正在准备生成任务'}`
                  : savingEdit
                    ? '正在保存画布编辑…'
                    : project
                      ? statusLabel(project.status)
                      : '输入构想开始设计，或从左侧选择已有项目'}
              </div>
            </div>
            {project ? (
              <button
                type="button"
                onClick={() => setMobileChatOpen(true)}
                className="ui-btn-secondary h-9 gap-1.5 text-xs lg:hidden"
              >
                <MessageSquareText className="h-3.5 w-3.5" />
                对话
              </button>
            ) : null}
            {project?.document || (isFileWorkspace && (fileTree.length > 0 || project?.status === 'ready')) ? (
              <button type="button" onClick={() => void download()} className="ui-btn-primary h-9 gap-1.5 text-xs">
                <Download className="h-3.5 w-3.5" />
                {isFileWorkspace ? '导出成果包' : '导出 Word'}
              </button>
            ) : null}
          </header>

          <div className="relative min-h-0 flex-1">
            {isFileWorkspace && project ? (
              <div ref={previewRef} className="absolute inset-0 flex min-h-0 flex-col bg-slate-100/70">
                {project.status === 'generating' ? (
                  <div className="shrink-0 border-b border-primary/15 bg-background/95 px-4 py-3">
                    <GenerationProgress project={project} compact />
                  </div>
                ) : null}
                <div className="min-h-0 flex-1">
                  <GridGuideFilePreview
                    projectId={project.id}
                    filePath={selectedFilePath}
                    disabled={project.status === 'generating'}
                    onError={setError}
                    onMouseUp={captureSelection}
                  />
                </div>
              </div>
            ) : (
            <div className="scrollbar-thin absolute inset-0 overflow-y-auto bg-slate-100/70 p-4 md:p-7">
            {!project ? (
              <div
                key={`compose-${workspaceEnterKey}`}
                className="grid-guide-view-enter mx-auto flex min-h-full max-w-xl flex-col items-center justify-center px-2"
              >
                <h2 className="text-center text-2xl font-semibold tracking-tight text-foreground md:text-[1.65rem]">
                  描述你的指南构想
                </h2>
                <div className="mt-8 w-full rounded-2xl border border-border/80 bg-card shadow-sm focus-within:border-primary/35 focus-within:ring-2 focus-within:ring-primary/5">
                  <textarea
                    value={idea}
                    onChange={(event) => setIdea(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void generateInitial();
                    }}
                    rows={4}
                    placeholder="研究对象、痛点或应用场景……"
                    className="w-full resize-none bg-transparent px-4 pb-2 pt-4 text-sm leading-7 text-foreground outline-none placeholder:text-muted-foreground/60"
                  />
                  {createAttachments.length ? (
                    <div className="flex flex-wrap gap-1.5 px-3 pb-2">
                      {createAttachments.map((item) => (
                        <span
                          key={item.clientId}
                          className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-2 py-1 text-[11px] text-foreground"
                        >
                          <span className="rounded bg-background px-1 py-0.5 text-[10px] text-muted-foreground">
                            {attachmentTypeLabel({ extension: item.extension, name: item.name })}
                          </span>
                          <span className="min-w-0 truncate">{item.name}</span>
                          <span className="shrink-0 text-muted-foreground">{formatAttachmentSize(item.size)}</span>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              setCreateAttachments((current) =>
                                current.filter((entry) => entry.clientId !== item.clientId)
                              )
                            }
                            className="rounded p-0.5 text-muted-foreground transition hover:bg-background hover:text-foreground disabled:opacity-40"
                            aria-label={`移除附件 ${item.name}`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-2 px-3 pb-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <input
                        ref={createFileInputRef}
                        type="file"
                        multiple
                        accept={GRID_GUIDE_ATTACHMENT_ACCEPT}
                        className="hidden"
                        onChange={(event) => {
                          addCreateAttachments(event.target.files);
                          event.target.value = '';
                        }}
                      />
                      <button
                        type="button"
                        disabled={busy || createAttachments.length >= GRID_GUIDE_ATTACHMENT_MAX_FILES}
                        onClick={() => createFileInputRef.current?.click()}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        title="上传参考附件（仅创建时可添加）"
                      >
                        <Paperclip className="h-3.5 w-3.5" />
                        附件
                        {createAttachments.length
                          ? ` ${createAttachments.length}/${GRID_GUIDE_ATTACHMENT_MAX_FILES}`
                          : ''}
                      </button>
                      <span className="hidden text-[11px] text-muted-foreground sm:inline">
                        {GRID_GUIDE_ATTACHMENT_HINT}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void generateInitial()}
                      disabled={!idea.trim() || busy}
                      className="ui-btn-primary h-9 gap-1.5 text-xs"
                    >
                      开始设计
                      {busy ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
                <p className="mt-5 flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="shrink-0">试试：</span>
                  {STARTERS.map((item, index) => (
                    <span key={item.label} className="inline-flex items-center gap-x-2">
                      {index > 0 ? <span className="text-border" aria-hidden>·</span> : null}
                      <button
                        type="button"
                        onClick={() => setIdea(item.value)}
                        className="text-left text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
                      >
                        {item.label}
                      </button>
                    </span>
                  ))}
                </p>
              </div>
            ) : project.document ? (
              <div key={`workspace-${project.id}-${workspaceEnterKey}`} className="grid-guide-view-enter mx-auto w-full max-w-[860px]">
                {project.status === 'generating' ? (
                  <div className="sticky top-2 z-20 mb-3 rounded-xl border border-primary/20 bg-background/95 px-4 py-3 shadow-sm backdrop-blur">
                    <GenerationProgress project={project} compact />
                  </div>
                ) : null}
                <div
                  ref={paperRef}
                  onMouseUp={captureSelection}
                  className="min-h-[1120px] w-full cursor-text bg-white px-8 py-6 shadow-[0_2px_20px_rgba(15,23,42,0.08)] selection:bg-sky-200/80 selection:text-slate-950 [&_*::selection]:bg-sky-200/80 [&_*::selection]:text-slate-950 md:px-14 md:py-8"
                >
                  <GuideDocument
                    document={project.document}
                    onCommit={editDocument}
                    onRegisterFlush={registerDocumentFlush}
                    disabled={project.status === 'generating' && !project.document}
                    lockedPaths={project.status === 'generating' ? aiTargetPaths : []}
                    glowPaths={
                      project.status === 'generating'
                        ? aiTargetPaths
                        : selectedText
                          ? locateSelectionTargets(project.document, selectedText).map((item) => pathKey(item.path))
                          : []
                    }
                    flashPaths={flashPaths}
                    preferredPart={preferredPart}
                  />
                </div>
              </div>
            ) : (
              <div key={`pending-${project.id}-${workspaceEnterKey}`} className="grid-guide-view-enter flex min-h-full items-center justify-center">
                <div className="max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
                  {busy || project.status === 'generating' ? (
                    <>
                      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
                        <LoaderCircle className="h-5 w-5 animate-spin text-primary" />
                      </div>
                      <h2 className="mt-4 text-base font-semibold text-foreground">正在构建项目指南</h2>
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        能元正在检索库内已有技术与网络最新方向，完成创新对标后设计课题链条并校准量化指标。
                      </p>
                      <GenerationProgress project={project} />
                    </>
                  ) : (
                    <>
                      <BookOpen className="mx-auto h-9 w-9 text-muted-foreground/40" />
                      <h2 className="mt-3 text-base font-semibold text-foreground">指南尚未生成</h2>
                      <p className="mt-2 text-sm text-muted-foreground">可在右侧对话中要求重新生成。</p>
                    </>
                  )}
                </div>
              </div>
            )}
            </div>
            )}
            {isLegacyCanvas ? (
              <div className="pointer-events-none absolute bottom-3 left-3 z-20 text-[10px] text-muted-foreground md:bottom-4 md:left-4">
                你的修改将会自动保存
              </div>
            ) : null}
          </div>
        </main>

        {project ? (
          <aside className="hidden w-[520px] shrink-0 border-l border-border lg:block">
            <ChatPanel
              project={project}
              selectedText={selectedText}
              busy={busy || project.status === 'generating'}
              focusToken={composerFocusToken}
              onClearSelection={() => {
                setSelectedText('');
                setSelectionPosition(null);
              }}
              onSend={sendRevision}
            />
          </aside>
        ) : null}
      </div>

      {selectionPosition ? (
        <button
          type="button"
          onClick={() => {
            const cited = pendingSelectedText;
            setSelectedText(cited);
            setPendingSelectedText('');
            setSelectionPosition(null);
            setComposerFocusToken((value) => value + 1);
            if (project?.document && cited) {
              const targets = locateSelectionTargets(project.document, cited);
              if (targets.some((item) => item.path[0] === 'explanation')) setPreferredPart('explanation');
              else if (targets.length) setPreferredPart('guide');
            }
            window.getSelection()?.removeAllRanges();
            if (window.innerWidth < 1024) setMobileChatOpen(true);
          }}
          className="fixed z-50 flex items-center gap-1.5 rounded-lg border border-orange-300 bg-orange-100 px-3 py-2 text-xs font-medium text-orange-950 shadow-xl transition hover:bg-orange-200"
          style={{ left: selectionPosition.left, top: selectionPosition.top }}
        >
          <Quote className="h-3.5 w-3.5" />
          引用到对话
        </button>
      ) : null}

      {project && mobileChatOpen ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/25 backdrop-blur-[1px] lg:hidden">
          <button
            type="button"
            onClick={() => setMobileChatOpen(false)}
            className="absolute inset-0 cursor-default"
            aria-label="关闭设计对话"
          />
          <div className="relative h-full w-full max-w-[520px] border-l border-border bg-card shadow-2xl">
            <button
              type="button"
              onClick={() => setMobileChatOpen(false)}
              className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="关闭设计对话"
            >
              <X className="h-4 w-4" />
            </button>
            <ChatPanel
              project={project}
              selectedText={selectedText}
              busy={busy || project.status === 'generating'}
              focusToken={composerFocusToken}
              onClearSelection={() => {
                setSelectedText('');
                setSelectionPosition(null);
              }}
              onSend={sendRevision}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
