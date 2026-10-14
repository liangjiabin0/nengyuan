import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PaperReviewStage } from './types';

export const PAPER_REVIEW_ROOT = () => path.join(process.cwd(), 'storage', 'paper-review');

const ID_RE = /^[0-9a-f-]{36}$/i;

export function taskDir(id: string) {
  if (!ID_RE.test(id)) throw new Error('任务 ID 不合法');
  return path.join(PAPER_REVIEW_ROOT(), id);
}

/** 解析任务目录内的相对路径，拒绝越界、绝对路径和符号链接逃逸。 */
export function resolveInTask(id: string, relative: string) {
  const root = taskDir(id);
  const clean = String(relative || '').replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || /^[a-z]:/i.test(clean) || clean.split('/').includes('..')) {
    throw new Error('路径不合法');
  }
  const full = path.resolve(root, clean);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('路径越界');
  if (fs.existsSync(full)) {
    const real = fs.realpathSync(full);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('路径越界（符号链接）');
  }
  return full;
}

export function toTaskRelative(id: string, full: string) {
  return path.relative(taskDir(id), full).split(path.sep).join('/');
}

export function ensureTaskDirs(id: string) {
  const root = taskDir(id);
  for (const d of ['inputs', 'stages', 'work', 'reproduction', 'review', 'ppt', 'package', 'logs']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  return root;
}

export function sha256File(file: string) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function sha256Text(text: string | Buffer) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** 原子写文件：先写临时文件再改名，避免半成品被后续阶段读到。 */
export function writeFileAtomic(file: string, data: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file: string, value: unknown) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as T;
  } catch {
    return fallback;
  }
}

export type StageManifest = {
  stage: PaperReviewStage;
  cacheKey: string;
  finishedAt: string;
  outputs: Array<{ path: string; sha256: string; bytes: number }>;
  summary: Record<string, unknown>;
};

export function stageManifestPath(id: string, stage: PaperReviewStage) {
  return path.join(taskDir(id), 'stages', stage, 'manifest.json');
}

/** 写阶段 manifest（含输出文件 hash）；只有它落盘成功，阶段才算通过。 */
export function writeStageManifest(id: string, stage: PaperReviewStage, cacheKey: string, outputs: string[], summary: Record<string, unknown>) {
  const manifest: StageManifest = {
    stage,
    cacheKey,
    finishedAt: new Date().toISOString(),
    outputs: outputs.filter((f) => fs.existsSync(f)).map((f) => ({ path: toTaskRelative(id, f), sha256: sha256File(f), bytes: fs.statSync(f).size })),
    summary
  };
  writeJsonAtomic(stageManifestPath(id, stage), manifest);
  return manifest;
}

/** 检查点是否仍然有效：manifest 存在、cacheKey 相同、所有输出文件 hash 未变。 */
export function validStageCheckpoint(id: string, stage: PaperReviewStage, cacheKey: string): StageManifest | null {
  const manifest = readJson<StageManifest | null>(stageManifestPath(id, stage), null);
  if (!manifest || manifest.cacheKey !== cacheKey) return null;
  for (const out of manifest.outputs) {
    const full = path.join(taskDir(id), out.path);
    if (!fs.existsSync(full) || sha256File(full) !== out.sha256) return null;
  }
  return manifest;
}

export function invalidateStagesFrom(id: string, stages: readonly PaperReviewStage[]) {
  for (const stage of stages) fs.rmSync(path.join(taskDir(id), 'stages', stage), { recursive: true, force: true });
}

/** 文件名里去掉路径分隔符和控制字符，保留中文，限制长度。 */
export function safeFileName(name: string, fallback = 'file') {
  const base = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);
  return base && base !== '.' && base !== '..' ? base : fallback;
}
