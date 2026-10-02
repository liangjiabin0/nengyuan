const fs = require('fs');
const path = require('path');

const src = process.argv[2];
const dest = process.argv[3];
const s = fs.readFileSync(src, 'utf8');
const start = s.indexOf('module.exports = ') + 'module.exports = '.length;
const end = s.search(/;[\r\n]*return module\.exports/);
if (start < 17 || end < 0) {
  console.error('parse failed', { start, end });
  process.exit(1);
}
const cfg = JSON.parse(s.slice(start, end));
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(cfg));
console.log('wrote', dest, 'name=', cfg.name, 'bytes=', fs.statSync(dest).size);
