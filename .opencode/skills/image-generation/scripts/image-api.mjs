import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findProjectRoot(startDir = __dirname) {
  const fromEnv = String(process.env.AI4ES_PROJECT_ROOT || '').trim();
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'package.json'))) {
    return path.resolve(fromEnv);
  }
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'storage'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '../../..');
}

export const PROJECT_ROOT = findProjectRoot();
export const SETTINGS_PATH = path.join(PROJECT_ROOT, 'storage', 'settings.json');

export const DEFAULT_IMAGE = {
  baseUrl: 'https://ai-api.ai-member.icu/v1',
  model: 'gpt-image-2',
  apiKey: ''
};

/** 与 src/lib/image-generation.ts 保持一致；科研 PPT 单页提示词会超过旧的 1500 上限。 */
export const IMAGE_PROMPT_MAX_CHARS = 8000;
export const IMAGE_SIZES = ['auto', '1024x1024', '1024x1536', '1536x1024'];

export function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

export function resolveImageEndpoint() {
  const stored = readJsonSafe(SETTINGS_PATH) || {};
  return {
    baseUrl: String(stored.image?.baseUrl || DEFAULT_IMAGE.baseUrl).trim().replace(/\/$/, ''),
    model: String(stored.image?.model || DEFAULT_IMAGE.model).trim(),
    apiKey: String(stored.image?.apiKey ?? DEFAULT_IMAGE.apiKey)
  };
}

export function argValue(argv, flag, fallback = '') {
  const index = argv.indexOf(flag);
  if (index < 0 || index + 1 >= argv.length) return fallback;
  return String(argv[index + 1] || '');
}

export function resolveProjectPath(input, projectRoot = PROJECT_ROOT) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

export function normalizeImageSize(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.toLowerCase() === 'auto') return 'auto';
  const lower = raw.toLowerCase().replace(/\s+/g, '');
  const landscape = new Set([
    '1536x1024',
    '1792x1024',
    '16:9',
    '16x9',
    '1920x1080',
    '1280x720',
    '1536x864',
    'landscape',
    'widescreen'
  ]);
  const portrait = new Set([
    '1024x1536',
    '1024x1792',
    '9:16',
    '9x16',
    '1080x1920',
    '720x1280',
    'portrait'
  ]);
  if (lower === '1024x1024' || lower === '256x256' || lower === '512x512' || lower === 'square') {
    return '1024x1024';
  }
  if (landscape.has(lower)) return '1536x1024';
  if (portrait.has(lower)) return '1024x1536';
  throw new Error(`不支持的图像尺寸 ${raw}（允许 auto / 1024x1024 / 1024x1536 / 1536x1024，16:9 会映射为 1536x1024）`);
}

export function normalizeImageQuality(value) {
  const raw = String(value || '').trim();
  if (!raw) return '2K';
  const lower = raw.toLowerCase();
  if (lower === '1k' || lower === 'standard') return '1K';
  if (lower === '2k' || lower === 'hd') return '2K';
  if (lower === '4k') return '4K';
  throw new Error(`不支持的图像质量 ${raw}（允许 1K / 2K / 4K）`);
}

export function formatImageApiError(status, text) {
  try {
    const json = JSON.parse(text);
    const err = json.error || {};
    const message = err.message || json.message || String(text).slice(0, 300);
    const type = err.type || err.code || json.code || '';
    if (type === 'model_not_found' || /not supported by any configured account/i.test(message)) {
      return `Image API HTTP ${status}: 当前图像 Key 所在分组不支持该模型。请在设置页更换具备 gpt-image-2 / Images 权限的 Key。`;
    }
    return `Image API HTTP ${status}: ${message}`;
  } catch {
    return `Image API HTTP ${status}: ${String(text).slice(0, 300)}`;
  }
}

export function normalizePrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('图像生成需要 prompt');
  if ([...text].length > IMAGE_PROMPT_MAX_CHARS) {
    throw new Error(`prompt 不能超过 ${IMAGE_PROMPT_MAX_CHARS} 个字符`);
  }
  return text;
}

function readPromptFile(filePath) {
  const abs = resolveProjectPath(filePath);
  if (!abs || !fs.existsSync(abs)) {
    throw new Error(`提示词文件不存在：${filePath}`);
  }
  return fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '').trim();
}

/**
 * 读取 --prompt / --prompt-file / --global-prompt-file。
 * 科研 PPT 单页提示词应走文件，避免 Windows 命令行长度限制。
 */
export function readPromptFromArgv(argv, projectRoot = PROJECT_ROOT) {
  const globalFile = argValue(argv, '--global-prompt-file').trim();
  const promptFile = argValue(argv, '--prompt-file').trim();
  const prompt = argValue(argv, '--prompt').trim();
  const parts = [];
  if (globalFile) parts.push(readPromptFile(resolveProjectPath(globalFile, projectRoot)));
  if (promptFile) parts.push(readPromptFile(resolveProjectPath(promptFile, projectRoot)));
  if (prompt) parts.push(prompt);
  return normalizePrompt(parts.filter(Boolean).join('\n\n'));
}

export function extensionFromUrl(url) {
  const match = String(url || '').split('?')[0].match(/\.(png|jpe?g|webp|gif)$/i);
  return match ? match[0].toLowerCase() : '.png';
}

export async function writeImageResult(json, outArg, projectRoot = PROJECT_ROOT) {
  const first = Array.isArray(json?.data) ? json.data[0] : null;
  if (!first) {
    throw new Error('图像 API 未返回任何图片');
  }
  const outPath = path.isAbsolute(outArg) ? outArg : path.resolve(projectRoot, outArg);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  if (first.b64_json) {
    const target = path.extname(outPath) ? outPath : `${outPath}.png`;
    fs.writeFileSync(target, Buffer.from(first.b64_json, 'base64'));
    console.log(target);
    return target;
  }

  if (first.url) {
    const imageResponse = await fetch(first.url, { signal: AbortSignal.timeout(120_000) });
    if (!imageResponse.ok) {
      throw new Error(`下载图像失败 HTTP ${imageResponse.status}`);
    }
    const buffer = Buffer.from(await imageResponse.arrayBuffer());
    const target = path.extname(outPath) ? outPath : `${outPath}${extensionFromUrl(first.url)}`;
    fs.writeFileSync(target, buffer);
    console.log(target);
    return target;
  }

  throw new Error('图像 API 未返回 b64_json 或 url');
}
