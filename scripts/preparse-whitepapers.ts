import fs from 'node:fs';
import path from 'node:path';
import { loadProjectEnv } from '../src/lib/load-env';
loadProjectEnv();
async function main() {
  const { extractPdfWithPdf2md } = await import('../src/lib/pdf2md');
  const root = process.argv[2] || 'F:\\数据\\白皮书';
  const files = fs.readdirSync(root).filter(x=>x.toLowerCase().endsWith('.pdf')).map(x=>path.join(root,x));
  const results = await Promise.all(files.map(async file => ({file,...await extractPdfWithPdf2md(file,{ocr:'auto'})})));
  fs.writeFileSync('storage/whitepaper-ocr-report.json',JSON.stringify(results.map(({text,...r})=>({...r,chars:text.length})),null,2));
  console.log('白皮书 OCR 完成');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
