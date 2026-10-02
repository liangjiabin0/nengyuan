import fs from 'node:fs';
import path from 'node:path';

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('Usage: node scripts/restore-single.mjs src/lib/db.ts ...');
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.map')) out.push(p);
  }
  return out;
}

const maps = walk('.next');

for (const target of targets) {
  const normalizedTarget = target.replace(/\\/g, '/');
  let found = false;

  for (const mapPath of maps) {
    try {
      const raw = fs.readFileSync(mapPath, 'utf8');
      const j = JSON.parse(raw);
      if (!Array.isArray(j.sources) || !Array.isArray(j.sourcesContent)) continue;

      for (let i = 0; i < j.sources.length; i += 1) {
        const src = j.sources[i];
        const content = j.sourcesContent[i];
        if (!src || !content || content.length < 50) continue;

        const norm = src
          .replace(/\\/g, '/')
          .replace(/^\.\.\//, '')
          .replace(/^webpack:\/\/\//, '');

        if (!norm.endsWith(normalizedTarget) && !norm.includes(`/${normalizedTarget}`)) continue;
        if (content.includes('invokeRouteModule') || content.includes('BaseServerSpan')) continue;

        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
        console.log(`Restored ${target} from ${mapPath} (${content.length} chars)`);
        found = true;
        break;
      }
    } catch {
      // skip bad maps
    }
    if (found) break;
  }

  if (!found) console.log(`NOT FOUND: ${target}`);
}
