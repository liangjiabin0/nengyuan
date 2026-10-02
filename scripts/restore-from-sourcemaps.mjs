import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const nextDir = path.join(projectRoot, '.next');
const restored = new Map();

function addSource(source, content) {
  if (!source || !content) return;
  if (/node_modules|__nextjs-internal-proxy|webpack-internal/.test(source)) return;
  if (!/src\/(app|components|lib)\//.test(source.replace(/\\/g, '/'))) return;
  const match = source.replace(/\\/g, '/').match(/src\/((?:app|components|lib)\/.+)$/);
  if (!match) return;
  if (/^export default "[0-9a-f]+"$/.test(content.trim())) return;

  const rel = match[1];
  const target = path.join(projectRoot, 'src', rel);
  const prev = restored.get(target);
  if (!prev || content.length > prev.length) {
    restored.set(target, content);
  }
}

function importMap(map) {
  if (!map?.sources || !map?.sourcesContent) return;
  for (let i = 0; i < map.sources.length; i++) {
    addSource(String(map.sources[i] ?? ''), String(map.sourcesContent[i] ?? ''));
  }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.name.endsWith('.map') && !entry.name.endsWith('.js')) continue;
    let raw;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (entry.name.endsWith('.map') && raw.includes('sourcesContent')) {
      try {
        importMap(JSON.parse(raw));
      } catch {}
      continue;
    }
    const inline = /sourceMappingURL=data:application\/json;charset=utf-8;base64,([A-Za-z0-9+/=]+)/g;
    let match;
    while ((match = inline.exec(raw))) {
      try {
        const json = Buffer.from(match[1], 'base64').toString('utf8');
        if (!json.includes('sourcesContent')) continue;
        importMap(JSON.parse(json));
      } catch {}
    }
  }
}

walk(nextDir);

let count = 0;
for (const [target, content] of restored) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  count++;
}

const byExt = {};
for (const target of restored.keys()) {
  const ext = path.extname(target) || '(none)';
  byExt[ext] = (byExt[ext] ?? 0) + 1;
}

console.log(`Restored ${count} source files.`);
for (const [ext, n] of Object.entries(byExt).sort()) {
  console.log(`  ${ext}: ${n}`);
}
