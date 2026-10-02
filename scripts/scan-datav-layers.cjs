const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('src/lib/datav-logistics-config.json', 'utf8'));
const layers = cfg.scenes[0].layers;

function dump(id) {
  const layer = layers[id];
  console.log('\n========', id, '========');
  console.log(JSON.stringify({
    comName: layer.comName,
    requirePath: layer.requirePath,
    alias: layer.alias,
    configKeys: layer.config ? Object.keys(layer.config) : [],
    data: layer.data,
    children: layer.children,
    parent: layer.parent
  }, null, 2).slice(0, 4000));
}

dump('number-title-flop_sW6jO');
dump('数字翻牌器_7kP31');
dump('@datav-3d-v3_datav-3dplane_2a7GL');
dump('@datav-3d-v3_datav-3dplane-od-flyingline_D7C93');
dump('@datav-3d-v3_datav-3dplane-bubbles_fDVyw');
dump('main-title_z4BMY');
dump('main-img_CQXXJ');
dump('icon_dzxGn');

console.log('\nall keys', Object.keys(layers));
console.log('cfg keys', Object.keys(cfg));
