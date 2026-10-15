'use client';

import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Download,
  FileBadge2,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  MessageSquare,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  Trash2,
  UploadCloud
} from 'lucide-react';
import {
  type DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type {
  PatentBlocker,
  PatentGenerationRun,
  PatentProject
} from '@/lib/patent-generation/types';
import { PatentClarificationPanel } from '@/components/patent-clarification-panel';
import { PatentStageTimeline } from '@/components/patent-stage-timeline';
import { ChatComposerToolMenu, ComposerToolChip } from '@/components/chat-composer-tool-menu';
import { useNotifyError } from '@/components/app-notify';
import { usePageContentReady } from '@/components/page-nav-loading';
import { ATTACHMENT_MAX_BYTES } from '@/lib/attachments/policy';
import { PATENT_WELCOME_PROMPTS } from '@/lib/chat-composer-tools';
import { readDashboardListCache } from '@/lib/dashboard-list-cache';
import type { ComposerToolId } from '@/lib/chat-composer-tools';

type ProjectSummary = Pick<
  PatentProject,
  'id' | 'title' | 'status' | 'currentStage' | 'qualityScore' | 'error' | 'createdAt' | 'updatedAt'
>;

const WELCOME_PROMPTS = PATENT_WELCOME_PROMPTS;

const ACCEPT = '.docx,.pdf,.md,.markdown,.txt,.rtf,.tex,.html,.htm,.zip';
const PATENT_SOURCE_EXTENSIONS = new Set([
  '.docx',
  '.pdf',
  '.md',
  '.markdown',
  '.txt',
  '.rtf',
  '.tex',
  '.html',
  '.htm',
  '.zip'
]);

function pickWelcomePrompt() {
  return WELCOME_PROMPTS[Math.floor(Math.random() * WELCOME_PROMPTS.length)];
}

function statusLabel(status: PatentProject['status']) {
  if (status === 'ready' || status === 'completed') return '已完成';
  if (status === 'review_required') return '待人工复核';
  if (status === 'queued') return '排队中';
  if (status === 'processing') return '生成中';
  if (status === 'needs_input') return '等待回复';
  if (status === 'failed') return '生成失败';
  if (status === 'cancelled') return '已取消';
  if (status === 'interrupted') return '生成中断';
  return '准备中';
}

function statusTone(status: PatentProject['status']) {
  if (status === 'ready' || status === 'completed') return 'text-success';
  if (status === 'review_required') return 'text-warning';
  if (status === 'processing') return 'text-foreground';
  if (status === 'needs_input') return 'text-warning';
  if (status === 'failed') return 'text-destructive';
  return 'text-muted-foreground';
}

function formatTime(value: string) {
  if (!value) return '';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function blockerAnswer(project: PatentProject, blocker: PatentBlocker) {
  if (blocker.id === 'confirm-applicant') return project.applicant;
  if (blocker.id === 'confirm-inventors') return project.inventors.join('、');
  return blocker.answer || project.answers[blocker.id] || '';
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
    <p className="max-w-[14em] text-xl font-medium tracking-tight text-muted-foreground">
      {head ? <span>{head}</span> : null}
      <span className="whitespace-nowrap">
        {tail}
        {!done ? (
          <span className="rag-welcome-caret" aria-hidden />
        ) : (
          <span
            className="rag-oc-status-dot ml-2.5 align-middle"
            title="服务已就绪"
            aria-label="服务已就绪"
          />
        )}
      </span>
    </p>
  );
}

function TypingIndicator() {
  return (
    <span className="inline-flex items-center gap-1.5 py-0.5" role="status" aria-label="正在生成">
      <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.2s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.1s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/50" />
    </span>
  );
}

function ArtifactCard({
  icon,
  title,
  summary,
  children,
  defaultOpen = false
}: {
  icon: React.ReactNode;
  title: string;
  summary: string;
  children?: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = defaultOpen;
  }, [defaultOpen]);
  return (
    <details ref={detailsRef} className="group mt-2 overflow-hidden rounded-lg border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-foreground">{title}</div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{summary}</div>
        </div>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition group-open:rotate-180" />
      </summary>
      {children ? <div className="border-t border-border bg-background/40 p-3">{children}</div> : null}
    </details>
  );
}

