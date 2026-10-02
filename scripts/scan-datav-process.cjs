const fs = require('fs');
const s = fs.readFileSync(process.env.TEMP + '/datav-24.js', 'utf8');
const idx = s.indexOf('processDataResult');
console.log(s.slice(idx, idx + 1200));
