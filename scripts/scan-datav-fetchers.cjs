const fs = require('fs');
const s = fs.readFileSync(process.env.TEMP + '/datav-24.js', 'utf8');

function dumpAround(label, idx, before, after) {
  console.log('\n====', label, 'at', idx, '====');
  console.log(s.slice(Math.max(0, idx - before), idx + after));
}

// Cube 1962 fetchers
let idx = s.indexOf('Cube(1962');
dumpAround('Cube(1962)', idx, 0, 2500);
idx = s.indexOf('Cube(1968');
dumpAround('Cube(1968)', idx, 0, 1800);
idx = s.indexOf('Cube(1969');
dumpAround('Cube(1969)', idx, 0, 1800);
idx = s.indexOf('Cube(1970');
dumpAround('Cube(1970)', idx, 0, 1800);
idx = s.indexOf('Cube(1971');
dumpAround('Cube(1971)', idx, 0, 1800);
idx = s.indexOf('Cube(1972');
dumpAround('Cube(1972)', idx, 0, 1800);

idx = s.indexOf('this.request=function');
dumpAround('request fn', idx, 200, 800);

idx = s.indexOf('var V=');
// too many. find near queryDataCenter
idx = s.lastIndexOf('V=', s.indexOf('queryDataCenter'));
dumpAround('V assignment near queryDC', idx, 300, 400);
