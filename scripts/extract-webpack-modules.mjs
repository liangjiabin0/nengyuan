import fs from 'node:fs';
import path from 'node:path';

const modules = [
  'src/lib/papers.ts',
  'src/lib/normalize.ts',
  'src/lib/text.ts'
];

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

function unescapeEval(escaped) {
  return escaped
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function extractModule(raw, modulePath) {
  const marker = `/***/ "(rsc)/./${modulePath}":`;
  const idx = raw.indexOf(marker);
  if (idx < 0) return null;

  const evalStart = raw.indexOf('eval("', idx);
  if (evalStart < 0) return null;

  let i = evalStart + 6;
  let escaped = '';
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"' && raw[i - 1] !== '\\') break;
    escaped += ch;
    i += 1;
  }

  const code = unescapeEval(escaped);
  if (code.includes('invokeRouteModule') || code.includes('BaseServerSpan')) return null;
  return code;
}

const best = new Map();

for (const file of walk(path.join(process.cwd(), '.next'))) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  for (const modulePath of modules) {
    if (!raw.includes(modulePath)) continue;
    const extracted = extractModule(raw, modulePath);
    if (!extracted || extracted.length < 200) continue;
    const prev = best.get(modulePath);
    if (!prev || extracted.length > prev.length) best.set(modulePath, extracted);
  }
}

for (const modulePath of modules) {
  const content = best.get(modulePath);
  if (!content) {
    console.log(`MISSING ${modulePath}`);
    continue;
  }
  const target = path.join(process.cwd(), modulePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  console.log(`Extracted ${modulePath} (${content.length} chars)`);
}
