import fs from 'node:fs';
import path from 'node:path';

export const REMOVED_SKILLS_ROOT = path.join(process.cwd(), 'storage', '.opencode', 'removed-skills');
export const CUSTOMIZED_SKILLS_ROOT = path.join(process.cwd(), 'storage', '.opencode', 'customized-skills');
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function markerPath(root: string, name: string) {
  return path.join(root, name);
}

function hasMarker(root: string, name: string) {
  const key = String(name || '').trim();
  if (!NAME_RE.test(key)) return false;
  return fs.existsSync(markerPath(root, key));
}

function writeMarker(root: string, name: string) {
  const key = String(name || '').trim();
  if (!NAME_RE.test(key)) return;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(markerPath(root, key), '');
}

function clearMarker(root: string, name: string) {
  const key = String(name || '').trim();
  if (!NAME_RE.test(key)) return;
  const file = markerPath(root, key);
  if (fs.existsSync(file)) fs.rmSync(file);
}

export function isSystemSkillRemoved(name: string) {
  return hasMarker(REMOVED_SKILLS_ROOT, name);
}

export function markSystemSkillRemoved(name: string) {
  writeMarker(REMOVED_SKILLS_ROOT, name);
}

export function unmarkSystemSkillRemoved(name: string) {
  clearMarker(REMOVED_SKILLS_ROOT, name);
}

export function isSystemSkillCustomized(name: string) {
  return hasMarker(CUSTOMIZED_SKILLS_ROOT, name);
}

export function markSystemSkillCustomized(name: string) {
  writeMarker(CUSTOMIZED_SKILLS_ROOT, name);
}

export function unmarkSystemSkillCustomized(name: string) {
  clearMarker(CUSTOMIZED_SKILLS_ROOT, name);
}
