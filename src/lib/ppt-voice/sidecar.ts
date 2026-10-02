import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childMetaForModule, trackChildProcess } from '@/lib/runtime-children';
import { getPptVoiceTtsSettings } from './settings';
import type { PptVoiceHealth } from './types';

const TOOL_ROOT = path.join(process.cwd(), 'tools', 'ppt-voice');
const VENV_PYTHON = process.platform === 'win32'
  ? path.join(process.cwd(), 'tools', 'ppt-voice-venv', 'Scripts', 'python.exe')
  : path.join(process.cwd(), 'tools', 'ppt-voice-venv', 'bin', 'python');

export type PptVoiceAgentEvent = {
  type?: string;
  ok?: boolean;
  message?: string;
  current?: number;
  total?: number;
  error?: string;
  [key: string]: unknown;
};

function resolvePython() {
  const envPython = process.env.PPT_VOICE_PYTHON?.trim();
  const configured = envPython
    ? (path.isAbsolute(envPython) ? envPython : path.resolve(process.cwd(), envPython))
    : undefined;
  const candidates = [configured, VENV_PYTHON].filter((value): value is string => Boolean(value));
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return { command: found, prefix: [] as string[] };
  return { command: process.platform === 'win32' ? 'python' : 'python3', prefix: [] as string[] };
}

function agentEnv(extra?: Record<string, string | undefined>) {
  const tts = getPptVoiceTtsSettings();
  return {
    ...process.env,
    PYTHONPATH: `${path.join(TOOL_ROOT, 'src')}${path.delimiter}${TOOL_ROOT}`,
    PYTHONIOENCODING: 'utf-8',
    DASHSCOPE_API_KEY: extra?.DASHSCOPE_API_KEY ?? tts.dashscopeApiKey,
    BAILIAN_WORKSPACE_ID: extra?.BAILIAN_WORKSPACE_ID ?? tts.workspaceId,
    BAILIAN_BASE_URL: extra?.BAILIAN_BASE_URL ?? tts.baseUrl,
    ...extra
  };
}

function parseJsonLines(text: string) {
  const events: PptVoiceAgentEvent[] = [];
  let result: PptVoiceAgentEvent | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as PptVoiceAgentEvent;
      if (parsed.type === 'progress') events.push(parsed);
      else result = parsed;
    } catch {
      // ignore non-JSON noise
    }
  }
  if (!result) {
    const start = text.lastIndexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        result = JSON.parse(text.slice(start, end + 1)) as PptVoiceAgentEvent;
      } catch {
        result = null;
      }
    }
  }
  return { events, result };
}

function assertToolRoot() {
  if (!fs.existsSync(TOOL_ROOT)) {
    throw new Error(`未找到 PPT 配音侧车目录：${TOOL_ROOT}`);
  }
}

export function runPptVoiceAgentSync(
  args: string[],
  options?: { timeoutMs?: number; env?: Record<string, string | undefined> }
) {
  assertToolRoot();
  const python = resolvePython();
  const result = spawnSync(python.command, [...python.prefix, '-u', '-m', 'ppt_voice_agent', ...args], {
    cwd: TOOL_ROOT,
    env: agentEnv(options?.env),
    encoding: 'utf8',
    timeout: options?.timeoutMs ?? 120_000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const parsed = parseJsonLines(stdout);
  if (!parsed.result) {
    throw new Error(stderr.trim() || `PPT 配音侧车无输出（exit ${result.status}）。`);
  }
  if (parsed.result.ok === false) {
    throw new Error(String(parsed.result.error || 'PPT 配音侧车执行失败。'));
  }
  return parsed.result;
}

export function runPptVoiceAgent(
  args: string[],
  options?: {
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
    onProgress?: (event: PptVoiceAgentEvent) => void;
  }
) {
  assertToolRoot();
  const python = resolvePython();
  return new Promise<PptVoiceAgentEvent>((resolve, reject) => {
    const child = spawn(python.command, [...python.prefix, '-u', '-m', 'ppt_voice_agent', ...args], {
      cwd: TOOL_ROOT,
      env: agentEnv(options?.env),
      windowsHide: true
    });
    trackChildProcess(child, childMetaForModule('ppt_voice_agent'));
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error('PPT 配音侧车超时。'));
      }
    }, options?.timeoutMs ?? 30 * 60 * 1000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const { events } = parseJsonLines(chunk);
      for (const event of events) options?.onProgress?.(event);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = parseJsonLines(stdout);
      if (!parsed.result) {
        reject(new Error(stderr.trim() || `PPT 配音侧车无输出（exit ${code}）。`));
        return;
      }
      if (parsed.result.ok === false) {
        reject(new Error(String(parsed.result.error || 'PPT 配音侧车执行失败。')));
        return;
      }
      resolve(parsed.result);
    });
  });
}

export function getPptVoiceHealth(): PptVoiceHealth {
  try {
    const result = runPptVoiceAgentSync(['health'], { timeoutMs: 20_000 });
    return {
      ok: Boolean(result.package && result.pptx),
      python: typeof result.python === 'string' ? result.python : undefined,
      package: Boolean(result.package),
      pptx: Boolean(result.pptx),
      powerpoint: Boolean(result.powerpoint),
      libreoffice: Boolean(result.libreoffice),
      ffmpeg: Boolean(result.ffmpeg),
      pdftoppm: Boolean(result.pdftoppm),
      embedEngine: typeof result.embedEngine === 'string' ? result.embedEngine : undefined,
      hasApiKey: Boolean(result.hasApiKey)
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
