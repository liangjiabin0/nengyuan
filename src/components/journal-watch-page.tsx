'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, FileCheck2, RefreshCw, Search, Upload } from 'lucide-react';
import { useNotifyError, useNotifySuccess } from '@/components/app-notify';
import { useAuth } from '@/components/auth-provider';
import { usePageContentReady } from '@/components/page-nav-loading';
import { UiSelect } from '@/components/ui-select';
import { cn } from '@/lib/utils';

type JournalStat = {
  code: string;
  name: string;
  shortName: string;
  publisher: string;
  openAccess: boolean;
  total: number;
  week: number;
  withAbstract: number;
  fulltext: number;
};

type Article = {
  doi: string;
  journalCode: string;
  title: string;
  authors: string;
  abstract: string;
  keywords: string;
  pubDate: string;
  volume: string;
  issue: string;
  url: string;
  openAccess: boolean;
  oaPdfUrl: string;
  fulltext: boolean;
  pdfSource: string;
};

type RunSummary = {
  sinceDate: string;
  journals: Record<string, { fetched: number; added: number; error?: string }>;
  enriched: { ieee: number; openalex: number };
  ieeeStatus: 'ok' | 'inactive' | 'no-key' | 'error' | 'skipped';
  errors: string[];
};

type Payload = {
  journals: JournalStat[];
  lastRun: { status: string; startedAt: string; finishedAt: string | null; error: string | null; summary: RunSummary | null } | null;
  activeJob: { id: string; status: string; progress: Record<string, unknown> | null } | null;
  total: number;
  page: number;
  pageSize: number;
  articles: Article[];
  error?: string;
};

type StatusFilter = 'all' | 'abstract' | 'title-only' | 'fulltext';

const DAY_OPTIONS = [
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
  { value: '90', label: '近 90 天' },
  { value: '0', label: '全部' }
];

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'abstract', label: '有摘要' },
  { value: 'title-only', label: '仅题目' },
  { value: 'fulltext', label: '全文已入库' }
];

const PDF_SOURCE_HINT: Record<string, string> = {
  upload: '手动上传的全文',
  'ieee-oa': '开放获取文章，自动从 IEEE Xplore 下载',
  arxiv: '作者在 arXiv 公开的预印本，内容可能与正式发表版略有不同',
  'oa-repository': '开放仓储中的公开版本，自动下载'
};

const RUN_STATUS: Record<string, string> = { done: '成功', error: '失败', running: '进行中' };

function formatTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

