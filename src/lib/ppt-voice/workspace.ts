import fs from 'node:fs';
import path from 'node:path';
import { PPT_VOICE_WORKSPACE_SCOPE } from './constants';
import type { PptVoiceSlide, PptVoiceVoiceSettings } from './types';

export function pptVoiceWorkspaceRoot(projectId: string) {
  return path.join(process.cwd(), 'storage', PPT_VOICE_WORKSPACE_SCOPE, projectId);
}

export function pptVoiceSourcePath(projectId: string) {
  return path.join(pptVoiceWorkspaceRoot(projectId), 'source.pptx');
}

export function pptVoiceWorkingPath(projectId: string) {
  return path.join(pptVoiceWorkspaceRoot(projectId), 'working.pptx');
}

export function isPptxFile(filePath: string) {
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 64) return false;
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(4);
    fs.readSync(fd, header, 0, 4, 0);
    fs.closeSync(fd);
    return header[0] === 0x50 && header[1] === 0x4b;
  } catch {
    return false;
  }
}

export function assertPptxFile(filePath: string, label: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label}不存在：${path.basename(filePath)}`);
  }
  if (!isPptxFile(filePath)) {
    throw new Error(`${label}不是有效的 PPTX，可能正在被占用或上次写入未完成。`);
  }
}

export function pptVoiceConfigPath(projectId: string) {
  return path.join(pptVoiceWorkspaceRoot(projectId), 'config.yaml');
}

export function pptVoiceNotesPath(projectId: string) {
  return path.join(pptVoiceWorkspaceRoot(projectId), 'notes.json');
}

export function pptVoicePreviewPath(projectId: string, slideIndex: number) {
  return path.join(pptVoiceWorkspaceRoot(projectId), 'preview', `slide-${String(slideIndex).padStart(3, '0')}.mp3`);
}

export function pptVoiceSlidesDir(projectId: string) {
  return path.join(pptVoiceWorkspaceRoot(projectId), 'slides');
}

export function pptVoiceSlideImagePath(projectId: string, slideIndex: number) {
  return path.join(pptVoiceSlidesDir(projectId), `slide-${String(slideIndex).padStart(3, '0')}.png`);
}

export function countPptVoiceSlideImages(projectId: string) {
  const dir = pptVoiceSlidesDir(projectId);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((name) => /^slide-\d+\.png$/i.test(name)).length;
}

export function hasPptVoiceSlideImages(projectId: string, expected = 1) {
  return countPptVoiceSlideImages(projectId) >= expected;
}

export function pptVoiceOutputDir(projectId: string) {
  return path.join(pptVoiceWorkspaceRoot(projectId), 'output');
}

export function ensurePptVoiceWorkspace(projectId: string) {
  const root = pptVoiceWorkspaceRoot(projectId);
  fs.mkdirSync(path.join(root, 'output'), { recursive: true });
  fs.mkdirSync(path.join(root, 'preview'), { recursive: true });
  fs.mkdirSync(path.join(root, 'slides'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  return root;
}

export function deletePptVoiceWorkspace(projectId: string) {
  const root = pptVoiceWorkspaceRoot(projectId);
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
}

export function writeSourcePptx(projectId: string, buffer: Buffer) {
  const root = ensurePptVoiceWorkspace(projectId);
  const filePath = pptVoiceSourcePath(projectId);
  fs.writeFileSync(filePath, buffer);
  return { root, filePath };
}

export function writeNotesJson(projectId: string, slides: Array<Pick<PptVoiceSlide, 'slideIndex' | 'notes'>>) {
  const filePath = pptVoiceNotesPath(projectId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      notes: slides.map((slide) => ({ slideIndex: slide.slideIndex, text: slide.notes || '' }))
    }, null, 2)}\n`,
    'utf8'
  );
  return filePath;
}

