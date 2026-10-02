import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getDataRootDir } from './config';
import { resolveDataSubdirs } from './data-dirs';
import type { Database } from './db';
import { getDb, withTransaction } from './db';
import { upsertEntityInDb, upsertEdgeInDb } from './normalize';
import { indexMentorProfileInDb } from './search-index';

type MentorProfile = {
  mentorKey: string;
  name: string;
  school: string;
  college: string;
  major: string;
  email: string;
  phone: string;
  title: string;
  filePath: string;
  fileHash: string;
  content: string;
};

function fileHashBuffer(buf: Buffer) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

async function runInDb(db: Database, sql: string, params: unknown[] = []) {
  if (params.length) await db.prepare(sql).run(...params);
  else await db.prepare(sql).run();
}

const LONG_NAME_MAP = '_long-name-map.json';

type MentorNameMaps = {
  originalToShort: Map<string, string>;
  shortToOriginal: Map<string, string>;
  mtime: number;
};

let mentorNameMapsCache: MentorNameMaps | null = null;

function posixRel(value: string) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function collectLongNameMapFiles(mentorRoot: string) {
  const files: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string) => {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved) || !fs.existsSync(resolved)) return;
    seen.add(resolved);
    files.push(resolved);
  };
  add(path.join(mentorRoot, LONG_NAME_MAP));
  add(path.join(getDataRootDir(), LONG_NAME_MAP));
  add(path.join(getDataRootDir(), '导师信息', LONG_NAME_MAP));
  try {
    for (const entry of fs.readdirSync(mentorRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) add(path.join(mentorRoot, entry.name, LONG_NAME_MAP));
    }
  } catch {
    // ignore
  }
  return files;
}

export function loadMentorLongNameMaps(mentorRoot?: string): MentorNameMaps {
  const root = mentorRoot || resolveDataSubdirs().mentors;
  const files = collectLongNameMapFiles(root);
  let newest = 0;
  for (const file of files) {
    try {
      newest = Math.max(newest, fs.statSync(file).mtimeMs);
    } catch {
      // ignore
    }
  }
  if (mentorNameMapsCache && mentorNameMapsCache.mtime === newest) return mentorNameMapsCache;
  const originalToShort = new Map<string, string>();
  const shortToOriginal = new Map<string, string>();
  const remember = (from: string, to: string) => {
    const a = posixRel(from);
    const b = posixRel(to);
    if (!a || !b) return;
    originalToShort.set(a, b);
    originalToShort.set(path.basename(a), b);
    shortToOriginal.set(b, a);
    shortToOriginal.set(path.basename(b), a);
  };
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
      for (const [from, to] of Object.entries(parsed)) remember(from, to);
    } catch {
      // ignore malformed maps
    }
  }
  mentorNameMapsCache = { originalToShort, shortToOriginal, mtime: newest };
  return mentorNameMapsCache;
}

export function resolveMentorFilePath(filePath: string, mentorRoot?: string) {
  const raw = String(filePath || '').trim();
  if (!raw) return raw;
  if (fs.existsSync(raw)) return raw;
  const root = mentorRoot || resolveDataSubdirs().mentors;
  const maps = loadMentorLongNameMaps(root);
  const rel = posixRel(path.relative(root, raw));
  const candidates = [
    maps.originalToShort.get(posixRel(raw)),
    maps.originalToShort.get(rel),
    maps.originalToShort.get(path.basename(raw)),
    maps.shortToOriginal.get(posixRel(raw)),
    maps.shortToOriginal.get(rel),
    maps.shortToOriginal.get(path.basename(raw))
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const tries = [
      path.isAbsolute(candidate) ? candidate : '',
      path.join(root, candidate),
      path.join(root, path.basename(candidate)),
      path.join(getDataRootDir(), candidate),
      path.join(path.dirname(raw), path.basename(candidate))
    ].filter(Boolean);
    for (const full of tries) {
      if (fs.existsSync(full)) return full;
    }
  }
  return raw;
}

