import fs from 'node:fs';
import path from 'node:path';
import type { RagpackJobState } from './types';

const jobPath = path.join(process.cwd(), 'storage', 'ragpack-job.json');

let activeJob: Promise<unknown> | null = null;

const defaultState: RagpackJobState = { status: 'idle', phase: 'idle', message: '' };

export function getRagpackJobState(): RagpackJobState {
  try {
    if (fs.existsSync(jobPath)) {
      return { ...defaultState, ...JSON.parse(fs.readFileSync(jobPath, 'utf8')) };
    }
  } catch {
    // ignore
  }
  return defaultState;
}

export function updateRagpackJobState(patch: Partial<RagpackJobState>) {
  const next = { ...getRagpackJobState(), ...patch };
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.writeFileSync(jobPath, JSON.stringify(next, null, 2));
  return next;
}

export function resetRagpackJobState() {
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.writeFileSync(jobPath, JSON.stringify(defaultState, null, 2));
}

export function isRagpackJobRunning() {
  return getRagpackJobState().status === 'running';
}

export function setActiveRagpackJob(job: Promise<unknown> | null) {
  activeJob = job;
}

export function getActiveRagpackJob() {
  return activeJob;
}
