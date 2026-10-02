const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('src/lib/datav-logistics-config.json', 'utf8'));
const layers = cfg.scenes[0].layers;
function walk(id, depth) {
  const layer = layers[id];
  if (!layer) return;
  const pad = '  '.repeat(depth);
  console.log(pad + id, layer.comName || layer.type, JSON.stringify(layer.attr));
  (layer.children || []).forEach(c => walk(c, depth + 1));
}
for (const id of (cfg.config.zIndexList || []).map(x => x.id)) {
  walk(id, 0);
}
