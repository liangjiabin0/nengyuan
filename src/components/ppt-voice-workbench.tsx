'use client';

import {
  AudioLines,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Film,
  Filter,
  LoaderCircle,
  MessageSquareText,
  Presentation,
  Send,
  SlidersHorizontal,
  Sparkles,
  Upload,
  Volume2,
  X
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { useNotifyError } from '@/components/app-notify';
import { usePageContentReady } from '@/components/page-nav-loading';
import { UiSelect } from '@/components/ui-select';
import { readDashboardListCache } from '@/lib/dashboard-list-cache';
import {
  WelcomeTypewriter,
  WorkbenchComposer,
  WorkbenchConvItem,
  WorkbenchMain,
  WorkbenchMainHeader,
  WorkbenchPageShell,
  WorkbenchSidebar
} from '@/components/workbench-page-shell';
import {
  DEFAULT_PPT_VOICE,
  PPT_VOICE_ACCEPT,
  PPT_VOICE_MAX_BYTES,
  PPT_VOICE_MODELS,
  PPT_VOICE_PRESETS,
  PPT_VOICE_STAGE_LABELS
} from '@/lib/ppt-voice/constants';
import type {
  PptVoiceEvent,
  PptVoiceProject,
  PptVoiceProjectSnapshot,
  PptVoiceSlide,
  PptVoiceVoiceSettings
} from '@/lib/ppt-voice/types';
import { cn } from '@/lib/utils';

const PPT_MODEL_OPTIONS = PPT_VOICE_MODELS.map((item) => ({ value: item.id, label: item.label }));
const PPT_VOICE_OPTIONS = PPT_VOICE_PRESETS.map((item) => ({ value: item.id, label: item.label }));

const WELCOME_PROMPTS = [
  '把 PPT 交给我来配音？',
  '今天要给哪份幻灯片配音？',
  '上传演示文稿，我来写讲稿。',
  '从哪一份 PPT 开始？'
];
const CHARS_PER_SECOND = 4.5;
const MAX_MB = Math.round(PPT_VOICE_MAX_BYTES / (1024 * 1024));

type RightTab = 'chat' | 'voice' | 'progress';
type FlowStep = 'look' | 'write' | 'listen' | 'produce';

const FLOW_STEPS: { id: FlowStep; label: string; hint: string }[] = [
  { id: 'look', label: '看本页', hint: '先看画面' },
  { id: 'write', label: '写讲稿', hint: '写下要说的话' },
  { id: 'listen', label: '试听', hint: '听这一页是否顺' },
  { id: 'produce', label: '出品', hint: '生成整份配音' }
];

function pickWelcomePrompt() {
  return WELCOME_PROMPTS[Math.floor(Math.random() * WELCOME_PROMPTS.length)];
}

function isFileDrag(event: ReactDragEvent) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function pickPptxFile(files: FileList | File[] | null) {
  return Array.from(files || []).find((file) => {
    const name = file.name.toLowerCase();
    return name.endsWith('.pptx') || file.type.includes('presentationml');
  }) || null;
}

function formatTime(value: string) {
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function describeNonJsonError(status: number, body: string) {
  const trimmed = body.replace(/\s+/g, ' ').trim();
  if (/^internal\s+server\s+error/i.test(trimmed) || trimmed.startsWith('Internal S')) {
    return '写稿服务超时或中断。请稍后重试；页数多时可先逐页写本页。';
  }
  if (status === 413) return '文件太大。';
  if (status >= 400) return trimmed.slice(0, 160) || `请求失败（${status}）。`;
  return `服务返回了无法解析的响应：${trimmed.slice(0, 160)}`;
}

async function readApiJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  const text = await response.text();
  const trimmed = text.trim();
  if (!trimmed) {
    if (!response.ok) throw new Error(describeNonJsonError(response.status, ''));
    return {} as T;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(describeNonJsonError(response.status, trimmed));
  }
}

type PptVoiceStreamEvent = {
  type?: string;
  thought?: string;
  reply?: string;
  applied?: number;
  updated?: number;
  error?: string;
  project?: PptVoiceProjectSnapshot;
};

async function consumePptVoiceNdjson(
  response: Response,
  onEvent: (event: PptVoiceStreamEvent) => void
) {
  const contentType = response.headers.get('content-type') || '';
  if (!response.body || (!contentType.includes('ndjson') && response.ok && contentType.includes('application/json'))) {
    const data = await readApiJson<PptVoiceStreamEvent & { error?: string }>(response);
    if (!response.ok) throw new Error(data.error || '操作失败。');
    onEvent({ type: 'done', ...data });
    return;
  }
  if (!response.body) {
    const data = await readApiJson<{ error?: string }>(response);
    throw new Error(data.error || '操作失败。');
  }
  if (!response.ok && contentType.includes('application/json')) {
    const data = await readApiJson<{ error?: string }>(response);
    throw new Error(data.error || '操作失败。');
  }
  if (!response.ok && !contentType.includes('ndjson')) {
    throw new Error(describeNonJsonError(response.status, await response.text()));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      const event = JSON.parse(trimmed) as PptVoiceStreamEvent;
      onEvent(event);
      if (event.type === 'error') throw new Error(event.error || '操作失败。');
    }
  }
}

function statusLabel(status: PptVoiceProject['status']) {
  return PPT_VOICE_STAGE_LABELS[status] || status;
}

function slideStatusDot(slide: PptVoiceSlide) {
  if (slide.status === 'failed') return 'bg-rose-500';
  if (slide.status === 'previewed' || slide.status === 'audio_ready') return 'bg-sky-400';
  if (slide.notes.trim()) return 'bg-emerald-400';
  return 'bg-amber-400';
}

function estimateSeconds(text: string) {
  const chars = text.trim().length;
  return chars ? chars / CHARS_PER_SECOND : 0;
}

async function downloadProtectedFile(url: string, fallbackName: string) {
  const response = await fetch(url);
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || contentType.includes('application/json')) {
    const data = await response.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || '下载失败。');
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const disposition = response.headers.get('content-disposition') || '';
  const utf = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = disposition.match(/filename="?([^"]+)"?/i);
  link.href = objectUrl;
  link.download = decodeURIComponent(utf?.[1] || plain?.[1] || fallbackName);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

type ChatTurn = {
  user: string;
  thought: string;
  reply: string;
  applied: number;
  error?: string;
};

