#!/usr/bin/env node
/**
 * 按 storage/settings.json 的图像端点生成一张图，写入 --out。
 */
import {
  PROJECT_ROOT,
  argValue,
  formatImageApiError,
  normalizeImageQuality,
  normalizeImageSize,
  resolveImageEndpoint,
  writeImageResult
} from './image-api.mjs';
import { resolvePromptForImage } from './optimize-prompt.mjs';

async function main() {
  const argv = process.argv.slice(2);
  const { prompt } = await resolvePromptForImage(argv, 'text2image');
  const outArg = argValue(argv, '--out').trim();
  const size = normalizeImageSize(argValue(argv, '--size', '1024x1024'));
  const quality = normalizeImageQuality(argValue(argv, '--quality', '2K'));
  if (!outArg) {
    console.error('缺少 --out');
    process.exit(1);
  }

  const endpoint = resolveImageEndpoint();
  if (!endpoint.baseUrl) {
    console.error('未配置图像接口 Base URL（设置页图像模型）');
    process.exit(1);
  }

  const headers = {
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID()
  };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;

  const response = await fetch(`${endpoint.baseUrl}/images/generations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: endpoint.model,
      prompt,
      n: 1,
      size,
      quality,
      response_format: 'url'
    }),
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
