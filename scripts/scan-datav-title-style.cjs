const cfg = JSON.parse(require('fs').readFileSync('src/lib/datav-logistics-config.json', 'utf8'));
const t = cfg.scenes[0].layers['main-title_z4BMY'];
console.log(JSON.stringify({ attr: t.attr, config: t.config, parent: t.parent }, null, 2));
const img = cfg.scenes[0].layers['main-img_zkkw3'];
console.log('img', JSON.stringify({ attr: img.attr, config: img.config }, null, 2));
const g = cfg.scenes[0].layers['group_zNTQ9'];
console.log('group', JSON.stringify(g.attr));
const g2 = cfg.scenes[0].layers['group_h2qRG'];
console.log('titleGroup', JSON.stringify(g2.attr));
