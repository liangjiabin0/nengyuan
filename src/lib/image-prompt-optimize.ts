import fs from 'node:fs';
import path from 'node:path';
import { completeChat, stripThinkTags } from '@/lib/llm';
import { getModelEndpoint } from '@/lib/config';

const IMAGE_PROMPT_MAX_CHARS = 8000;

export type ImagePromptOptimizeMode = 'text2image' | 'image2image';

export type OptimizeImagePromptResult = {
  prompt: string;
  originalPrompt: string;
  optimized: boolean;
  model?: string;
  mode: ImagePromptOptimizeMode;
  error?: string;
};

const PROMPTS_DIR = path.join(process.cwd(), 'tools', 'image-generation', 'prompts');

function readTemplate(mode: ImagePromptOptimizeMode) {
  const file = mode === 'image2image' ? 'i2i-optimize.txt' : 't2i-optimize.txt';
  const abs = path.join(PROMPTS_DIR, file);
  if (!fs.existsSync(abs)) {
    throw new Error(`缺少提示词优化模板：${abs}`);
  }
  return fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '').trim();
}

export function extractOptimizedPrompt(text: string, fallback: string) {
  let out = stripThinkTags(text);
  out = out.replace(/^```(?:[\w-]+)?\s*/i, '').replace(/\s*```$/i, '').trim();
  out = out.replace(/^(?:优化后的提示词|Optimized prompt)\s*[:：]\s*/i, '').trim();
  if (!out || [...out].length < 8) return fallback;
  if ([...out].length > IMAGE_PROMPT_MAX_CHARS) {
    out = [...out].slice(0, IMAGE_PROMPT_MAX_CHARS).join('');
  }
  return out;
}

export function parseOptimizePromptFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return undefined;
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  return undefined;
}

/**
 * 文生图提示词优化：用能元小模型（失败则大模型）按 Prompt Optimizer 文生图流程改写。
 * 失败时返回原文，不抛错。
 */
export async function optimizeImagePrompt(
  prompt: string,
  options: {
    mode?: ImagePromptOptimizeMode;
    signal?: AbortSignal;
  } = {}
): Promise<OptimizeImagePromptResult> {
  const original = prompt.trim();
  const mode: ImagePromptOptimizeMode = options.mode === 'image2image' ? 'image2image' : 'text2image';
  const system = readTemplate(mode);
  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: original }
  ];
  const endpoints = [getModelEndpoint('small'), getModelEndpoint('large')];
  const tried = new Set<string>();
  let lastError = '';

  for (const settings of endpoints) {
    const key = `${settings.baseUrl}|${settings.model}`;
    if (!settings.baseUrl || !settings.model || tried.has(key)) continue;
    tried.add(key);
    try {
      const { content } = await completeChat(messages, {
        settings,
        model: settings.model,
        temperature: 0.4,
        max_tokens: 1200,
        thinking: false,
        signal: options.signal
      });
      const optimized = extractOptimizedPrompt(content, original);
      return {
        prompt: optimized,
        originalPrompt: original,
        optimized: optimized !== original,
        model: settings.model,
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
