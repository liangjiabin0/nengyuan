/** Validate Windows-to-Linux paths before changing PostgreSQL. Dry-run by default. */
import fs from 'node:fs';
import path from 'node:path';
import {Client} from 'pg';
const value=(flag:string,fallback:string)=>{const i=process.argv.indexOf(flag);return i>=0?process.argv[i+1]:fallback;};
async function main(){
 const oldRoot=value('--from','D:\\电元系统').replace(/[\\/]+$/,'');
 const newRoot=path.resolve(value('--to','/data/ai4es'));
 const apply=process.argv.includes('--apply');
 if(apply&&!fs.existsSync(value('--backup-marker','/data/ai4es-backup-20261002/backup-completed.txt')))throw Error('Completed backup marker required before modifying stored paths');
 if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required');
 const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
 const qi=(s:string)=>'"'+s.replaceAll('"','""')+'"';const report:{table:string,column:string,mapped:number,missing:number,otherRoot:number}[]=[];
 const missing:{table:string,column:string,oldPath:string,candidate:string}[]=[];
 const exists=new Map<string,boolean>();
 const mappingFile=value('--mapping',path.join(process.cwd(),'storage','recovered-file-paths.json'));
 const recovered=new Map<string,string>();
 if(fs.existsSync(mappingFile))for(const entry of JSON.parse(fs.readFileSync(mappingFile,'utf8')) as {oldPath:string,newPath:string}[])recovered.set(entry.oldPath,entry.newPath);
 try{
  const columns=(await db.query<{table_name:string,column_name:string}>("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND data_type IN ('text','character varying') AND column_name ~ '(path|dir|directory)$' ORDER BY table_name,column_name")).rows;
  if(apply)await db.query('BEGIN');
  for(const {table_name:table,column_name:column} of columns){
   const rows=(await db.query<{value:string}>(`SELECT DISTINCT ${qi(column)} AS value FROM ${qi(table)} WHERE ${qi(column)} ~ '^[A-Za-z]:'`)).rows;
   if(!rows.length)continue;
   const mappings:{oldPath:string,newPath:string}[]=[];let otherRoot=0,countMissing=0;
   for(const {value:oldPath} of rows){
    if(!oldPath.toLowerCase().startsWith(oldRoot.toLowerCase()+'\\')&&!oldPath.toLowerCase().startsWith(oldRoot.toLowerCase()+'/')){otherRoot++;continue;}
    const suffix=oldPath.slice(oldRoot.length).replaceAll('\\','/').replace(/^\/+/, '');
    const candidate=path.resolve(recovered.get(oldPath)??path.join(newRoot,suffix));const relative=path.relative(newRoot,candidate);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Path escaped target root');
    if(!exists.has(candidate))exists.set(candidate,fs.existsSync(candidate));
    if(!exists.get(candidate)){countMissing++;missing.push({table,column,oldPath,candidate});continue;}
    mappings.push({oldPath,newPath:candidate});
   }
   if(apply)for(let i=0;i<mappings.length;i+=500){const batch=mappings.slice(i,i+500);const args=batch.flatMap(m=>[m.oldPath,m.newPath]);const pairs=batch.map((_,j)=>`($${j*2+1}::text,$${j*2+2}::text)`).join(',');await db.query(`UPDATE ${qi(table)} AS target SET ${qi(column)}=v.new_path FROM (VALUES ${pairs}) AS v(old_path,new_path) WHERE target.${qi(column)}=v.old_path`,args);}
   report.push({table,column,mapped:mappings.length,missing:countMissing,otherRoot});
  }
  if(apply)await db.query('COMMIT');
  const output=value('--report',path.join(process.cwd(),'storage','pg-path-remap-report.json'));fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({apply,oldRoot,newRoot,columns:report,missing},null,2));
  console.log(JSON.stringify({apply,columns:report,missing:missing.length,report:output},null,2));
 }catch(error){if(apply)await db.query('ROLLBACK').catch(()=>undefined);throw error;}finally{await db.end();}
}
main().catch(error=>{console.error(error);process.exit(1);});
