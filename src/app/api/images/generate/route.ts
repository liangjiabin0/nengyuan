import { NextResponse } from 'next/server';
import { generateImage } from '@/lib/image-generation';
import { parseOptimizePromptFlag } from '@/lib/image-prompt-optimize';
import { requireUser } from '@/lib/auth/request';

export const maxDuration = 180;

/**
 * OpenAI Images 兼容生成：转发到设置页配置的图像端点（默认 gpt-image-2）。
 */
export async function POST(request: Request) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const body = await request.json().catch(() => ({}));
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    const result = await generateImage({
      prompt,
      model: typeof body.model === 'string' ? body.model : undefined,
      n: typeof body.n === 'number' ? body.n : undefined,
      size: typeof body.size === 'string' ? body.size : undefined,
      quality: typeof body.quality === 'string' ? body.quality : undefined,
      responseFormat: body.response_format === 'b64_json' || body.responseFormat === 'b64_json'
        ? 'b64_json'
        : 'url',
      optimizePrompt: parseOptimizePromptFlag(body.optimize_prompt ?? body.optimizePrompt)
    });
    return NextResponse.json({
      ok: true,
      model: result.model,
      baseUrl: result.baseUrl,
      created: result.created,
      images: result.images,
      usage: result.usage,
      prompt: result.prompt,
      originalPrompt: result.originalPrompt,
      promptOptimized: result.promptOptimized
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : '图像生成失败'
    }, { status: 400 });
  }
}
