import { NextResponse } from 'next/server';
import {
  getDualModelSettings,
  mergeDualModelSettings,
  parseApiFormat,
  type ModelRole
} from '@/lib/config';
import { probeAllEndpoints, probeEndpoint } from '@/lib/endpoint-probe';
import { requireAdmin } from '@/lib/auth/request';

function parseRole(value: unknown): ModelRole | null {
  if (value === 'large' || value === 'image' || value === 'small' || value === 'storm') return value;
  return null;
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;
    const body = await request.json().catch(() => ({}));
    const role = parseRole(body.role);

    if (!role) {
      const results = await probeAllEndpoints();
      return NextResponse.json({ ok: true, results });
    }

    const current = getDualModelSettings();
    const patch = body[role];
    const merged = mergeDualModelSettings(current, {
      [role]: patch
        ? {
            baseUrl: patch.baseUrl,
            model: patch.model,
            apiKey: typeof patch.apiKey === 'string' && patch.apiKey.trim() ? patch.apiKey : undefined,
            clearApiKey: patch.clearApiKey === true,
            think: patch.think,
            apiFormat: typeof patch.apiFormat === 'string' ? parseApiFormat(patch.apiFormat) : undefined,
            optimizePrompt: typeof patch.optimizePrompt === 'boolean' ? patch.optimizePrompt : undefined
          }
        : undefined
    });
    const endpoint = role === 'large'
      ? merged.large
      : role === 'storm'
        ? merged.storm
        : role === 'image'
          ? merged.image
          : merged.small;
    const result = await probeEndpoint(role, endpoint);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : '健康探测失败'
    }, { status: 400 });
  }
}
