import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
const base=process.argv[2]||'http://localhost:3107';
const source=process.env.T06_EXPORT_PATH;
if(!source) throw new Error('T06_EXPORT_PATH 환경 변수로 비공개 백업 파일을 지정하세요.');
const snapshot=JSON.parse(await readFile(source,'utf8'));
const username='migration_owner',password=randomBytes(24).toString('hex');
const post=async(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-PDS-Request':'1'},body:JSON.stringify(body)});
assert.equal((await post('/api/auth?action=signup',{username,password})).status,201);
const migration=spawnSync(process.execPath,['scripts/migrate-owner.mjs',username,source],{env:process.env,encoding:'utf8'});
if(migration.status!==0) throw new Error(migration.stderr);
const login=await post('/api/auth?action=login',{username,password});
const cookie=login.headers.get('set-cookie').split(';')[0];
const restored=await (await fetch(base+'/api/export',{headers:{Cookie:cookie}})).json();
const counts={};
for(const table of ['plans','plan_versions','tasks','task_tags','task_completions','runs','reviews']) {
 const normalize=rows=>rows.map(row=>{const r={...row};delete r.user_id;return r;}).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 assert.deepEqual(normalize(restored[table]),normalize(snapshot[table]),table+' contents and IDs preserved');
 counts[table]=restored[table].length;
}
const repeat=spawnSync(process.execPath,['scripts/migrate-owner.mjs',username],{env:process.env,encoding:'utf8'});
assert.notEqual(repeat.status,0);
await writeFile('evidence/t07-migration-result.json',JSON.stringify({environment:'local rehearsal using supplied T06 backup; production NOT migrated',executed_at:new Date().toISOString(),counts,all_original_fields_and_ids_equal:true,repeat_migration_rejected:true},null,2));
console.log('PASS migration: all original fields, IDs and relationships preserved; repeat rejected',counts);
