const fs = require('fs');
const s = fs.readFileSync(process.env.TEMP + '/datav-24.js', 'utf8');
for (const id of [1968, 1971, 1973]) {
  const marker = `Cube(${id}`;
  const idx = s.indexOf(marker);
  const chunk = s.slice(idx, idx + 3500);
  const typeIdx = chunk.lastIndexOf('.type=');
  console.log('\n====', id, 'type snippet ====');
  console.log(chunk.slice(Math.max(0, typeIdx - 80), typeIdx + 80));
}