function ThinkTicker({ text, active }: { text: string; active: boolean }) {
  const trackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = trackRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [text]);
  if (!text) return null;
  return (
    <div className="rag-think-ticker">
      <span className={active ? 'rag-think-label-shimmer' : 'rag-think-label'}>
        {active ? '思考中' : '已思考'}
      </span>
      <div ref={trackRef} className="rag-think-ticker-track">
        <span className={cn('rag-think-ticker-text', active && 'rag-oc-prose-active')}>{text}</span>
      </div>
    </div>
  );
}

export function PptVoiceWorkbench() {
  const [projects, setProjects] = useState<PptVoiceProject[]>([]);
  const [project, setProject] = useState<PptVoiceProjectSnapshot | null>(null);
  const [search, setSearch] = useState('');
  const [, setError] = useNotifyError();
  const [busy, setBusy] = useState(false);
  const [slideIndex, setSlideIndex] = useState(1);
  const [notesDraft, setNotesDraft] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatTurn, setChatTurn] = useState<ChatTurn | null>(null);
  const [ttsReady, setTtsReady] = useState<boolean | null>(null);
  const [hasPowerpoint, setHasPowerpoint] = useState<boolean | null>(null);
  const [rendering, setRendering] = useState(false);
  const [slideBroken, setSlideBroken] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [exportingVideo, setExportingVideo] = useState(false);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>('chat');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [emptyOnly, setEmptyOnly] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [appliedSlides, setAppliedSlides] = useState<number[]>([]);
  const [welcomeLine] = useState(() => pickWelcomePrompt());
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const eventAfterRef = useRef(0);
  const actionLockRef = useRef(false);
  const pendingVideoDownloadRef = useRef(false);
  const downloadMenuRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef(0);
  const notesDraftRef = useRef('');
  const renderTriedRef = useRef('');
  const projectRef = useRef<PptVoiceProjectSnapshot | null>(null);
  const currentSlideRef = useRef<PptVoiceSlide | null>(null);
  const slideIndexRef = useRef(1);

  usePageContentReady(true);

  const currentSlide = project?.slides.find((item) => item.slideIndex === slideIndex) || null;
  const emptySlides = project?.slides.filter((item) => !item.notes.trim()) || [];
  const emptyCount = emptySlides.length;
  const slideStamp = project?.updatedAt || '';
  const slideImageSrc = project
    ? `/api/ppt-voice/${project.id}/download?kind=slide&slide=${slideIndex}&t=${encodeURIComponent(slideStamp)}&n=${project.slideImageCount}`
    : '';
  const jobLocked = Boolean(busy || project?.status === 'generating' || project?.status === 'checking');
  const skipEmpty = project?.voice.emptyNotePolicy === 'skip';
  const visibleSlides = useMemo(() => {
    if (!project) return [];
    return emptyOnly ? project.slides.filter((item) => !item.notes.trim()) : project.slides;
  }, [project, emptyOnly]);
  const noteChars = notesDraft.trim().length;
  const noteSeconds = estimateSeconds(notesDraft);

  projectRef.current = project;
  currentSlideRef.current = currentSlide;
  slideIndexRef.current = slideIndex;

  const refreshProjects = useCallback(async (force = false) => {
    const list = await readDashboardListCache('/api/ppt-voice', async () => {
      const response = await fetch('/api/ppt-voice');
      const data = await readApiJson<{ error?: string; projects?: PptVoiceProject[] }>(response);
      if (!response.ok) throw new Error(data.error || '读取项目失败。');
      return data.projects || [];
    }, { force });
    setProjects(list);
    return list;
  }, []);

  const loadProject = useCallback(async (id: string, after = eventAfterRef.current) => {
    const response = await fetch(`/api/ppt-voice/${id}?after=${after}`);
    const data = await readApiJson<{ error?: string; project?: PptVoiceProjectSnapshot }>(response);
    if (!response.ok) throw new Error(data.error || '读取项目失败。');
    if (!data.project) throw new Error('读取项目失败。');
    const next = data.project as PptVoiceProjectSnapshot;
    setProject((prev) => {
      if (!prev || prev.id !== next.id) return next;
      const seen = new Set(prev.events.map((item) => item.id));
      const merged = [...prev.events];
      for (const event of next.events) {
        if (!seen.has(event.id)) merged.push(event);
      }
      return { ...next, events: merged };
    });
    setProjects((prev) =>
      prev.map((item) =>
        item.id === next.id
          ? {
              ...item,
              status: next.status,
              progress: next.progress,
              progressDetail: next.progressDetail,
              title: next.title,
              updatedAt: next.updatedAt,
              hasOutput: next.hasOutput,
              hasVideo: next.hasVideo,
              hasReport: next.hasReport
            }
          : item
      )
    );
    const maxId = Math.max(after, ...(next.events || []).map((item: PptVoiceEvent) => item.id), 0);
    eventAfterRef.current = maxId;
    return next;
  }, []);

  useEffect(() => {
    fetch('/api/ppt-voice/settings')
      .then(async (response) => {
        const data = await response.json();
        if (response.ok) {
          setTtsReady(Boolean(data.hasApiKey));
          const health = data.health || {};
          setHasPowerpoint(
            health.powerpoint === true
            || health.embedEngine === 'ooxml'
            || health.libreoffice === true
          );
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshProjects()
      .then((list) => {
        if (!list.length) return;
        eventAfterRef.current = 0;
        return loadProject(list[0].id, 0);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : '加载失败。'));
  }, [refreshProjects, loadProject]);

  useEffect(() => {
    const active = exportingVideo
      || project?.status === 'generating' || project?.status === 'checking'
      || projects.some((item) => item.status === 'generating' || item.status === 'checking');
    if (!active) return;
    const timer = window.setInterval(async () => {
      const id = project?.id;
      void (id ? loadProject(id) : refreshProjects()).catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [exportingVideo, project?.id, project?.status, projects, loadProject, refreshProjects]);

  useEffect(() => {
    if (project?.status === 'generating' || project?.status === 'checking') {
      setRightTab('progress');
    }
  }, [project?.status]);

  useEffect(() => {
    if (exportingVideo) setRightTab('progress');
  }, [exportingVideo]);

  useEffect(() => {
    if (!exportingVideo || !project) return;
    if (project.hasVideo && pendingVideoDownloadRef.current) {
      pendingVideoDownloadRef.current = false;
      setExportingVideo(false);
      void downloadProtectedFile(
        `/api/ppt-voice/${project.id}/download?kind=video`,
        `${project.title}.mp4`
      ).catch((reason) => setError(reason instanceof Error ? reason.message : '下载视频失败。'));
      return;
    }
    if (project.progressDetail?.includes('视频导出失败')) {
      pendingVideoDownloadRef.current = false;
      setExportingVideo(false);
      setError(project.progressDetail);
    }
  }, [exportingVideo, project]);

  useEffect(() => {
    if (!downloadMenuOpen) return;
    function onDocPointer(event: MouseEvent) {
      if (!downloadMenuRef.current?.contains(event.target as Node)) {
        setDownloadMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocPointer);
    return () => document.removeEventListener('mousedown', onDocPointer);
  }, [downloadMenuOpen]);

  useEffect(() => {
    notesDraftRef.current = notesDraft;
  }, [notesDraft]);

  useEffect(() => {
    setSlideBroken(false);
  }, [project?.id, slideIndex, project?.slideImageCount]);

  useEffect(() => {
    setEditingTitle(false);
    setAppliedSlides([]);
    setEmptyOnly(false);
    setRightTab('chat');
    setAssistantOpen(false);
  }, [project?.id]);

  useEffect(() => {
    if (!project || project.hasSlideImages || rendering || busy) return;
    if (renderTriedRef.current === project.id) return;
    renderTriedRef.current = project.id;
    setRendering(true);
    fetch(`/api/ppt-voice/${project.id}/render`, { method: 'POST' })
      .then(async (response) => {
        const data = await readApiJson<{ error?: string; project?: PptVoiceProjectSnapshot }>(response);
        if (!response.ok) throw new Error(data.error || '生成预览失败。');
        if (data.project) setProject(data.project);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : '生成预览失败。'))
      .finally(() => setRendering(false));
  }, [project, rendering, busy]);

  useEffect(() => {
    if (!currentSlide) {
      setNotesDraft('');
      return;
    }
    setNotesDraft(currentSlide.notes);
  }, [currentSlide?.id, currentSlide?.updatedAt]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [project?.messages.length, chatTurn?.thought, chatTurn?.reply, chatBusy]);

  useEffect(() => {
    if (!currentSlide?.audioRelpath) return;
    audioRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [currentSlide?.audioRelpath, currentSlide?.updatedAt]);

  const visibleProjects = useMemo(() => {
    const keyword = search.trim();
    if (!keyword) return projects;
    return projects.filter((item) => item.title.includes(keyword) || item.sourceName.includes(keyword));
  }, [projects, search]);

  async function persistNotes(target: PptVoiceSlide, notes: string) {
    const id = projectRef.current?.id;
    if (!id || notes === target.notes) return;
    const response = await fetch(`/api/ppt-voice/${id}/slides`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slideIndex: target.slideIndex, notes })
    });
    const data = await readApiJson<{ error?: string; project?: PptVoiceProjectSnapshot }>(response);
    if (!response.ok) throw new Error(data.error || '保存备注失败。');
    if (data.project) setProject(data.project);
  }

  function scheduleSave(value: string) {
    setNotesDraft(value);
    window.clearTimeout(saveTimer.current);
    const slide = currentSlideRef.current;
    if (!slide) return;
    saveTimer.current = window.setTimeout(() => {
      void persistNotes(slide, value).catch((reason) => setError(reason instanceof Error ? reason.message : '保存失败。'));
    }, 700);
  }

  async function flushSave() {
    window.clearTimeout(saveTimer.current);
    const slide = currentSlideRef.current;
    if (slide) await persistNotes(slide, notesDraftRef.current);
  }

  function switchSlide(nextIndex: number) {
    if (!projectRef.current || nextIndex === slideIndexRef.current) return;
    window.clearTimeout(saveTimer.current);
    const slide = currentSlideRef.current;
    const draft = notesDraftRef.current;
    setSlideIndex(nextIndex);
    if (slide) {
      void persistNotes(slide, draft).catch((reason) => setError(reason instanceof Error ? reason.message : '保存失败。'));
    }
  }

  useEffect(() => {
    if (!project) return;
    function onKey(event: KeyboardEvent) {
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
      const total = projectRef.current?.slides.length || 0;
      if (!total) return;
      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault();
        switchSlide(Math.min(total, slideIndexRef.current + 1));
      }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        switchSlide(Math.max(1, slideIndexRef.current - 1));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project?.id]);

  async function uploadPpt(file: File) {
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.set('file', file);
      const response = await fetch('/api/ppt-voice', { method: 'POST', body: form });
      const data = await readApiJson<{ error?: string; project?: PptVoiceProjectSnapshot }>(response);
      if (!response.ok) throw new Error(data.error || '导入失败。');
      eventAfterRef.current = 0;
      if (data.project) setProject(data.project);
      setSlideIndex(1);
      await refreshProjects(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导入失败。');
    } finally {
      setBusy(false);
    }
  }

  function handleFileDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (project || busy || !isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDraggingFiles(true);
  }

  function handleFileDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (project || busy || !isFileDrag(event)) return;
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
    if (project || busy) return;
    const file = pickPptxFile(event.dataTransfer.files);
    if (!file) {
      setError('请拖入 .pptx 文件。');
      return;
    }
    void uploadPpt(file);
  }

  async function downloadVideo() {
    if (!project || !project.hasOutput) return;
    setDownloadMenuOpen(false);
    setError('');
    if (project.hasVideo) {
      try {
        await downloadProtectedFile(`/api/ppt-voice/${project.id}/download?kind=video`, `${project.title}.mp4`);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '下载视频失败。');
      }
      return;
    }
    pendingVideoDownloadRef.current = true;
    setExportingVideo(true);
    try {
      const response = await fetch(`/api/ppt-voice/${project.id}/export-video`, { method: 'POST' });
      const data = await readApiJson<{ error?: string; project?: PptVoiceProjectSnapshot }>(response);
      if (!response.ok) throw new Error(data.error || '导出视频失败。');
      if (data.project) setProject(data.project);
    } catch (reason) {
      pendingVideoDownloadRef.current = false;
      setExportingVideo(false);
      setError(reason instanceof Error ? reason.message : '导出视频失败。');
    }
  }

  async function downloadReport() {
    if (!project) return;
    setDownloadMenuOpen(false);
    try {
      await downloadProtectedFile(`/api/ppt-voice/${project.id}/download?kind=report`, `${project.title}_生成报告.html`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '下载报告失败。');
    }
  }

  async function runAction(path: string, body?: unknown) {
    if (!project || actionLockRef.current) return;
    actionLockRef.current = true;
    setError('');
    if (path === '/build') {
      setProject((current) => current
        ? { ...current, status: 'generating', progress: Math.max(8, current.progress), progressDetail: '正在启动配音', error: undefined }
        : current);
    }
    setBusy(true);
    try {
      try {
        await flushSave();
      } catch (reason) {
        if (path !== '/build') throw reason;
      }
      const response = await fetch(`/api/ppt-voice/${project.id}${path}`, {
        method: 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (path === '/ai') {
        const notesBefore = new Map(project.slides.map((slide) => [slide.slideIndex, slide.notes]));
        let sawDone = false;
        await consumePptVoiceNdjson(response, (event) => {
          if (event.project) {
            setProject(event.project);
            const changed = event.project.slides
              .filter((slide) => notesBefore.get(slide.slideIndex) !== slide.notes)
              .map((slide) => slide.slideIndex);
            if (changed.length) setAppliedSlides(changed);
          }
          if (event.type === 'done') sawDone = true;
        });
        if (!sawDone) await loadProject(project.id, 0);
        return;
      }
      const data = await readApiJson<{ error?: string; project?: PptVoiceProjectSnapshot }>(response);
      if (!response.ok) throw new Error(data.error || '操作失败。');
      if (data.project) setProject(data.project);
      else await loadProject(project.id, 0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败。');
    } finally {
      actionLockRef.current = false;
      setBusy(false);
    }
  }

  async function saveVoice(patch: Partial<PptVoiceVoiceSettings>) {
    const current = projectRef.current;
    if (!current) return;
    const voice = { ...DEFAULT_PPT_VOICE, ...current.voice, ...patch };
    const response = await fetch(`/api/ppt-voice/${current.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(voice)
    });
    const data = await readApiJson<{ error?: string; project?: PptVoiceProjectSnapshot }>(response);
    if (!response.ok) throw new Error(data.error || '保存音色失败。');
    if (data.project) setProject(data.project);
  }

  async function saveTitle(nextTitle: string) {
    const current = projectRef.current;
    const trimmed = nextTitle.trim();
    if (!current || !trimmed || trimmed === current.title) {
      setEditingTitle(false);
      return;
    }
    try {
      const response = await fetch(`/api/ppt-voice/${current.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed })
      });
      const data = await readApiJson<{ error?: string; project?: PptVoiceProjectSnapshot }>(response);
      if (!response.ok) throw new Error(data.error || '重命名失败。');
      if (data.project) setProject(data.project);
      setProjects((prev) => prev.map((item) => (item.id === current.id ? { ...item, title: trimmed } : item)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '重命名失败。');
    } finally {
      setEditingTitle(false);
    }
  }

  async function sendChat() {
    const text = chatInput.trim();
    const current = projectRef.current;
    if (!current || !text || chatBusy) return;
    await flushSave();
    const notesBefore = new Map(current.slides.map((slide) => [slide.slideIndex, slide.notes]));
    setChatInput('');
    setError('');
    setChatBusy(true);
    setChatTurn({ user: text, thought: '已收到，正在阅读幻灯片目录', reply: '', applied: 0 });
    try {
      const response = await fetch(`/api/ppt-voice/${current.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text })
      });
      await consumePptVoiceNdjson(response, (event) => {
        if (event.project) {
          setProject(event.project);
          const changed = event.project.slides
            .filter((slide) => notesBefore.get(slide.slideIndex) !== slide.notes)
            .map((slide) => slide.slideIndex);
          if (changed.length) setAppliedSlides(changed);
        }
        if (event.thought || event.reply || event.applied) {
          setChatTurn((item) => item
            ? {
                ...item,
                thought: event.thought || item.thought,
                reply: event.reply ?? item.reply,
                applied: event.applied ?? item.applied
              }
            : item);
        }
        if (event.type === 'done') setChatTurn(null);
      });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '对话失败。';
      setError(message);
      setChatTurn((item) => item ? { ...item, error: message, thought: message } : item);
    } finally {
      setChatBusy(false);
    }
  }

  async function removeProject(id: string) {
    if (!window.confirm('删除该配音项目？源 PPT 不会被改动。')) return;
    const response = await fetch(`/api/ppt-voice/${id}`, { method: 'DELETE' });
    const data = await readApiJson<{ error?: string }>(response);
    if (!response.ok) {
      setError(data.error || '删除失败。');
      return;
    }
    if (project?.id === id) {
      setProject(null);
      eventAfterRef.current = 0;
    }
    await refreshProjects(true);
  }

  function openAssistant(tab: RightTab = 'chat') {
    setRightTab(tab);
    setAssistantOpen(true);
  }

  async function produceDeck() {
    const current = projectRef.current;
    if (!current || actionLockRef.current) return;
    await flushSave();
    const currentIndex = slideIndexRef.current;
    const draft = notesDraftRef.current;
    const empties = current.slides.filter((slide) => {
      const notes = slide.slideIndex === currentIndex ? draft : slide.notes;
      return !notes.trim();
    });
    const skip = current.voice.emptyNotePolicy === 'skip';
    if (empties.length && !skip) {
      switchSlide(empties[0].slideIndex);
      setError(`还有 ${empties.length} 页没有讲稿。先看图写完这些页，再生成整份配音。`);
      return;
    }
    void runAction('/build', { skipEmpty: skip });
  }

  const events = [...(project?.events || [])].slice(-40).reverse();
  const writtenCount = project?.slides.filter((slide) => slide.notes.trim()).length || 0;
  const listenedCount = project?.slides.filter((slide) => slide.audioRelpath || slide.status === 'previewed' || slide.status === 'audio_ready').length || 0;
  const flowStep: FlowStep = !project
    ? 'look'
    : project.hasOutput || project.status === 'done'
      ? 'produce'
      : project.status === 'generating' || project.status === 'checking'
        ? 'produce'
        : emptyCount > 0
          ? 'write'
          : currentSlide?.audioRelpath
            ? 'produce'
            : notesDraft.trim()
              ? 'listen'
              : 'write';
  const flowIndex = FLOW_STEPS.findIndex((step) => step.id === flowStep);

  return (
    <WorkbenchPageShell
      crumb="工作台 / 配音"
      title="PPT 智能配音"
      description="用于为 PPT 编写讲稿、生成配音并导出成品。"
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
      dragOverlay={
        draggingFiles && !project ? (
          <div className="pointer-events-none absolute inset-3 z-[250] flex items-center justify-center rounded-xl border-2 border-dashed border-primary/40 bg-muted/90 text-foreground shadow-soft backdrop-blur-sm" role="status" aria-live="polite">
            <div className="flex flex-col items-center gap-2">
              <Upload className="h-7 w-7" />
              <span className="text-sm font-semibold">释放以上传 PPT</span>
              <span className="text-xs text-muted-foreground">仅支持 .pptx，最大 {MAX_MB} MB</span>
            </div>
          </div>
        ) : null
      }
    >
      <WorkbenchSidebar
        historyOpen={historyOpen}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="搜索项目..."
        onNew={() => {
          setProject(null);
          setError('');
          setHistoryOpen(false);
          setEditingTitle(false);
        }}
        newLabel="新配音项目"
        newDisabled={busy}
        hasItems={visibleProjects.length > 0}
        emptyIcon={<AudioLines className="h-8 w-8 text-muted-foreground/40" strokeWidth={1.4} />}
        emptyTitle="暂无配音项目"
        emptyHint="上传 PPT 后会显示在这里"
      >
        {visibleProjects.map((item) => (
          <WorkbenchConvItem
            key={item.id}
            active={project?.id === item.id}
            title={item.title}
            time={formatTime(item.updatedAt)}
            subtitle={
              item.status === 'generating' || item.status === 'checking'
                ? `${statusLabel(item.status)} ${item.progress}%`
                : statusLabel(item.status)
            }
            onOpen={() => {
              eventAfterRef.current = 0;
              setHistoryOpen(false);
              void loadProject(item.id, 0)
                .then((next) => setSlideIndex(next.slides[0]?.slideIndex || 1))
                .catch((reason) => setError(reason instanceof Error ? reason.message : '读取失败。'));
            }}
            onDelete={() => void removeProject(item.id)}
            deleteLabel="删除项目"
          />
        ))}
      </WorkbenchSidebar>

      <WorkbenchMain historyOpen={historyOpen}>
        <input
          ref={fileRef}
          type="file"
          accept={PPT_VOICE_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void uploadPpt(file);
          }}
        />
        <WorkbenchMainHeader
          title={
            project && editingTitle ? (
              <input
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void saveTitle(titleDraft);
                  }
                  if (event.key === 'Escape') setEditingTitle(false);
                }}
                onBlur={() => void saveTitle(titleDraft)}
                className="h-7 w-full max-w-xs rounded-md border border-border bg-background px-2 text-sm font-semibold"
                aria-label="项目标题"
                autoFocus
              />
            ) : project ? (
              <button
                type="button"
                className="block max-w-full truncate text-left hover:underline"
                title="点击重命名"
                onClick={() => {
                  setTitleDraft(project.title);
                  setEditingTitle(true);
                }}
              >
                {project.title}
              </button>
            ) : (
              '新配音项目'
            )
          }
          subtitle={
            project
              ? `${project.slides.length} 页 · ${writtenCount} 页已写讲稿${listenedCount ? ` · ${listenedCount} 页已试听` : ''}`
              : '先打开一份 PPT，再一页一页备课'
          }
          onOpenHistory={() => setHistoryOpen(true)}
          historyLabel="打开项目列表"
          actions={
            project ? (
              <>
                {project.hasOutput ? (
                  <div ref={downloadMenuRef} className="relative">
                    <button
                      type="button"
                      className="ui-btn-secondary h-8 gap-1.5 px-2.5 text-xs"
                      aria-expanded={downloadMenuOpen}
                      aria-haspopup="menu"
                      onClick={() => setDownloadMenuOpen((open) => !open)}
                    >
                      <Download className="h-3.5 w-3.5" />
                      下载成品
                      <ChevronDown className={cn('h-3 w-3 opacity-70 transition', downloadMenuOpen && 'rotate-180')} />
                    </button>
                    {downloadMenuOpen ? (
                      <div className="absolute right-0 top-full z-10 pt-1">
                        <div className="w-52 overflow-hidden rounded-md border border-border bg-card py-1 shadow-md" role="menu">
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground hover:bg-muted disabled:opacity-50"
                            disabled={exportingVideo}
                            onClick={() => void downloadVideo()}
                          >
                            {exportingVideo ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Film className="h-3.5 w-3.5" />}
                            {exportingVideo ? '正在导出视频…' : project.hasVideo ? '视频（MP4）' : '导出并下载视频'}
                          </button>
                          <a
                            className="flex items-center gap-2 px-3 py-2 text-xs text-foreground hover:bg-muted"
                            href={`/api/ppt-voice/${project.id}/download?kind=pptx`}
                            onClick={() => setDownloadMenuOpen(false)}
                          >
                            <Presentation className="h-3.5 w-3.5" />
                            带声音的 PPT
                          </a>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground hover:bg-muted disabled:opacity-50"
                            disabled={!project.hasReport}
                            onClick={() => void downloadReport()}
                          >
                            <FileText className="h-3.5 w-3.5" />
                            配音报告
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <button
                  type="button"
                  className={cn('ui-btn-secondary h-8 gap-1.5 px-2.5 text-xs', assistantOpen && rightTab === 'voice' && 'bg-accent')}
                  onClick={() => openAssistant('voice')}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  音色
                </button>
                <button
                  type="button"
                  className={cn('ui-btn-secondary h-8 gap-1.5 px-2.5 text-xs', assistantOpen && rightTab === 'chat' && 'bg-accent')}
                  aria-pressed={assistantOpen}
                  onClick={() => (assistantOpen ? setAssistantOpen(false) : openAssistant('chat'))}
                >
                  <MessageSquareText className="h-3.5 w-3.5" />
                  助手
                </button>
              </>
            ) : null
          }
        />

        {ttsReady === false ? (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
            还没有配置百炼 API Key。看图写稿可用，试听和整份配音需要管理员在
            <a className="mx-1 underline" href="/settings?tab=voice">系统设置 → PPT 配音</a>
            填写 DASHSCOPE_API_KEY。
          </div>
        ) : null}
        {hasPowerpoint === false ? (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
            未检测到 PowerPoint / LibreOffice 配音引擎。Linux 上请安装 libreoffice-impress 与 ffmpeg；嵌入音频也可走 OOXML 回退。
          </div>
        ) : null}

        {!project ? (
          <>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <div className="flex h-full min-h-72 flex-col items-center justify-center px-4 text-center">
                <WelcomeTypewriter text={welcomeLine} ready />
                <ol className="mt-6 flex flex-wrap items-center justify-center gap-2 text-[11px] text-muted-foreground">
                  <li className="rounded-full border border-border bg-background px-2.5 py-1">1 打开 PPT</li>
                  <li className="text-border">→</li>
                  <li className="rounded-full border border-border bg-background px-2.5 py-1">2 看图写讲稿</li>
                  <li className="text-border">→</li>
                  <li className="rounded-full border border-border bg-background px-2.5 py-1">3 试听本页</li>
                  <li className="text-border">→</li>
                  <li className="rounded-full border border-border bg-background px-2.5 py-1">4 生成整份配音</li>
                </ol>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                  className="mt-8 flex w-full max-w-md flex-col items-center gap-3 rounded-xl border-2 border-dashed border-border bg-muted/30 px-6 py-10 transition hover:border-primary/40 hover:bg-muted/50 disabled:opacity-60"
                >
                  {busy ? <LoaderCircle className="h-8 w-8 animate-spin text-muted-foreground" /> : <Upload className="h-8 w-8 text-muted-foreground" />}
                  <span className="text-sm font-medium text-foreground">{busy ? '正在打开 PPT…' : '选择或拖入 PPT'}</span>
                  <span className="text-xs text-muted-foreground">仅支持 .pptx，最大 {MAX_MB} MB</span>
                </button>
              </div>
            </div>
            <WorkbenchComposer>
              <p className="text-xs text-muted-foreground">
                {busy ? '正在解析幻灯片…' : '先打开文稿，再像翻卡片一样逐页备课'}
              </p>
            </WorkbenchComposer>
          </>
        ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <ol className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-2">
                {FLOW_STEPS.map((step, index) => (
                  <li key={step.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      title={step.hint}
                      className={cn(
                        'rounded-full px-2.5 py-1 text-[11px] font-medium transition',
                        index === flowIndex
                          ? 'bg-primary text-primary-foreground'
                          : index < flowIndex
                            ? 'bg-emerald-50 text-emerald-800'
                            : 'text-muted-foreground hover:bg-muted'
                      )}
                      onClick={() => {
                        if (step.id === 'write' && emptySlides[0]) switchSlide(emptySlides[0].slideIndex);
                        if (step.id === 'produce') void produceDeck();
                      }}
                    >
                      {index + 1} {step.label}
                    </button>
                    {index < FLOW_STEPS.length - 1 ? <span className="text-[11px] text-muted-foreground/40">→</span> : null}
                  </li>
                ))}
              </ol>
              <div className="flex min-h-0 flex-1">
              <aside className="flex w-[168px] shrink-0 flex-col border-r border-border">
                <div className="space-y-2 border-b border-border px-2.5 py-2 text-[11px] text-muted-foreground">
                  <div>目录 · {writtenCount}/{project.slides.length} 已写</div>
                  {emptyCount ? (
                    <div className="flex flex-wrap gap-1">
                      {emptySlides.slice(0, 8).map((slide) => (
                        <button
                          key={slide.id}
                          type="button"
                          className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800 hover:bg-amber-100"
                          onClick={() => switchSlide(slide.slideIndex)}
                        >
                          {slide.slideIndex}
                        </button>
                      ))}
                      {emptyCount > 8 ? <span className="text-[10px]">+{emptyCount - 8}</span> : null}
                    </div>
                  ) : null}
                  <label className="flex items-center gap-1.5">
                    <Filter className="h-3 w-3" />
                    <input type="checkbox" checked={emptyOnly} onChange={(event) => setEmptyOnly(event.target.checked)} />
                    只看未写
                  </label>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                  {visibleSlides.map((slide) => (
                    <button
                      key={slide.id}
                      type="button"
                      className={cn(
                        'mb-1.5 w-full overflow-hidden rounded-md border text-left transition',
                        slide.slideIndex === slideIndex
                          ? 'border-primary bg-accent'
                          : 'border-transparent hover:border-border hover:bg-muted/60'
                      )}
                      onClick={() => switchSlide(slide.slideIndex)}
                    >
                      <div className="relative aspect-video bg-slate-950">
                        {project.hasSlideImages ? (
                          <img
                            alt={`第 ${slide.slideIndex} 页`}
                            src={`/api/ppt-voice/${project.id}/download?kind=slide&slide=${slide.slideIndex}&t=${encodeURIComponent(slideStamp)}`}
                            className="h-full w-full object-contain"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center text-[10px] text-slate-400">
                            {rendering ? '导出中' : `第 ${slide.slideIndex} 页`}
                          </div>
                        )}
                        <span className={cn('absolute right-1 top-1 h-1.5 w-1.5 rounded-full', slideStatusDot(slide))} />
                      </div>
                      <div className="truncate px-2 py-1 text-[11px] text-muted-foreground">
                        {slide.slideIndex}. {slide.title || '（无标题）'}
                      </div>
                    </button>
                  ))}
                  {emptyOnly && !visibleSlides.length ? (
                    <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">没有未写的页</div>
                  ) : null}
                </div>
              </aside>

              <section className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <div className="relative overflow-hidden rounded-lg border border-border bg-slate-950">
                    {slideImageSrc && project.hasSlideImages && !slideBroken ? (
                      <img
                        alt={currentSlide?.title || `第 ${slideIndex} 页`}
                        src={slideImageSrc}
                        className="mx-auto max-h-[min(48vh,520px)] w-full object-contain"
                        onError={() => setSlideBroken(true)}
                      />
                    ) : (
                      <div className="flex aspect-video max-h-[min(48vh,520px)] items-center justify-center text-sm text-slate-300">
                        {rendering || busy ? '正在生成幻灯片画面…' : '还没有幻灯片画面，可稍后重试。'}
                      </div>
                    )}
                    <button
                      type="button"
                      className="absolute left-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/65 disabled:opacity-30"
                      disabled={slideIndex <= 1}
                      aria-label="上一页"
                      onClick={() => switchSlide(slideIndex - 1)}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/65 disabled:opacity-30"
                      disabled={slideIndex >= project.slides.length}
                      aria-label="下一页"
                      onClick={() => switchSlide(slideIndex + 1)}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>第 {slideIndex} / {project.slides.length} 页 · {currentSlide?.title || '（无标题）'}</span>
                    <span>← → 翻页</span>
                  </div>
                  <div className="mt-4 flex items-center justify-between gap-2">
                    <label className="text-sm font-medium text-foreground">这一页要说的话</label>
                    <span className="text-[11px] text-muted-foreground">
                      {noteChars} 字{noteChars ? ` · 大约 ${Math.max(1, Math.round(noteSeconds))} 秒` : ''}
                      {currentSlide?.durationSeconds ? ` · 已试听 ${currentSlide.durationSeconds.toFixed(1)} 秒` : ''}
                    </span>
                  </div>
                  <textarea
                    value={notesDraft}
                    onChange={(event) => scheduleSave(event.target.value)}
                    rows={6}
                    className="mt-1.5 w-full rounded-lg border border-border bg-background p-3 text-sm leading-6"
                    placeholder="看着上面的画面，写下上台要讲的话。也可以让 AI 先看图起草。"
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={cn('inline-flex h-8 items-center rounded-md px-2.5 text-xs', !notesDraft.trim() ? 'ui-btn-primary' : 'ui-btn-secondary')}
                      disabled={jobLocked}
                      onClick={() => void runAction('/ai', { action: 'generate', scope: 'one', slideIndex })}
                    >
                      <Sparkles className="mr-1 h-3.5 w-3.5" />
                      {notesDraft.trim() ? '按画面重写本页' : '看图写本页'}
                    </button>
                    <button type="button" className="ui-btn-secondary h-8 px-2.5 text-xs" disabled={jobLocked || !notesDraft.trim()} onClick={() => void runAction('/ai', { action: 'polish', scope: 'one', slideIndex })}>
                      润色口吻
                    </button>
                    <UiSelect
                      className="w-48"
                      value={project.voice.voiceId}
                      disabled={jobLocked}
                      aria-label="这一页用的音色"
                      options={PPT_VOICE_OPTIONS}
                      onChange={(voiceId) => void saveVoice({ voiceId })}
                    />
                    <button
                      type="button"
                      className={cn('inline-flex h-8 items-center rounded-md px-2.5 text-xs', notesDraft.trim() && !currentSlide?.audioRelpath ? 'ui-btn-primary' : 'ui-btn-secondary')}
                      disabled={jobLocked || !notesDraft.trim()}
                      onClick={() => void runAction('/preview', { slideIndex })}
                    >
                      <Volume2 className="mr-1 h-3.5 w-3.5" />
                      试听这一页
                    </button>
                    {slideIndex < project.slides.length ? (
                      <button type="button" className="ui-btn-ghost h-8 px-2.5 text-xs" onClick={() => switchSlide(slideIndex + 1)}>
                        下一页
                      </button>
                    ) : null}
                  </div>
                  {currentSlide?.audioRelpath ? (
                    <audio
                      ref={audioRef}
                      className="mt-3 w-full"
                      controls
                      src={`/api/ppt-voice/${project.id}/download?kind=audio&slide=${slideIndex}&t=${currentSlide.updatedAt}`}
                    />
                  ) : null}
                </div>
                <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
                  <div className="min-w-0 text-xs text-muted-foreground">
                    {project.status === 'generating' || project.status === 'checking' || exportingVideo ? (
                      <div className="w-56">
                        <div className="mb-1 flex justify-between">
                          <span>{exportingVideo ? '正在导出视频' : project.progressDetail || statusLabel(project.status)}</span>
                          <span>{Math.max(8, project.progress)}%</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className="h-full bg-primary" style={{ width: `${Math.max(8, project.progress)}%` }} />
                        </div>
                      </div>
                    ) : project.hasOutput ? (
                      <span>整份配音已经做好，可以下载成品。</span>
                    ) : emptyCount ? (
                      <span>先把未写的 {emptyCount} 页讲稿补上，再生成整份配音。</span>
                    ) : (
                      <span>各页讲稿已齐{project.preflight ? ` · 约 ${project.preflight.characterCount} 字 · ¥${project.preflight.estimatedCostYuan}` : ''}，可以出品。</span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {emptyCount && !jobLocked && !project.hasOutput ? (
                      <button
                        type="button"
                        className="ui-btn-secondary h-8 gap-1.5 px-3 text-xs"
                        onClick={() => void runAction('/ai', { action: 'generate', scope: 'empty' })}
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        空页都看图写掉
                      </button>
                    ) : null}
                    {!emptyCount && !project.hasOutput ? (
                      <button
                        type="button"
                        className="ui-btn-primary h-8 gap-1.5 px-3 text-xs"
                        disabled={jobLocked}
                        onClick={() => void produceDeck()}
                      >
                        {project.status === 'generating' ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Volume2 className="h-3.5 w-3.5" />}
                        生成整份配音
                      </button>
                    ) : null}
                    {project.hasOutput && !downloadMenuOpen ? (
                      <a className="ui-btn-primary h-8 gap-1.5 px-3 text-xs" href={`/api/ppt-voice/${project.id}/download?kind=pptx`}>
                        <Presentation className="h-3.5 w-3.5" />
                        下载带声音的 PPT
                      </a>
                    ) : null}
                  </div>
                </footer>
              </section>

              <aside className={cn('rag-knowledge-panel min-w-0 shrink-0 border-l border-border', assistantOpen ? 'flex w-[min(42%,320px)] min-w-[260px]' : 'hidden')}>
                <div className="flex shrink-0 items-center border-b border-border">
                  {([
                    ['chat', '助手'],
                    ['voice', '音色'],
                    ['progress', '进度']
                  ] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={cn(
                        'flex-1 px-2 py-2.5 text-xs font-medium',
                        rightTab === id ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'
                      )}
                      onClick={() => setRightTab(id)}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="ui-btn-ghost mr-1 h-7 w-7 px-0"
                    aria-label="关闭助手"
                    onClick={() => setAssistantOpen(false)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                {rightTab === 'chat' ? (
                  <>
                    <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
                      <MessageSquareText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-foreground">备课助手</div>
                        <div className="truncate text-xs text-muted-foreground">跨页改口吻、压时长时再找我</div>
                      </div>
                    </header>
                    <div className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                      <div className="rounded-xl border border-primary/15 bg-primary/5 p-3 text-xs leading-5 text-muted-foreground">
                        <div className="mb-1 flex items-center gap-1.5 font-semibold text-foreground">
                          <Sparkles className="h-3.5 w-3.5 text-primary" />
                          AI 配音助手
                        </div>
                        平时先看图写本页。需要统一口吻或压时长时再说，例如：「把第 3 页压到 40 秒」「统一成答辩口吻」。
                        <button
                          type="button"
                          className="mt-2 block text-[11px] text-foreground underline"
                          disabled={jobLocked}
                          onClick={() => {
                            if (!window.confirm('将按画面重写全部页面的讲稿，现有文字会被覆盖。继续？')) return;
                            void runAction('/ai', { action: 'generate', scope: 'all' });
                          }}
                        >
                          按画面重写全部讲稿
                        </button>
                      </div>
                      {appliedSlides.length ? (
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="text-[11px] text-muted-foreground">已更新</span>
                          {appliedSlides.map((index) => (
                            <button
                              key={index}
                              type="button"
                              className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted"
                              onClick={() => switchSlide(index)}
                            >
                              第 {index} 页
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {(project.messages || []).map((item) => (
                        <div key={item.id} className={`flex ${item.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                          <div className={item.role === 'user' ? 'rag-user-bubble max-w-[88%]' : 'rag-assistant-bubble max-w-[95%]'}>
                            <p className="whitespace-pre-wrap">{item.content}</p>
                          </div>
                        </div>
                      ))}
                      {chatTurn && (project.messages || []).at(-1)?.content !== chatTurn.user ? (
                        <div className="flex justify-end">
                          <div className="rag-user-bubble max-w-[88%]">
                            <p className="whitespace-pre-wrap">{chatTurn.user}</p>
                          </div>
                        </div>
                      ) : null}
                      {chatTurn && ((project.messages || []).at(-1)?.role !== 'assistant' || chatBusy) ? (
                        <div className="flex justify-start">
                          <div className="rag-assistant-bubble w-[95%]">
                            <ThinkTicker text={chatTurn.thought} active={chatBusy && !chatTurn.error} />
                            {chatTurn.reply ? <p className="whitespace-pre-wrap">{chatTurn.reply}</p> : null}
                            {chatBusy && !chatTurn.reply ? (
                              <div className="flex items-center gap-2 text-muted-foreground">
                                <LoaderCircle className="h-4 w-4 animate-spin text-primary" />
                                <span>本轮正在处理中</span>
                              </div>
                            ) : null}
                            {chatTurn.error ? <p className="mt-1 text-destructive">{chatTurn.error}</p> : null}
                          </div>
                        </div>
                      ) : null}
                      <div ref={chatEndRef} />
                    </div>
                    <div className="shrink-0 border-t border-border p-3">
                      <div className="rounded-xl border border-border bg-background p-2 focus-within:border-primary/40">
                        <textarea
                          value={chatInput}
                          onChange={(event) => setChatInput(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                              event.preventDefault();
                              void sendChat();
                            }
                          }}
                          disabled={chatBusy || jobLocked}
                          rows={3}
                          placeholder="对这一份 PPT 提要求，Enter 发送"
                          className="w-full resize-none bg-transparent px-1 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground"
                        />
                        <div className="mt-1 flex items-center justify-between">
                          <span className="text-[10px] text-muted-foreground">Enter 发送 · Shift+Enter 换行</span>
                          <button
                            type="button"
                            onClick={() => void sendChat()}
                            disabled={!chatInput.trim() || chatBusy || jobLocked}
                            className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:opacity-30"
                            aria-label="发送"
                          >
                            <Send className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                ) : null}

                {rightTab === 'voice' ? (
                  <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block space-y-1">
                        <span className="text-[11px] font-medium text-muted-foreground">合成模型</span>
                        <UiSelect
                          size="md"
                          value={project.voice.model}
                          disabled={jobLocked}
                          aria-label="合成模型"
                          options={PPT_MODEL_OPTIONS}
                          onChange={(model) => void saveVoice({ model })}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-[11px] font-medium text-muted-foreground">音色</span>
                        <UiSelect
                          size="md"
                          value={project.voice.voiceId}
                          disabled={jobLocked}
                          aria-label="音色"
                          options={PPT_VOICE_OPTIONS}
                          onChange={(voiceId) => void saveVoice({ voiceId })}
                        />
                      </label>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-[11px] font-medium text-muted-foreground">语气指令</span>
                      <textarea
                        defaultValue={project.voice.instruction}
                        key={`${project.id}-${project.voice.instruction}`}
                        disabled={jobLocked}
                        rows={3}
                        onBlur={(event) => {
                          if (event.target.value === project.voice.instruction) return;
                          void saveVoice({ instruction: event.target.value });
                        }}
                        className="w-full rounded-md border border-border bg-background p-2 text-xs leading-5"
                      />
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {([
                        ['语速', 'rate', 0.5, 2, 0.01],
                        ['音调', 'pitch', 0.5, 2, 0.01],
                        ['音量', 'volume', 0, 100, 1]
                      ] as const).map(([label, key, min, max, step]) => (
                        <label key={key} className="block space-y-1">
                          <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
                          <input
                            type="number"
                            min={min}
                            max={max}
                            step={step}
                            defaultValue={project.voice[key]}
                            key={`${project.id}-${key}-${project.voice[key]}`}
                            disabled={jobLocked}
                            onBlur={(event) => {
                              const next = Number(event.target.value);
                              if (!Number.isFinite(next)) return;
                              const value = key === 'volume'
                                ? Math.round(Math.min(max, Math.max(min, next)))
                                : Math.min(max, Math.max(min, next));
                              if (value === project.voice[key]) return;
                              void saveVoice({ [key]: value });
                            }}
                            className="ui-input h-8 bg-background px-2 text-xs"
                          />
                        </label>
                      ))}
                    </div>
                    <div className="grid grid-cols-1 gap-2">
                      {([
                        ['翻页缓冲（秒）', 'transitionBufferSeconds', 0, 10, 0.1],
                        ['末页停留（秒）', 'lastSlideHoldSeconds', 0, 30, 0.1],
                        ['最短页时长（秒）', 'minimumSlideSeconds', 0.5, 30, 0.1]
                      ] as const).map(([label, key, min, max, step]) => (
                        <label key={key} className="flex items-center justify-between gap-2">
                          <span className="text-[11px] text-muted-foreground">{label}</span>
                          <input
                            type="number"
                            min={min}
                            max={max}
                            step={step}
                            defaultValue={project.voice[key]}
                            key={`${project.id}-${key}-${project.voice[key]}`}
                            disabled={jobLocked}
                            onBlur={(event) => {
                              const next = Number(event.target.value);
                              if (!Number.isFinite(next)) return;
                              const value = Math.min(max, Math.max(min, next));
                              if (value === project.voice[key]) return;
                              void saveVoice({ [key]: value });
                            }}
                            className="ui-input h-8 w-20 bg-background px-2 text-xs"
                          />
                        </label>
                      ))}
                    </div>
                    <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={skipEmpty}
                        disabled={jobLocked}
                        onChange={(event) => void saveVoice({ emptyNotePolicy: event.target.checked ? 'skip' : 'error' })}
                      />
                      配音时跳过空备注页
                    </label>
                  </div>
                ) : null}

                {rightTab === 'progress' ? (
                  <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto bg-muted/20 px-3 py-3">
                    {project.status === 'generating' || project.status === 'checking' || exportingVideo ? (
                      <div className="mb-3">
                        <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                          <span>{exportingVideo ? '正在导出视频' : statusLabel(project.status)}</span>
                          <span>{Math.max(8, project.progress)}%</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className="h-full bg-primary" style={{ width: `${Math.max(8, project.progress)}%` }} />
                        </div>
                      </div>
                    ) : null}
                    <div className="space-y-1.5">
                      {events.map((event) => (
                        <div key={event.id} className={cn('text-[11px] leading-5', event.level === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                          {event.text}
                        </div>
                      ))}
                      {!events.length ? <div className="text-xs text-muted-foreground">还没有日志。</div> : null}
                    </div>
                  </div>
                ) : null}
              </aside>
              </div>
            </div>
          )}
      </WorkbenchMain>
    </WorkbenchPageShell>
  );
}
