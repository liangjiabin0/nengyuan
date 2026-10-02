import { NextResponse } from 'next/server';
import { getDualModelSettings, parseApiFormat, saveDualModelSettings } from '@/lib/config';
import { OPENCODE_PROVIDER_ID, OPENCODE_SMALL_MODEL_ALIAS } from '@/lib/model-ids';
import { getOpenCodeHealth } from '@/lib/opencode/runtime';
import { requireAdmin, requireUser } from '@/lib/auth/request';

async function readOpenCodeStatus() {
  try {
    const health = await getOpenCodeHealth();
    return {
      running: Boolean(health?.healthy),
      healthy: Boolean(health?.healthy),
      version: health?.version || '',
      provider: OPENCODE_PROVIDER_ID,
      model: OPENCODE_SMALL_MODEL_ALIAS
    };
  } catch (error) {
    return {
      running: false,
      healthy: false,
      version: '',
      provider: OPENCODE_PROVIDER_ID,
      model: OPENCODE_SMALL_MODEL_ALIAS,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function publicEndpoint(endpoint: {
  baseUrl: string;
  model: string;
  apiKey: string;
  think: boolean;
  apiFormat?: string;
  optimizePrompt?: boolean;
}) {
  return {
    baseUrl: endpoint.baseUrl,
    model: endpoint.model,
    hasApiKey: Boolean(endpoint.apiKey),
    think: endpoint.think,
    apiFormat: endpoint.apiFormat === 'anthropic' ? 'anthropic' : 'openai',
    ...(typeof endpoint.optimizePrompt === 'boolean'
      ? { optimizePrompt: endpoint.optimizePrompt }
      : {})
  };
}

function parseEndpointBody(raw: unknown) {
  if (!raw || typeof raw !== 'object') return undefined;
  const body = raw as Record<string, unknown>;
  return {
    baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
    apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey : undefined,
    clearApiKey: body.clearApiKey === true,
    think: typeof body.think === 'boolean' ? body.think : undefined,
    apiFormat: typeof body.apiFormat === 'string' ? parseApiFormat(body.apiFormat) : undefined,
    optimizePrompt: typeof body.optimizePrompt === 'boolean' ? body.optimizePrompt : undefined
  };
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const settings = getDualModelSettings();
  return NextResponse.json({
    small: publicEndpoint(settings.small),
    large: publicEndpoint(settings.large),
    storm: publicEndpoint(settings.storm),
    image: publicEndpoint(settings.image),
    // 兼容旧前端：顶层 = 小模型
    baseUrl: settings.small.baseUrl,
    model: settings.small.model,
    hasApiKey: Boolean(settings.small.apiKey),
    think: settings.small.think,
    dataRootDir: settings.dataRootDir,
    opencode: await readOpenCodeStatus()
  });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  try {
    const body = await request.json().catch(() => ({}));
    const settings = saveDualModelSettings({
      small: body.small
        ? parseEndpointBody(body.small)
        : body.baseUrl !== undefined || body.model !== undefined
          ? parseEndpointBody(body)
          : undefined,
      large: parseEndpointBody(body.large),
      storm: parseEndpointBody(body.storm),
      image: parseEndpointBody(body.image),
      dataRootDir: body.dataRootDir
    });
    return NextResponse.json({
      small: publicEndpoint(settings.small),
      large: publicEndpoint(settings.large),
      storm: publicEndpoint(settings.storm),
      image: publicEndpoint(settings.image),
      baseUrl: settings.small.baseUrl,
      model: settings.small.model,
      hasApiKey: Boolean(settings.small.apiKey),
      think: settings.small.think,
      dataRootDir: settings.dataRootDir
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : '保存失败'
    }, { status: 500 });
  }
}
