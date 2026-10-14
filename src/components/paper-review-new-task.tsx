'use client';

import { useRef, useState } from 'react';
import { FileUp, Loader2, Play, Trash2 } from 'lucide-react';
import { UiSelect } from '@/components/ui-select';
import { cn } from '@/lib/utils';

export type InputRole = 'paper' | 'supplement' | 'code' | 'data' | 'previous_review' | 'author_response';

export const ROLE_LABELS: Record<InputRole, string> = {
  paper: '主论文',
  supplement: '补充材料',
  code: '作者代码',
  data: '数据',
  previous_review: '旧审稿意见',
  author_response: '作者回复'
};

type Pending = { file: File; role: InputRole };

export type NewTaskOptions = {
  targetVenue: string;
  reproduce: boolean;
  dataPriority: 'public_first' | 'local_licensed' | 'simulated';
  reproductionTimeoutMinutes: number;
  seed: number;
  searchLatestLiterature: boolean;
  reportLanguage: 'auto' | 'zh' | 'en_zh';
  reportDepth: 'standard' | 'deep';
  pptTemplate: 'auto' | 'planning' | 'forecasting' | 'control';
  allowStormFallback: boolean;
  allowUntrustedCode: boolean;
  allowExternalModel: boolean;
  maxModelTokens: number;
};

const DEFAULT_OPTIONS: NewTaskOptions = {
  targetVenue: '',
  reproduce: true,
  dataPriority: 'public_first',
  reproductionTimeoutMinutes: 30,
  seed: 20261012,
  searchLatestLiterature: true,
  reportLanguage: 'auto',
  reportDepth: 'deep',
  pptTemplate: 'auto',
  allowStormFallback: false,
  allowUntrustedCode: false,
  allowExternalModel: false,
  maxModelTokens: 2_000_000
};

const MAX_FILES = 20;
const MAX_BYTES = 200 * 1024 * 1024;
const PAPER_EXT = /\.(pdf|docx|tex|txt|md)$/i;

function guessRole(name: string, hasPaper: boolean): InputRole {
  if (/\.(py|m|ipynb|zip)$/i.test(name)) return 'code';
  if (/\.(csv|xlsx|json)$/i.test(name)) return 'data';
  if (/(response|rebuttal|回复|答复)/i.test(name)) return 'author_response';
  if (/(review|comment|审稿|意见)/i.test(name)) return 'previous_review';
  return hasPaper || !PAPER_EXT.test(name) ? 'supplement' : 'paper';
}

