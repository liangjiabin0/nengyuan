const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('src/lib/datav-logistics-config.json', 'utf8'));
const layers = cfg.scenes[0].layers;
for (const [id, layer] of Object.entries(layers)) {
  const name = layer.comName || layer.type;
  if (name === 'main-title' || name === 'main-img' || name === 'icon' || /title|img|logo/i.test(id)) {
    const img = layer.config && (layer.config['background-image'] || layer.config.vectorImage);
    console.log(JSON.stringify({
      id,
      comName: layer.comName,
      alias: layer.alias,
      attr: layer.attr,
      content: layer.config && layer.config.content,
      fontSize: layer.config && layer.config.textStyle && layer.config.textStyle.fontSize,
      fontFamily: layer.config && layer.config.textStyle && layer.config.textStyle.fontFamily,
      imageType: layer.config && layer.config.imageType,
      bg: img,
      parent: layer.parent
    }));
  }
}
