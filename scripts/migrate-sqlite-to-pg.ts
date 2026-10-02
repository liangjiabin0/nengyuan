/** Copy legacy SQLite into an EMPTY PostgreSQL target. Dry-run unless --apply. */
import fs from 'node:fs';
import path from 'node:path';
import Sqlite from 'better-sqlite3';
import {Client} from 'pg';
import {POSTGRES_SCHEMA_SQL} from '../src/lib/db/schema';
async function main(){
 const source=process.argv.find((v,i)=>i>1&&!v.startsWith('--'));
 if(!source||!fs.existsSync(source))throw Error('Usage: npm run db:migrate-pg -- /absolute/legacy.sqlite [--apply]; DATABASE_URL must point to an empty target');
 if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required');
 const sqlite=new Sqlite(path.resolve(source),{readonly:true});
 const pg=new Client({connectionString:process.env.DATABASE_URL});await pg.connect();
 const qi=(s:string)=>'"'+s.replaceAll('"','""')+'"';
 try{
  await pg.query('BEGIN');
  await pg.query(POSTGRES_SCHEMA_SQL);
  const tables=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
  const plan=[];let compatible=true;
  for(const {name} of tables){
   const count=(sqlite.prepare(`SELECT COUNT(*) n FROM ${qi(name)}`).get() as {n:number}).n;if(!count)continue;
   const columns=sqlite.prepare(`PRAGMA table_info(${qi(name)})`).all() as {name:string}[];
   const target=await pg.query<{column_name:string}>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[name]);
   const targetNames=new Set(target.rows.map(r=>r.column_name));const unsupported=columns.map(c=>c.name).filter(c=>!targetNames.has(c));
   const existing=targetNames.size?(await pg.query(`SELECT COUNT(*) n FROM ${qi(name)}`)).rows[0].n:null;
   if(unsupported.length||!targetNames.size||Number(existing)>0)compatible=false;
   plan.push({name,count,columns:columns.map(c=>c.name),unsupported,existing});
  }
  console.log(JSON.stringify({source:path.resolve(source),compatible,apply:process.argv.includes('--apply'),tables:plan},null,2));
  if(!process.argv.includes('--apply')){await pg.query('ROLLBACK');return;}
  if(!compatible)throw Error('Refusing migration: target has records or source schema needs an explicit mapping. Source was not modified.');
  await pg.query('SET CONSTRAINTS ALL DEFERRED');
  for(const table of plan){
   const placeholders=table.columns.map((_,i)=>'$'+(i+1)).join(',');
   const insert=`INSERT INTO ${qi(table.name)} (${table.columns.map(qi).join(',')}) VALUES (${placeholders})`;
   for(const row of sqlite.prepare(`SELECT * FROM ${qi(table.name)}`).iterate() as Iterable<Record<string,unknown>>)await pg.query(insert,table.columns.map(c=>row[c]));
   const n=Number((await pg.query(`SELECT COUNT(*) n FROM ${qi(table.name)}`)).rows[0].n);if(n!==table.count)throw Error('Row count mismatch: '+table.name);
   for(const column of table.columns){const result=await pg.query<{seq:string|null}>('SELECT pg_get_serial_sequence($1,$2) seq',[table.name,column]);const seq=result.rows[0].seq;if(seq)await pg.query(`SELECT setval($1::regclass, COALESCE(MAX(${qi(column)}),1), COUNT(*)>0) FROM ${qi(table.name)}`,[seq]);}
  }
  await pg.query('COMMIT');console.log('MIGRATION_PASS');
 }catch(error){await pg.query('ROLLBACK').catch(()=>undefined);throw error;}finally{sqlite.close();await pg.end();}
}
main().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});
