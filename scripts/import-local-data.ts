import fs from 'node:fs';
import path from 'node:path';
import { loadProjectEnv } from '../src/lib/load-env';

loadProjectEnv();
Object.assign(process.env, {
  DATA_IMPORT_READONLY: '1', MENTOR_LOCAL_CORPUS: '1',
  AI4ES_USE_JOB_QUEUE: '0', SKIP_INLINE_INDEX: '1',
  SKIP_EXISTING_PAPERS: '1', SKIP_EXISTING_PATENTS: '1',
  SKIP_EXISTING_MENTORS: '1', SKIP_CAJ_CONVERT: '1',
  INDEX_FTS_ONLY: '1', SEARCH_INDEX_SYNC_FTS: '0',
  KG_DEFER_SIMILARITY: '1',
  PDF2MD_OCR: 'never',
  PAPER_INGEST_CONCURRENCY: process.env.PAPER_INGEST_CONCURRENCY || '6'
});

async function main() {
  const root = path.resolve(process.argv[2] || 'F:\\数据');
  const mode = process.argv[3] || 'structured';
  if (!fs.statSync(root).isDirectory()) throw new Error(`数据目录不存在：${root}`);
  const { saveDualModelSettings } = await import('../src/lib/config');
  saveDualModelSettings({ dataRootDir: root });
  const { getDb, persistDbSummary } = await import('../src/lib/db');
  const { updateImportJobState } = await import('../src/lib/import-state');
  const { indexDocumentsFast } = await import('../src/lib/doc-index');
  const { exportKnowledgeCorpus } = await import('../src/lib/corpus/export');
  const db = getDb();
  const reportPath = path.resolve('storage', `data-import-${mode}.json`);
  const report: Record<string, any> = fs.existsSync(reportPath)
    ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : { root, startedAt: new Date().toISOString(), phases: {} };
  if (report.error) {
    report.recoveredErrors = [...(report.recoveredErrors || []), report.error];
    delete report.error;
  }
  report.status = 'running';
  const persist = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  persist();
  updateImportJobState({status:'running', phase:'preparing', rootDir:root, startedAt:report.startedAt, error:undefined, message:`分批导入：${mode}`, progress:{current:0,total:1}});
  if (!fs.existsSync('storage/backups/pre-data-import.sqlite')) {
    fs.mkdirSync('storage/backups', {recursive:true});
    await db.backup('storage/backups/pre-data-import.sqlite');
  }
  const phase = async (name: string, run: () => Promise<any>) => {
    if (report.phases[name]?.completedAt) { console.log(`SKIP completed ${name}`); return report.phases[name].result; }
    console.log(`START ${name} ${new Date().toISOString()}`);
    report.phases[name] = {startedAt:new Date().toISOString()}; persist();
    updateImportJobState({phase:name as any, message:`正在导入 ${name}`, progress:{current:0,total:1}});
    const result = await run();
    report.phases[name] = {...report.phases[name], completedAt:new Date().toISOString(), result}; persist();
    console.log(`DONE ${name} ${JSON.stringify({files:result.files ?? result.scannedFiles, imported:result.imported, failed:result.failed, skipped:result.skipped, projects:result.projects})}`);
    await persistDbSummary();
    return result;
  };
  try {
    if (mode === 'structured') {
      const { ingestExcelAndCsv } = await import('../src/lib/excel-ingest');
      await phase('funds', () => ingestExcelAndCsv({roots:[path.join(root,'基金信息')], rebuildIndex:false, crossLink:false, exportCorpus:false,
        onProgress:(current,total,file)=>updateImportJobState({phase:'funds',message:`基金 ${current}/${total} ${path.basename(file)}`,progress:{current,total}})}));
      const { ingestNkrdProjects } = await import('../src/lib/nkrd-ingest');
      await phase('nkrd', () => ingestNkrdProjects({root:path.join(root,'国重项目信息'),rebuildIndex:false,exportCorpus:false}));
      const { ingestMentorDirectory } = await import('../src/lib/mentors');
      const mentors = await phase('mentors', () => ingestMentorDirectory(path.join(root,'导师信息')));
      const { ingestPatentMarkdownDirectory } = await import('../src/lib/patents');
      const patents = await phase('patents', () => ingestPatentMarkdownDirectory(path.join(root,'_legacy')));
      const { indexProjectInDb } = await import('../src/lib/search-index');
      const projects = db.prepare('SELECT * FROM projects').all();
      for (let i=0;i<projects.length;i+=500) {
        db.transaction(() => {for (const p of projects.slice(i,i+500)) indexProjectInDb(db,p as any);})();
        updateImportJobState({phase:'indexing',message:`项目索引 ${Math.min(i+500,projects.length)}/${projects.length}`,progress:{current:Math.min(i+500,projects.length),total:projects.length}});
      }
      report.index = await indexDocumentsFast({paperKeys:patents.changedKeys,mentorKeys:mentors.changedKeys});
    } else if (mode === 'pdf') {
      const { ingestPaperDirectory } = await import('../src/lib/papers');
      const { fileSha1, getConvertWorkDir } = await import('../src/lib/pdf2md');
      const { ingestPatentMarkdownDirectory } = await import('../src/lib/patents');
      await phase('paper-notes', () => ingestPatentMarkdownDirectory(path.join(root,'论文信息'),200,{keyPrefix:'paper:'}));
      for (const [name,folder,keyPrefix] of [['whitepapers','白皮书','whitepaper:'],['papers','论文信息','paper:'],['patents','专利信息','patent:']]) {
        (globalThis as any).__paperIngestProgress = (current:number,total:number,file:string) => updateImportJobState({phase:name as any,message:`${folder} ${current}/${total} ${path.basename(file)}`,progress:{current,total}});
        await phase(name, () => ingestPaperDirectory(path.join(root,folder),{keyPrefix}));
        await indexDocumentsFast();
      }
      report.ocrRetries = {};
      process.env.PDF2MD_OCR = 'auto';
      process.env.FORCE_PDF2MD = '1';
      for (const [name,folder,keyPrefix] of [['whitepapers','白皮书','whitepaper:'],['papers','论文信息','paper:'],['patents','专利信息','patent:']]) {
        const errors = report.phases[name].result.errors as Array<{filePath:string;error:string}>;
        const candidates = errors.filter(({filePath}) => {
          try {
            const meta = JSON.parse(fs.readFileSync(path.join(getConvertWorkDir(),'md',`${fileSha1(filePath)}.json`),'utf8'));
            return Number(meta.numpages)>0;
          } catch {return false;}
        }).map(e=>e.filePath);
        if(candidates.length) {
          console.log(`OCR retry ${name}: ${candidates.length}`);
          (globalThis as any).__paperIngestProgress = (current:number,total:number,file:string)=>updateImportJobState({phase:name as any,message:`OCR ${folder} ${current}/${total} ${path.basename(file)}`,progress:{current,total}});
          report.ocrRetries[name] = await ingestPaperDirectory(path.join(root,folder),{keyPrefix,filePaths:candidates});
          persist();
        }
      }
      process.env.FORCE_PDF2MD = '0';
      const { mergePatentSources } = await import('./merge-patent-sources');
      report.patentSources = await mergePatentSources(db);
      const keys = (db.prepare("SELECT paper_key AS k FROM paper_documents WHERE paper_key LIKE 'patent:%'").all() as Array<{k:string}>).map(r=>r.k);
      report.index = await indexDocumentsFast({paperKeys:keys});
    } else throw new Error(`未知模式：${mode}`);
    updateImportJobState({phase:'indexing',message:'导出知识语料并核对数量'});
    report.corpus = await exportKnowledgeCorpus();
    report.summary = await persistDbSummary({includeSlowCounts:true});
    report.status = 'done'; report.completedAt = new Date().toISOString(); persist();
    updateImportJobState({status:'done',phase:'done',message:`${mode} 批次导入完成`,result:report.summary,progress:{current:1,total:1}});
    console.log(`COMPLETE ${mode} ${JSON.stringify(report.summary)}`);
  } catch(error) {
    report.status='error'; report.error=error instanceof Error?error.stack:String(error); persist();
    updateImportJobState({status:'error',phase:'error',error:report.error,message:'导入遇到错误，可从已完成批次继续'});
    throw error;
  } finally {db.pragma('wal_checkpoint(PASSIVE)');}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