function ApplicantDetailsCard({
  project,
  saving,
  onSave
}: {
  project: PatentProject;
  saving: boolean;
  onSave: (input: {
    applicant: string;
    inventors: string[];
    contact: Record<string, string>;
  }) => Promise<PatentProject | null>;
}) {
  const [applicant, setApplicant] = useState(project.applicant);
  const [inventors, setInventors] = useState(project.inventors.join('、'));
  const [contact, setContact] = useState(project.contact);
  useEffect(() => {
    setApplicant(project.applicant);
    setInventors(project.inventors.join('、'));
    setContact(project.contact);
  }, [project.id, project.applicant, project.inventors, project.contact]);

  const fields = [
    ['address', '地址'],
    ['postalCode', '邮政编码'],
    ['unifiedSocialCreditCode', '统一社会信用代码'],
    ['contactName', '联系人'],
    ['phone', '联系电话'],
    ['email', '电子邮箱']
  ] as const;

  return (
    <ArtifactCard
      icon={<FileBadge2 className="h-3.5 w-3.5" />}
      title="申请主体信息"
      summary="下载前请核对申请人、发明人与联系信息"
    >
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave({
            applicant,
            inventors: inventors.split(/[、，,;\n]/).map((item) => item.trim()).filter(Boolean),
            contact
          });
        }}
      >
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>申请人</span>
          <input className="ui-input" value={applicant} maxLength={300} onChange={(event) => setApplicant(event.target.value)} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>发明人（顿号或逗号分隔）</span>
          <input className="ui-input" value={inventors} maxLength={1_000} onChange={(event) => setInventors(event.target.value)} />
        </label>
        {fields.map(([key, label]) => (
          <label key={key} className="space-y-1 text-xs text-muted-foreground">
            <span>{label}</span>
            <input
              className="ui-input"
              type={key === 'email' ? 'email' : 'text'}
              value={contact[key] || ''}
              maxLength={500}
              onChange={(event) => setContact((current) => ({ ...current, [key]: event.target.value }))}
            />
          </label>
        ))}
        <button type="submit" disabled={saving} className="ui-btn-primary sm:col-span-2">
          {saving ? '保存中…' : '保存申请主体信息'}
        </button>
      </form>
    </ArtifactCard>
  );
}

