import path from 'node:path';
import {runtimeModule} from './runtime-root.mjs';
if(!process.argv[2])throw Error('Provide formula-manifest.json');
const {reviseFormulas}=await import(runtimeModule('revise-formulas.mjs'));
console.log(JSON.stringify(await reviseFormulas(path.resolve(process.argv[2]))));
