import fs from 'node:fs';
import path from 'node:path';
import { getBundleDatabasePath } from './bundle-store';
import {
  LOCAL_SMALL_CONTEXT_TOKENS,
  LOCAL_SMALL_DEFAULT_BASE_URL,
  LOCAL_SMALL_DEFAULT_MODEL,
  LOCAL_SMALL_OUTPUT_TOKENS,
  getLocalSmallChatExtras
} from './local-llm-extras';
import {
  OPENCODE_IMAGE_MODEL_ALIAS,
  OPENCODE_LARGE_LEGACY_ALIAS,
  OPENCODE_LARGE_MODEL_ALIAS,
  OPENCODE_PROVIDER_ID,
  OPENCODE_SMALL_LEGACY_ALIAS,
  OPENCODE_SMALL_LOW_MODEL_ALIAS,
  OPENCODE_SMALL_MEDIUM_MODEL_ALIAS,
  OPENCODE_SMALL_MODEL_ALIAS,
  OPENCODE_SMALL_XHIGH_MODEL_ALIAS,
  OPENCODE_STORM_MODEL_ALIAS,
  resolveOpenCodeModelRef,
  type EndpointRole
} from './model-ids';
import { parseApiFormat, type ApiFormat } from './openai-anthropic-compat';
import { syncOpenCodeSubagentRouter } from './subagent-router-store';

export { parseApiFormat, type ApiFormat };
export type { EndpointRole };

/** 单个模型端点（Arc / Thunder / Storm / 图像共用结构） */
export type ModelEndpointSettings = {
  baseUrl: string;
  model: string;
  apiKey: string;
  think: boolean;
  /**
   * 上游对话协议。openai：/v1/chat/completions；anthropic：/v1/messages。
   * 图像端点固定 openai。
   */
  apiFormat?: ApiFormat;
  /**
   * 是否按 Arc 规则构造思考参数（enable_thinking / xhigh）。
   * Thunder / Storm 走云端 reasoning_effort。
   */
  reasoningEffortNone?: boolean;
  /** 仅图像端点：出图前是否用对话模型优化提示词，默认 true */
  optimizePrompt?: boolean;
};

export type ModelRole = EndpointRole;

/**
 * 对话与直连 LLM 默认使用的模型配置（= 小模型）。
 * 保留扁平字段以兼容既有调用方。
 */
export type ModelSettings = ModelEndpointSettings & {
  dataRootDir?: string;
};

export type DualModelSettings = {
  small: ModelEndpointSettings;
  large: ModelEndpointSettings;
  storm: ModelEndpointSettings;
  image: ModelEndpointSettings;
  dataRootDir?: string;
};

type StoredSettings = Partial<ModelEndpointSettings> & {
  small?: Partial<ModelEndpointSettings>;
  large?: Partial<ModelEndpointSettings>;
  storm?: Partial<ModelEndpointSettings>;
  arc?: Partial<ModelEndpointSettings>;
  thunder?: Partial<ModelEndpointSettings>;
  image?: Partial<ModelEndpointSettings>;
  dataRootDir?: string;
};

type EndpointPatch = Partial<ModelEndpointSettings> & { clearApiKey?: boolean };

export type DualModelSettingsInput = {
  small?: EndpointPatch;
  large?: EndpointPatch;
  storm?: EndpointPatch;
  image?: EndpointPatch;
  dataRootDir?: string;
  /** 兼容旧单模型写入：映射到小模型 */
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  think?: boolean;
  clearApiKey?: boolean;
};

const settingsPath = path.join(process.cwd(), 'storage', 'settings.json');

const DEFAULT_SMALL: ModelEndpointSettings = {
  baseUrl: LOCAL_SMALL_DEFAULT_BASE_URL,
  model: LOCAL_SMALL_DEFAULT_MODEL,
  apiKey: '',
  think: false,
  apiFormat: 'openai'
};

