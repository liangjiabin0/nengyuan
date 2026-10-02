const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('src/lib/datav-logistics-config.json', 'utf8'));
console.log('config keys', Object.keys(cfg.config));
console.log(JSON.stringify({
  ifLogo: cfg.config.ifLogo,
  ifUserWatermark: cfg.config.ifUserWatermark,
  watermark: cfg.config.watermark,
  logo: cfg.config.logo
}, null, 2));
console.log('root extra', JSON.stringify({
  share: cfg.share,
  name: cfg.name
}, null, 2).slice(0, 1500));

const s = fs.readFileSync(process.env.TEMP + '/datav-24.js', 'utf8');
const idx = s.indexOf('Cube(1626');
console.log('\n==== Cube(1626) ====');
console.log(s.slice(idx, idx + 2200));
