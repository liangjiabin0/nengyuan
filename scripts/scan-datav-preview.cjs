const fs = require('fs');
const s = fs.readFileSync(process.env.TEMP + '/datav-preview.js', 'utf8');
const keys = [
  'datacenter',
  'dcConfig',
  'static',
  'source.data',
  'fetchData',
  'dataCenter',
  'getData',
  'useFilter',
  'pageFilter',
  'dc.datav'
];
for (const k of keys) {
  let idx = 0;
  let n = 0;
  while ((idx = s.indexOf(k, idx)) !== -1 && n < 3) {
    console.log('\n===', k, 'at', idx, '===');
    console.log(s.slice(Math.max(0, idx - 100), idx + 180));
    idx += k.length;
    n += 1;
  }
  if (n === 0) console.log('\n===', k, 'NOT FOUND ===');
}