const DEFAULT_LARGE: ModelEndpointSettings = {
  baseUrl: 'https://proxy.ai-member.icu/v1',
  model: 'gpt-6-sol',
  apiKey: '',
  think: false,
  apiFormat: 'openai'
};

const DEFAULT_STORM: ModelEndpointSettings = {
  baseUrl: 'https://proxy.ai-member.icu/v1',
  model: 'gpt-6-astra',
  apiKey: '',
  think: false,
  apiFormat: 'openai'
};

const DEFAULT_IMAGE: ModelEndpointSettings = {
  baseUrl: 'https://ai-api.ai-member.icu/v1',
  model: 'gpt-image-2',
  apiKey: '',
  think: false,
  optimizePrompt: true
};

function readStoredSettings(): StoredSettings {
  try {
    if (!fs.existsSync(settingsPath)) return {};
    const raw = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw) as StoredSettings;
  } catch {
    return {};
  }
}

function resolveEndpoint(
  stored: Partial<ModelEndpointSettings> | undefined,
  defaults: ModelEndpointSettings,
  env: { baseUrl?: string; model?: string; apiKey?: string; think?: string; apiFormat?: string },
  role: EndpointRole
): ModelEndpointSettings {
  return {
    baseUrl: stored?.baseUrl || env.baseUrl || defaults.baseUrl,
    model: stored?.model || env.model || defaults.model,
    apiKey: stored?.apiKey ?? env.apiKey ?? defaults.apiKey,
    think: stored?.think === true || (stored?.think === undefined && env.think === '1'),
    apiFormat: role === 'image' ? 'openai' : parseApiFormat(stored?.apiFormat || env.apiFormat || defaults.apiFormat),
    // 仅 Arc 走本地 extras；Thunder / Storm / 图像走云端 reasoning_effort
    reasoningEffortNone: role === 'small',
    optimizePrompt: role === 'image' ? stored?.optimizePrompt !== false : undefined
  };
}

function mergeEndpoint(current: ModelEndpointSettings, input?: EndpointPatch): ModelEndpointSettings {
  if (!input) return current;
  const apiKey = input.clearApiKey
    ? ''
    : input.apiKey !== undefined && input.apiKey.trim()
      ? input.apiKey.trim()
      : current.apiKey;
  return {
    baseUrl: input.baseUrl?.trim() || current.baseUrl,
    model: input.model?.trim() || current.model,
    apiKey,
    think: input.think ?? current.think,
    apiFormat: input.apiFormat !== undefined
      ? parseApiFormat(input.apiFormat)
      : (current.apiFormat || 'openai'),
    reasoningEffortNone: current.reasoningEffortNone,
    optimizePrompt: input.optimizePrompt ?? current.optimizePrompt
  };
}

function legacyFlatAsSmall(stored: StoredSettings): Partial<ModelEndpointSettings> | undefined {
  if (stored.small) return undefined;
  if (!stored.baseUrl && !stored.model && stored.apiKey === undefined && stored.think === undefined) {
    return undefined;
  }
  return {
    baseUrl: stored.baseUrl,
    model: stored.model,
    apiKey: stored.apiKey,
    think: stored.think
  };
}

