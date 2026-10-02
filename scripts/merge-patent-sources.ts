import path from 'node:path';
import type { Database } from '../src/lib/db';

/** Match only identical publication numbers; preserve both metadata and PDF full text. */
export async function mergePatentSources(db: Database) {
  const { upsertEdgeInDb } = await import('../src/lib/normalize');
  const { updateImportJobState } = await import('../src/lib/import-state');
  type Doc = {paper_key:string,file_path:string,pdf_path:string,page_count:number,references_json:string,citations_json:string,algorithms_json:string};
  const rows = db.prepare("SELECT * FROM paper_documents WHERE paper_key LIKE 'patent:%'").all() as Doc[];
  const publication = (p:string) => path.basename(p).replace(/[-_]/g,'').toUpperCase().match(/CN\d+[A-Z]/i)?.[0];
  const metadata = new Map(rows.filter(r=>path.extname(r.file_path).toLowerCase()==='.md').map(r=>[publication(r.file_path),r]));
  const binaries = rows.filter(r=>path.extname(r.file_path).toLowerCase()==='.pdf');
  const matched = binaries.map(pdf=>({pdf,md:metadata.get(publication(pdf.file_path))})).filter(p=>p.md && publication(p.pdf.file_path));
  let merged = 0;
  const unmatchedText:Array<{pdf:string,publication:string,actualPublication?:string,reason:string}> = [];
  const firstText = db.prepare("SELECT text FROM paper_chunks WHERE paper_key=? AND chunk_role='parent' ORDER BY chunk_index LIMIT 4");
  const audit:Array<{publication:string,metadata:string,pdf:string,key:string,removedKey:string}> = [];
  for (let offset=0;offset<matched.length;offset+=100) {
    db.transaction(()=>{
      for (const {pdf,md} of matched.slice(offset,offset+100)) {
        if(!md) continue;
        const code=publication(pdf.file_path)!;
        const text=(firstText.all(pdf.paper_key) as Array<{text:string}>).map(r=>r.text).join('\n');
        const actualPublication=text.normalize('NFKC').replace(/[\s_－-]/g,'').toUpperCase().match(/CN\d+[A-Z]/i)?.[0];
        if(actualPublication!==code) {
          unmatchedText.push({pdf:pdf.pdf_path,publication:code,actualPublication,reason:'PDF 开头文字未能确认文件名中的公开号，保留独立记录'});
          continue;
        }
        // Parent blocks are the corpus's full-text source; retain the original metadata block too.
        db.prepare("UPDATE paper_chunks SET chunk_role='parent' WHERE paper_key=? AND chunk_index=0").run(md.paper_key);
        db.prepare('UPDATE paper_chunks SET paper_key=?,chunk_index=chunk_index+10000 WHERE paper_key=?').run(md.paper_key,pdf.paper_key);
        db.prepare(`UPDATE paper_documents SET pdf_path=?,page_count=?,references_json=?,citations_json=?,algorithms_json=?,updated_at=CURRENT_TIMESTAMP WHERE paper_key=?`).run(pdf.pdf_path,pdf.page_count,pdf.references_json,pdf.citations_json,pdf.algorithms_json,md.paper_key);
        const edges = db.prepare('SELECT * FROM edges WHERE source_key=? OR target_key=?').all(pdf.paper_key,pdf.paper_key) as Array<{source_key:string,target_key:string,relation:string,weight:number,meta:string}>;
        for (const edge of edges) {
          if(edge.relation==='entity') continue;
          upsertEdgeInDb(db,edge.source_key===pdf.paper_key?md.paper_key:edge.source_key,edge.target_key===pdf.paper_key?md.paper_key:edge.target_key,edge.relation,edge.weight,JSON.parse(edge.meta||'{}'));
        }
        db.prepare('DELETE FROM edges WHERE source_key=? OR target_key=?').run(pdf.paper_key,pdf.paper_key);
        db.prepare('DELETE FROM search_terms WHERE record_id IN (SELECT record_id FROM search_records WHERE source_key=?)').run(pdf.paper_key);
        db.prepare('DELETE FROM search_records WHERE source_key=?').run(pdf.paper_key);
        db.prepare('DELETE FROM paper_documents WHERE paper_key=?').run(pdf.paper_key);
        merged++;
        audit.push({publication:publication(pdf.file_path)!,metadata:md.file_path,pdf:pdf.pdf_path,key:md.paper_key,removedKey:pdf.paper_key});
      }
    }).immediate();
    updateImportJobState({phase:'patents',message:`合并专利说明与 PDF ${merged}/${matched.length}`,progress:{current:merged,total:matched.length}});
  }
  return {merged,audit,unmatchedText};
}
