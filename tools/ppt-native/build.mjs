import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import PptxGenJS from 'pptxgenjs';
import {renderLatexSvg} from './math-svg.mjs';
import {rasterFallbacks} from './revise-formulas.mjs';

// Standalone server builder: editable PowerPoint objects; no Codex runtime dependency.
export async function buildDeck({specPath,outputPath,exactSlides}) {
 const spec=JSON.parse(await fs.readFile(specPath,'utf8'));
 const pages=spec.slides??[spec.slide1,spec.slide2];
 if(!pages.length||pages.some(x=>!x))throw Error('Provide slides, or slide1 and slide2');
 if(exactSlides&&pages.length!==exactSlides)throw Error(`Expected ${exactSlides} slides`);
 const pptx=new PptxGenJS();const W=13.333333,H=7.5;
 pptx.defineLayout({name:'RESEARCH',width:W,height:H});pptx.layout='RESEARCH';
 pptx.author='能元科研系统';pptx.subject=spec.meta?.paperTitle??'';pptx.title=spec.meta?.paperTitle??'';
 const font=spec.meta?.fontFamily??'Noto Sans CJK SC';pptx.theme={headFontFace:font,bodyFontFace:font,lang:'zh-CN'};
 const C={ink:'172A3A',blue:'0B438C',teal:'169C98',gray:'586B78',pale:'EEF7FA',line:'8EBCCB',red:'C62828'};
 const manifest=[];const receipts=[];const outDir=path.dirname(outputPath);await fs.mkdir(outDir,{recursive:true});
 function text(slide,value,x,y,w,h,opts={}) {slide.addText(String(value??''),{x,y,w,h,fontFace:font,fontSize:14,color:C.ink,margin:.05,breakLine:false,fit:'shrink',...opts});}
 function card(slide,label,x,y,w,h,opts={}) {slide.addText(String(label??''),{x,y,w,h,fontFace:font,fontSize:14,color:C.ink,margin:.09,shape:pptx.ShapeType.roundRect,fill:{color:C.pale},line:{color:C.line,width:.8},align:'center',valign:'mid',fit:'shrink',...opts});}
 function arrow(slide,a,b,dashed=false) {
  const dx=b.x-a.x,dy=b.y-a.y;
  slide.addShape(pptx.ShapeType.line,{x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.abs(dx),h:Math.abs(dy),flipH:dx<0,flipV:dy<0,line:{color:dashed?C.teal:C.blue,width:1.1,beginArrowType:'none',endArrowType:'triangle',...(dashed?{dashType:'dash'}:{})}});
 }
 async function formula(slide,f,box,index) {
  const unique=JSON.stringify({id:f.id,slide:index+1,placement:manifest.length}).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const svg=(await renderLatexSvg({latex:f.latex,color:'#'+C.blue})).replace(/(<svg\b[^>]*>)/,`$1<metadata>${unique}</metadata>`);
  const vb=svg.match(/viewBox="([^"]+)"/)?.[1]?.split(/\s+/).map(Number);const ratio=vb?.length===4?vb[2]/vb[3]:4;
  const w=Math.min(box.w,box.h*ratio),h=w/ratio;
  slide.addImage({data:'image/svg+xml;base64,'+Buffer.from(svg).toString('base64'),x:box.x+(box.w-w)/2,y:box.y+(box.h-h)/2,w,h,objectName:'latex-svg-'+f.id,altText:'LaTeX: '+f.latex});
  manifest.push({...f,slide:index+1,targetShapeName:'latex-svg-'+f.id,position:{left:box.x*96,top:box.y*96,width:box.w*96,height:box.h*96},color:'#'+C.blue});
 }
 function graph(slide,g,box) {
  if(!Array.isArray(g.nodes)||!Array.isArray(g.edges))throw Error('Diagram requires explicit nodes and edges');
  const positions=new Map();const cols=Math.min(4,g.nodes.length),rows=Math.ceil(g.nodes.length/cols);
  g.nodes.forEach((n,i)=>{const w=box.w/cols-.15,h=Math.min(.7,box.h/rows-.25);const p=n.position??{x:(i%cols)/cols,y:Math.floor(i/cols)/rows};const x=box.x+p.x*box.w,y=box.y+p.y*box.h;positions.set(n.id,{x,y,w,h});});
  for(const e of g.edges){const a=positions.get(e.from),b=positions.get(e.to);if(!a||!b)throw Error('Diagram references missing node');arrow(slide,{x:a.x+a.w/2,y:a.y+a.h},{x:b.x+b.w/2,y:b.y},e.phase==='training'||e.flowType==='optimization');}
  for(const n of g.nodes){const b=positions.get(n.id);card(slide,n.label??n.id,b.x,b.y,b.w,b.h,{fontSize:12});}
 }
 async function visual(slide,v,b,index) {
  if(v.type==='chart') {
   if(!v.categories?.length||!v.series?.length||v.series.some(s=>s.values?.length!==v.categories.length||s.values.some(x=>!Number.isFinite(x))))throw Error('Chart requires exact numeric values for each category');
   slide.addChart(v.chartType==='bar'?pptx.ChartType.bar:pptx.ChartType.line,v.series.map(s=>({name:s.name,labels:v.categories.map(String),values:s.values})),{...b,fontFace:font,showLegend:true,legendPos:'t',legendFontSize:10,catAxisLabelFontSize:10,valAxisLabelFontSize:10,showTitle:false,showValue:false,showMarker:true,markerSize:4,chartColors:[C.blue,C.red,'007A33','604A7B'],chartLineSize:2,catAxisTitle:v.xTitle??'',valAxisTitle:v.yTitle??'',valAxisMinVal:v.yMin,valAxisMaxVal:v.yMax,valAxisMajorUnit:v.yMajorUnit,catAxisLineColor:'666666',valAxisLineColor:'666666',});
  } else if(v.type==='table') {
   if(!v.headers?.length||!v.rows?.length)throw Error('Table requires headers and rows');
   slide.addTable([v.headers,...v.rows],{...b,fontFace:font,fontSize:11,border:{type:'solid',color:C.line,pt:.6},fill:'FFFFFF',color:C.ink,margin:.08,autoFit:false,rowH:Math.min(.45,b.h/(v.rows.length+1))});
  } else if(v.type==='source-figure'||v.type==='figure') {
   if(!v.assetPath)throw Error('Source figure requires assetPath');const file=path.resolve(path.dirname(specPath),v.assetPath);await fs.access(file);slide.addImage({path:file,...b});
  } else if(v.type==='diagram') {
   graph(slide,v,b);
  } else if(v.type==='metrics') {
   const values=Array.isArray(v.values)?v.values:Object.entries(v.values??{}).map(([label,value])=>({label,value}));
   values.forEach((m,i)=>card(slide,typeof m==='object'?`${m.label??m.name??''}\n${m.value??m.text??''}`:m,b.x,b.y+i*b.h/values.length,b.w,b.h/values.length-.08,{fontSize:16}));
  } else throw Error('Unsupported visual type: '+v.type);
 }
 for(let index=0;index<pages.length;index++) {
  const page=pages[index],slide=pptx.addSlide();slide.background={color:'FFFFFF'};
  slide.addShape(pptx.ShapeType.rect,{x:0,y:0,w:W,h:.1,fill:{color:C.blue},line:{color:C.blue}});
  text(slide,page.title,.35,.25,W-.7,.55,{fontSize:28,bold:true,color:C.blue});
  const runs=page.summaryRuns??[{text:page.summary??''}];slide.addText(runs.map(r=>({text:r.text,options:{color:r.emphasis==='red'?C.red:C.ink,bold:r.emphasis==='red'}})),{x:.45,y:1,w:W-.9,h:.65,fontFace:font,fontSize:17,margin:.05,fit:'shrink'});
  const panels=page.resultModules??(page.charts?[...page.charts.map(c=>({...c,visuals:[{...c,type:'chart'}]})),...(page.thirdModule?[{...page.thirdModule,visuals:[page.thirdModule]}]:[])]:page.panels??[]);
  if(panels.length>4)throw Error('Too many panels for readable starter layout; create a task-specific builder');
  if(page.methodGraphPath)graph(slide,JSON.parse(await fs.readFile(path.resolve(path.dirname(specPath),page.methodGraphPath),'utf8')),{x:.5,y:2,w:W-1,h:4.5});
  else if(panels.length)for(let i=0;i<panels.length;i++) {
   const p=panels[i],w=(W-.9)/panels.length-.16,x=.45+i*(w+.16),y=1.9;
   card(slide,p.title,x,y,w,.5,{fontSize:16,bold:true,color:C.blue});
   if(p.visuals?.length){const vh=3.55/p.visuals.length;for(let j=0;j<p.visuals.length;j++)await visual(slide,p.visuals[j],{x:x+.05,y:y+.65+j*vh,w:w-.1,h:vh-.13},index);}
   else {
    const steps=p.steps??[];const gap=Math.min(.7,2.2/Math.max(steps.length,1));steps.forEach((s,j)=>card(slide,s,x+.12,y+.7+j*gap,w-.24,gap-.09,{fontSize:12}));
    text(slide,(p.details??[]).join('\n'),x+.1,y+3,w-.2,.7,{fontSize:12});
    const formulas=(page.formulas??[]).filter(f=>p.formulaIds?.includes(f.id));for(let j=0;j<formulas.length;j++)await formula(slide,formulas[j],{x:x+.1,y:y+3.7+j*.4,w:w-.2,h:.38},index);
   }
   text(slide,p.conclusion??'',x+.1,6.3,w-.2,.75,{fontSize:13,bold:true,color:C.teal});
  }
  else if(page.body)text(slide,page.body,.5,2,W-1,4.7,{fontSize:20});
  else throw Error('Slide needs panels, resultModules, methodGraphPath, or body');
  const remaining=(page.formulas??[]).filter(f=>!manifest.some(m=>m.slide===index+1&&m.id===f.id));if(page.methodGraphPath)for(let j=0;j<remaining.length;j++)await formula(slide,remaining[j],{x:.5+j*(W-1)/remaining.length,y:6.4,w:(W-1)/remaining.length-.1,h:.6},index);
  slide.addNotes(JSON.stringify({paperTitle:spec.meta?.paperTitle,doi:spec.meta?.doi,sourcePath:spec.meta?.sourcePath,evidence:panels.map(p=>p.evidenceRef),formulas:page.formulas,description:'论文内容解读；不代表运行过作者算法。'},null,2));
  receipts.push({slide:index+1,nativeObjects:true,panels:panels.length});
 }
 await pptx.writeFile({fileName:outputPath});
 await rasterFallbacks(outputPath,manifest);
 await fs.writeFile(outputPath.replace(/\.pptx$/i,'-formula-manifest.json'),JSON.stringify({sourcePptx:outputPath,outputPptx:outputPath.replace(/\.pptx$/i,'-formula-revision.pptx'),formulas:manifest},null,2));
 await fs.writeFile(outputPath+'.build.json',JSON.stringify({engine:'pptxgenjs',slides:receipts,templateReference:spec.meta?.templatePptx??null,templateImported:false,visualRenderingRequired:true},null,2));
 return {outputPath,slides:pages.length,formulaCount:manifest.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
 const specPath=path.resolve(process.env.SPEC_PATH??process.argv[2]??'spec.json');
 const outputPath=path.resolve(process.env.FINAL_PPTX??process.argv[3]??'output.pptx');
 console.log(JSON.stringify(await buildDeck({specPath,outputPath})));
}