export function JournalWatchPage() {
  const { isAdmin } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [journal, setJournal] = useState('');
  const [days, setDays] = useState('30');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [uploadingDoi, setUploadingDoi] = useState('');
  const uploadTarget = useRef('');
  const fileInput = useRef<HTMLInputElement>(null);
  const [, setError] = useNotifyError();
  const [, setSuccess] = useNotifySuccess();

  usePageContentReady(!loading);

  async function load(background = false) {
    if (background) setRefreshing(true);
    else setLoading(true);
    try {
      const params = new URLSearchParams({ days, status, page: String(page) });
      if (journal) params.set('journal', journal);
      if (appliedQuery) params.set('q', appliedQuery);
      const response = await fetch(`/api/journal-watch?${params}`, { cache: 'no-store' });
      const payload = (await response.json().catch(() => ({}))) as Payload;
      if (!response.ok) throw new Error(payload.error || '加载期刊追踪失败');
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载期刊追踪失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load(Boolean(data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journal, days, status, appliedQuery, page]);

  // 抓取进行中时每 5 秒刷新一次
  const active = Boolean(data?.activeJob);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(true), 5_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function startRun() {
    if (starting) return;
    setStarting(true);
    try {
      const response = await fetch('/api/journal-watch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; mode?: string };
      if (!response.ok) throw new Error(payload.error || '启动抓取失败');
      setSuccess(payload.mode === 'queued' ? '已开始抓取，完成后列表会自动刷新。' : '抓取完成。');
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动抓取失败');
    } finally {
      setStarting(false);
    }
  }

  function pickFile(doi: string) {
    uploadTarget.current = doi;
    fileInput.current?.click();
  }

  async function uploadFile(file: File | undefined) {
    const doi = uploadTarget.current;
    if (!file || !doi) return;
    setUploadingDoi(doi);
    try {
      const form = new FormData();
      form.set('doi', doi);
      form.set('file', file);
      const response = await fetch('/api/journal-watch/fulltext', { method: 'POST', body: form });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || '上传全文失败');
      setSuccess('全文已入库，能元检索和问答可以用到正文了。');
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传全文失败');
    } finally {
      setUploadingDoi('');
      uploadTarget.current = '';
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  function toggle(doi: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(doi)) next.delete(doi);
      else next.add(doi);
      return next;
    });
  }

  const journals = data?.journals || [];
  const nameOf = new Map(journals.map((item) => [item.code, item.shortName]));
  const lastRun = data?.lastRun;
  const ieeeStatus = lastRun?.summary?.ieeeStatus;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const progress = data?.activeJob?.progress as { phase?: string; journal?: string } | null | undefined;

  return (
    <div className="rag-shell flex h-full min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4">
      <div className="mb-3 shrink-0 md:mb-4">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          Dashboard / Journal watch
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">期刊追踪</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          每天凌晨自动抓取订阅期刊的新文章（题目、作者、摘要），开放获取的全文自动下载入库，都进入能元的检索与问答。订阅文章需要全文时，点「原文」用机构账号下载，再点「上传全文」。
        </p>
      </div>

      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          上次抓取：{formatTime(lastRun?.startedAt)}
          {lastRun ? `（${RUN_STATUS[lastRun.status] || lastRun.status}）` : ''}
        </span>
        {data?.activeJob ? (
          <span className="inline-flex items-center gap-1 text-foreground">
            <RefreshCw className="h-3 w-3 animate-spin" />
            正在抓取{progress?.journal ? ` ${nameOf.get(progress.journal) || progress.journal}` : ''}…
          </span>
        ) : null}
        {ieeeStatus === 'inactive' || ieeeStatus === 'no-key' ? (
          <span>IEEE 期刊的摘要要等 IEEE Xplore API key 生效后才能补全。</span>
        ) : null}
        {lastRun?.error ? <span className="text-destructive">失败原因：{lastRun.error}</span> : null}
      </div>

      <div className="mb-3 flex shrink-0 flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => { setJournal(''); setPage(1); }}
          className={cn('rounded-md border px-2.5 py-1 text-xs transition', !journal ? 'border-foreground/30 bg-accent font-medium text-foreground' : 'border-border text-muted-foreground hover:bg-accent/70')}
        >
          全部期刊
        </button>
        {journals.map((item) => (
          <button
            key={item.code}
            type="button"
            title={`${item.name}\n共 ${item.total} 篇，有摘要 ${item.withAbstract} 篇，全文 ${item.fulltext} 篇`}
            onClick={() => { setJournal(item.code); setPage(1); }}
            className={cn('rounded-md border px-2.5 py-1 text-xs transition', journal === item.code ? 'border-foreground/30 bg-accent font-medium text-foreground' : 'border-border text-muted-foreground hover:bg-accent/70')}
          >
            {item.shortName}
            {item.week ? <span className="ml-1 tabular-nums text-[10px] text-muted-foreground">+{item.week}</span> : null}
          </button>
        ))}
      </div>

      <div className="rag-chat-card min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
          <form
            className="relative min-w-[12rem] flex-1"
            onSubmit={(event) => { event.preventDefault(); setAppliedQuery(query.trim()); setPage(1); }}
          >
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索题目、作者、关键词、摘要或 DOI，回车确认"
              className="ui-input h-8 pl-8 text-xs"
            />
          </form>
          <UiSelect className="w-28" value={days} options={DAY_OPTIONS} aria-label="时间范围" onChange={(value) => { setDays(value); setPage(1); }} />
          <UiSelect className="w-32" value={status} options={STATUS_OPTIONS} aria-label="状态" onChange={(value) => { setStatus(value); setPage(1); }} />
          <span className="min-w-12 text-right text-xs tabular-nums text-muted-foreground">{data?.total ?? 0} 篇</span>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={loading || refreshing}
            className="ui-btn-secondary h-8 w-8 p-0"
            aria-label="刷新列表"
            title="刷新"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          </button>
          {isAdmin ? (
            <button
              type="button"
              onClick={() => void startRun()}
              disabled={starting || Boolean(data?.activeJob)}
              className="ui-btn-primary h-8 px-3 text-xs"
              title="立即从各期刊抓取新文章"
            >
              立即抓取
            </button>
          ) : null}
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
          {loading ? (
            <div className="flex h-full min-h-48 items-center justify-center text-xs text-muted-foreground">加载中…</div>
          ) : data?.articles.length ? (
            <ul className="divide-y divide-border">
              {data.articles.map((article) => {
                const open = expanded.has(article.doi);
                return (
                  <li key={article.doi} className="px-3 py-2 hover:bg-muted/30">
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        onClick={() => toggle(article.doi)}
                        className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                        aria-label={open ? '收起摘要' : '展开摘要'}
                      >
                        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <button type="button" onClick={() => toggle(article.doi)} className="text-left text-[13px] font-medium leading-5 text-foreground">
                          {article.title}
                        </button>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                          <span className="rounded bg-muted px-1.5 py-px text-[10px] text-foreground/80">{nameOf.get(article.journalCode) || article.journalCode}</span>
                          <span className="tabular-nums">{article.pubDate || '—'}</span>
                          {article.fulltext ? (
                            <span className="inline-flex items-center gap-0.5 text-foreground" title={PDF_SOURCE_HINT[article.pdfSource] || ''}>
                              <FileCheck2 className="h-3 w-3" />
                              {article.pdfSource === 'arxiv' ? '预印本已入库' : '全文已入库'}
                              {article.pdfSource && article.pdfSource !== 'upload' ? '（自动）' : ''}
                            </span>
                          ) : article.abstract ? (
                            <span>有摘要</span>
                          ) : (
                            <span>仅题目</span>
                          )}
                          {article.openAccess ? <span>开放获取</span> : null}
                          <span className="min-w-0 truncate" title={article.authors}>{article.authors}</span>
                        </div>
                        {open ? (
                          <div className="mt-2 space-y-1.5 text-xs leading-5 text-muted-foreground">
                            <p className="whitespace-pre-wrap text-foreground/90">{article.abstract || '暂无摘要。'}</p>
                            {article.keywords ? <p>关键词：{article.keywords}</p> : null}
                            <p className="tabular-nums">DOI：{article.doi}</p>
                          </div>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <a
                          href={article.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
                          title="在出版商网站打开，用机构账号下载全文"
                        >
                          原文<ExternalLink className="h-3 w-3" />
                        </a>
                        {!article.fulltext ? (
                          <button
                            type="button"
                            onClick={() => pickFile(article.doi)}
                            disabled={Boolean(uploadingDoi)}
                            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
                            title="上传从机构账号下载的 PDF"
                          >
                            {uploadingDoi === article.doi ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                            上传全文
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="flex h-full min-h-48 items-center justify-center text-xs text-muted-foreground">
              {data?.lastRun ? '没有符合条件的文章。' : '还没有抓取过。管理员可点「立即抓取」，或等每天凌晨自动运行。'}
            </div>
          )}
        </div>

        {data && totalPages > 1 ? (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <button type="button" className="ui-btn-secondary h-7 px-2 text-xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
            <span className="tabular-nums">{page} / {totalPages}</span>
            <button type="button" className="ui-btn-secondary h-7 px-2 text-xs" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
          </div>
        ) : null}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(event) => void uploadFile(event.target.files?.[0])}
      />
    </div>
  );
}
