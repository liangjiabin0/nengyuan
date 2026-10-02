const fs = require('fs');
const s = fs.readFileSync(process.env.TEMP + '/datav-24.js', 'utf8');
const keys = [
  'dc.datav',
  'datacenter',
  'serviceBase',
  'dcConfig',
  '"static"',
  'type:"static"',
  "type:'static'",
  'useFilter',
  'pageFilters',
  'source.data',
  'getStaticData',
  'staticData'
];
for (const k of keys) {
  let idx = 0;
  let n = 0;
  while ((idx = s.indexOf(k, idx)) !== -1 && n < 2) {
    console.log('\n===', k, 'at', idx, '===');
    console.log(s.slice(Math.max(0, idx - 120), idx + 200).replace(/\n/g, ' '));
    idx += k.length;
    n += 1;
  }
  if (n === 0) console.log('\n===', k, 'NOT FOUND ===');
}