function formatSize(bytes: number) {
  return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** 新建评审任务：上传文件、标注角色、填写评审设置。 */
export function PaperReviewNewTask({ onCreated, modelLabel }: { onCreated: (id: string) => void; modelLabel: string }) {
  const [files, setFiles] = useState<Pending[]>([]);
  const [options, setOptions] = useState<NewTaskOptions>(DEFAULT_OPTIONS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  function addFiles(list: FileList | null) {
    if (!list) return;
    setError('');
    setFiles((current) => {
      const next = [...current];
      for (const file of Array.from(list)) {
        if (next.length >= MAX_FILES) { setError(`一次最多 ${MAX_FILES} 个文件`); break; }
        if (file.size > MAX_BYTES) { setError(`${file.name} 超过 200 MB`); continue; }
        next.push({ file, role: guessRole(file.name, next.some((f) => f.role === 'paper')) });
      }
      return next;
    });
    if (input.current) input.current.value = '';
  }

  const set = <K extends keyof NewTaskOptions>(key: K, value: NewTaskOptions[K]) => setOptions((o) => ({ ...o, [key]: value }));
  const paperCount = files.filter((f) => f.role === 'paper').length;

  async function submit() {
    if (submitting) return;
    if (paperCount !== 1) { setError('请指定且只指定一篇主论文'); return; }
    if (!options.allowExternalModel) { setError('需要勾选“允许把论文内容发送给配置的模型服务”才能运行'); return; }
    setSubmitting(true);
    setError('');
    try {
      const form = new FormData();
      for (const f of files) { form.append('files', f.file); form.append('roles', f.role); }
      form.set('options', JSON.stringify(options));
      const created = await fetch('/api/paper-review', { method: 'POST', body: form });
      const data = (await created.json().catch(() => ({}))) as { task?: { id: string }; error?: string };
      if (!created.ok || !data.task) throw new Error(data.error || '创建任务失败');
      const started = await fetch(`/api/paper-review/${data.task.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start' }) });
      const startData = (await started.json().catch(() => ({}))) as { error?: string };
      if (!started.ok) throw new Error(startData.error || '启动任务失败');
      setFiles([]);
      onCreated(data.task.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建任务失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="scrollbar-thin h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-3xl space-y-4">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">1. 上传材料</h2>
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
            className="flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground transition hover:bg-muted/60"
          >
            <FileUp className="h-5 w-5" />
            点击或拖入论文 PDF / DOCX，以及补充材料、作者代码、数据、旧审稿意见、作者回复
            <span className="text-[11px]">单个文件不超过 200 MB，最多 {MAX_FILES} 个</span>
          </button>
          <input ref={input} type="file" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
          {files.length ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {files.map((f, i) => (
                <li key={`${f.file.name}-${i}`} className="flex items-center gap-2 px-3 py-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-foreground" title={f.file.name}>{f.file.name}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{formatSize(f.file.size)}</span>
                  <UiSelect
                    className="w-28"
                    value={f.role}
                    aria-label="文件角色"
                    options={(Object.keys(ROLE_LABELS) as InputRole[]).map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
                    onChange={(role) => setFiles((cur) => cur.map((x, j) => (j === i ? { ...x, role } : x)))}
                  />
                  <button type="button" className="text-muted-foreground hover:text-destructive" aria-label={`移除 ${f.file.name}`} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">2. 评审设置</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">目标期刊 / 领域（可选）</span>
              <input className="ui-input h-8 text-xs" value={options.targetVenue} onChange={(e) => set('targetVenue', e.target.value)} placeholder="例如 IEEE Trans. Power Systems" />
            </label>
            <div className="space-y-1 text-xs">
              <span className="text-muted-foreground">报告语言</span>
              <UiSelect value={options.reportLanguage} aria-label="报告语言" onChange={(v) => set('reportLanguage', v)} options={[{ value: 'auto', label: '跟随论文（英文论文出中英两版）' }, { value: 'zh', label: '仅中文' }, { value: 'en_zh', label: '英文 + 中文' }]} />
            </div>
            <div className="space-y-1 text-xs">
              <span className="text-muted-foreground">复现数据优先级</span>
              <UiSelect value={options.dataPriority} aria-label="复现数据优先级" onChange={(v) => set('dataPriority', v)} options={[{ value: 'public_first', label: '公开数据 → 本地许可 → 透明模拟' }, { value: 'local_licensed', label: '优先使用我上传的数据' }, { value: 'simulated', label: '直接用透明模拟样例' }]} />
            </div>
            <div className="space-y-1 text-xs">
              <span className="text-muted-foreground">两页 PPT 模板</span>
              <UiSelect value={options.pptTemplate} aria-label="PPT 模板" onChange={(v) => set('pptTemplate', v)} options={[{ value: 'auto', label: '按论文类型自动选择' }, { value: 'planning', label: '规划 / 运行 / 优化' }, { value: 'forecasting', label: '预测 / 数据科学' }, { value: 'control', label: '控制 / 稳定性' }]} />
            </div>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">复现时限（分钟）</span>
              <input type="number" min={1} max={720} className="ui-input h-8 text-xs" value={options.reproductionTimeoutMinutes} onChange={(e) => set('reproductionTimeoutMinutes', Math.max(1, Number(e.target.value) || 30))} />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">随机种子</span>
              <input type="number" min={0} className="ui-input h-8 text-xs" value={options.seed} onChange={(e) => set('seed', Math.max(0, Number(e.target.value) || 0))} />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">模型用量上限（tokens）</span>
              <input type="number" min={10000} step={100000} className="ui-input h-8 text-xs" value={options.maxModelTokens} onChange={(e) => set('maxModelTokens', Math.max(10_000, Number(e.target.value) || 2_000_000))} />
            </label>
            <div className="space-y-1 text-xs">
              <span className="text-muted-foreground">评审深度</span>
              <UiSelect value={options.reportDepth} aria-label="评审深度" onChange={(v) => set('reportDepth', v)} options={[{ value: 'deep', label: '深度' }, { value: 'standard', label: '标准' }]} />
            </div>
          </div>
          <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs">
            {([
              ['reproduce', '执行原理级复现（推荐）：编写并真实运行复现脚本'],
              ['searchLatestLiterature', '最新文献对比（本系统暂无联网检索，只列出确信存在的工作）'],
              ['allowUntrustedCode', '允许运行上传的作者代码（不可信代码；本机只有受控子进程隔离，不是容器隔离）'],
              ['allowStormFallback', '首选模型不可用时允许回退到 Storm（不勾选则停下并提示）'],
              ['allowExternalModel', `允许把论文内容发送给配置的模型服务（当前：${modelLabel}）。未公开论文请先确认可以外发。`]
            ] as Array<[keyof NewTaskOptions, string]>).map(([key, label]) => (
              <label key={key} className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={Boolean(options[key])} onChange={(e) => set(key, e.target.checked as never)} />
                <span className={cn(key === 'allowExternalModel' && !options.allowExternalModel && 'font-medium text-foreground')}>{label}</span>
              </label>
            ))}
          </div>
        </section>

        {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
        <div className="flex justify-end">
          <button type="button" className="ui-btn-primary h-9 gap-1.5 px-4 text-sm" disabled={submitting || !files.length} onClick={() => void submit()}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            开始评审
          </button>
        </div>
      </div>
    </div>
  );
}