export function getDualModelSettings(): DualModelSettings {
  const stored = readStoredSettings();
  const legacySmall = legacyFlatAsSmall(stored);
  const small = resolveEndpoint(stored.arc || stored.small || legacySmall, DEFAULT_SMALL, {
    baseUrl: process.env.LLM_BASE_URL || process.env.PACKY_BASE_URL,
    model: process.env.LLM_MODEL || process.env.PACKY_MODEL,
    apiKey: process.env.LLM_API_KEY || process.env.PACKY_API_KEY,
    think: process.env.LLM_THINK,
    apiFormat: process.env.LLM_API_FORMAT
  }, 'small');
  const large = resolveEndpoint(stored.thunder || stored.large, DEFAULT_LARGE, {
    baseUrl: process.env.LLM_LARGE_BASE_URL,
    model: process.env.LLM_LARGE_MODEL,
    apiKey: process.env.LLM_LARGE_API_KEY,
    think: process.env.LLM_LARGE_THINK,
    apiFormat: process.env.LLM_LARGE_API_FORMAT
  }, 'large');
  const storm = resolveEndpoint(stored.storm, DEFAULT_STORM, {
    baseUrl: process.env.LLM_STORM_BASE_URL || process.env.LLM_LARGE_BASE_URL,
    model: process.env.LLM_STORM_MODEL,
    apiKey: process.env.LLM_STORM_API_KEY || process.env.LLM_LARGE_API_KEY,
    think: process.env.LLM_STORM_THINK,
    apiFormat: process.env.LLM_STORM_API_FORMAT || process.env.LLM_LARGE_API_FORMAT
  }, 'storm');
  const image = resolveEndpoint(stored.image, DEFAULT_IMAGE, {}, 'image');
  return {
    small,
    large,
    storm,
    image,
    dataRootDir: getDataRootDir()
  };
}

/** 按角色取端点；默认小模型（对话能力默认走本地小模型） */
export function getModelEndpoint(role: EndpointRole = 'small'): ModelEndpointSettings {
  const dual = getDualModelSettings();
  if (role === 'large') return dual.large;
  if (role === 'storm') return dual.storm;
  if (role === 'image') return dual.image;
  return dual.small;
}

/**
 * 默认模型配置 = 小模型。
 * 所有对话 / 标题生成 / 直连 LLM 默认走此配置。
 */
export function getModelSettings(): ModelSettings {
  const dual = getDualModelSettings();
  return {
    ...dual.small,
    dataRootDir: dual.dataRootDir
  };
}

