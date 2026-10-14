'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, FileSearch, Loader2, Settings2, Wifi, X } from 'lucide-react';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';

type Thinking = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

type PublicConfig = {
  baseUrl: string;
  hasApiKey: boolean;
  model: string;
  thinking: Thinking;
  allowStormFallback: boolean;
  proxyUrl: string;
};

type Probe = {
  ok: boolean;
  listed: boolean;
  responded: boolean;
  actualModel?: string;
  availableModels: string[];
  reason?: string;
  checkedAt: string;
};

const THINKING_LABELS: Record<Thinking, string> = {
  none: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高'
};

function maskBaseUrl(url: string) {
  if (!url) return '未配置接口地址';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 模型配置页里的“论文智能评审”一栏：独立的接口地址、Key、模型和思考档位。 */
export function PaperReviewModelSettings() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ baseUrl: '', apiKey: '', model: '', thinking: 'high' as Thinking, allowStormFallback: false, proxyUrl: '' });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async (withProbe = false) => {
    const response = await fetch(`/api/paper-review/model${withProbe ? '?probe=1' : ''}`, { cache: 'no-store' });
    const data = (await response.json().catch(() => ({}))) as { config?: PublicConfig; probe?: Probe | null; error?: string };
    if (!response.ok || !data.config) throw new Error(data.error || '读取论文智能评审模型配置失败');
    setConfig(data.config);
    if (withProbe) setProbe(data.probe || null);
    return data;
  }, []);

  useEffect(() => {
    void load(true).catch(() => undefined);
  }, [load]);

  function openModal() {
    if (!config) return;
    setDraft({ baseUrl: config.baseUrl, apiKey: '', model: config.model, thinking: config.thinking, allowStormFallback: config.allowStormFallback, proxyUrl: config.proxyUrl || '' });
    setOpen(true);
  }

  async function save(): Promise<boolean> {
    setSaving(true);
    try {
      const response = await fetch('/api/paper-review/model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl: draft.baseUrl,
          model: draft.model,
          thinking: draft.thinking,
          allowStormFallback: draft.allowStormFallback,
          proxyUrl: draft.proxyUrl,
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {})
        })
      });
      const data = (await response.json().catch(() => ({}))) as { config?: PublicConfig; error?: string };
      if (!response.ok || !data.config) throw new Error(data.error || '保存失败');
      setConfig(data.config);
      setDraft((current) => ({ ...current, apiKey: '' }));
      return true;
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '保存失败');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    try {
      if (!(await save())) return;
      const data = await load(true);
      if (data.probe?.ok) notify.success(`连接正常：${data.probe.actualModel || draft.model}`);
      else notify.error(data.probe?.reason || '连接失败');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '测试失败');
    } finally {
      setTesting(false);
    }
  }

  const status = !probe ? 'bg-amber-400' : probe.ok ? 'bg-emerald-500' : 'bg-rose-500';

  return (
    <>
      <button type="button" onClick={openModal} className="rag-conv-item w-full" disabled={!config}>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-background text-foreground shadow-sm ring-1 ring-border/60">
          <FileSearch className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className={cn('inline-flex h-2.5 w-2.5 shrink-0 rounded-full', status)} title={probe?.ok ? '正常' : probe ? '异常' : '探测中'} />
            <span className="truncate text-sm font-medium text-foreground">论文智能评审</span>
            <span className="rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">专用</span>
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {config ? `${config.model || '未配置模型'} · 思考${THINKING_LABELS[config.thinking]} · ${maskBaseUrl(config.baseUrl)}${config.hasApiKey ? '' : ' · 未配置 Key'}` : '加载中…'}
          </div>
          {probe && !probe.ok && probe.reason ? (
            <div className="mt-0.5 truncate text-[11px] text-rose-600" title={probe.reason}>{probe.reason}</div>
          ) : null}
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground">
          <Settings2 className="h-3.5 w-3.5" />
          配置
        </span>
      </button>

      {open ? (
        <div className="rag-evidence-modal-backdrop" onClick={() => setOpen(false)}>
          <div className="rag-evidence-modal max-w-xl" role="dialog" aria-modal="true" aria-label="配置论文智能评审模型" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-foreground">配置论文智能评审模型</h3>
                <p className="mt-1 text-sm text-muted-foreground">只用于“论文智能评审”，不影响 Arc / Thunder / Storm 和其它功能。</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground" aria-label="关闭">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[min(70vh,560px)] space-y-3 overflow-y-auto px-5 py-4">
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground">接口地址（Base URL）</span>
                <input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} className="ui-input h-9 bg-muted/40" placeholder="https://proxy.example.com" />
                <p className="text-[11px] leading-5 text-muted-foreground">OpenAI 兼容格式；只填主机地址即可，会自动补 /v1。</p>
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground">API Key</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={draft.apiKey}
                  onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                  className="ui-input h-9 bg-muted/40"
                  placeholder={config?.hasApiKey ? '已保存，留空表示不修改' : '请输入 API Key'}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground">模型名称</span>
                <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} className="ui-input h-9 bg-muted/40" placeholder="gpt-6.1-sol" list="paper-review-models" />
                {probe?.availableModels?.length ? (
                  <datalist id="paper-review-models">
                    {probe.availableModels.map((id) => <option key={id} value={id} />)}
                  </datalist>
                ) : null}
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground">代理地址（可选）</span>
                <input value={draft.proxyUrl} onChange={(e) => setDraft({ ...draft, proxyUrl: e.target.value })} className="ui-input h-9 bg-muted/40" placeholder="http://127.0.0.1:7897" />
                <p className="text-[11px] leading-5 text-muted-foreground">服务商限制地区访问时填写；只用于论文智能评审的模型请求，留空则直连。</p>
              </label>
              <div className="space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground">思考强度</span>
                <div className="flex rounded-lg border border-border bg-muted/40 p-0.5">
                  {(Object.keys(THINKING_LABELS) as Thinking[]).map((level) => (
                    <button
                      key={level}
                      type="button"
                      aria-pressed={draft.thinking === level}
                      onClick={() => setDraft({ ...draft, thinking: level })}
                      className={cn('h-8 flex-1 rounded-md text-xs font-medium transition', draft.thinking === level ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                    >
                      {THINKING_LABELS[level]}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-start gap-2 text-xs text-foreground">
                <input type="checkbox" className="mt-0.5" checked={draft.allowStormFallback} onChange={(e) => setDraft({ ...draft, allowStormFallback: e.target.checked })} />
                <span>首选模型不可用时，允许回退到系统 Storm 档（高思考）。不勾选时任务会停下并提示原因，不会自动换模型。</span>
              </label>
              {probe ? (
                <div className={cn('rounded-md border px-3 py-2 text-[11px] leading-5', probe.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800')}>
                  {probe.ok
                    ? `上次探测正常：实际模型 ${probe.actualModel || '未知'}${probe.listed ? '' : '（不在上游模型列表中）'}`
                    : `上次探测失败：${probe.reason || '未知原因'}`}
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
              <button type="button" className="ui-btn-secondary h-9" onClick={() => setOpen(false)} disabled={saving || testing}>取消</button>
              <button type="button" className="ui-btn-secondary h-9 gap-1.5" onClick={() => void test()} disabled={saving || testing}>
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
                保存并测试
              </button>
              <button
                type="button"
                className="ui-btn-primary h-9 gap-1.5"
                onClick={() => void save().then((ok) => { if (ok) { setOpen(false); notify.success('已保存'); } })}
                disabled={saving || testing}
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
