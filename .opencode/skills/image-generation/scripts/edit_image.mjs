#!/usr/bin/env node
/**
 * 按 storage/settings.json 的图像端点做参考图编辑，写入 --out。
 * 用法: node edit_image.mjs --prompt "..." --out out.png IMAGE [IMAGE ...]
 * 长提示词用 --prompt-file / --global-prompt-file，避免命令行截断。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  PROJECT_ROOT,
  argValue,
  formatImageApiError,
  normalizeImageQuality,
  normalizeImageSize,
  resolveImageEndpoint,
  resolveProjectPath,
  writeImageResult
} from './image-api.mjs';
import { resolvePromptForImage } from './optimize-prompt.mjs';

function positionalImages(argv) {
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      if (
        arg === '--prompt'
        || arg === '--prompt-file'
        || arg === '--global-prompt-file'
        || arg === '--out'
        || arg === '--size'
        || arg === '--quality'
        || arg === '--mask'
        || arg === '--mode'
      ) {
        i += 1;
      }
      continue;
    }
    files.push(arg);
  }
  return files;
}

function imageContentType(filename) {
  switch (path.extname(filename).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { prompt } = await resolvePromptForImage(argv, 'image2image');
  const outArg = argValue(argv, '--out').trim();
  const size = normalizeImageSize(argValue(argv, '--size', '1024x1024'));
  const quality = normalizeImageQuality(argValue(argv, '--quality', '2K'));
  const maskArg = argValue(argv, '--mask').trim();
  const imagePaths = positionalImages(argv);
  if (!outArg) {
    console.error('缺少 --out');
    process.exit(1);
  }
  if (imagePaths.length < 1 || imagePaths.length > 8) {
    console.error('需要 1–8 张参考图路径');
    process.exit(1);
  }

  const endpoint = resolveImageEndpoint();
  const body = new FormData();
  body.set('model', endpoint.model);
  body.set('prompt', prompt);
  body.set('n', '1');
  body.set('size', size);
  body.set('quality', quality);
  body.set('response_format', 'url');
  for (const imagePath of imagePaths) {
    const abs = resolveProjectPath(imagePath);
    body.append(
      'image',
      new Blob([fs.readFileSync(abs)], { type: imageContentType(abs) }),
      path.basename(abs)
    );
  }
  if (maskArg) {
    const abs = resolveProjectPath(maskArg);
    body.set('mask', new Blob([fs.readFileSync(abs)], { type: 'image/png' }), path.basename(abs));
  }

  const headers = { 'Idempotency-Key': crypto.randomUUID() };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;

  const response = await fetch(`${endpoint.baseUrl}/images/edits`, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(180_000)
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(formatImageApiError(response.status, text));
    process.exit(1);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`无法解析图像 API 响应: ${text.slice(0, 200)}`);
    process.exit(1);
  }
  await writeImageResult(json, outArg, PROJECT_ROOT);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
