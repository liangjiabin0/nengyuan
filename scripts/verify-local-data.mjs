import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const db=new Database('storage/rag.sqlite',{readonly:true});
const count=(sql)=>Number(db.prepare(sql).pluck().get());
const root='F:\\数据';
const counts={
  funds:count("SELECT COUNT(*) FROM projects WHERE project_key NOT LIKE 'nkrd:%'"),
  nkrd:count("SELECT COUNT(*) FROM projects WHERE project_key LIKE 'nkrd:%'"),
  outputs:count('SELECT COUNT(*) FROM outputs'),
  mentors:count('SELECT COUNT(*) FROM mentor_profiles'),
  patents:count("SELECT COUNT(*) FROM paper_documents WHERE paper_key LIKE 'patent:%'"),
  papers:count("SELECT COUNT(*) FROM paper_documents WHERE paper_key NOT LIKE 'patent:%' AND paper_key NOT LIKE 'whitepaper:%'"),
  whitepapers:count("SELECT COUNT(*) FROM paper_documents WHERE paper_key LIKE 'whitepaper:%'"),
  rawRecords:count('SELECT COUNT(*) FROM raw_records'),
  sourceTables:count('SELECT COUNT(*) FROM source_files'),
  people:count("SELECT COUNT(*) FROM entities WHERE type='person'")
};
const report={verifiedAt:new Date().toISOString(),root,counts,checks:[],browserErrors:[]};
const check=(name,ok,details)=>{report.checks.push({name,ok,details});console.log(`${ok?'PASS':'FAIL'} ${name}`);};
check('SQLite integrity',db.pragma('quick_check',{simple:true})==='ok');
const missingMentors=count("SELECT COUNT(*) FROM mentor_profiles m WHERE NOT EXISTS (SELECT 1 FROM search_records s WHERE s.source_key=m.mentor_key AND s.source_type='mentor')");
const missingDocs=count("SELECT COUNT(*) FROM paper_documents p WHERE NOT EXISTS (SELECT 1 FROM search_records s WHERE s.source_key=p.paper_key)");
check('All mentor and document indexes present',missingMentors===0 && missingDocs===0,{missingMentors,missingDocs});
check('FTS counts match search records',count('SELECT COUNT(*) FROM search_fts')===count('SELECT COUNT(*) FROM search_records'));
const pdfReport=JSON.parse(fs.readFileSync('storage/data-import-pdf.json','utf8'));
const preparseFiles=fs.readFileSync('storage/pdf-preparse-files.jsonl','utf8').trim().split('\n').map(line=>JSON.parse(line));
const hashByPath=new Map(preparseFiles.filter(r=>r.hash).map(r=>[path.resolve(r.file).toLowerCase(),r.hash]));
const represented=new Set();
for(const doc of db.prepare('SELECT file_hash,pdf_path FROM paper_documents').all()){
  represented.add(doc.file_hash);
  const hash=hashByPath.get(path.resolve(doc.pdf_path).toLowerCase());if(hash)represented.add(hash);
}
const failedPaths=new Set(['papers','patents'].flatMap(k=>pdfReport.phases[k].result.errors.map(e=>path.resolve(e.filePath).toLowerCase())));
for(const result of Object.values(pdfReport.ocrRetries || {}))for(const r of result.results || [])failedPaths.delete(path.resolve(r.originalPath).toLowerCase());
const unrepresented=preparseFiles.filter(r=>!failedPaths.has(path.resolve(r.file).toLowerCase()) && (!r.hash || !represented.has(r.hash)));
check('Every valid PDF content accounted for',unrepresented.length===0,{files:preparseFiles.length,failedSourceFiles:failedPaths.size,unrepresented:unrepresented.map(r=>r.file)});
const corpusCounts={};
for(const [domain,key] of [['projects','funds'],['national-projects','nkrd'],['mentors','mentors'],['patents','patents'],['papers','papers'],['whitepapers','whitepapers'],['people','people']]) {
  const dir=path.resolve('storage/knowledge-corpus',domain);
  corpusCounts[domain]=fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.md')).length:0;
  check(`Corpus ${domain}`,corpusCounts[domain]===counts[key],{files:corpusCounts[domain],database:counts[key]});
}
report.corpusCounts=corpusCounts;
const sourceNames=new Set(db.prepare('SELECT filename FROM source_files').all().map(r=>r.filename));
const sourceCsv=['基金信息','国重项目信息'].flatMap(folder=>fs.readdirSync(path.join(root,folder)).filter(x=>x.endsWith('.csv')));
check('Every CSV accounted for',sourceCsv.every(name=>sourceNames.has(name)),{diskFiles:sourceCsv.length,sourceTables:counts.sourceTables,missing:sourceCsv.filter(n=>!sourceNames.has(n))});
const originalInventory=JSON.parse(fs.readFileSync('storage/data-import-inventory.json','utf8'));
for(const [folder,original] of Object.entries(originalInventory.categories)) {
  let files=0,bytes=0;
  const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())walk(p);else{files++;bytes+=fs.statSync(p).size;}}};
  walk(path.join(root,folder));
  check(`Source preserved ${folder}`,files===original.files && bytes===original.bytes,{files,bytes});
}
const env=fs.readFileSync('.env.local','utf8');
const envValue=name=>env.match(new RegExp(`^${name}=(.*)$`,'m'))?.[1].trim().replace(/^['"]|['"]$/g,'');
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const login=await context.request.post('http://127.0.0.1:3000/api/auth/login',{data:{username:envValue('DEFAULT_ADMIN_USERNAME')||'admin',password:envValue('DEFAULT_ADMIN_PASSWORD')}});
  assert.equal(login.status(),200,'Admin login');
  const api=async url=>{const response=await context.request.get(`http://127.0.0.1:3000${url}`,{timeout:120000});assert.equal(response.status(),200,url);return response.json();};
  const settings=await api('/api/settings');check('Configured data root',path.resolve(settings.dataRootDir)===path.resolve(root));
  const bootstrap=await api('/api/bootstrap?refresh=1');report.bootstrapCounts={papers:bootstrap.papers,patents:bootstrap.patents,mentors:bootstrap.mentors,whitepapers:bootstrap.whitepapers,projects:bootstrap.stats?.projects};
  check('Dashboard counts match database',bootstrap.papers===counts.papers && bootstrap.patents===counts.patents && bootstrap.mentors===counts.mentors && bootstrap.whitepapers===counts.whitepapers && bootstrap.stats.projects===counts.funds+counts.nkrd);
  check('Dashboard includes patent originals',bootstrap.disk?.patentPdf===originalInventory.categories['专利信息'].extensions['.pdf'] && bootstrap.disk?.patentMd===originalInventory.categories['_legacy'].extensions['.md']);
  const samples={};
  for(const [domain,key] of [['projects','funds'],['national-projects','nkrd'],['mentors','mentors'],['patents','patents'],['papers','papers'],['whitepapers','whitepapers']]) {
    const result=await api(`/api/corpus?domain=${domain}&pageSize=5`);
    check(`API corpus ${domain}`,result.total===counts[key] && result.rows.length>0,{total:result.total,title:result.rows[0]?.title});
    if(result.rows[0]){const preview=await api(`/api/corpus/content?path=${encodeURIComponent(result.rows[0].relativePath)}`);check(`Preview ${domain}`,!!preview.content?.includes('#'));samples[domain]=result.rows[0].title;}
  }
  report.samples=samples;
  for(const [kind,prefix] of [['paper','paper:'],['patent','patent:'],['whitepaper','whitepaper:']]) {
    const doc=db.prepare("SELECT paper_key FROM paper_documents WHERE paper_key LIKE ? AND pdf_path LIKE '%.pdf' LIMIT 1").get(`${prefix}%`);
    const preview=await context.request.get(`http://127.0.0.1:3000/api/files/preview?sourceType=${kind}&sourceKey=${encodeURIComponent(doc.paper_key)}`,{timeout:120000});
    check(`Original PDF preview ${kind}`,preview.status()===200 && preview.headers()['content-type']?.startsWith('application/pdf'),{status:preview.status()});
  }
  const searches=[];
  for(const q of ['微电网','零碳','新能源']){const result=await api(`/api/search?q=${encodeURIComponent(q)}&limit=5`);searches.push({q,count:result.results.length,types:result.results.map(r=>r.sourceType)});}
  check('Research searches return results',searches.every(r=>r.count>0),searches);
  const page=await context.newPage();page.on('pageerror',error=>report.browserErrors.push(error.message));
  await page.goto('http://127.0.0.1:3000/',{waitUntil:'domcontentloaded',timeout:120000});
  await page.getByText('admin',{exact:true}).first().waitFor({timeout:60000});
  await page.waitForFunction(value=>document.body.innerText.includes(Number(value).toLocaleString('zh-CN')),counts.patents,{timeout:60000});
  await page.screenshot({path:'storage/data-import-home.png',fullPage:true});
  await page.goto('http://127.0.0.1:3000/corpus',{waitUntil:'domcontentloaded',timeout:120000});
  await page.getByText(new RegExp(`共\\s*${counts.papers}\\s*条`)).first().waitFor({timeout:60000});
  await page.getByRole('button',{name:/导师.*本地导师档案与研究方向/}).click();
  await page.getByText(new RegExp(`共\\s*${counts.mentors}\\s*条`)).first().waitFor({timeout:60000});
  await page.screenshot({path:'storage/data-import-mentors.png',fullPage:true});
  check('Browser pages',report.browserErrors.length===0,report.browserErrors);
} catch(error){check('Browser/API verification',false,error.stack || String(error));}
finally {await browser.close();db.close();}
fs.writeFileSync('storage/data-import-verification.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({counts,passed:report.checks.filter(c=>c.ok).length,failed:report.checks.filter(c=>!c.ok)},null,2));
if(report.checks.some(c=>!c.ok))process.exitCode=1;
