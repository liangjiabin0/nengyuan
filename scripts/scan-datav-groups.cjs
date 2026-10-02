const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('src/lib/datav-logistics-config.json', 'utf8'));
const layers = cfg.scenes[0].layers;
for (const [id, layer] of Object.entries(layers)) {
  if (layer.comName === 'group' || layer.type === 'group') {
    console.log(JSON.stringify({ id, attr: layer.attr, children: layer.children, parent: layer.parent }));
  }
}
console.log('screen', cfg.config);
