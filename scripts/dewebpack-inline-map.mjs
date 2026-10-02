import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node scripts/dewebpack-inline-map.mjs src/lib/text.ts ...');
  process.exit(1);
}

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const match = raw.match(/sourceMappingURL=data:application\/json;charset=utf-8;base64,([A-Za-z0-9+/=]+)/);
  if (!match) {
    console.log(`No inline map: ${file}`);
    continue;
  }

  const map = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
  const content = map.sourcesContent?.[0];
  if (!content || content.includes('__webpack_require__')) {
    console.log(`No TS source in map: ${file}`);
    continue;
  }

  fs.writeFileSync(file, content, 'utf8');
  console.log(`Restored ${file} from inline map (${content.length} chars)`);
}
