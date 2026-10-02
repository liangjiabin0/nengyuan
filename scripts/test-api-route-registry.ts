import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const walk=(dir:string):string[]=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
const registry=fs.readFileSync('server/api/routes.ts','utf8');
const files=walk('src/app/api').filter(f=>f.endsWith('route.ts'));
for(const file of files){const normalized=file.replaceAll('\\','/').replace(/\.ts$/,'');assert.ok(registry.includes("import('../../"+normalized+"')"),'Unregistered API route: '+file);}
console.log(`API registry PASS: ${files.length} route modules`);
