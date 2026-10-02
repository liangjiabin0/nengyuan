import fs from 'node:fs';
import path from 'node:path';
import { loadProjectEnv } from '../src/lib/load-env';
loadProjectEnv();
Object.assign(process.env,{MENTOR_LOCAL_CORPUS:'1',DATA_IMPORT_READONLY:'1',KG_DEFER_SIMILARITY:'1',INDEX_FTS_ONLY:'1',SEARCH_INDEX_SYNC_FTS:'0'});

async function main() {
  const reportPath=path.resolve('storage/data-import-pdf.json');
  const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));
  if(report.status!=='done')throw new Error('PDF 批次尚未完成');
  const {getDb,persistDbSummary}=await import('../src/lib/db');
  const {updateImportJobState}=await import('../src/lib/import-state');
  const {mergePatentSources}=await import('./merge-patent-sources');
  const {indexDocumentsFast}=await import('../src/lib/doc-index');
  const {syncPaperDocumentsToCorpus}=await import('../src/lib/corpus/export');
  const {getCorpusRoot,corpusRecordFileName}=await import('../src/lib/corpus/schema');
  const db=getDb();
  updateImportJobState({status:'running',phase:'patents',rootDir:report.root,message:'核对公开号并关联专利说明/PDF',error:undefined,startedAt:report.startedAt});
  try {
    const merged=await mergePatentSources(db);
    const previous=report.patentSources || {merged:0,audit:[]};
    report.patentSources={...merged,merged:previous.merged+merged.merged,audit:[...previous.audit,...merged.audit]};
    console.log(`Merged ${merged.merged}; unmatched ${merged.unmatchedText.length}`);
    const dir=path.resolve(getCorpusRoot(),'patents');
    for(const entry of merged.audit) {
      const file=path.resolve(dir,corpusRecordFileName(entry.removedKey));
      if(path.dirname(file)!==dir)throw new Error('Unexpected corpus file path');
      if(fs.existsSync(file))fs.unlinkSync(file);
    }
    const keys=(db.prepare("SELECT paper_key AS k FROM paper_documents WHERE paper_key LIKE 'patent:%'").all() as Array<{k:string}>).map(r=>r.k);
    report.index=await indexDocumentsFast({paperKeys:keys});
    updateImportJobState({phase:'indexing',message:'更新专利全文语料与清单'});
    report.patentCorpusSync=syncPaperDocumentsToCorpus(db,{keyPrefix:'patent:'});
    report.summary=await persistDbSummary({includeSlowCounts:true});
    report.completedAt=new Date().toISOString();
    fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
    db.pragma('wal_checkpoint(PASSIVE)');
    updateImportJobState({status:'done',phase:'done',message:'资料导入与专利关联完成',result:report.summary,progress:{current:1,total:1}});
    console.log(JSON.stringify({merged:report.patentSources.merged,summary:report.summary}));
  } catch(error) {
    updateImportJobState({status:'error',phase:'error',message:'专利关联更新失败',error:error instanceof Error?error.stack:String(error)});
    throw error;
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
