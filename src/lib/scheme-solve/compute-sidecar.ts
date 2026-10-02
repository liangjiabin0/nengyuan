import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childMetaForModule, trackChildProcess } from '@/lib/runtime-children';

function projectPath(value: string) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

export function venvPython(venvDir: string) {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

export type SidecarPayload = {
  ok?: boolean;
  type?: string;
  error?: string;
  engine?: string;
  status?: string;
  success?: boolean;
  fixture?: boolean;
  objective?: unknown;
  [key: string]: unknown;
};

export function resolvePython(envName: string, venvDir?: string) {
  const configured = process.env[envName]?.trim();
  const candidates = [
    configured ? projectPath(configured) : '',
    venvDir ? venvPython(venvDir) : '',
    ...(process.platform === 'win32' ? [] : ['python3']),
    'python'
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => candidate === 'python' || candidate === 'python3' || fs.existsSync(candidate)) || 'python';
}

export function extractBalancedJson(text: string, start: number) {
  const open = text[start];
  const close = open === '{' ? '}' : open === '[' ? ']' : '';
  if (!close) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export function parseJsonPayload(text: string): SidecarPayload | null {
  const candidates: SidecarPayload[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '{' || char === '[') {
      const slice = extractBalancedJson(text, index);
      if (slice) {
        try {
          candidates.push(JSON.parse(slice) as SidecarPayload);
        } catch {
          // keep looking
        }
        index += slice.length;
        continue;
      }
    }
    index += 1;
  }
  return candidates.at(-1) || null;
}

export function runPythonModuleSync(input: {
  root: string;
  module: string;
  args: string[];
  python: string;
  extraPath?: string[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}) {
  const pythonPath = [input.root, ...(input.extraPath || [])].join(path.delimiter);
  const result = spawnSync(input.python, ['-u', '-m', input.module, ...input.args], {
    cwd: input.root,
    env: {
      ...process.env,
      PYTHONPATH: pythonPath,
      PYTHONIOENCODING: 'utf-8',
      MPLBACKEND: 'Agg',
      ...input.env
    },
    encoding: 'utf8',
    timeout: input.timeoutMs === 0 ? undefined : input.timeoutMs ?? 60_000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  const parsed = parseJsonPayload(String(result.stdout || ''));
  if (!parsed) {
    throw new Error(String(result.stderr || '').trim() || `${input.module} 无输出（exit ${result.status}）。`);
  }
  if (parsed.ok === false) {
    throw new Error(String(parsed.error || `${input.module} 执行失败。`));
  }
  return parsed;
}

export function runPythonModule(input: {
  root: string;
  module: string;
  args: string[];
  python: string;
  extraPath?: string[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}) {
  const pythonPath = [input.root, ...(input.extraPath || [])].join(path.delimiter);
  return new Promise<SidecarPayload>((resolve, reject) => {
    const child = spawn(input.python, ['-u', '-m', input.module, ...input.args], {
      cwd: input.root,
      env: {
        ...process.env,
        PYTHONPATH: pythonPath,
        PYTHONIOENCODING: 'utf-8',
        MPLBACKEND: 'Agg',
        ...input.env
      },
      windowsHide: true
    });
    trackChildProcess(child, childMetaForModule(input.module));
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = input.timeoutMs ?? 30 * 60 * 1000;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          child.kill();
          if (!settled) {
            settled = true;
            reject(new Error(`${input.module} 执行超时。`));
          }
        }, timeoutMs)
      : null;
    const abort = () => {
      if (!settled) child.kill();
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      if (input.signal?.aborted) {
        reject(new DOMException('执行已取消。', 'AbortError'));
        return;
      }
      const parsed = parseJsonPayload(stdout);
      if (!parsed) {
        reject(new Error(stderr.trim() || `${input.module} 无输出（exit ${code}）。`));
        return;
      }
      if (parsed.ok === false) {
        reject(new Error(String(parsed.error || `${input.module} 执行失败。`)));
        return;
      }
      resolve(parsed);
    });
  });
}
