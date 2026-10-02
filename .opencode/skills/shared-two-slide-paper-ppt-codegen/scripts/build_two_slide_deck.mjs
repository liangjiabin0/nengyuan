import path from 'node:path';
import {runtimeModule} from './runtime-root.mjs';
const {buildDeck}=await import(runtimeModule('build.mjs'));
console.log(JSON.stringify(await buildDeck({specPath:path.resolve(process.env.SPEC_PATH??process.argv[2]??'spec.json'),outputPath:path.resolve(process.env.FINAL_PPTX??process.argv[3]??'output.pptx'),exactSlides:2})));