export function originalMentorBaseName(filePath: string, mentorRoot?: string) {
  const resolved = resolveMentorFilePath(filePath, mentorRoot);
  const maps = loadMentorLongNameMaps(mentorRoot);
  const original = maps.shortToOriginal.get(posixRel(resolved))
    || maps.shortToOriginal.get(path.basename(resolved))
    || maps.shortToOriginal.get(posixRel(filePath))
    || maps.shortToOriginal.get(path.basename(filePath));
  const source = original || resolved || filePath;
  return path.basename(source, path.extname(source));
}

function pickField(content: string, labels: string[]) {
  for (const label of labels) {
    const match = new RegExp(`[-*]\\s*\\*\\*${label}[：:]\\*\\*\\s*([^\\n]+)`, 'i').exec(content);
    if (match) return match[1].trim();
  }
  return '';
}

function parseMentorFromMarkdown(filePath: string, content: string, hash: string): MentorProfile {
  const fileName = originalMentorBaseName(filePath);
  const parts = fileName.split('+');
  const mentorKey = `mentor:${hash.slice(0, 24)}`;
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() || fileName;
  const name = pickField(content, ['姓名', '导师姓名', '姓名：']) || parts.at(-1)?.trim() || heading;
  return {
    mentorKey,
    name,
    school: pickField(content, ['学校', '学校名']) || parts[0]?.trim() || '',
    college: pickField(content, ['学院/单位', '学院', '单位']) || parts[1]?.trim() || '',
    major: pickField(content, ['专业', '招生专业']) || parts[2]?.trim() || '',
    email: pickField(content, ['邮箱', '电子邮件', 'E-mail']),
    phone: pickField(content, ['电话', '联系电话']),
    title: pickField(content, ['职称', '职务']),
    filePath,
    fileHash: hash,
    content
  };
}

async function upsertMentorInDb(db: Database, mentor: MentorProfile) {
  await runInDb(
    db,
    `INSERT INTO mentor_profiles(
      mentor_key, name, school, college, major, email, phone, title, file_path, file_hash, content, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(mentor_key) DO UPDATE SET
      name=excluded.name,
      school=excluded.school,
      college=excluded.college,
      major=excluded.major,
      email=excluded.email,
      phone=excluded.phone,
      title=excluded.title,
      file_path=excluded.file_path,
      file_hash=excluded.file_hash,
      content=excluded.content,
      updated_at=CURRENT_TIMESTAMP`,
    [
      mentor.mentorKey,
      mentor.name,
      mentor.school || null,
      mentor.college || null,
      mentor.major || null,
      mentor.email || null,
      mentor.phone || null,
      mentor.title || null,
      mentor.filePath,
      mentor.fileHash,
      mentor.content
    ]
  );

  const person = await upsertEntityInDb(db, 'person', mentor.name, { mentorKey: mentor.mentorKey, school: mentor.school, college: mentor.college });
  await upsertEdgeInDb(db, mentor.mentorKey, person, 'entity', 8);
  if (mentor.school) await upsertEdgeInDb(db, mentor.mentorKey, await upsertEntityInDb(db, 'institution', mentor.school), 'affiliated_with', 5);
  if (mentor.college) await upsertEdgeInDb(db, mentor.mentorKey, await upsertEntityInDb(db, 'institution', mentor.college), 'affiliated_with', 4);
  if (mentor.major) await upsertEdgeInDb(db, mentor.mentorKey, await upsertEntityInDb(db, 'discipline', mentor.major), 'mentors_in', 4);

  if (process.env.SKIP_INLINE_INDEX !== '1') {
    await indexMentorProfileInDb(db, {
      mentor_key: mentor.mentorKey,
      name: mentor.name,
      school: mentor.school,
      college: mentor.college,
      major: mentor.major,
      email: mentor.email,
      phone: mentor.phone,
      title: mentor.title,
      file_path: mentor.filePath,
      content: mentor.content
    });
  }
}

