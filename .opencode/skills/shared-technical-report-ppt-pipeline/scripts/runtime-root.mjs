import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
export function runtimeModule(file){
 const candidates=[process.env.AI4ES_PROJECT_ROOT,process.cwd()].filter(Boolean);
 let dir=path.dirname(fileURLToPath(import.meta.url));
 while(true){candidates.push(dir);const parent=path.dirname(dir);if(parent===dir)break;dir=parent;}
 for(const root of candidates){const candidate=path.join(root,'tools','ppt-native',file);if(fs.existsSync(candidate))return pathToFileURL(candidate).href;}
 throw Error('Set AI4ES_PROJECT_ROOT to the installation containing tools/ppt-native');
}
