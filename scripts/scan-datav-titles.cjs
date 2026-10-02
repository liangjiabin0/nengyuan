const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('src/lib/datav-logistics-config.json', 'utf8'));
const layers = cfg.scenes[0].layers;
for (const id of ['main-title_rodUw', 'main-title_xh60C', '通用标题_PEZWu', 'main-title_Tyw9S', 'timer_SFBVF']) {
  const l = layers[id];
  console.log('\n', id, JSON.stringify({ config: l?.config, data: l?.data }, null, 2).slice(0, 1500));
}