function yamlScalar(value: string) {
  if (value === '') return '""';
  if (/[:#\n"'\\]/.test(value) || value.includes('\n')) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return value;
}

export function writeProjectConfig(
  projectId: string,
  voice: PptVoiceVoiceSettings,
  options?: { pronunciationFile?: string }
) {
  const root = ensurePptVoiceWorkspace(projectId);
  const pronunciation = options?.pronunciationFile
    || path.join(process.cwd(), 'tools', 'ppt-voice', 'profiles', 'pronunciation.yaml');
  const body = [
    'bailian:',
    '  region: "cn-beijing"',
    `  model: ${yamlScalar(voice.model)}`,
    '  preview_model: "cosyvoice-v3-flash"',
    '  request_timeout_seconds: 180',
    '  max_retries: 3',
    '  sample_rate: 24000',
    '  prices_per_10k_chars:',
    '    cosyvoice-v3.5-plus: "3.5"',
    '    cosyvoice-v3.5-flash: "2.0"',
    '    cosyvoice-v3-flash: "1.0"',
    'voice:',
    `  profile_name: ${yamlScalar(voice.profileName)}`,
    `  voice_id: ${yamlScalar(voice.voiceId)}`,
    `  instruction: ${yamlScalar(voice.instruction || '')}`,
    `  rate: ${voice.rate}`,
    `  pitch: ${voice.pitch}`,
    `  volume: ${voice.volume}`,
    `  seed: ${voice.seed}`,
    'timing:',
    `  transition_buffer_seconds: ${voice.transitionBufferSeconds}`,
    `  last_slide_hold_seconds: ${voice.lastSlideHoldSeconds}`,
    `  minimum_slide_seconds: ${voice.minimumSlideSeconds}`,
    '  advance_on_click: false',
    'notes:',
    `  empty_note_policy: ${yamlScalar(voice.emptyNotePolicy)}`,
    'project:',
    '  output_suffix: "_自动配音版"',
    `  cache_dir: ${yamlScalar(path.join(root, 'cache'))}`,
    `  work_dir: ${yamlScalar(path.join(root, 'work'))}`,
    `  output_dir: ${yamlScalar(path.join(root, 'output'))}`,
    `  pronunciation_file: ${yamlScalar(pronunciation)}`
  ].join('\n');
  const filePath = pptVoiceConfigPath(projectId);
  fs.writeFileSync(filePath, `${body}\n`, 'utf8');
  return filePath;
}

function isTempMediaName(name: string) {
  const lower = name.toLowerCase();
  return lower.includes('.exporting.') || lower.includes('.building.') || lower.includes('.tmp.');
}

export function isUnlockedFile(filePath: string, minBytes = 1024) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (stat.size < minBytes) return false;
    const fd = fs.openSync(filePath, 'r');
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

export function findOutputFiles(projectId: string) {
  const dir = pptVoiceOutputDir(projectId);
  if (!fs.existsSync(dir)) return { pptx: '', mp4: '', report: '', manifest: '' };
  const files = fs.readdirSync(dir);
  const pptx = files.find((name) => name.toLowerCase().endsWith('.pptx') && !isTempMediaName(name)) || '';
  const preferredMp4 = pptx ? `${pptx.replace(/\.pptx$/i, '')}.mp4` : '';
  const mp4Candidates = files.filter((name) => name.toLowerCase().endsWith('.mp4') && !isTempMediaName(name));
  const mp4 = (preferredMp4 && mp4Candidates.includes(preferredMp4) ? preferredMp4 : mp4Candidates[0]) || '';
  const report = files.find((name) => name.endsWith('_生成报告.html')) || '';
  const manifest = files.find((name) => name.endsWith('_manifest.json')) || '';
  const mp4Path = mp4 ? path.join(dir, mp4) : '';
  return {
    pptx: pptx ? path.join(dir, pptx) : '',
    mp4: mp4Path && isUnlockedFile(mp4Path) ? mp4Path : '',
    report: report ? path.join(dir, report) : '',
    manifest: manifest ? path.join(dir, manifest) : ''
  };
}

export function hasPptVoiceOutput(projectId: string) {
  return Boolean(findOutputFiles(projectId).pptx);
}

export function hasPptVoiceVideo(projectId: string) {
  return Boolean(findOutputFiles(projectId).mp4);
}

export function hasPptVoiceReport(projectId: string) {
  return Boolean(findOutputFiles(projectId).report);
}