export function getDataRootDir() {
  const stored = readStoredSettings();
  let raw = stored.dataRootDir || process.env.DATA_ROOT_DIR || path.join(process.cwd(), '数据');
  if (process.platform !== 'win32' && /^[a-z]:[\\/]/i.test(raw)) {
    // A copied Windows settings file must not become a literal directory name on Linux.
    const fallback = process.env.DATA_ROOT_DIR || path.join(process.cwd(), '数据');
    if (/^[a-z]:[\\/]/i.test(fallback) || !fs.existsSync(fallback)) {
      throw new Error('数据目录仍为Windows路径，请配置当前服务器的 DATA_ROOT_DIR 或 dataRootDir。');
    }
    raw = fallback;
  }
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

export function mergeDualModelSettings(
  current: DualModelSettings,
  input: DualModelSettingsInput
): DualModelSettings {
  const legacySmallPatch: EndpointPatch | undefined =
    input.baseUrl !== undefined ||
    input.model !== undefined ||
    input.apiKey !== undefined ||
    input.think !== undefined ||
    input.clearApiKey
      ? {
          baseUrl: input.baseUrl,
          model: input.model,
          apiKey: input.apiKey,
          think: input.think,
          clearApiKey: input.clearApiKey
        }
      : undefined;

  return {
    small: mergeEndpoint(current.small, input.small || legacySmallPatch),
    large: mergeEndpoint(current.large, input.large),
    storm: mergeEndpoint(current.storm, input.storm),
    image: { ...mergeEndpoint(current.image, input.image), apiFormat: 'openai' },
    dataRootDir: input.dataRootDir?.trim() || current.dataRootDir
  };
}

/** @deprecated 使用 mergeDualModelSettings；仍把扁平字段当作小模型补丁 */
export function mergeModelSettings(
  current: ModelSettings,
  input: Partial<ModelSettings> & { clearApiKey?: boolean }
): ModelSettings {
  const dual = mergeDualModelSettings(
    {
      small: current,
      large: getDualModelSettings().large,
      storm: getDualModelSettings().storm,
      image: getDualModelSettings().image,
      dataRootDir: current.dataRootDir
    },
    input
  );
  return { ...dual.small, dataRootDir: dual.dataRootDir };
}

function readStoredSettingsRaw(): Record<string, unknown> {
  try {
    if (!fs.existsSync(settingsPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function toPersisted(next: DualModelSettings) {
  return {
    ...readStoredSettingsRaw(),
    small: {
      baseUrl: next.small.baseUrl,
      model: next.small.model,
      apiKey: next.small.apiKey,
      think: next.small.think,
      apiFormat: parseApiFormat(next.small.apiFormat)
    },
    large: {
      baseUrl: next.large.baseUrl,
      model: next.large.model,
      apiKey: next.large.apiKey,
      think: next.large.think,
      apiFormat: parseApiFormat(next.large.apiFormat)
    },
    thunder: {
      baseUrl: next.large.baseUrl,
      model: next.large.model,
      apiKey: next.large.apiKey,
      think: next.large.think,
      apiFormat: parseApiFormat(next.large.apiFormat)
    },
    storm: {
      baseUrl: next.storm.baseUrl,
      model: next.storm.model,
      apiKey: next.storm.apiKey,
      think: next.storm.think,
      apiFormat: parseApiFormat(next.storm.apiFormat)
    },
    arc: {
      baseUrl: next.small.baseUrl,
      model: next.small.model,
      apiKey: next.small.apiKey,
      think: next.small.think,
      apiFormat: parseApiFormat(next.small.apiFormat)
    },
    image: {
      baseUrl: next.image.baseUrl,
      model: next.image.model,
      apiKey: next.image.apiKey,
      think: next.image.think,
      optimizePrompt: next.image.optimizePrompt !== false
    },
    // 扁平别名：兼容侧车脚本等仍读 top-level baseUrl 的逻辑
    baseUrl: next.small.baseUrl,
    model: next.small.model,
    apiKey: next.small.apiKey,
    think: next.small.think,
    dataRootDir: next.dataRootDir
  };
}

/** 将小/大模型别名同步到 opencode.json（图像走 Gateway Images，不写入 OpenCode chat models） */
function syncOpenCodeModels(_dual: DualModelSettings) {
  const opencodePath = path.join(process.cwd(), 'opencode.json');
  try {
    if (!fs.existsSync(opencodePath)) return;
    const raw = fs.readFileSync(opencodePath, 'utf8').replace(/^\uFEFF/, '');
    const config = JSON.parse(raw) as {
      model?: string;
      small_model?: string;
      provider?: Record<string, {
        npm?: string;
        name?: string;
        options?: Record<string, unknown>;
        models?: Record<string, {
          name?: string;
          id?: string;
          attachment?: boolean;
          modalities?: {
            input?: Array<'text' | 'audio' | 'image' | 'video' | 'pdf'>;
            output?: Array<'text' | 'audio' | 'image' | 'video' | 'pdf'>;
          };
          reasoning?: boolean;
          interleaved?: { field: 'reasoning' | 'reasoning_content' | 'reasoning_details' };
          limit?: { context: number; output: number };
          options?: Record<string, unknown>;
          variants?: Record<string, Record<string, unknown>>;
        }>;
      }>;
      [key: string]: unknown;
      agent?: Record<string, { model?: string }>;
    };

    const smallRef = resolveOpenCodeModelRef('small');
    const largeRef = resolveOpenCodeModelRef('large');
    const stormRef = resolveOpenCodeModelRef('storm');
    config.model = smallRef;
    config.small_model = smallRef;
    const agents = config.agent;
    if (agents && typeof agents === 'object') {
      for (const [name, agent] of Object.entries(agents as Record<string, { model?: string }>)) {
        if (!agent || typeof agent !== 'object') continue;
        if (name === 'general' || name === 'explore') {
          delete agent.model;
          const options = (agent as { options?: Record<string, unknown> }).options;
          if (options && typeof options === 'object') {
            delete options.think;
            delete options.reasoning_effort;
            if (!Object.keys(options).length) {
              delete (agent as { options?: Record<string, unknown> }).options;
            }
          }
          continue;
        }
        if (typeof agent.model !== 'string') continue;
        if (/\/storm$/i.test(agent.model)) agent.model = stormRef;
        else if (/ai4es-large|\/thunder$/i.test(agent.model)) agent.model = largeRef;
        else if (/ai4es-small|\/arc$/i.test(agent.model)) agent.model = smallRef;
      }
    }

    // 迁移：去掉旧 lan-qwen provider
    if (config.provider?.['lan-qwen']) {
      delete config.provider['lan-qwen'];
    }

    config.provider = config.provider || {};
    const provider = config.provider[OPENCODE_PROVIDER_ID] || {
      npm: '@ai-sdk/openai-compatible',
      name: 'AI4ES Gateway',
      options: { baseURL: '{env:KNOWLEDGE_QA_BASE_URL}' },
      models: {}
    };
    provider.name = 'AI4ES Gateway';
    provider.npm = provider.npm || '@ai-sdk/openai-compatible';
    provider.options = {
      ...(provider.options || {}),
      baseURL: '{env:KNOWLEDGE_QA_BASE_URL}'
    };
    const smallOff = getLocalSmallChatExtras('off');
    const smallMedium = getLocalSmallChatExtras('medium');
    const smallXhigh = getLocalSmallChatExtras('xhigh');
    const existingSmallContext = Number(
      provider.models?.[OPENCODE_SMALL_MODEL_ALIAS]?.limit?.context
      || provider.models?.[OPENCODE_SMALL_LEGACY_ALIAS]?.limit?.context
    );
    const smallContext = Number.isFinite(existingSmallContext) && existingSmallContext > 0
      ? Math.floor(existingSmallContext)
      : LOCAL_SMALL_CONTEXT_TOKENS;
    const existingLargeContext = Number(
      provider.models?.[OPENCODE_LARGE_MODEL_ALIAS]?.limit?.context
      || provider.models?.[OPENCODE_LARGE_LEGACY_ALIAS]?.limit?.context
    );
    const largeModelName = String(_dual.large.model || '');
    const stormModelName = String(_dual.storm.model || '');
    const cloudContextFor = (name: string, existing: number) => {
      if (/gpt-6-astra|\bastra\b/i.test(name)) return 272_000;
      if (/claude/i.test(name)) return 200_000;
      if (/gpt-6-sol/i.test(name)) return 919_387;
      if (/5\.6|gpt-5/i.test(name)) return 200_000;
      return Number.isFinite(existing) && existing > 0 ? Math.floor(existing) : 200_000;
    };
    const largeContext = cloudContextFor(largeModelName, existingLargeContext);
    const existingStormContext = Number(provider.models?.[OPENCODE_STORM_MODEL_ALIAS]?.limit?.context);
    const stormContext = cloudContextFor(stormModelName, existingStormContext);
    const existingLargeOutput = Number(
      provider.models?.[OPENCODE_LARGE_MODEL_ALIAS]?.limit?.output
      || provider.models?.[OPENCODE_LARGE_LEGACY_ALIAS]?.limit?.output
    );
    const largeOutput = Number.isFinite(existingLargeOutput) && existingLargeOutput > 0
      ? Math.floor(existingLargeOutput)
      : 32_768;
    const cloudVariants = {
      low: { reasoning_effort: 'low', include_reasoning: true },
      medium: { reasoning_effort: 'medium', include_reasoning: true },
      high: { reasoning_effort: 'high', include_reasoning: true },
      xhigh: { reasoning_effort: 'xhigh', include_reasoning: true }
    };
    const cloudModel = (name: string, context: number) => ({
      name,
      attachment: true,
      modalities: { input: ['text', 'image'] as ('text' | 'image')[], output: ['text'] as 'text'[] },
      reasoning: true,
      interleaved: { field: 'reasoning_content' as const },
      limit: { context, output: largeOutput },
      options: {
        include_reasoning: false
      },
      variants: { ...cloudVariants }
    });
    const smallThinkingAlias = (
      name: string,
      extras: ReturnType<typeof getLocalSmallChatExtras>
    ) => ({
      name,
      id: OPENCODE_SMALL_MODEL_ALIAS,
      attachment: true,
      modalities: { input: ['text', 'image'] as ('text' | 'image')[], output: ['text'] as 'text'[] },
      reasoning: true,
      interleaved: { field: 'reasoning' as const },
      limit: { context: smallContext, output: LOCAL_SMALL_OUTPUT_TOKENS },
      options: { ...extras }
    });
    provider.models = {
      [OPENCODE_SMALL_MODEL_ALIAS]: {
        name: 'arc',
        attachment: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        reasoning: true,
        interleaved: { field: 'reasoning' as const },
        limit: {
          context: smallContext,
          output: LOCAL_SMALL_OUTPUT_TOKENS
        },
        options: { ...smallOff },
        variants: {
          medium: { ...smallMedium },
          xhigh: { ...smallXhigh }
        }
      },
      [OPENCODE_SMALL_LEGACY_ALIAS]: smallThinkingAlias('arc', smallOff),
      // 旧会话目录名；发给 Gateway 的 model 仍是 arc
      [OPENCODE_SMALL_LOW_MODEL_ALIAS]: smallThinkingAlias('arc', smallMedium),
      [OPENCODE_SMALL_MEDIUM_MODEL_ALIAS]: smallThinkingAlias('arc', smallMedium),
      [OPENCODE_SMALL_XHIGH_MODEL_ALIAS]: smallThinkingAlias('arc', smallXhigh),
      [OPENCODE_LARGE_MODEL_ALIAS]: cloudModel('thunder', largeContext),
      [OPENCODE_LARGE_LEGACY_ALIAS]: {
        ...cloudModel('thunder', largeContext),
        id: OPENCODE_LARGE_MODEL_ALIAS
      },
      [OPENCODE_STORM_MODEL_ALIAS]: cloudModel('storm', stormContext),
      // 真实调用走 Gateway /images/generations 与 /images/edits
      [OPENCODE_IMAGE_MODEL_ALIAS]: {
        name: 'AI4ES Image (Gateway)',
        reasoning: false,
        modalities: { input: ['text', 'image'], output: ['image'] },
        options: {}
      }
    };
    config.provider[OPENCODE_PROVIDER_ID] = provider;

    fs.writeFileSync(opencodePath, `${JSON.stringify(config, null, 2)}\n`);
  } catch {
    // 同步失败不阻断设置保存
  }
}

export function saveDualModelSettings(input: DualModelSettingsInput) {
  const current = getDualModelSettings();
  const next = mergeDualModelSettings(current, input);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(toPersisted(next), null, 2));
  syncOpenCodeModels(next);
  syncOpenCodeSubagentRouter();
  return next;
}

/** @deprecated 使用 saveDualModelSettings；扁平写入映射到小模型 */
export function saveModelSettings(input: Partial<ModelSettings> & { clearApiKey?: boolean }) {
  const next = saveDualModelSettings(input);
  return { ...next.small, dataRootDir: next.dataRootDir };
}

export const config = {
  get databasePath() {
    return process.env.RAG_TEST_DATABASE_PATH
      || getBundleDatabasePath()
      || process.env.DATABASE_PATH
      || path.join(process.cwd(), 'storage', 'rag.sqlite');
  },
  dataDir: path.join(process.cwd(), 'data'),
  get dataRootDir() {
    return getDataRootDir();
  },
  importDir: process.cwd(),
  get packyBaseUrl() {
    return getModelSettings().baseUrl;
  },
  get packyModel() {
    return getModelSettings().model;
  },
  get packyApiKey() {
    return getModelSettings().apiKey;
  }
};
