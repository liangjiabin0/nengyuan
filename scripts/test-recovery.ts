import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Hono} from 'hono';
import {registerApiRoutes} from '../server/api/routes';
import {isLocalAdminHost} from '../src/lib/auth/request';
import {ensureDefaultAdmin,createUser} from '../src/lib/auth/users';
import {createSession} from '../src/lib/auth/session';
import {enqueueJob} from '../src/lib/jobs/queue';
import {getDb} from '../src/lib/db';
async function main(){
 if(!new URL(process.env.DATABASE_URL??'').pathname.includes('repair_'))throw Error('Use a dedicated repair_ test database');
 for(const headers of [{host:'localhost'},{host:'127.0.0.1'},{host:'attacker.invalid','x-ai4es-original-host':'localhost'},{host:'attacker.invalid','x-forwarded-host':'localhost'}])assert.equal(isLocalAdminHost(new Request('http://localhost/api',{headers})),false);
 const app=new Hono();await registerApiRoutes(app);
 const admin=await ensureDefaultAdmin();const adminToken=await createSession(admin.id);
 const user=await createUser({username:'recovery_'+Date.now(),password:'TestAccount_Strong_20261002'});const userToken=await createSession(user.id);
 // Header name is exported by the application; do not hard-code a competing cookie contract.
 const {SESSION_HEADER}=await import('../src/lib/auth/types');
 const job=await enqueueJob('reindex',{audit:true});
 try{
  for(const url of ['/api/jobs','/api/jobs/'+job.id]){
   assert.equal((await app.request(url)).status,401);
   assert.equal((await app.request(url,{headers:{[SESSION_HEADER]:userToken}})).status,403);
  }
  const jobs=await app.request('/api/jobs',{headers:{[SESSION_HEADER]:adminToken}});assert.equal(jobs.status,200);assert.ok(Array.isArray((await jobs.json()).jobs));
  const item=await app.request('/api/jobs/'+job.id,{headers:{[SESSION_HEADER]:adminToken}});assert.equal((await item.json()).job.id,job.id);
  assert.equal((await app.request('/api/jobs/nonexistent',{headers:{[SESSION_HEADER]:adminToken}})).status,404);
  const me=await app.request('/api/auth/me',{headers:{host:'localhost','x-ai4es-original-host':'localhost'}});assert.equal((await me.json()).authenticated,false);
  // Explicitly cleared keys and workspace IDs must not fall back to older environment values.
  const settingsFile=path.join(process.cwd(),'storage','ppt-voice-settings.json');
  const previousStored=fs.existsSync(settingsFile)?fs.readFileSync(settingsFile):null;
  const previous=process.env.BAILIAN_WORKSPACE_ID;process.env.BAILIAN_WORKSPACE_ID='ws-test-old';
  const {savePptVoiceTtsSettings,getPptVoiceTtsSettings}=await import('../src/lib/ppt-voice/settings');
  try{savePptVoiceTtsSettings({workspaceId:'',baseUrl:'',clearApiKey:true});assert.equal(getPptVoiceTtsSettings().workspaceId,'');assert.equal(getPptVoiceTtsSettings().dashscopeApiKey,'');}finally{if(previousStored)fs.writeFileSync(settingsFile,previousStored);else fs.rmSync(settingsFile,{force:true});if(previous===undefined)delete process.env.BAILIAN_WORKSPACE_ID;else process.env.BAILIAN_WORKSPACE_ID=previous;}
  console.log('RECOVERY_AUTH_JOBS_SETTINGS_PASS');
 }finally{
  await getDb().prepare('DELETE FROM background_jobs WHERE id=?').run(job.id);
  await getDb().prepare('DELETE FROM auth_sessions WHERE user_id=?').run(user.id);
  await getDb().prepare('DELETE FROM users WHERE id=?').run(user.id);
 }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
