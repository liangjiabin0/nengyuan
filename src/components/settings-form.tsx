'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  CheckCircle2,
  CloudLightning,
  Database,
  HardDrive,
  ImageIcon,
  Loader2,
  RefreshCw,
  Settings2,
  Volume2,
  Wifi,
  X,
  Zap
} from 'lucide-react';
import { useNotifyError } from '@/components/app-notify';
import { notify } from '@/lib/notify';
import { usePageContentReady } from '@/components/page-nav-loading';
import { PptVoiceSettingsPanel } from '@/components/ppt-voice-settings-panel';
import { SettingsDataPanel } from '@/components/settings-data-panel';
import { SubagentRouterPanel } from '@/components/subagent-router-panel';
import { PaperReviewModelSettings } from '@/components/paper-review-model-settings';
import { cn } from '@/lib/utils';
import { aliyunAnthropicBaseUrl, aliyunOpenAIBaseUrl } from '@/lib/openai-anthropic-compat';

type EndpointRole = 'small' | 'large' | 'storm' | 'image';
type LightStatus = 'green' | 'yellow' | 'red' | 'probing';
type SettingsTab = 'models' | 'data' | 'voice';
type SettingsArea = 'models' | 'system';

type EndpointForm = {
  baseUrl: string;
  model: string;
  apiKey: string;
  hasApiKey: boolean;
  clearApiKey: boolean;
  think: boolean;
  optimizePrompt: boolean;
  apiFormat: 'openai' | 'anthropic';
};

type SettingsState = {
  small: EndpointForm;
  large: EndpointForm;
  storm: EndpointForm;
  image: EndpointForm;
  opencode: {
    running: boolean;
    healthy: boolean;
    version: string;
    provider: string;
    model: string;
    error?: string;
  };
};

type RoleMeta = {
  role: EndpointRole;
  title: string;
  subtitle: string;
  badge?: string;
  icon: ReactNode;
  placeholderUrl: string;
  placeholderModel: string;
  showThink: boolean;
};

const TABS: Array<{ id: SettingsTab; label: string; icon: ReactNode }> = [
  { id: 'data', label: '数据资源', icon: <Database className="h-3.5 w-3.5" /> },
  { id: 'voice', label: 'PPT 配音', icon: <Volume2 className="h-3.5 w-3.5" /> }
];

const ROLE_META: RoleMeta[] = [
  {
    role: 'small',
    title: 'Arc',
    subtitle: '本地快速档，对话默认',
    badge: '对话默认',
    icon: <HardDrive className="h-4 w-4" />,
    placeholderUrl: 'http://10.1.4.166:8000/v1',
    placeholderModel: 'Arc',
    showThink: true
  },
  {
    role: 'large',
    title: 'Thunder',
    subtitle: '云端加强档',
    icon: <Zap className="h-4 w-4" />,
    placeholderUrl: 'https://proxy.ai-member.icu/v1',
    placeholderModel: 'gpt-5.6-sol',
    showThink: true
  },
  {
    role: 'storm',
    title: 'Storm',
    subtitle: '云端最强档',
    icon: <CloudLightning className="h-4 w-4" />,
    placeholderUrl: 'https://proxy.ai-member.icu/v1',
    placeholderModel: 'gpt-6-astra',
    showThink: true
  },
  {
    role: 'image',
    title: '图像生成',
    subtitle: '文生图 / 图编辑 · gpt-image-2',
    icon: <ImageIcon className="h-4 w-4" />,
    placeholderUrl: 'https://ai-api.ai-member.icu/v1',
    placeholderModel: 'gpt-image-2',
    showThink: false
  }
];

const emptyEndpoint = (): EndpointForm => ({
  baseUrl: '',
  model: '',
  apiKey: '',
  hasApiKey: false,
  clearApiKey: false,
  think: false,
  optimizePrompt: true,
  apiFormat: 'openai'
});

