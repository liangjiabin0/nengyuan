import {runtimeModule} from './runtime-root.mjs';
export async function renderLatexSvg(options){return (await import(runtimeModule('math-svg.mjs'))).renderLatexSvg(options);}
