import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {mathjax}=require('mathjax-full/js/mathjax.js');
const {TeX}=require('mathjax-full/js/input/tex.js');
const {SVG}=require('mathjax-full/js/output/svg.js');
const {liteAdaptor}=require('mathjax-full/js/adaptors/liteAdaptor.js');
const {RegisterHTMLHandler}=require('mathjax-full/js/handlers/html.js');
const {AllPackages}=require('mathjax-full/js/input/tex/AllPackages.js');
const adaptor=liteAdaptor();RegisterHTMLHandler(adaptor);
const document=mathjax.document('',{InputJax:new TeX({packages:AllPackages}),OutputJax:new SVG({fontCache:'none'})});
export async function renderLatexSvg({latex,color='#123E78'}) {
 if(!latex)throw Error('Formula latex is required');
 const result=adaptor.outerHTML(document.convert(latex,{display:true}));
 if(result.includes('data-mjx-error'))throw Error('Invalid LaTeX formula');
 const svg=result.match(/<svg[\s\S]*<\/svg>/)?.[0];if(!svg)throw Error('MathJax did not produce SVG');
 return svg.replace('<svg ',`<svg color="${color.replace(/[^#\w]/g,'')}" `).replaceAll('currentColor',color);
}
