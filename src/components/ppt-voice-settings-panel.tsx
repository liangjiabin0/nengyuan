'use client';
// 【合并版】本文件取自 codex 版（比 claude 版新：健康检查含 LibreOffice/ffmpeg/嵌入引擎与 Linux 说明）

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { useNotifyError, useNotifySuccess } from '@/components/app-notify';
import { UiSelect } from '@/components/ui-select';
import { PPT_VOICE_MODELS, PPT_VOICE_PRESETS } from '@/lib/ppt-voice/constants';

const PPT_MODEL_OPTIONS = PPT_VOICE_MODELS.map((item) => ({ value: item.id, label: item.label }));
const PPT_VOICE_OPTIONS = PPT_VOICE_PRESETS.map((item) => ({ value: item.id, label: item.label }));

type TtsForm = {
  dashscopeApiKey: string;
  workspaceId: string;
  baseUrl: string;
  model: string;
  voiceId: string;
  instruction: string;
  rate: number;
  pitch: number;
  volume: number;
  hasApiKey: boolean;
  clearApiKey: boolean;
};

type Health = {
  ok?: boolean;
  python?: string;
  package?: boolean;
  pptx?: boolean;
  powerpoint?: boolean;
  libreoffice?: boolean;
  ffmpeg?: boolean;
  embedEngine?: string;
  hasApiKey?: boolean;
  error?: string;
};

const emptyForm = (): TtsForm => ({
  dashscopeApiKey: '',
  workspaceId: 'ws-emec9enjn73ykbe4',
  baseUrl: 'https://ws-emec9enjn73ykbe4.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  model: 'cosyvoice-v3-flash',
  voiceId: 'longshuo_v3',
  instruction: '正式自然的技术汇报语气，语速稍慢，停顿清晰，避免新闻播音腔。',
  rate: 0.92,
  pitch: 0.96,
  volume: 58,
  hasApiKey: false,
  clearApiKey: false
});

export function PptVoiceSettingsPanel() {
  const [form, setForm] = useState<TtsForm>(emptyForm);
  const [health, setHealth] = useState<Health>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [, setError] = useNotifyError();
  const [, setMessage] = useNotifySuccess();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/ppt-voice/settings')
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '读取配音设置失败。');
        if (cancelled) return;
        setForm({
          dashscopeApiKey: '',
          workspaceId: data.workspaceId || 'ws-emec9enjn73ykbe4',
          baseUrl: data.baseUrl || 'https://ws-emec9enjn73ykbe4.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          model: data.model || 'cosyvoice-v3-flash',
          voiceId: data.voiceId || 'longshuo_v3',
          instruction: data.instruction || '',
          rate: data.rate ?? 0.92,
          pitch: data.pitch ?? 0.96,
          volume: data.volume ?? 58,
          hasApiKey: Boolean(data.hasApiKey),
          clearApiKey: false
        });
        setHealth(data.health || {});
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '读取失败。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/ppt-voice/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dashscopeApiKey: form.dashscopeApiKey,
          workspaceId: form.workspaceId,
          baseUrl: form.baseUrl,
          model: form.model,
          voiceId: form.voiceId,
          instruction: form.instruction,
          rate: form.rate,
          pitch: form.pitch,
          volume: form.volume,
          clearApiKey: form.clearApiKey
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存失败。');
      setForm((current) => ({
        ...current,
        dashscopeApiKey: '',
        hasApiKey: Boolean(data.hasApiKey),
        clearApiKey: false
      }));
      setHealth(data.health || {});
      setMessage('配音设置已保存。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在读取配音设置…
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <div>
          <h2 className="text-base font-semibold">PPT 配音 / 百炼 CosyVoice</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            备注撰写走系统大模型；语音合成走阿里云百炼北京地域 CosyVoice。Windows 可用桌面版 PowerPoint 嵌入成品；Linux 使用 LibreOffice 渲染预览、OOXML 嵌入音频，导出视频需要 ffmpeg。
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          {[
            ['Python', health.python || '未检测'],
            ['配音包', health.package ? '已就绪' : '未安装'],
            ['PPTX 解析', health.pptx ? '可用' : '不可用'],
            ['嵌入引擎', health.powerpoint ? 'PowerPoint' : health.embedEngine === 'ooxml' ? 'OOXML' : '未检测到'],
            ['LibreOffice', health.libreoffice ? '已安装' : '未检测到'],
            ['ffmpeg', health.ffmpeg ? '已安装' : '未检测到']
          ].map(([label, value]) => (
            <div key={label} className="rounded-md border border-border bg-muted/40 px-3 py-2">
              <div className="text-muted-foreground">{label}</div>
              <div className="mt-0.5 font-medium">{value}</div>
            </div>
          ))}
        </div>
        {health.error ? <div className="text-xs text-destructive">{health.error}</div> : null}

        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-muted-foreground">DASHSCOPE_API_KEY</span>
          <input
            type="password"
            value={form.dashscopeApiKey}
            disabled={form.clearApiKey}
            onChange={(event) => setForm({ ...form, dashscopeApiKey: event.target.value, clearApiKey: false })}
            className="ui-input h-9 bg-muted/40"
            placeholder={form.hasApiKey ? '已配置，留空则保持不变' : '百炼 API Key'}
          />
          {form.hasApiKey ? (
            <label className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={form.clearApiKey}
                onChange={(event) => setForm({ ...form, clearApiKey: event.target.checked, dashscopeApiKey: '' })}
              />
              清除已保存的 Key
            </label>
          ) : null}
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-muted-foreground">业务空间 ID</span>
          <input
            value={form.workspaceId}
            onChange={(event) => setForm({ ...form, workspaceId: event.target.value })}
            className="ui-input h-9 bg-muted/40"
            placeholder="ws-xxxxxxxx"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-muted-foreground">Base URL</span>
          <input
            value={form.baseUrl}
            onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
            className="ui-input h-9 bg-muted/40"
            placeholder="https://ws-xxxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">合成模型</span>
            <UiSelect
              size="md"
              value={form.model}
              options={PPT_MODEL_OPTIONS}
              onChange={(model) => setForm({ ...form, model })}
              aria-label="合成模型"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">默认音色</span>
            <UiSelect
              size="md"
              value={form.voiceId}
              options={PPT_VOICE_OPTIONS}
              onChange={(voiceId) => setForm({ ...form, voiceId })}
              aria-label="默认音色"
            />
          </label>
        </div>

        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-muted-foreground">默认语气指令（系统音色会自动忽略）</span>
          <textarea
            value={form.instruction}
            onChange={(event) => setForm({ ...form, instruction: event.target.value })}
            rows={3}
            className="w-full rounded-md border border-border bg-muted/40 p-2 text-sm"
          />
        </label>

        <div className="grid grid-cols-3 gap-3">
          {[
            ['语速', 'rate', 0.5, 2, 0.01],
            ['音调', 'pitch', 0.5, 2, 0.01],
            ['音量', 'volume', 0, 100, 1]
          ].map(([label, key, min, max, step]) => (
            <label key={String(key)} className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
              <input
                type="number"
                min={Number(min)}
                max={Number(max)}
                step={Number(step)}
                value={form[key as 'rate' | 'pitch' | 'volume']}
                onChange={(event) => setForm({ ...form, [key]: Number(event.target.value) })}
                className="ui-input h-9 bg-muted/40"
              />
            </label>
          ))}
        </div>

        <button type="button" className="ui-btn-primary h-9 gap-1.5 px-4 text-sm" disabled={saving} onClick={() => void save()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          保存配音设置
        </button>
      </div>
    </div>
  );
}
