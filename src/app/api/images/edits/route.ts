import { NextResponse } from 'next/server';
import { editImage, type ImageQuality, type ImageSize } from '@/lib/image-generation';
import { parseOptimizePromptFlag } from '@/lib/image-prompt-optimize';
import { requireUser } from '@/lib/auth/request';

export const maxDuration = 180;

function asFileList(form: FormData, key: string) {
  return form.getAll(key).filter((entry): entry is File => entry instanceof File && entry.size > 0);
}

export async function POST(request: Request) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const form = await request.formData();
    const prompt = String(form.get('prompt') || '');
    const images = asFileList(form, 'image');
    const mask = asFileList(form, 'mask')[0];
    const optimizeRaw = form.get('optimize_prompt') ?? form.get('optimizePrompt');
    const result = await editImage({
      prompt,
      images,
      mask,
      model: String(form.get('model') || '') || undefined,
      n: form.get('n') ? Number(form.get('n')) : undefined,
      size: (String(form.get('size') || '') || undefined) as ImageSize | undefined,
      quality: (String(form.get('quality') || '') || undefined) as ImageQuality | undefined,
      responseFormat: String(form.get('response_format') || form.get('responseFormat')) === 'b64_json'
        ? 'b64_json'
        : 'url',
      optimizePrompt: parseOptimizePromptFlag(optimizeRaw)
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
      error: error instanceof Error ? error.message : '图像编辑失败'
    }, { status: 400 });
  }
}
