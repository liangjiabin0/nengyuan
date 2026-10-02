// 【重建】原文件已丢失，按 dist/runtime/api-app.mjs 还原并补回类型。
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { parseChatModelId } from '@/lib/model-ids';
import { detectAllThinkingLevels, detectThinkingLevels } from '@/lib/thinking-levels';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const model = parseChatModelId(new URL(request.url).searchParams.get('model'));
  const payload = model ? await detectThinkingLevels(model) : await detectAllThinkingLevels();
  return NextResponse.json(payload, {
    headers: { 'Cache-Control': 'private, max-age=60' }
  });
}