function parseEndpoint(data: Partial<EndpointForm> | undefined): EndpointForm {
  return {
    baseUrl: data?.baseUrl || '',
    model: data?.model || '',
    apiKey: '',
    hasApiKey: Boolean(data?.hasApiKey),
    clearApiKey: false,
    think: Boolean(data?.think),
    optimizePrompt: data?.optimizePrompt !== false,
    apiFormat: data?.apiFormat === 'anthropic' ? 'anthropic' : 'openai'
  };
}

function maskBaseUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return '未配置 Base URL';
  try {
    const parsed = new URL(trimmed);
    return `${parsed.host}${parsed.pathname.replace(/\/$/, '') || ''}`;
  } catch {
    return trimmed.length > 42 ? `${trimmed.slice(0, 42)}…` : trimmed;
  }
}

function parseTab(value: string | null): SettingsTab {
  if (value === 'voice') return 'voice';
  return 'data';
}

function StatusDot({ status }: { status: LightStatus }) {
  const color =
    status === 'green'
      ? 'bg-emerald-500'
      : status === 'red'
        ? 'bg-rose-500'
        : status === 'probing'
          ? 'bg-amber-400'
          : 'bg-amber-500';
  return (
    <span
      className="relative inline-flex h-2.5 w-2.5 shrink-0"
      title={
        status === 'green' ? '正常' : status === 'red' ? '异常' : status === 'probing' ? '探测中' : '待确认'
      }
    >
      <span
        className={`absolute inset-0 rounded-full ${color} ${
          status === 'green' ? 'animate-ping opacity-30' : status === 'probing' ? 'animate-pulse opacity-50' : 'opacity-0'
        }`}
      />
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${color}`} />
    </span>
  );
}

function ModalShell({
  title,
  description,
  onClose,
  children,
  footer
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="rag-evidence-modal-backdrop" onClick={onClose}>
      <div
        className="rag-evidence-modal max-w-xl"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-foreground">{title}</h3>
            {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[min(70vh,560px)] overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="border-t border-border px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

export function SettingsForm({ area = 'system' }: { area?: SettingsArea }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = area === 'models' ? 'models' : parseTab(searchParams.get('tab'));

  const [settings, setSettings] = useState<SettingsState>({
    small: emptyEndpoint(),
    large: emptyEndpoint(),
    storm: emptyEndpoint(),
    image: emptyEndpoint(),
    opencode: {
      running: false,
      healthy: false,
      version: '',
      provider: '',
      model: ''
    }
  });
  const [draft, setDraft] = useState<EndpointForm | null>(null);
  const [activeRole, setActiveRole] = useState<EndpointRole | null>(null);
  const [statusMap, setStatusMap] = useState<Record<EndpointRole, LightStatus>>({
    small: 'yellow',
    large: 'yellow',
    storm: 'yellow',
    image: 'yellow'
  });
  const [statusDetail, setStatusDetail] = useState<Record<EndpointRole, string>>({
    small: '',
    large: '',
    storm: '',
    image: ''
  });
  const [dirtyMap, setDirtyMap] = useState<Record<EndpointRole, boolean>>({
    small: false,
    large: false,
    storm: false,
    image: false
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [, setError] = useNotifyError();

  usePageContentReady(!loading || tab === 'data' || tab === 'voice');

  const setTab = useCallback(
    (next: SettingsTab) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === 'data') params.delete('tab');
      else params.set('tab', next);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  useEffect(() => {
    if (area === 'system' && searchParams.get('tab') === 'models') {
      router.replace('/models');
    }
  }, [area, router, searchParams]);

  const applyPublicSettings = useCallback((data: Partial<SettingsState> & Record<string, unknown>) => {
    setSettings((current) => {
      const incomingOpenCode = data.opencode as SettingsState['opencode'] | undefined;
      return {
        small: parseEndpoint((data.small as Partial<EndpointForm> | undefined) || current.small),
        large: parseEndpoint((data.large as Partial<EndpointForm> | undefined) || current.large),
        storm: parseEndpoint((data.storm as Partial<EndpointForm> | undefined) || current.storm),
        image: parseEndpoint((data.image as Partial<EndpointForm> | undefined) || current.image),
        opencode: incomingOpenCode
          ? {
              running: Boolean(incomingOpenCode.running),
              healthy: Boolean(incomingOpenCode.healthy),
              version: incomingOpenCode.version || '',
              provider: incomingOpenCode.provider || '',
              model: incomingOpenCode.model || '',
              error: incomingOpenCode.error
            }
          : current.opencode
      };
    });
  }, []);

  const probeAll = useCallback(async () => {
    setProbing(true);
    setStatusMap({ small: 'probing', large: 'probing', storm: 'probing', image: 'probing' });
    try {
      const response = await fetch('/api/settings/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const raw = await response.text();
      let data: { error?: string; results?: Record<string, { status?: LightStatus; message?: string }> } = {};
      try {
        data = raw ? JSON.parse(raw) as typeof data : {};
      } catch {
        throw new Error(
          response.ok
            ? `健康探测返回了非 JSON 响应：${raw.slice(0, 120)}`
            : `健康探测失败 HTTP ${response.status}${raw ? `: ${raw.slice(0, 120)}` : ''}`
        );
      }
      if (!response.ok) throw new Error(data.error || '健康探测失败');
      const results = data.results || {};
      setStatusMap({
        small: results.small?.status || 'yellow',
        large: results.large?.status || 'yellow',
        storm: results.storm?.status || 'yellow',
        image: results.image?.status || 'yellow'
      });
      setStatusDetail({
        small: results.small?.message || '',
        large: results.large?.message || '',
        storm: results.storm?.message || '',
        image: results.image?.message || ''
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : '探测失败';
      setStatusMap({ small: 'yellow', large: 'yellow', storm: 'yellow', image: 'yellow' });
      setStatusDetail({ small: text, large: text, storm: text, image: text });
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/settings');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '读取设置失败');
        if (cancelled) return;
        applyPublicSettings(data);
        setLoading(false);
        void probeAll();
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '读取设置失败');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyPublicSettings, probeAll]);

  function openConfig(role: EndpointRole) {
    setActiveRole(role);
    setDraft({ ...settings[role] });
  }

  function closeConfig() {
    setActiveRole(null);
    setDraft(null);
    setTesting(false);
  }

  async function saveAll(nextRules: Partial<Record<EndpointRole, EndpointForm>>) {
    setSaving(true);
    setError('');
    try {
      const payload: Record<string, unknown> = {};
      if (nextRules.small) payload.small = serializeEndpoint(nextRules.small);
      if (nextRules.large) payload.large = serializeEndpoint(nextRules.large);
      if (nextRules.storm) payload.storm = serializeEndpoint(nextRules.storm);
      if (nextRules.image) payload.image = serializeEndpoint(nextRules.image, 'image');
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000)
      });
      const raw = await response.text();
      let data: { error?: string } & Partial<SettingsState> = {};
      try {
        data = raw ? JSON.parse(raw) as typeof data : {};
      } catch {
        throw new Error(
          response.status === 500 && /Internal Server Error/i.test(raw)
            ? '保存超时或后台返回了非 JSON 响应。请刷新后重试。'
            : `保存失败 HTTP ${response.status}${raw ? `: ${raw.slice(0, 120)}` : ''}`
        );
      }
      if (!response.ok) throw new Error(data.error || '保存失败');
      applyPublicSettings(data);
      setDirtyMap((current) => ({
        small: nextRules.small ? false : current.small,
        large: nextRules.large ? false : current.large,
        storm: nextRules.storm ? false : current.storm,
        image: nextRules.image ? false : current.image
      }));
      return data as SettingsState;
    } catch (err) {
      const text = err instanceof Error
        ? (err.name === 'TimeoutError' || /aborted|timeout/i.test(err.name + err.message)
          ? '保存超时。配置写入不应超过数秒，请确认后台 API 是否在运行。'
          : err.message)
        : '保存失败';
      setError(text);
      throw err;
    } finally {
      setSaving(false);
    }
  }

  async function saveModal() {
    if (!activeRole || !draft) return;
    try {
      await saveAll({ [activeRole]: draft });
      setStatusMap((current) => ({ ...current, [activeRole]: 'yellow' }));
      setStatusDetail((current) => ({ ...current, [activeRole]: '配置已变更，请重新测试' }));
      setDirtyMap((current) => ({ ...current, [activeRole]: false }));
      notify.success('配置已保存');
      closeConfig();
      void probeAll();
    } catch {
      // saveAll 已发出失败通知
    }
  }

  async function testModal() {
    if (!activeRole || !draft) return;
    setTesting(true);
    setStatusMap((current) => ({ ...current, [activeRole]: 'probing' }));
    try {
      const response = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: activeRole,
          [activeRole]: serializeEndpoint(draft, activeRole)
        }),
        signal: AbortSignal.timeout(90_000)
      });
      const raw = await response.text();
      let data: { error?: string; message?: string; authenticated?: boolean } = {};
      try {
        data = raw ? JSON.parse(raw) as typeof data : {};
      } catch {
        const looksProxyTimeout = response.status === 500 && /Internal Server Error/i.test(raw);
        throw new Error(
          looksProxyTimeout
            ? '连通性测试超时：网页反代后台上限约 180 秒。请确认 Base URL、接口格式和模型名后重试。'
            : response.ok
              ? `连通性测试返回了非 JSON 响应：${raw.slice(0, 120)}`
              : `连通性测试失败 HTTP ${response.status}${raw ? `: ${raw.slice(0, 120)}` : ''}`
        );
      }
      if (!response.ok) throw new Error(data.error || '连通性测试失败');
      setDraft((current) =>
        current
          ? {
              ...current,
              hasApiKey: current.hasApiKey || Boolean(data.authenticated),
              clearApiKey: false
            }
          : current
      );
      setStatusMap((current) => ({ ...current, [activeRole]: 'green' }));
      setStatusDetail((current) => ({
        ...current,
        [activeRole]: data.message || '连接正常'
      }));
      notify.success(data.message || '连接正常');
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : '连通性测试失败';
      const text = err instanceof Error && (err.name === 'TimeoutError' || /aborted|timeout/i.test(err.name + err.message))
        ? '连通性测试超时。请确认 Base URL、接口格式和模型名；连通性测试不会开启思考。'
        : rawMessage;
      setStatusMap((current) => ({ ...current, [activeRole]: 'red' }));
      setStatusDetail((current) => ({ ...current, [activeRole]: text }));
      notify.error(text);
    } finally {
      setTesting(false);
    }
  }

  if (loading && tab === 'models') {
    return (
      <div className="rag-shell flex h-full min-h-0 flex-1 items-center justify-center p-3 md:p-4">
        <div className="flex items-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          正在读取设置…
        </div>
      </div>
    );
  }

  const activeMeta = ROLE_META.find((item) => item.role === activeRole) || null;

  return (
    <div className="rag-shell relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4">
      <div className="mb-3 shrink-0 md:mb-4">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          Dashboard / {area === 'models' ? 'Models' : 'Settings'}
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">
          {area === 'models' ? '模型配置' : '系统设置'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {area === 'models'
            ? '配置 Arc / Thunder / Storm 端点，以及什么情况下使用哪一档。'
            : '管理数据来源、PPT 配音和其他系统运行配置。'}
        </p>
      </div>

      <div className="rag-chat-card min-h-0 flex-1 flex-col">
        {area === 'system' ? (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <div className="inline-flex rounded-lg bg-muted p-1">
            {TABS.map((item) => {
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition',
                    active
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {item.icon}
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
        ) : (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <div
                className={cn(
                  'flex max-w-[12rem] items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]',
                  settings.opencode.healthy
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-amber-200 bg-amber-50 text-amber-800'
                )}
                title={settings.opencode.error || undefined}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    settings.opencode.healthy ? 'bg-emerald-500' : 'bg-amber-500'
                  )}
                />
                <span className="truncate">能元 {settings.opencode.healthy ? '正常' : '未连接'}</span>
              </div>
              <button
                type="button"
                onClick={() => void probeAll()}
                disabled={probing || testing || saving}
                className="ui-btn-secondary h-8 gap-1.5 px-2.5"
              >
                {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                刷新
              </button>
            </div>
        </div>
        )}

        {tab === 'models' ? (
          <>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2">
              <div className="space-y-0.5">
                {ROLE_META.map((meta) => {
                  const endpoint = settings[meta.role];
                  const status =
                    dirtyMap[meta.role] && statusMap[meta.role] === 'green'
                      ? 'yellow'
                      : statusMap[meta.role];
                  return (
                    <button
                      key={meta.role}
                      type="button"
                      onClick={() => openConfig(meta.role)}
                      className="rag-conv-item w-full"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-background text-foreground shadow-sm ring-1 ring-border/60">
                        {meta.icon}
                      </div>
                      <div className="min-w-0 flex-1 text-left">
                        <div className="flex items-center gap-2">
                          <StatusDot status={status} />
                          <span className="truncate text-sm font-medium text-foreground">{meta.title}</span>
                          {meta.badge ? (
                            <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                              {meta.badge}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {endpoint.model || '未配置模型'} · {maskBaseUrl(endpoint.baseUrl)}
                          {meta.role !== 'image' ? ` · ${endpoint.apiFormat === 'anthropic' ? 'Anthropic' : 'OpenAI'}` : ''}
                        </div>
                        {statusDetail[meta.role] ? (
                          <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
                            {statusDetail[meta.role]}
                          </div>
                        ) : null}
                      </div>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground">
                        <Settings2 className="h-3.5 w-3.5" />
                        配置
                      </span>
                    </button>
                  );
                })}
                <PaperReviewModelSettings />
              </div>
              <div className="mt-3 border-t border-border">
                <SubagentRouterPanel />
              </div>
            </div>
          </>
        ) : tab === 'voice' ? (
          <PptVoiceSettingsPanel />
        ) : (
          <SettingsDataPanel />
        )}
      </div>

      {activeMeta && draft ? (
        <ModalShell
          title={`配置${activeMeta.title}`}
          description={activeMeta.subtitle}
          onClose={closeConfig}
          footer={(
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button type="button" className="ui-btn-secondary h-9" onClick={closeConfig} disabled={saving || testing}>
                取消
              </button>
              <button
                type="button"
                className="ui-btn-secondary h-9 gap-1.5"
                onClick={() => void testModal()}
                disabled={saving || testing}
              >
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
                测试连接
              </button>
              <button
                type="button"
                className="ui-btn-primary h-9 gap-1.5"
                onClick={() => void saveModal()}
                disabled={saving || testing}
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                保存
              </button>
            </div>
          )}
        >
          <div className="space-y-3">
            {activeMeta.role !== 'image' ? (
              <div className="space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground">接口格式</span>
                <div className="flex rounded-lg border border-border bg-muted/40 p-0.5">
                  {([
                    { id: 'openai' as const, label: 'OpenAI' },
                    { id: 'anthropic' as const, label: 'Anthropic' }
                  ]).map((option) => {
                    const active = draft.apiFormat === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={cn(
                          'h-8 flex-1 rounded-md text-xs font-medium transition',
                          active
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                        aria-pressed={active}
                        onClick={() => {
                          const nextFormat = option.id;
                          const nextUrl = nextFormat === 'anthropic'
                            ? (aliyunAnthropicBaseUrl(draft.baseUrl) || draft.baseUrl)
                            : (aliyunOpenAIBaseUrl(draft.baseUrl) || draft.baseUrl);
                          setDraft({ ...draft, apiFormat: nextFormat, baseUrl: nextUrl });
                          setDirtyMap((current) => ({ ...current, [activeMeta.role]: true }));
                        }}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] leading-5 text-muted-foreground">
                  {draft.apiFormat === 'anthropic'
                    ? 'Anthropic 格式请求 /v1/messages。阿里云百炼请填业务空间的 /apps/anthropic（不要用 /compatible-mode/v1）。'
                    : 'OpenAI 格式请求 /v1/chat/completions。只填 https://主机名 时会自动补 /v1。兼容官方 OpenAI、vLLM、阿里云 /compatible-mode/v1。'}
                </p>
              </div>
            ) : null}

            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">Base URL</span>
              <input
                value={draft.baseUrl}
                onChange={(event) => {
                  setDraft({ ...draft, baseUrl: event.target.value });
                  setDirtyMap((current) => ({ ...current, [activeMeta.role]: true }));
                }}
                className="ui-input h-9 bg-muted/40"
                placeholder={
                  draft.apiFormat === 'anthropic' && activeMeta.role !== 'image'
                    ? 'https://api.anthropic.com/v1'
                    : activeMeta.placeholderUrl
                }
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">模型名称</span>
              <input
                value={draft.model}
                onChange={(event) => {
                  setDraft({ ...draft, model: event.target.value });
                  setDirtyMap((current) => ({ ...current, [activeMeta.role]: true }));
                }}
                className="ui-input h-9 bg-muted/40"
                placeholder={
                  draft.apiFormat === 'anthropic' && activeMeta.role !== 'image'
                    ? 'claude-sonnet-4-5'
                    : activeMeta.placeholderModel
                }
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">API Key</span>
              <input
                type="password"
                value={draft.apiKey}
                disabled={draft.clearApiKey}
                onChange={(event) => {
                  setDraft({ ...draft, apiKey: event.target.value, clearApiKey: false });
                  setDirtyMap((current) => ({ ...current, [activeMeta.role]: true }));
                }}
                className="ui-input h-9 bg-muted/40"
                placeholder={
                  draft.hasApiKey
                    ? '已配置，留空则保持不变'
                    : activeMeta.role === 'small'
                      ? '可选'
                      : '通常需要 API Key'
                }
              />
              {draft.hasApiKey ? (
                <label className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={draft.clearApiKey}
                    onChange={(event) => {
                      setDraft({
                        ...draft,
                        clearApiKey: event.target.checked,
                        apiKey: event.target.checked ? '' : draft.apiKey
                      });
                      setDirtyMap((current) => ({ ...current, [activeMeta.role]: true }));
                    }}
                  />
                  清除已保存的 API Key
                </label>
              ) : null}
            </label>

            {activeMeta.showThink ? (
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={draft.think}
                  onChange={(event) => {
                    setDraft({ ...draft, think: event.target.checked });
                    setDirtyMap((current) => ({ ...current, [activeMeta.role]: true }));
                  }}
                />
                直连调用默认开启思考；智能对话在 Arc / Thunder / Storm 上分别调节思考额度
              </label>
            ) : null}
            {activeMeta.role === 'image' ? (
              <>
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={draft.optimizePrompt}
                    onChange={(event) => {
                      setDraft({ ...draft, optimizePrompt: event.target.checked });
                      setDirtyMap((current) => ({ ...current, [activeMeta.role]: true }));
                    }}
                  />
                  开启提示词优化（用 Arc 按 Prompt Optimizer 文生图流程改写；关闭则按原文出图）
                </label>
                <p className="text-xs leading-5 text-amber-700">
                  测试连接只请求 GET /models，确认 Key 能列出当前图像模型，不会真正出图。
                  出图支持尺寸 auto、1024×1024、1024×1536、1536×1024，质量 1K / 2K / 4K。
                  Base URL、模型和 Key 只保存在 storage/settings.json，不读环境变量。
                </p>
              </>
            ) : null}
          </div>
        </ModalShell>
      ) : null}
    </div>
  );
}

function serializeEndpoint(endpoint: EndpointForm, role?: EndpointRole) {
  return {
    baseUrl: endpoint.baseUrl,
    model: endpoint.model,
    apiKey: endpoint.apiKey,
    clearApiKey: endpoint.clearApiKey,
    think: endpoint.think,
    apiFormat: role === 'image' ? 'openai' : endpoint.apiFormat,
    ...(role === 'image' ? { optimizePrompt: endpoint.optimizePrompt !== false } : {})
  };
}