export function listMentorFiles(dir: string) {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.name.toLowerCase().endsWith('.md')) files.push(fullPath);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return files.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

export async function ingestMentorFile(filePath: string) {
  const buf = fs.readFileSync(filePath);
  const hash = fileHashBuffer(buf);
  if (process.env.SKIP_EXISTING_MENTORS === '1') {
    const existing = await getDb().prepare('SELECT mentor_key, name FROM mentor_profiles WHERE file_hash = ?').get<{
      mentor_key: string;
      name: string;
    }>(hash);
    if (existing) {
      return {
        mentorKey: existing.mentor_key,
        name: existing.name,
        school: '',
        college: '',
        major: '',
        filePath,
        skipped: true as const
      };
    }
  }
  const content = buf.toString('utf8');
  const mentor = parseMentorFromMarkdown(filePath, content, hash);
  await withTransaction(async (db) => await upsertMentorInDb(db, mentor), true);
  return {
    mentorKey: mentor.mentorKey,
    name: mentor.name,
    school: mentor.school,
    college: mentor.college,
    major: mentor.major,
    filePath,
    skipped: false as const
  };
}

export async function ingestMentorDirectory(dir: string) {
  const files = listMentorFiles(dir);
  const results: Array<Awaited<ReturnType<typeof ingestMentorFile>>> = [];
  const errors: Array<{ filePath: string; error: string }> = [];
  const changedKeys: string[] = [];
  let skipped = 0;
  for (const file of files) {
    try {
      const item = await ingestMentorFile(file);
      results.push(item);
      if (item.skipped) skipped += 1;
      else changedKeys.push(item.mentorKey);
    } catch (error) {
      errors.push({ filePath: file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    dir,
    files: files.length,
    imported: results.length,
    failed: errors.length,
    skipped,
    changedKeys,
    results: results.slice(0, 20),
    errors: errors.slice(0, 20)
  };
}

export function extractMentorZip(zipPath: string, outputDir: string) {
  fs.mkdirSync(outputDir, { recursive: true });
  const mapPath = path.join(outputDir, LONG_NAME_MAP);
  const script = `
import json, os, hashlib, zipfile
from pathlib import Path
zip_path = r${JSON.stringify(zipPath)}
out_dir = Path(r${JSON.stringify(outputDir)})
map_path = Path(r${JSON.stringify(mapPath)})
out_dir.mkdir(parents=True, exist_ok=True)
mapping = {}
if map_path.exists():
    try:
        mapping = json.loads(map_path.read_text(encoding="utf-8"))
    except Exception:
        mapping = {}
limit = 200
count = 0
with zipfile.ZipFile(zip_path) as zf:
    for member in zf.namelist():
        if not member.lower().endswith(".md") or member.endswith("/"):
            continue
        original = Path(member).name
        ext = "".join(Path(original).suffixes[-1:]) or ".md"
        stem = original[:-len(ext)] if original.endswith(ext) else original
        raw = original.encode("utf-8")
        name = original
        if len(raw) > limit:
            digest = hashlib.sha1(original.encode("utf-8")).hexdigest()[:10]
            cut = stem
            while len(f"{cut}_{digest}{ext}".encode("utf-8")) > limit and len(cut) > 1:
                cut = cut[:-2]
            name = f"{cut}_{digest}{ext}"
            mapping[original] = name
            mapping[member.replace("\\\\", "/")] = name
        target = out_dir / name
        if target.exists():
            continue
        with zf.open(member) as src, open(target, "wb") as dst:
            dst.write(src.read())
        count += 1
if mapping:
    map_path.write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")
print(count)
`;
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const count = Number(execFileSync(python, ['-c', script], { encoding: 'utf8' }).trim() || '0');
  mentorNameMapsCache = null;
  return { zipPath, outputDir, extracted: count };
}
