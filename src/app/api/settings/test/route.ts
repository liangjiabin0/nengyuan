import { NextResponse } from 'next/server';
import {
  getDualModelSettings,
  mergeDualModelSettings,
  parseApiFormat,
  type ModelRole
} from '@/lib/config';
import { testImageConnection } from '@/lib/image-generation';
import { testLLMConnection } from '@/lib/llm';
import { requireAdmin } from '@/lib/auth/request';

export const maxDuration = 180;

function parseRole(value: unknown): ModelRole {
  if (value === 'large' || value === 'image' || value === 'small' || value === 'storm') return value;
  return 'small';
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;
    const body = await request.json().catch(() => ({}));
    const role = parseRole(body.role);
    const current = getDualModelSettings();
    const patch = body[role] || (role === 'small'
      ? {
          baseUrl: body.baseUrl,
          model: body.model,
          apiKey: body.apiKey,
          clearApiKey: body.clearApiKey,
          think: body.think
        }
      : undefined);
    const merged = mergeDualModelSettings(current, {
      [role]: patch
        ? {
            baseUrl: patch.baseUrl,
            model: patch.model,
            apiKey: typeof patch.apiKey === 'string' && patch.apiKey.trim() ? patch.apiKey : undefined,
            clearApiKey: patch.clearApiKey === true,
            think: typeof patch.think === 'boolean' ? patch.think : undefined,
            apiFormat: typeof patch.apiFormat === 'string' ? parseApiFormat(patch.apiFormat) : undefined,
            optimizePrompt: typeof patch.optimizePrompt === 'boolean' ? patch.optimizePrompt : undefined
          }
        : undefined
    });
    const endpoint = getEndpoint(merged, role);
    const message = role === 'image'
      ? await testImageConnection(endpoint)
      : await testLLMConnection(endpoint);
    return NextResponse.json({
      ok: true,
      role,
      message,
      model: endpoint.model,
      baseUrl: endpoint.baseUrl,
      authenticated: Boolean(endpoint.apiKey),
      status: 'green'
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      status: 'red',
      error: error instanceof Error ? error.message : '连通性测试失败'
    }, { status: 400 });
  }
}

function getEndpoint(
  settings: ReturnType<typeof getDualModelSettings>,
  role: ModelRole
) {
  if (role === 'large') return settings.large;
  if (role === 'storm') return settings.storm;
  if (role === 'image') return settings.image;
  return settings.small;
}
