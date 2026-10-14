import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin, requireUser } from '@/lib/auth/request';
import { probePaperReviewModel } from '@/lib/paper-review/llm';
import {
  PAPER_REVIEW_THINKING_LEVELS,
  getPaperReviewModelConfig,
  publicPaperReviewModelConfig,
  savePaperReviewModelConfig
} from '@/lib/paper-review/model-config';

export const runtime = 'nodejs';

const patchSchema = z.object({
  baseUrl: z.string().max(500).optional(),
  apiKey: z.string().max(500).optional(),
  clearApiKey: z.boolean().optional(),
  model: z.string().max(200).optional(),
  thinking: z.enum(PAPER_REVIEW_THINKING_LEVELS as [string, ...string[]]).optional(),
  allowStormFallback: z.boolean().optional(),
  proxyUrl: z.string().max(200).optional()
});

/** 读取论文智能评审的模型配置（不含 Key）。?probe=1 时实际探测一次上游。 */
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const config = getPaperReviewModelConfig();
  const probe = new URL(request.url).searchParams.get('probe') === '1' ? await probePaperReviewModel(config) : null;
  return NextResponse.json({ config: publicPaperReviewModelConfig(config), probe, thinkingLevels: PAPER_REVIEW_THINKING_LEVELS });
}

/** 保存配置（仅管理员）。apiKey 留空表示不修改；clearApiKey=true 清除。 */
export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  const parsed = patchSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: '参数不合法。' }, { status: 400 });
  try {
    const next = savePaperReviewModelConfig(parsed.data as Parameters<typeof savePaperReviewModelConfig>[0]);
    return NextResponse.json({ config: publicPaperReviewModelConfig(next) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '保存失败。' }, { status: 400 });
  }
}
