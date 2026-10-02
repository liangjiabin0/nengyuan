const fs = require('fs');
const s = fs.readFileSync(process.env.TEMP + '/datav-24.js', 'utf8');
const keys = ['getComponentApiData', 'createSuccessCallback', 'createWorker', 'S[e]', 'api_data'];
for (const k of keys) {
  let idx = 0;
  let n = 0;
  while ((idx = s.indexOf(k, idx)) !== -1 && n < 2) {
    console.log('\n===', k, 'at', idx, '===');
    console.log(s.slice(Math.max(0, idx - 250), idx + 350).replace(/\n/g, ' '));
    idx += k.length;
    n += 1;
  }
}
