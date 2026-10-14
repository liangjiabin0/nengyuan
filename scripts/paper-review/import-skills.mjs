// 论文智能评审：把两份技能压缩包导入为固定版本快照。
//   node scripts/paper-review/import-skills.mjs --review <v8.zip> --ppt <v3.zip> [--force]
// 安全检查：zip 完整性、路径穿越、绝对路径、符号链接、解压总量、文件数、非 UTF-8 文件名。
// v8 内嵌的旧版 integrations/two-slide-paper-ppt-codegen/ 不导入（PPT 只走独立 v3）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

const ROOT = process.cwd();
const SKILLS_DIR = path.join(ROOT, '.opencode', 'skills');
const MAX_FILES = 512;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_RATIO = 200;

export const SKILL_TARGETS = {
  review: {
    dir: 'paper-peer-review-v8',
    zipRoot: 'paper-peer-review/',
    expectName: 'paper-peer-review',
    // 旧版两页 PPT 集成：不得被执行，导入时剔除
    exclude: [/^integrations\/two-slide-paper-ppt-codegen\//]
  },
  ppt: {
    dir: 'two-slide-paper-ppt-graphical-v3',
    zipRoot: 'two-slide-paper-ppt-codegen/',
    expectName: 'two-slide-paper-ppt-codegen',
    exclude: []
  }
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 读取并校验 zip，返回 [相对路径, 内容] 列表（已去掉 zipRoot 前缀）。 */
export async function readSafeZip(zipPath, target) {
  const raw = fs.readFileSync(zipPath);
  const zip = await JSZip.loadAsync(raw, { checkCRC32: true, decodeFileName: (bytes) => {
    const text = Buffer.from(bytes).toString('utf8');
    if (text.includes('�')) throw new Error('压缩包内有非 UTF-8 文件名');
    return text;
  } });
  const files = [];
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    const name = entry.name.replace(/\\/g, '/');
    if (entry.dir) continue;
    if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some((p) => p === '..')) {
      throw new Error(`压缩包含非法路径：${name}`);
    }
    // unix 权限高位 0o120000 表示符号链接
    const mode = entry.unixPermissions;
    if (typeof mode === 'number' && (mode & 0o170000) === 0o120000) throw new Error(`压缩包含符号链接：${name}`);
    if (name.startsWith('__MACOSX/') || path.posix.basename(name) === '.DS_Store') continue;
    if (!name.startsWith(target.zipRoot)) throw new Error(`文件不在预期根目录 ${target.zipRoot} 下：${name}`);
    const rel = name.slice(target.zipRoot.length);
    if (!rel || target.exclude.some((re) => re.test(rel))) continue;
    const content = await entry.async('nodebuffer');
    total += content.length;
    if (files.length >= MAX_FILES) throw new Error(`文件数超过 ${MAX_FILES}`);
    if (total > MAX_TOTAL_BYTES) throw new Error('解压后总大小超过限制');
    files.push([rel, content]);
  }
  if (total > raw.length * MAX_RATIO) throw new Error('压缩比异常，疑似压缩炸弹');
  const skill = files.find(([rel]) => rel === 'SKILL.md');
  if (!skill) throw new Error('压缩包根目录缺少 SKILL.md');
  return { files, zipSha256: sha256(raw), skillMd: skill[1].toString('utf8') };
}

function frontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  const version = m[1].match(/version:\s*["']?([\w.]+)/);
  if (version) out.version = version[1];
  return out;
}

/** 把 frontmatter 的 name 改成目录名，避免和其它技能重名；原名记在 original_name。 */
function renameSkill(md, newName, originalName) {
  return md.replace(/^(---\r?\n[\s\S]*?)^name:.*$/m, `$1name: ${newName}\noriginal_name: ${originalName}`);
}

export async function importSkill(kind, zipPath, { force = false } = {}) {
  const target = SKILL_TARGETS[kind];
  const { files, zipSha256, skillMd } = await readSafeZip(zipPath, target);
  const meta = frontmatter(skillMd);
  if (meta.name !== target.expectName) throw new Error(`SKILL.md 的 name 是 ${meta.name}，预期 ${target.expectName}`);
  const dest = path.join(SKILLS_DIR, target.dir);
  const snapshotPath = path.join(dest, 'skill-snapshot.json');
  if (fs.existsSync(snapshotPath) && !force) {
    const prev = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    if (prev.zipSha256 === zipSha256) return { dir: target.dir, unchanged: true, zipSha256 };
    throw new Error(`${target.dir} 已存在不同版本，加 --force 覆盖（旧版本会先备份）`);
  }
  const staging = `${dest}.importing-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  const manifest = [];
  for (const [rel, content] of files) {
    const out = path.join(staging, ...rel.split('/'));
    if (!out.startsWith(staging + path.sep)) throw new Error(`路径越界：${rel}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const data = rel === 'SKILL.md' ? Buffer.from(renameSkill(content.toString('utf8'), target.dir, meta.name)) : content;
    fs.writeFileSync(out, data);
    manifest.push({ path: rel, bytes: data.length, sha256: sha256(data) });
  }
  const snapshot = {
    skill: target.dir,
    originalName: meta.name,
    version: meta.version || null,
    sourceZip: path.basename(zipPath),
    zipSha256,
    importedAt: new Date().toISOString(),
    excluded: target.exclude.map(String),
    files: manifest.sort((a, b) => a.path.localeCompare(b.path))
  };
  snapshot.contentSha256 = sha256(JSON.stringify(snapshot.files));
  fs.writeFileSync(path.join(staging, 'skill-snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  if (fs.existsSync(dest)) {
    const backup = path.join(ROOT, 'storage', 'paper-review', 'skill-backups', `${target.dir}-${Date.now()}`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.renameSync(dest, backup);
  }
  fs.renameSync(staging, dest);
  return { dir: target.dir, version: snapshot.version, files: manifest.length, zipSha256, contentSha256: snapshot.contentSha256 };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/').replace(/^\//, '')}` || process.argv[1]?.endsWith('import-skills.mjs')) {
  const review = arg('review');
  const ppt = arg('ppt');
  const force = process.argv.includes('--force');
  if (!review && !ppt) {
    console.error('用法：node scripts/paper-review/import-skills.mjs --review <v8.zip> --ppt <v3.zip> [--force]');
    process.exit(2);
  }
  try {
    if (review) console.log(JSON.stringify(await importSkill('review', review, { force })));
    if (ppt) console.log(JSON.stringify(await importSkill('ppt', ppt, { force })));
  } catch (error) {
    console.error(`导入失败：${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
