'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import {
  CHAT_MODEL_IDS,
  CHAT_MODEL_META,
  type ChatModelId
} from '@/lib/model-ids';
import {
  DEFAULT_ROUTER_TIERS,
  DEFAULT_SUBAGENT_ROUTER_CONFIG,
  newTierId,
  normalizeSubagentRouterConfig,
  type RouterTier,
  type SubagentRouterConfig
} from '@/lib/subagent-router';

const THINKING_OPTIONS: Array<{ id: string; label: string }> = [
  { id: '', label: '跟随默认' },
  { id: 'off', label: '关' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '超高' }
];

function emptyTier(index: number): RouterTier {
  return {
    id: newTierId(),
    enabled: true,
    title: `档位 ${index}`,
    when: '',
    model: 'thunder',
    thinking: ''
  };
}

export function SubagentRouterPanel() {
  const [config, setConfig] = useState<SubagentRouterConfig>(DEFAULT_SUBAGENT_ROUTER_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/system/subagent-router');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '读取子代理路由失败');
      setConfig(normalizeSubagentRouterConfig(data.router || data));
      setDirty(false);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '读取子代理路由失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function patch(next: SubagentRouterConfig) {
    setConfig(next);
    setDirty(true);
  }

  function patchTier(index: number, changes: Partial<RouterTier>) {
    patch({
      ...config,
      tiers: config.tiers.map((item, itemIndex) => (
        itemIndex === index ? { ...item, ...changes } : item
      ))
    });
  }

  async function save() {
    setSaving(true);
    try {
      const response = await fetch('/api/system/subagent-router', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ router: config })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存子代理路由失败');
      setConfig(normalizeSubagentRouterConfig(data.router || data));
      setDirty(false);
      notify.success('子代理路由已保存');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '保存子代理路由失败');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center px-3 py-6 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在读取子代理路由…
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-sm font-semibold text-foreground">子代理路由</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            子代理的模型和思考档由本地 Arc 短调用按下面的判据决定。判的是任务性质，不是有没有出现某个词。
            用户在当前问题里明确指定子代理模型时，按用户的指定执行。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="ui-btn-secondary h-8 gap-1.5 px-3 text-xs"
            onClick={() => patch({ ...config, tiers: DEFAULT_ROUTER_TIERS.map((item) => ({ ...item })) })}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            恢复默认档位
          </button>
          <button
            type="button"
            className="ui-btn-primary h-8 gap-1.5 px-3 text-xs"
            onClick={() => void save()}
            disabled={saving || !dirty}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            保存
          </button>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(event) => patch({ ...config, enabled: event.target.checked })}
          />
          启用智能路由
        </label>
        <label className="block space-y-1 rounded-lg border border-border bg-background px-3 py-2">
          <span className="text-[11px] text-muted-foreground">兜底模型</span>
          <select
            className="ui-input h-8 bg-muted/40"
            value={config.defaultModel}
            onChange={(event) => patch({ ...config, defaultModel: event.target.value as ChatModelId })}
          >
            {CHAT_MODEL_IDS.map((id) => (
              <option key={id} value={id}>{CHAT_MODEL_META[id].label}</option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 rounded-lg border border-border bg-background px-3 py-2">
          <span className="text-[11px] text-muted-foreground">兜底思考档</span>
          <select
            className="ui-input h-8 bg-muted/40"
            value={config.defaultThinking}
            onChange={(event) => patch({ ...config, defaultThinking: event.target.value })}
          >
            {THINKING_OPTIONS.filter((item) => item.id).map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 rounded-lg border border-border bg-background px-3 py-2">
          <span className="text-[11px] text-muted-foreground">路由等待上限（毫秒）</span>
          <input
            type="number"
            min={1500}
            max={30000}
            step={500}
            className="ui-input h-8 bg-muted/40"
            value={config.routerTimeoutMs}
            onChange={(event) => patch({ ...config, routerTimeoutMs: Number(event.target.value) })}
          />
        </label>
      </div>

      <p className="text-[11px] leading-5 text-muted-foreground">
        关闭智能路由，或路由超时、网关不通时，子代理一律走上面的兜底档。
      </p>

      <div className="space-y-2">
        {config.tiers.map((tier, index) => (
          <div key={tier.id} className="rounded-xl border border-border bg-background p-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={tier.enabled}
                  onChange={(event) => patchTier(index, { enabled: event.target.checked })}
                />
                启用
              </label>
              <input
                className="ui-input h-8 min-w-[8rem] flex-1 bg-muted/40"
                value={tier.title}
                onChange={(event) => patchTier(index, { title: event.target.value })}
                placeholder="档位名称"
              />
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => patch({
                  ...config,
                  tiers: tier.builtin
                    ? config.tiers.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: false } : item)
                    : config.tiers.filter((_, itemIndex) => itemIndex !== index)
                })}
                aria-label="删除档位"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <label className="mt-2 block space-y-1">
              <span className="text-[11px] text-muted-foreground">什么样的子任务算这一档（写给路由模型看，越像判据越准）</span>
              <textarea
                className="ui-input min-h-[5rem] bg-muted/40 py-2"
                value={tier.when}
                onChange={(event) => patchTier(index, { when: event.target.value })}
                placeholder="例如：指令明确、路径唯一的执行型子任务，不需要子代理自己拆解步骤"
              />
            </label>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-[11px] text-muted-foreground">模型</span>
                <select
                  className="ui-input h-8 bg-muted/40"
                  value={tier.model}
                  onChange={(event) => patchTier(index, { model: event.target.value as ChatModelId })}
                >
                  {CHAT_MODEL_IDS.map((id) => (
                    <option key={id} value={id}>{CHAT_MODEL_META[id].label}</option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] text-muted-foreground">思考档</span>
                <select
                  className="ui-input h-8 bg-muted/40"
                  value={tier.thinking}
                  onChange={(event) => patchTier(index, { thinking: event.target.value })}
                >
                  {THINKING_OPTIONS.map((item) => (
                    <option key={item.id || 'default'} value={item.id}>{item.label}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        className={cn('ui-btn-secondary h-8 gap-1.5 px-3 text-xs')}
        onClick={() => patch({ ...config, tiers: [...config.tiers, emptyTier(config.tiers.length + 1)] })}
      >
        <Plus className="h-3.5 w-3.5" />
        添加档位
      </button>
    </div>
  );
}
