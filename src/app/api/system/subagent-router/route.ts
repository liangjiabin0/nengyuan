// 【重建】原文件已丢失，按 dist/runtime/api-app.mjs 还原并补回类型。
import { NextResponse } from 'next/server';
import { requireAdmin, requireUser } from '@/lib/auth/request';
import { publicSubagentRouterConfig } from '@/lib/subagent-router';
import { getSubagentRouterConfig, saveSubagentRouterConfig } from '@/lib/subagent-router-store';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  return NextResponse.json({
    router: publicSubagentRouterConfig(getSubagentRouterConfig())
  });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  try {
    const body = await request.json().catch(() => ({}));
    const router = saveSubagentRouterConfig(body?.router ?? body);
    return NextResponse.json({ router: publicSubagentRouterConfig(router) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '保存失败' },
      { status: 500 }
    );
  }
}
