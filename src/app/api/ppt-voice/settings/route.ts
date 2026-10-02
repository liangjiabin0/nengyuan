import { NextResponse } from 'next/server';
import { requireAdmin, requireUser } from '@/lib/auth/request';
import { getPptVoiceHealth } from '@/lib/ppt-voice/sidecar';
import { publicTtsSettings, savePptVoiceTtsSettings } from '@/lib/ppt-voice/settings';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  return NextResponse.json({
    ...publicTtsSettings(),
    health: getPptVoiceHealth()
  });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => ({}));
  const saved = savePptVoiceTtsSettings({
    dashscopeApiKey: typeof body.dashscopeApiKey === 'string' ? body.dashscopeApiKey : undefined,
    workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
    baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
    voiceId: typeof body.voiceId === 'string' ? body.voiceId : undefined,
    profileName: typeof body.profileName === 'string' ? body.profileName : undefined,
    instruction: typeof body.instruction === 'string' ? body.instruction : undefined,
    rate: typeof body.rate === 'number' ? body.rate : undefined,
    pitch: typeof body.pitch === 'number' ? body.pitch : undefined,
    volume: typeof body.volume === 'number' ? body.volume : undefined,
    seed: typeof body.seed === 'number' ? body.seed : undefined,
    clearApiKey: body.clearApiKey === true
  });
  return NextResponse.json({
    ...publicTtsSettings(saved),
    health: getPptVoiceHealth()
  });
}
