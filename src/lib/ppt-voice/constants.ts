import type { PptVoiceVoiceSettings } from './types';

export const PPT_VOICE_API_BASE = '/api/ppt-voice';
export const PPT_VOICE_WORKSPACE_SCOPE = 'ppt-voice';
export const PPT_VOICE_MAX_BYTES = 200 * 1024 * 1024;
export const PPT_VOICE_ACCEPT = '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation';

export const PPT_VOICE_MODELS = [
  { id: 'cosyvoice-v3-flash', label: 'CosyVoice v3 Flash', price: '1.0' },
  { id: 'cosyvoice-v3.5-flash', label: 'CosyVoice v3.5 Flash', price: '2.0' },
  { id: 'cosyvoice-v3.5-plus', label: 'CosyVoice v3.5 Plus', price: '3.5' }
] as const;

export const PPT_VOICE_PRESETS = [
  { id: 'longshuo_v3', label: '龙朔 · 沉稳男中音', hint: '正式技术汇报' },
  { id: 'longxiaochun_v3', label: '龙小淳 · 清亮女声', hint: '清晰讲解' },
  { id: 'longhua_v3', label: '龙华 · 温和女声', hint: '培训讲解' },
  { id: 'longshu_v3', label: '龙书 · 叙事男声', hint: '专题解说' },
  { id: 'longxiaoxia_v3', label: '龙小夏 · 干练女声', hint: '短汇报' }
] as const;

export const DEFAULT_PPT_VOICE: PptVoiceVoiceSettings = {
  model: 'cosyvoice-v3-flash',
  voiceId: 'longshuo_v3',
  profileName: '龙朔·正式科技汇报',
  instruction: '正式自然的技术汇报语气，语速稍慢，停顿清晰，避免新闻播音腔。',
  rate: 0.92,
  pitch: 0.96,
  volume: 58,
  seed: 12345,
  emptyNotePolicy: 'error',
  transitionBufferSeconds: 0.8,
  lastSlideHoldSeconds: 4,
  minimumSlideSeconds: 2
};

export const PPT_VOICE_STAGE_LABELS: Record<string, string> = {
  draft: '已上传',
  ready: '备注就绪',
  checking: '预检中',
  generating: '配音中',
  done: '已完成',
  failed: '失败'
};
