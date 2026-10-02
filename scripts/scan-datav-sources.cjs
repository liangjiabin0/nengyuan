const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('src/lib/datav-logistics-config.json', 'utf8'));
const layers = cfg.scenes[0].layers;
const rows = [];
for (const [id, layer] of Object.entries(layers)) {
  const data = layer.data || {};
  for (const [apiName, source] of Object.entries(data)) {
    if (!source || typeof source !== 'object') continue;
    rows.push({
      id,
      apiName,
      type: source.dcConfig?.type,
      handler: source.handler,
      hasData: Array.isArray(source.data),
      dataLen: Array.isArray(source.data) ? source.data.length : 0,
      api: source.dcConfig?.api || source.api || '',
      autoUpdate: source.autoUpdate || 0,
      sample: Array.isArray(source.data) ? JSON.stringify(source.data).slice(0, 180) : ''
    });
  }
}
console.log('snapshot_id', cfg.snapshot_id);
console.log('count', rows.length);
console.log(JSON.stringify(rows, null, 2));
