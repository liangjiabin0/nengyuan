import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import {renderLatexSvg} from './math-svg.mjs';
export async function rasterFallbacks(pptxPath,formulas){
 const zip=await JSZip.loadAsync(await fs.readFile(pptxPath));
 await updateMedia(zip,formulas);
 await fs.writeFile(pptxPath,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
}
async function formulaPng(svg){
 const box=svg.match(/viewBox="([^"]+)"/)?.[1]?.split(/\s+/).map(Number);
 if(!box||box.length!==4||box[2]<=0||box[3]<=0)throw Error('Invalid formula SVG dimensions');
 const width=1600,height=Math.max(1,Math.round(width*box[3]/box[2]));
 const sized=svg.replace(/\bwidth="[^"]+"/,`width="${width}px"`).replace(/\bheight="[^"]+"/,`height="${height}px"`);
 return sharp(Buffer.from(sized)).png().toBuffer();
}
async function updateMedia(zip,formulas){
 for(const formula of formulas) {
  const slideFile=`ppt/slides/slide${formula.slide}.xml`;
  const xml=await zip.file(slideFile)?.async('string');if(!xml)throw Error('Missing slide: '+formula.slide);
  const picture=[...xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)].map(x=>x[0]).find(x=>x.includes('name="'+formula.targetShapeName+'"'));
  if(!picture)throw Error('Missing formula shape: '+formula.targetShapeName);
  const rels=await zip.file(`ppt/slides/_rels/slide${formula.slide}.xml.rels`)?.async('string');if(!rels)throw Error('Missing slide relationships');
  const svgId=picture.match(/<asvg:svgBlip[^>]*r:embed="([^"]+)"/)?.[1];
  const imageId=picture.match(/<a:blip[^>]*r:embed="([^"]+)"/)?.[1];
  const target=(id)=>{
   const rel=[...rels.matchAll(/<Relationship\b[^>]*\/>/g)].map(x=>x[0]).find(x=>x.includes('Id="'+id+'"'));
   const to=rel?.match(/Target="([^"]+)"/)?.[1];if(!to)throw Error('Missing formula image relationship');
   const file=path.posix.normalize('ppt/slides/'+to);if(!file.startsWith('ppt/media/'))throw Error('Unexpected formula image target');return file;
  };
  const svg=await renderLatexSvg({latex:formula.latex,color:formula.color});
  if(svgId)zip.file(target(svgId),svg);
  if(imageId){const file=target(imageId);if(file.endsWith('.svg'))zip.file(file,svg);else zip.file(file,await formulaPng(svg));}
 }
}
export async function reviseFormulas(manifestPath) {
 const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
 if(!path.isAbsolute(manifest.sourcePptx??'')||!path.isAbsolute(manifest.outputPptx??''))throw Error('PPTX paths must be absolute');
 let outputPath=manifest.outputPptx;
 try{await fs.access(outputPath);const p=path.parse(outputPath);outputPath=path.join(p.dir,p.name+'-'+Date.now()+p.ext);}catch{}
 const zip=await JSZip.loadAsync(await fs.readFile(manifest.sourcePptx));
 await updateMedia(zip,manifest.formulas??[]);
 await fs.mkdir(path.dirname(outputPath),{recursive:true});await fs.writeFile(outputPath,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
 return {outputPath,formulaCount:manifest.formulas?.length??0};
}
