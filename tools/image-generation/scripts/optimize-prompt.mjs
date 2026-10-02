#!/usr/bin/env node
/**
 * 文生图 / 图编辑提示词优化。
 * 流程对齐 linshenkx/prompt-optimizer（用对话模型改写，而不是堆砌 SD 标签），
 * 调用能元设置页的小模型（失败则大模型）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IMAGE_PROMPT_MAX_CHARS,
  PROJECT_ROOT,
  SETTINGS_PATH,
  argValue,
  normalizePrompt,
  readJsonSafe,
  readPromptFromArgv
} from './image-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

export const IMAGE_OPTIMIZE_MODES = ['text2image', 'image2image'];

function stripThinkTags(content) {
  return String(content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function readTemplate(mode) {
  const file = mode === 'image2image' ? 'i2i-optimize.txt' : 't2i-optimize.txt';
  const abs = path.join(PROMPTS_DIR, file);
  if (!fs.existsSync(abs)) {
    throw new Error(`缺少提示词优化模板：${abs}`);
  }
  return fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '').trim();
}

export function extractOptimizedPrompt(text, fallback) {
  let out = stripThinkTags(text);
  out = out.replace(/^```(?:[\w-]+)?\s*/i, '').replace(/\s*```$/i, '').trim();
  out = out.replace(/^(?:优化后的提示词|Optimized prompt)\s*[:：]\s*/i, '').trim();
  if (!out || [...out].length < 8) return fallback;
  if ([...out].length > IMAGE_PROMPT_MAX_CHARS) {
    out = [...out].slice(0, IMAGE_PROMPT_MAX_CHARS).join('');
  }
  return out;
}

export function parseOptimizePromptFlag(value) {
  if (typeof value === 'boolean') return value;
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return undefined;
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  return undefined;
}

/**
 * 开关优先级：CLI 标志 > 环境变量 IMAGE_OPTIMIZE_PROMPT > settings.json image.optimizePrompt > 默认开。
 */
export function resolveOptimizePrompt(argv = [], storedDefault = true) {
  if (argv.includes('--no-optimize-prompt') || argv.includes('--optimize-prompt=false') || argv.includes('--optimize-prompt=0')) {
    return false;
  }
  if (argv.includes('--optimize-prompt') || argv.includes('--optimize-prompt=true') || argv.includes('--optimize-prompt=1')) {
    return true;
  }
  const envFlag = parseOptimizePromptFlag(process.env.IMAGE_OPTIMIZE_PROMPT);
  if (typeof envFlag === 'boolean') return envFlag;
  const stored = readJsonSafe(SETTINGS_PATH) || {};
  if (typeof stored.image?.optimizePrompt === 'boolean') return stored.image.optimizePrompt;
  return storedDefault;
}

function endpointFrom(stored, env) {
  return {
    baseUrl: String(stored?.baseUrl || env.baseUrl || '').trim().replace(/\/$/, ''),
    model: String(stored?.model || env.model || '').trim(),
    apiKey: String(stored?.apiKey ?? env.apiKey ?? '')
  };
}

export function resolveOptimizeChatEndpoints() {
  const stored = readJsonSafe(SETTINGS_PATH) || {};
  const small = endpointFrom(stored.small || stored, {
    baseUrl: process.env.LLM_BASE_URL || process.env.PACKY_BASE_URL || 'http://10.1.4.166:8000/v1',
    model: process.env.LLM_MODEL || process.env.PACKY_MODEL || 'Arc',
    apiKey: process.env.LLM_API_KEY || process.env.PACKY_API_KEY || ''
  });
  const large = endpointFrom(stored.large || {}, {
    baseUrl: process.env.LLM_LARGE_BASE_URL || '',
    model: process.env.LLM_LARGE_MODEL || '',
    apiKey: process.env.LLM_LARGE_API_KEY || ''
  });
  return { small, large };
}

async function completeOptimizeChat(endpoint, messages) {
  if (!endpoint.baseUrl || !endpoint.model) {
    throw new Error('未配置对话模型，无法优化提示词');
  }
  const headers = { 'Content-Type': 'application/json' };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
  const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: endpoint.model,
      messages,
      stream: false,
      temperature: 0.4,
      max_tokens: 1200,
      chat_template_kwargs: { enable_thinking: false }
    }),
    signal: AbortSignal.timeout(60_000)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`提示词优化 HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const json = JSON.parse(trimmed);
    const message = json?.choices?.[0]?.message || {};
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
        : '';
    return content || String(message.reasoning_content || message.reasoning || '');
  }
  throw new Error(`无法解析提示词优化响应: ${trimmed.slice(0, 200)}`);
}

export async function optimizeImagePrompt(prompt, options = {}) {
  const original = normalizePrompt(prompt);
  const mode = options.mode === 'image2image' ? 'image2image' : 'text2image';
  const system = options.system || readTemplate(mode);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: original }
  ];
  const { small, large } = options.endpoints || resolveOptimizeChatEndpoints();
  const tried = [];
  let lastError = '';
  for (const endpoint of [small, large]) {
    if (!endpoint?.baseUrl || !endpoint?.model) continue;
    if (tried.some((item) => item.baseUrl === endpoint.baseUrl && item.model === endpoint.model)) continue;
    tried.push(endpoint);
    try {
      const raw = await completeOptimizeChat(endpoint, messages);
      const optimized = extractOptimizedPrompt(raw, original);
      return {
        prompt: optimized,
        originalPrompt: original,
        optimized: optimized !== original,
        model: endpoint.model,
        mode
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    prompt: original,
    originalPrompt: original,
    optimized: false,
    mode,
    error: lastError || '未配置可用的对话模型，已跳过提示词优化'
  };
}

export function logOptimizeResult(result) {
  if (result.error) {
    console.error(`[image-generation] prompt-optimize skipped: ${result.error}`);
    return;
  }
  const originalChars = [...result.originalPrompt].length;
  const optimizedChars = [...result.prompt].length;
  console.error(
    `[image-generation] prompt-optimize=${result.optimized ? 'rewritten' : 'unchanged'} mode=${result.mode} ${originalChars}->${optimizedChars} chars`
  );
}

async function applyResolvedPrompt(argv, mode) {
  const original = readPromptFromArgv(argv, PROJECT_ROOT);
  if (!resolveOptimizePrompt(argv)) {
    console.error('[image-generation] prompt-optimize=off');
    return { prompt: original, originalPrompt: original, optimized: false, mode, skipped: true };
  }
  const result = await optimizeImagePrompt(original, { mode });
  logOptimizeResult(result);
  return result;
}

export async function resolvePromptForImage(argv, mode = 'text2image') {
  return applyResolvedPrompt(argv, mode);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const argv = process.argv.slice(2);
  const mode = argValue(argv, '--mode', 'text2image') === 'image2image' ? 'image2image' : 'text2image';
  optimizeImagePrompt(readPromptFromArgv(argv), { mode })
    .then((result) => {
      if (result.error) console.error(result.error);
      process.stdout.write(`${result.prompt}\n`);
      if (result.error) process.exit(1);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