export function PatentWorkbench({
  embedded = false,
  composerTool = 'patent',
  onSelectComposerTool
}: {
  embedded?: boolean;
  composerTool?: ComposerToolId | null;
  onSelectComposerTool?: (tool: ComposerToolId | null) => void;
} = {}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<PatentProject | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [convSearch, setConvSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressDetail, setProgressDetail] = useState('');
  const [error, setError] = useNotifyError();
  const [reply, setReply] = useState('');
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [welcomeLine, setWelcomeLine] = useState(WELCOME_PROMPTS[0]);
  const [ready, setReady] = useState(false);
  const [watchVersion, setWatchVersion] = useState(0);
  usePageContentReady(ready);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replyInputRef = useRef<HTMLTextAreaElement>(null);
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);
  const loadSequenceRef = useRef(0);

  const refreshProjects = useCallback(async (force = false) => {
    const projects = await readDashboardListCache('/api/patents', async () => {
      const response = await fetch('/api/patents');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '读取专利项目失败。');
      return data.projects || [];
    }, { force });
    setProjects(projects);
  }, []);

  const loadProject = useCallback(async (id: string) => {
    const sequence = ++loadSequenceRef.current;
    setError('');
    setReply('');
    const response = await fetch(`/api/patents/${encodeURIComponent(id)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取专利项目失败。');
    if (sequence !== loadSequenceRef.current) return;
    setProject(data.project);
  }, []);

  useEffect(() => {
    setWelcomeLine(pickWelcomePrompt());
    void refreshProjects()
      .then(() => setReady(true))
      .catch((reason) => {
        setReady(true);
        setError(reason instanceof Error ? reason.message : '读取项目失败。');
      });
  }, [refreshProjects]);

  useEffect(() => {
    const projectId = project?.id;
    if (!projectId) return;
    let disposed = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const response = await fetch(`/api/patents/${encodeURIComponent(projectId)}/generate`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '读取生成任务失败。');
        if (disposed) return;
        if (data.project) setProject(data.project as PatentProject);
        const run = data.run as PatentGenerationRun | null;
        if (!run) return;
        setProgress(run.progress);
        setProgressDetail(run.detail || '');
        const active = run.status === 'queued' || run.status === 'running';
        setGenerating(active);
        if (run.error) setError(run.error);
        if (active) {
          timer = window.setTimeout(poll, 1_500);
        } else {
          await refreshProjects(true);
        }
      } catch (reason) {
        if (!disposed) {
          setGenerating(false);
          setError(reason instanceof Error ? reason.message : '读取生成任务失败。');
        }
      }
    };

    void poll();
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [project?.id, refreshProjects, watchVersion]);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: generating ? 'smooth' : 'auto' });
  }, [project?.updatedAt, project?.blockers, progressDetail, generating]);

  const filteredProjects = useMemo(() => {
    const query = convSearch.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((item) => item.title.toLowerCase().includes(query));
  }, [convSearch, projects]);

  const activeQuestion = useMemo(
    () => project?.blockers.find((blocker) => !blocker.resolved) || null,
    [project?.blockers]
  );

  useEffect(() => {
    if (!activeQuestion || saving || generating) return;
    // 仅预填 OpenCode 在 blockers 里给出的候选答复（若有）。
    setReply(activeQuestion.answer?.trim() || '');
    const frame = window.requestAnimationFrame(() => {
      const input = replyInputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeQuestion?.id, generating, saving]);

  async function uploadFile(file: File) {
    const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
    if (!PATENT_SOURCE_EXTENSIONS.has(extension)) {
      setError('仅支持 DOCX、PDF、Markdown/TXT/RTF/HTML/TeX 技术文档，或包含这些文件的 ZIP 包。');
      return;
    }
    if (file.size > ATTACHMENT_MAX_BYTES) {
      setError('技术文档不能超过 200 MB。');
      return;
    }
    setUploading(true);
    setError('');
    setProgressDetail('正在读取文档内容…');
    let createdProject: PatentProject | null = null;
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/patents', { method: 'POST', body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '上传技术文档失败。');
      createdProject = data.project as PatentProject;
      loadSequenceRef.current += 1;
      setProject(createdProject);
      setReply('');
      setHistoryOpen(false);
      await refreshProjects(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '上传技术文档失败。');
    } finally {
      setUploading(false);
      setProgressDetail('');
    }
    if (createdProject && !createdProject.blockers.some((blocker) => !blocker.resolved)) {
      await generatePatent(createdProject);
    }
  }

  async function updateProject(input: {
    applicant?: string;
    inventors?: string[];
    contact?: Record<string, string>;
    answers?: Record<string, string>;
  }) {
    if (!project) return null;
    setSaving(true);
    setError('');
    try {
      const response = await fetch(`/api/patents/${encodeURIComponent(project.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存回复失败。');
      setProject(data.project);
      await refreshProjects(true);
      return data.project as PatentProject;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存回复失败。');
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function sendReply() {
    if (!project || !activeQuestion || !reply.trim() || saving || generating) return;
    const value = reply.trim();
    let updated: PatentProject | null = null;
    if (activeQuestion.id === 'confirm-applicant') {
      updated = await updateProject({ applicant: value });
    } else if (activeQuestion.id === 'confirm-inventors') {
      updated = await updateProject({
        inventors: value.split(/[、，,;\n]/).map((item) => item.trim()).filter(Boolean)
      });
    } else {
      updated = await updateProject({
        answers: { ...project.answers, [activeQuestion.id]: value }
      });
    }
    if (updated) {
      setReply('');
      if (!updated.blockers.some((blocker) => !blocker.resolved)) {
        await generatePatent(updated);
      }
    }
  }

  async function generatePatent(targetProject: PatentProject | null = project) {
    if (!targetProject || generating) return;
    setGenerating(true);
    setProject(targetProject);
    setError('');
    setProgress(1);
    setProgressDetail(targetProject.disclosure ? '正在继续分析并完善申请文件…' : '正在分析技术文档…');
    try {
      const response = await fetch(`/api/patents/${encodeURIComponent(targetProject.id)}/generate`, {
        method: 'POST'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '启动专利生成失败。');
      if (data.project) setProject(data.project as PatentProject);
      setProgress(data.run?.progress || 0);
      setProgressDetail(data.run?.detail || '任务已启动');
      setWatchVersion((value) => value + 1);
    } catch (reason) {
      setGenerating(false);
      setError(reason instanceof Error ? reason.message : '专利生成失败。');
    }
  }

  async function cancelGeneration() {
    if (!project || !generating) return;
    setError('');
    const response = await fetch(`/api/patents/${encodeURIComponent(project.id)}/generate`, {
      method: 'DELETE'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(data.error || '取消生成失败。');
      return;
    }
    setProgressDetail('正在取消…');
    setWatchVersion((value) => value + 1);
  }

  async function submitClarifications(values: Record<string, string>) {
    if (!project) return;
    const answers: Record<string, string> = {};
    let applicant: string | undefined;
    let inventors: string[] | undefined;
    for (const [id, value] of Object.entries(values)) {
      if (id === 'confirm-applicant') applicant = value.trim();
      else if (id === 'confirm-inventors') {
        inventors = value.split(/[、，,;\n]/).map((item) => item.trim()).filter(Boolean);
      } else {
        answers[id] = value.trim();
      }
    }
    const updated = await updateProject({
      applicant,
      inventors,
      answers: { ...project.answers, ...answers }
    });
    if (updated && !updated.blockers.some((item) => !item.resolved)) {
      await generatePatent(updated);
    }
  }

  async function removeProject(id: string) {
    setError('');
    try {
      const response = await fetch(`/api/patents/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || '删除项目失败。');
        return;
      }
      if (project?.id === id) setProject(null);
      await refreshProjects(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除项目失败。');
    }
  }

  function startNewPatent() {
    loadSequenceRef.current += 1;
    setProject(null);
    setReply('');
    setError('');
    setHistoryOpen(false);
    window.requestAnimationFrame(() => fileInputRef.current?.click());
  }

  async function downloadBundle() {
    if (!project) return;
    setError('');
    try {
      const response = await fetch(`/api/patents/${encodeURIComponent(project.id)}/download`);
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || '下载专利包失败。');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') || '';
      const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const fileName = encodedName ? decodeURIComponent(encodedName) : `${project.title}.zip`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '下载专利包失败。');
    }
  }

  function handleDropzoneDragEnter(event: ReactDragEvent) {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setDraggingFiles(true);
  }

  function handleDropzoneDragOver(event: ReactDragEvent) {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  }

  function handleDropzoneDragLeave(event: ReactDragEvent) {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDraggingFiles(false);
  }

  function handleDropzoneDrop(event: ReactDragEvent) {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setDraggingFiles(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void uploadFile(file);
  }

  const showComposerTools = Boolean(onSelectComposerTool);
  const source = project?.source?.parsed;
  const resolvedQuestions = project?.blockers.filter((blocker) =>
    blocker.resolved && Boolean(blockerAnswer(project, blocker))
  ) || [];
  return (
    <div
      className={embedded
        ? 'relative flex h-full min-h-0 flex-1 flex-col overflow-hidden'
        : 'rag-shell relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4'}
      onDragEnter={handleDropzoneDragEnter}
      onDragOver={handleDropzoneDragOver}
      onDragLeave={handleDropzoneDragLeave}
      onDrop={handleDropzoneDrop}
    >
      {draggingFiles ? (
        <div className="pointer-events-none absolute inset-0 z-[250] flex items-center justify-center rounded-xl border-2 border-dashed border-primary/40 bg-muted/90 text-foreground shadow-soft backdrop-blur-sm" role="status" aria-live="polite">
          <div className="flex flex-col items-center gap-2">
            <UploadCloud className="h-7 w-7" />
            <span className="text-sm font-semibold">释放以上传技术交底</span>
            <span className="text-xs text-muted-foreground">PDF/DOCX/MD/TXT/RTF/HTML · 支持 ZIP · 最大 200 MB</span>
          </div>
        </div>
      ) : null}
      {embedded ? null : (
        <div className="mb-3 shrink-0 md:mb-4">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
            Dashboard / Patent
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">专利生成</h1>
          <p className="mt-1 text-sm text-muted-foreground">用于根据技术资料编制和管理专利申请文件草稿。</p>
        </div>
      )}

      <div className="rag-chat-card min-h-0 flex-1">
        <aside className={`rag-conv-list ${historyOpen ? 'flex' : 'hidden lg:flex'}`}>
          <div className="shrink-0 space-y-3 border-b border-border p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={convSearch}
                onChange={(event) => setConvSearch(event.target.value)}
                placeholder="搜索专利项目..."
                className="ui-input h-9 pl-9"
              />
            </div>
            <button
              type="button"
              onClick={startNewPatent}
              disabled={uploading || generating}
              className="ui-btn-primary h-9 w-full gap-1.5 text-xs"
            >
              {uploading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              {uploading ? '正在解析…' : '新专利'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              tabIndex={-1}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadFile(file);
                event.target.value = '';
              }}
            />
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
                          onClick={() => {
                            void loadProject(item.id).catch((reason) =>
                              setError(reason instanceof Error ? reason.message : '读取项目失败。')
                            );
                            setHistoryOpen(false);
                          }}
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
                            onClick={() => {
                              void loadProject(item.id).catch((reason) =>
                                setError(reason instanceof Error ? reason.message : '读取项目失败。')
                              );
                              setHistoryOpen(false);
                            }}
                            className={`min-w-0 flex-1 truncate text-left text-xs leading-4 ${statusTone(item.status)}`}
                          >
                            {statusLabel(item.status)}
                            {item.currentStage === 'audit' || ['ready', 'completed', 'review_required'].includes(item.status)
                              ? ` · ${item.qualityScore}分`
                              : ''}
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeProject(item.id)}
                            disabled={uploading || generating}
                            className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground opacity-100 transition hover:text-destructive focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                            aria-label="删除项目"
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
                <FileBadge2 className="h-8 w-8 text-muted-foreground/40" strokeWidth={1.4} />
                <p className="mt-3 text-sm font-medium text-foreground">暂无专利项目</p>
                <p className="mt-1 text-xs text-muted-foreground">上传交底后会出现在这里</p>
              </div>
            )}
          </div>
        </aside>

        <main className={`min-h-0 min-w-0 flex-1 flex-col ${historyOpen ? 'hidden lg:flex' : 'flex'}`}>
          <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent lg:hidden"
              aria-label="打开项目列表"
            >
              <MessageSquare className="h-4 w-4" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">
                {project?.title || '新专利对话'}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {generating && progressDetail
                  ? progressDetail
                  : uploading
                    ? '正在解析交底…'
                    : project
                      ? `${statusLabel(project.status)}${project.source?.name ? ` · ${project.source.name}` : ''}`
                      : '上传技术交底开始撰写'}
              </div>
            </div>
            <div className="flex items-center gap-1">
              {generating ? (
                <button
                  type="button"
                  onClick={() => void cancelGeneration()}
                  className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                >
                  <Square className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">取消</span>
                </button>
              ) : project && ['failed', 'cancelled', 'interrupted', 'review_required'].includes(project.status) ? (
                <button
                  type="button"
                  onClick={() => void generatePatent(project)}
                  className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">
                    {project.status === 'review_required' ? '继续修复' : '重试'}
                  </span>
                </button>
              ) : null}
              {project?.draft && ['completed', 'review_required', 'ready'].includes(project.status) ? (
                <button
                  type="button"
                  onClick={downloadBundle}
                  disabled={generating}
                  className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">下载申请包</span>
                </button>
              ) : null}
              <button
                type="button"
                onClick={startNewPatent}
                disabled={uploading || generating}
                className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">新专利</span>
              </button>
            </div>
          </header>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {!project ? (
              <div className="flex h-full min-h-72 flex-col items-center justify-center px-4 text-center">
                <WelcomeTypewriter text={welcomeLine} ready={ready && !uploading} />
              </div>
            ) : (
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
                <div className="flex w-full justify-end">
                  <div className="max-w-[75%]">
                    <div className="rag-user-bubble">
                      <div className="flex items-start gap-2">
                        <FileText className="mt-0.5 h-4 w-4 shrink-0 opacity-80" />
                        <div>
                          <p>请根据「{project.source?.name}」生成完整发明专利申请文件。</p>
                          <p className="mt-1 text-[11px] text-primary-foreground/70">
                            {(source?.charCount || 0).toLocaleString()} 字 · 附图 {source?.metadata.imageCount || 0} · 公式 {source?.formulaObjectsDetected || 0}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex w-full justify-start">
                  <div className="w-full max-w-[90%]">
                    <div className="rag-assistant-bubble">
                      <p>文档已读取。我会先确认申请主体，再分析交底；资料不完整时会逐项提问。</p>
                      {source?.warnings.length ? (
                        <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-amber-700 dark:text-amber-300">
                          {source.warnings.slice(0, 5).map((warning) => (
                            <li key={warning}>{warning}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </div>
                </div>

                {resolvedQuestions.map((blocker) => (
                  <div key={blocker.id} className="contents">
                    <div className="flex w-full justify-start">
                      <div className="w-full max-w-[90%]">
                        <div className="rag-assistant-bubble">
                          <p className="font-medium">{blocker.question}</p>
                          {blocker.reason ? (
                            <p className="mt-1.5 text-xs text-muted-foreground">{blocker.reason}</p>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    <div className="flex w-full justify-end">
                      <div className="max-w-[75%]">
                        <div className="rag-user-bubble whitespace-pre-wrap">
                          {blockerAnswer(project, blocker)}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                {project.disclosure ? (
                  <div className="flex w-full justify-start">
                    <div className="w-full max-w-[90%]">
                      <div className="rag-assistant-bubble">
                        <p>第一轮技术交底分析已完成。</p>
                        <ArtifactCard
                          icon={<FileText className="h-3.5 w-3.5" />}
                          title="发明交底分析"
                          summary={project.disclosure.inventiveConcept || project.disclosure.proposedTitle}
                        >
                          <div className="space-y-2 text-xs leading-6 text-muted-foreground">
                            <div><span className="font-semibold text-foreground">建议名称：</span>{project.disclosure.proposedTitle}</div>
                            <div><span className="font-semibold text-foreground">技术领域：</span>{project.disclosure.technicalField}</div>
                            <div><span className="font-semibold text-foreground">核心构思：</span>{project.disclosure.inventiveConcept}</div>
                            <div className="flex flex-wrap gap-1.5">
                              {project.disclosure.essentialFeatures.map((feature) => (
                                <span key={feature.id} className="rounded-md bg-muted px-2 py-1 text-foreground">
                                  {feature.name}
                                </span>
                              ))}
                            </div>
                          </div>
                        </ArtifactCard>
                      </div>
                    </div>
                  </div>
                ) : null}

                {project.priorArt ? (
                  <div className="flex w-full justify-start">
                    <div className="w-full max-w-[90%]">
                      <div className="rag-assistant-bubble">
                        <p>现有技术检索与区别特征分析已完成。</p>
                        <ArtifactCard
                          icon={<Search className="h-3.5 w-3.5" />}
                          title="现有技术检索"
                          summary={`检出 ${project.priorArt.candidates.length} 个候选`}
                        >
                          <div className="space-y-3">
                            {project.priorArt.candidates.slice(0, 6).map((candidate, index) => (
                              <div key={`${candidate.id}-${index}`} className="border-b border-border pb-3 last:border-0 last:pb-0">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="text-xs font-medium text-foreground">{candidate.title}</div>
                                  <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                                    {candidate.risk === 'high' ? '高风险' : candidate.risk === 'medium' ? '中风险' : '低风险'}
                                  </span>
                                </div>
                                <div className="mt-1 text-[10px] text-muted-foreground">
                                  {candidate.publicationNumber || '公开号未提取'}
                                </div>
                                <p className="mt-2 text-xs leading-5 text-muted-foreground">{candidate.riskReason || candidate.snippet}</p>
                                {candidate.commonFeatures.length ? (
                                  <p className="mt-1 text-[11px] text-muted-foreground">
                                    <b className="text-foreground">相同点：</b>{candidate.commonFeatures.join('；')}
                                  </p>
                                ) : null}
                                {candidate.distinguishingFeatures.length ? (
                                  <p className="mt-1 text-[11px] text-muted-foreground">
                                    <b className="text-foreground">区别点：</b>{candidate.distinguishingFeatures.join('；')}
                                  </p>
                                ) : null}
                                {candidate.url ? (
                                  <a className="mt-2 inline-block text-[11px] text-primary underline-offset-2 hover:underline" href={candidate.url} target="_blank" rel="noreferrer">
                                    查看公开文本
                                  </a>
                                ) : null}
                              </div>
                            ))}
                            {project.priorArt.searchLimitations.length ? (
                              <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
                                <b className="text-foreground">检索局限：</b>
                                {project.priorArt.searchLimitations.join('；')}
                              </div>
                            ) : null}
                          </div>
                        </ArtifactCard>
                      </div>
                    </div>
                  </div>
                ) : null}

                {project.strategy ? (
                  <div className="flex w-full justify-start">
                    <div className="w-full max-w-[90%]">
                      <div className="rag-assistant-bubble">
                        <p>保护范围与权利要求布局已经确定。</p>
                        <ArtifactCard
                          icon={<Sparkles className="h-3.5 w-3.5" />}
                          title="专利保护策略"
                          summary={project.strategy.coreContribution}
                        >
                          <div className="space-y-2 text-xs leading-6 text-muted-foreground">
                            <div><span className="font-semibold text-foreground">核心贡献：</span>{project.strategy.coreContribution}</div>
                            <div><span className="font-semibold text-foreground">技术问题：</span>{project.strategy.objectiveTechnicalProblem}</div>
                            <div>
                              <span className="font-semibold text-foreground">区别特征：</span>
                              {project.strategy.distinguishingFeatures.join('，')}
                            </div>
                          </div>
                        </ArtifactCard>
                      </div>
                    </div>
                  </div>
                ) : null}

                {project.drawings?.assets?.length ? (
                  <div className="flex w-full justify-start">
                    <div className="w-full max-w-[90%]">
                      <div className="rag-assistant-bubble">
                        <p>说明书附图已经准备完成。</p>
                        <ArtifactCard
                          icon={<ImageIcon className="h-3.5 w-3.5" />}
                          title="说明书附图"
                          summary={`共 ${project.drawings.assets.length} 幅`}
                        >
                          <div className="grid gap-2 sm:grid-cols-2">
                            {project.drawings.assets.map((asset) => (
                              <div key={asset.id} className="rounded-lg border border-border p-3">
                                <div className="text-xs font-medium text-foreground">{asset.caption}</div>
                                <div className="mt-1 text-[10px] text-muted-foreground">
                                  {asset.source === 'extracted' ? '源文档提取' : '自动生成线稿'}
                                </div>
                              </div>
                            ))}
                          </div>
                        </ArtifactCard>
                      </div>
                    </div>
                  </div>
                ) : null}

                {project.draft ? (
                  <div className="flex w-full justify-start">
                    <div className="w-full max-w-[90%]">
                      <div className="rag-assistant-bubble">
                        <p>权利要求书、说明书和摘要已经生成。</p>
                        <ArtifactCard
                          icon={<FileText className="h-3.5 w-3.5" />}
                          title="完整专利申请文件"
                          summary={project.draft.title}
                          defaultOpen
                        >
                          <div className="space-y-3">
                            <details className="rounded-lg border border-border">
                              <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold text-foreground">权利要求书</summary>
                              <div className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-border p-3 text-xs leading-6 text-muted-foreground">
                                {project.draft.claims}
                              </div>
                            </details>
                            <details className="rounded-lg border border-border">
                              <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold text-foreground">说明书摘要</summary>
                              <div className="whitespace-pre-wrap border-t border-border p-3 text-xs leading-6 text-muted-foreground">
                                {project.draft.abstract}
                              </div>
                            </details>
                            <details className="rounded-lg border border-border">
                              <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold text-foreground">说明书正文</summary>
                              <div className="max-h-96 space-y-4 overflow-auto border-t border-border p-3 text-xs leading-6 text-muted-foreground">
                                <section><b className="text-foreground">技术领域</b><p className="whitespace-pre-wrap">{project.draft.technicalField}</p></section>
                                <section><b className="text-foreground">背景技术</b><p className="whitespace-pre-wrap">{project.draft.backgroundArt}</p></section>
                                <section><b className="text-foreground">发明内容</b><p className="whitespace-pre-wrap">{project.draft.inventionSummary}</p></section>
                                <section><b className="text-foreground">附图说明</b><p className="whitespace-pre-wrap">{project.draft.drawingDescription}</p></section>
                                <section><b className="text-foreground">具体实施方式</b><p className="whitespace-pre-wrap">{project.draft.embodiments}</p></section>
                              </div>
                            </details>
                          </div>
                        </ArtifactCard>
                      </div>
                    </div>
                  </div>
                ) : null}

                {project.draft && !generating ? (
                  <div className="flex w-full justify-start">
                    <div className="w-full max-w-[90%]">
                      <div className="rag-assistant-bubble">
                        <p>申请文件已具备，请在下载前核对申请主体信息。</p>
                        <ApplicantDetailsCard
                          project={project}
                          saving={saving}
                          onSave={updateProject}
                        />
                      </div>
                    </div>
                  </div>
                ) : null}

                {project.audit ? (
                  <div className="flex w-full justify-start">
                    <div className="w-full max-w-[90%]">
                      <div className="rag-assistant-bubble">
                        <p>
                          已完成申请文件检查，当前得分 {project.audit.score}/100。
                          {project.audit.passed ? ' 自动检查已通过，仍建议提交前专业复核。' : ' 仍有问题需要人工复核或继续修复。'}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : null}

                {project.status === 'review_required' && !generating ? (
                  <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                      <div>
                        <p className="font-semibold text-foreground">草稿已生成，但尚未通过质量门禁</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          可点击顶部“继续修复”，或下载带“待复核”标识的草稿交由专利代理师检查。
                        </p>
                        {project.audit ? (
                          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                            {[...project.audit.deterministicIssues, ...project.audit.modelIssues]
                              .filter((item) => item.severity === 'error')
                              .slice(0, 5)
                              .map((item) => <li key={item.id}>• {item.message}</li>)}
                          </ul>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : null}

                {activeQuestion && !generating ? (
                  <PatentClarificationPanel
                    project={project}
                    disabled={generating}
                    saving={saving}
                    onSubmit={submitClarifications}
                  />
                ) : null}

                {generating ? (
                  <div className="flex w-full justify-start">
                    <div className="w-full max-w-[90%]">
                      <div className="rag-assistant-bubble">
                        <div className="rag-oc-live" aria-busy="true">
                          <div className="rag-oc-live-label rag-think-label-shimmer">运行中…</div>
                          <div className="rag-oc-stream">
                            <div className="rag-oc-prose rag-oc-prose-active">
                              <div className="rag-oc-prose-body" aria-busy="true" aria-live="polite">
                                {progressDetail || '正在通过能元撰写…'}
                              </div>
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 flex items-center gap-3">
                          <div
                            className="h-1.5 flex-1 overflow-hidden rounded-full bg-border"
                            role="progressbar"
                            aria-label="专利生成进度"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={progress}
                          >
                            <div
                              className="h-full rounded-full bg-primary transition-all"
                              style={{ width: `${Math.max(3, progress)}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-muted-foreground">{progress}%</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {error || project.error ? (
                  <div className="flex w-full justify-start">
                    <div className="w-full max-w-[90%]">
                      <div className="rag-assistant-bubble" role="alert">
                        <div className="flex items-start gap-2 text-destructive">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>{error || project.error}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {(project.status === 'ready' || project.status === 'completed') && !generating ? (
                  <div className="flex w-full justify-start">
                    <div className="w-full max-w-[90%]">
                      <div className="rag-assistant-bubble">
                        <div className="flex items-start gap-2">
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                          <div>
                            <p>完整申请文件已经生成。</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              点击右上角「下载申请包」获取 DOCX、说明书附图和分析资料。
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                <div ref={conversationEndRef} />
              </div>
            )}
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (activeQuestion) void sendReply();
            }}
            className="shrink-0 border-t border-border px-4 py-3"
          >
            {showComposerTools ? (
              <div className="relative min-h-12 min-w-0 rounded-2xl border border-input bg-background shadow-sm">
                {!project ? (
                  <div className="flex items-end gap-1 px-1.5 pb-1.5 pt-1.5">
                    <ChatComposerToolMenu
                      selectedTool={composerTool}
                      onSelect={(tool) => onSelectComposerTool?.(tool)}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      onDragEnter={handleDropzoneDragEnter}
                      onDragOver={handleDropzoneDragOver}
                      onDragLeave={handleDropzoneDragLeave}
                      onDrop={handleDropzoneDrop}
                      disabled={uploading}
                      className={`flex min-h-8 min-w-0 flex-1 flex-col items-start justify-center rounded-xl px-2 py-1 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-60 ${
                        draggingFiles ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                      }`}
                      aria-label="点击或拖入技术交底"
                    >
                      {uploading ? (
                        <span className="inline-flex items-center gap-2">
                          <LoaderCircle className="h-4 w-4 animate-spin" />
                          <span>{progressDetail || '正在解析…'}</span>
                        </span>
                      ) : (
                        <>
                          <span className="leading-5">
                            {draggingFiles ? '释放以上传技术交底' : '点击或拖入技术交底，开始撰写…'}
                          </span>
                          <span className="text-[11px] leading-4 text-muted-foreground/80">
                            PDF/DOCX/MD/TXT/RTF/HTML · 支持 ZIP · 最大 200 MB
                          </span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label="添加技术交底"
                    >
                      <Paperclip className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-end gap-1 px-1.5 pb-1.5 pt-1.5">
                    <ChatComposerToolMenu
                      selectedTool={composerTool}
                      onSelect={(tool) => onSelectComposerTool?.(tool)}
                    />
                    <div className="flex min-h-8 min-w-0 flex-1 items-center px-1 text-sm text-muted-foreground">
                      {activeQuestion
                        ? '请在上方集中确认全部问题'
                        : generating
                          ? (
                            <span className="inline-flex items-center gap-2">
                              <TypingIndicator />
                              <span>正在继续处理对话</span>
                            </span>
                          )
                          : project.status === 'ready' || project.status === 'completed'
                            ? '本次专利对话已完成'
                            : '分析将在信息完整后自动继续'}
                    </div>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading || generating}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label="用新交底创建新专利"
                      title="用新交底创建新专利（不会替换当前项目）"
                    >
                      <Paperclip className="h-4 w-4" />
                    </button>
                  </div>
                )}
                {composerTool ? (
                  <div className="flex flex-wrap items-center gap-1.5 px-1.5 pb-2">
                    <ComposerToolChip
                      tool={composerTool}
                      onClear={() => onSelectComposerTool?.(null)}
                    />
                  </div>
                ) : null}
              </div>
            ) : !project ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                onDragEnter={handleDropzoneDragEnter}
                onDragOver={handleDropzoneDragOver}
                onDragLeave={handleDropzoneDragLeave}
                onDrop={handleDropzoneDrop}
                disabled={uploading}
                className={`flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-6 text-sm transition disabled:cursor-not-allowed disabled:opacity-60 ${
                  draggingFiles
                    ? 'border-primary/50 bg-primary/5 text-foreground'
                    : 'border-border bg-muted/40 text-muted-foreground hover:border-primary/40 hover:bg-muted hover:text-foreground'
                }`}
                aria-label="点击或拖入技术交底"
              >
                {uploading ? (
                  <>
                    <LoaderCircle className="h-5 w-5 animate-spin" />
                    <span className="font-medium">{progressDetail || '正在解析…'}</span>
                  </>
                ) : (
                  <>
                    <UploadCloud className="h-5 w-5" />
                    <span className="font-medium">
                      {draggingFiles ? '释放以上传技术交底' : '点击或拖入技术交底'}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      PDF/DOCX/MD/TXT/RTF/HTML · 支持 ZIP · 最大 200 MB
                    </span>
                    <span className="max-w-lg text-[11px] leading-4 text-muted-foreground/80">
                      扫描版 PDF 需先 OCR。交底包含未公开技术信息，请仅在可信内网环境处理。
                    </span>
                  </>
                )}
              </button>
            ) : (
              <div className="flex items-end gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || generating}
                  className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="用新交底创建新专利"
                  title="用新交底创建新专利（不会替换当前项目）"
                >
                  <Paperclip className="h-4 w-4" />
                </button>

                {activeQuestion ? (
                  <div className="ui-input flex min-h-10 flex-1 items-center text-sm text-muted-foreground">
                    请在上方集中确认全部问题
                  </div>
                ) : (
                  <div className="ui-input flex min-h-10 flex-1 items-center text-sm text-muted-foreground">
                    {generating ? (
                      <span className="inline-flex items-center gap-2">
                        <TypingIndicator />
                        <span>正在继续处理对话</span>
                      </span>
                    ) : project.status === 'ready' || project.status === 'completed' ? (
                      '本次专利对话已完成'
                    ) : (
                      '分析将在信息完整后自动继续'
                    )}
                  </div>
                )}

                {activeQuestion ? (
                  <span className="mb-0.5 h-8 w-8 shrink-0" aria-hidden />
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || generating}
                    className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="用新交底创建新专利"
                  >
                    <UploadCloud className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}
          </form>
        </main>

        {project ? (
          <aside className="rag-knowledge-panel hidden w-[300px] shrink-0 border-l border-border 2xl:flex">
            <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <FileBadge2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm font-semibold text-foreground">申请产物</span>
              </div>
              {project?.audit ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-foreground">
                  {project.qualityScore}分
                </span>
              ) : null}
            </header>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3">
              <div className="mb-3 rounded-lg border border-border bg-background/50 p-3">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  生成阶段
                </div>
                <PatentStageTimeline project={project} />
              </div>
              <div className="space-y-2">
                {[
                  { key: 'source', label: '源文档', ready: Boolean(project?.source), detail: project?.source?.name },
                  { key: 'disclosure', label: '发明交底', ready: Boolean(project?.disclosure), detail: project?.disclosure?.proposedTitle },
                  { key: 'prior_art', label: '现有技术', ready: Boolean(project?.priorArt), detail: project?.priorArt ? `${project.priorArt.candidates.length} 候选` : undefined },
                  { key: 'strategy', label: '保护策略', ready: Boolean(project?.strategy), detail: project?.strategy?.inventionTitle },
                  { key: 'drawings', label: '说明书附图', ready: Boolean(project?.drawings?.assets?.length), detail: project?.drawings ? `${project.drawings.assets.length} 幅` : undefined },
                  { key: 'draft', label: '申请文件', ready: Boolean(project?.draft), detail: project?.draft?.title },
                  { key: 'audit', label: '质量审校', ready: Boolean(project?.audit), detail: project?.audit ? `${project.audit.score}/100` : undefined }
                ].map((item) => (
                  <div key={item.key} className="rag-knowledge-source cursor-default">
                    <span className="flex items-start justify-between gap-2">
                      <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
                        {item.label}
                      </span>
                      {item.ready ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                      ) : generating ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      ) : (
                        <span className="text-[10px] text-muted-foreground">待生成</span>
                      )}
                    </span>
                    <span className="mt-2 block text-xs font-medium leading-5 text-foreground">
                      {item.detail || (item.ready ? '已就绪' : '尚未产出')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="shrink-0 border-t border-border p-3">
              <button
                type="button"
                onClick={downloadBundle}
                disabled={!project?.draft || generating || !['ready', 'completed', 'review_required'].includes(project.status)}
                className="ui-btn-secondary flex w-full items-center justify-center gap-1.5 text-xs disabled:opacity-40"
              >
                <Download className="h-3.5 w-3.5" />
                下载申请包
              </button>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
