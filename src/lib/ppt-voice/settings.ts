import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PPT_VOICE } from './constants';
import type { PptVoiceTtsSettings, PptVoiceVoiceSettings } from './types';

const settingsPath = path.join(process.cwd(), 'storage', 'ppt-voice-settings.json');

const DEFAULT_TTS: PptVoiceTtsSettings = {
  dashscopeApiKey: process.env.DASHSCOPE_API_KEY || '',
  workspaceId: process.env.BAILIAN_WORKSPACE_ID || '',
  baseUrl:
    process.env.BAILIAN_BASE_URL
    || '',
  model: DEFAULT_PPT_VOICE.model,
  voiceId: DEFAULT_PPT_VOICE.voiceId,
  profileName: DEFAULT_PPT_VOICE.profileName,
  instruction: DEFAULT_PPT_VOICE.instruction,
  rate: DEFAULT_PPT_VOICE.rate,
  pitch: DEFAULT_PPT_VOICE.pitch,
  volume: DEFAULT_PPT_VOICE.volume,
  seed: DEFAULT_PPT_VOICE.seed
};

function readStored(): Partial<PptVoiceTtsSettings> {
  try {
    if (!fs.existsSync(settingsPath)) return {};
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')) as Partial<PptVoiceTtsSettings>;
  } catch {
    return {};
  }
}

export function getPptVoiceTtsSettings(): PptVoiceTtsSettings {
  const stored = readStored();
  return {
    dashscopeApiKey: stored.dashscopeApiKey ?? process.env.DASHSCOPE_API_KEY ?? DEFAULT_TTS.dashscopeApiKey,
    workspaceId: stored.workspaceId ?? process.env.BAILIAN_WORKSPACE_ID ?? DEFAULT_TTS.workspaceId,
    baseUrl: stored.baseUrl ?? process.env.BAILIAN_BASE_URL ?? DEFAULT_TTS.baseUrl,
    model: stored.model || DEFAULT_TTS.model,
    voiceId: stored.voiceId || DEFAULT_TTS.voiceId,
    profileName: stored.profileName || DEFAULT_TTS.profileName,
    instruction: stored.instruction || DEFAULT_TTS.instruction,
    rate: typeof stored.rate === 'number' ? stored.rate : DEFAULT_TTS.rate,
    pitch: typeof stored.pitch === 'number' ? stored.pitch : DEFAULT_TTS.pitch,
    volume: typeof stored.volume === 'number' ? stored.volume : DEFAULT_TTS.volume,
    seed: typeof stored.seed === 'number' ? stored.seed : DEFAULT_TTS.seed
  };
}

export function savePptVoiceTtsSettings(input: Partial<PptVoiceTtsSettings> & { clearApiKey?: boolean }) {
  const current = getPptVoiceTtsSettings();
  const next: PptVoiceTtsSettings = {
    dashscopeApiKey: input.clearApiKey
      ? ''
      : input.dashscopeApiKey?.trim()
        ? input.dashscopeApiKey.trim()
        : current.dashscopeApiKey,
    workspaceId: input.workspaceId !== undefined ? input.workspaceId.trim() : current.workspaceId,
    baseUrl: input.baseUrl !== undefined ? input.baseUrl.trim() : current.baseUrl,
    model: input.model?.trim() || current.model,
    voiceId: input.voiceId?.trim() || current.voiceId,
    profileName: input.profileName?.trim() || current.profileName,
    instruction: input.instruction !== undefined ? input.instruction : current.instruction,
    rate: typeof input.rate === 'number' ? input.rate : current.rate,
    pitch: typeof input.pitch === 'number' ? input.pitch : current.pitch,
    volume: typeof input.volume === 'number' ? input.volume : current.volume,
    seed: typeof input.seed === 'number' ? input.seed : current.seed
  };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function publicTtsSettings(settings = getPptVoiceTtsSettings()) {
  return {
    hasApiKey: Boolean(settings.dashscopeApiKey),
    workspaceId: settings.workspaceId,
    baseUrl: settings.baseUrl,
    model: settings.model,
    voiceId: settings.voiceId,
    profileName: settings.profileName,
    instruction: settings.instruction,
    rate: settings.rate,
    pitch: settings.pitch,
    volume: settings.volume,
    seed: settings.seed
  };
}

export function defaultVoiceFromTts(settings = getPptVoiceTtsSettings()): PptVoiceVoiceSettings {
  return {
    ...DEFAULT_PPT_VOICE,
    model: settings.model,
    voiceId: settings.voiceId,
    profileName: settings.profileName,
    instruction: settings.instruction,
    rate: settings.rate,
    pitch: settings.pitch,
    volume: settings.volume,
    seed: settings.seed
  };
}
