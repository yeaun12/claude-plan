import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
process.env.TURSO_DATABASE_URL='file:'+(await mkdtemp(tmpdir()+'/t06-import-'))+'/test.db';
const {db,ensureSchema}=await import('../lib/db.js');
const {importT06}=await import('../lib/import-t06.js');
await ensureSchema();
await db().execute("INSERT INTO users(id,username,password_hash,created_at) VALUES(2,'aleph02','test-only','2026-10-01'),(3,'other','test-only','2026-10-01')");
await db().execute("INSERT INTO plans(id,title,start_date,end_date,priority,success_criteria,estimated_minutes,created_at,updated_at,user_id) VALUES(2,'Existing','2026-10-01','2026-10-01',2,'Keep',1,'2026-10-01','2026-10-01',2),(3,'Other account','2026-10-01','2026-10-01',2,'Keep',1,'2026-10-01','2026-10-01',3)");
await db().execute("INSERT INTO observations(id,user_id,config_json,created_at) VALUES(1,2,'{}','2026-10-01')");
for(let i=0;i<5;i++)await db().execute({sql:'INSERT INTO observation_days(observation_id,date,value,note,created_at) VALUES(1,?,?,?,?)',args:['2026-10-0'+(i+1),[130,250,40,30,120][i],'keep','2026-10-01']});
const snapshot=async()=>JSON.stringify((await db().execute('SELECT * FROM observation_days')).rows);
const before=await snapshot();
const source=JSON.parse(await readFile(process.argv[2],'utf8'));
const result=await importT06(source,{id:2});
for(const [t,count] of Object.entries(result.counts))assert.equal((await db().execute('SELECT * FROM '+t)).rows.length,count+(t==='plans'?2:0));
assert.equal(await snapshot(),before);
assert.equal((await db().execute('SELECT title FROM plans WHERE id=2')).rows[0].title,'Existing');
assert.equal((await db().execute('SELECT user_id FROM plans WHERE id=3')).rows[0].user_id,3);
for(const p of source.plans){const row=(await db().execute({sql:'SELECT * FROM plans WHERE id=?',args:[result.id_map.plans[p.id]]})).rows[0];assert.equal(row.title,p.title);assert.equal(row.created_at,p.created_at);assert.equal(row.user_id,2);assert.equal(row.carried_from_review_id,p.carried_from_review_id==null?null:result.id_map.reviews[p.carried_from_review_id]);}
for(const r of source.reviews){const row=(await db().execute({sql:'SELECT * FROM reviews WHERE id=?',args:[result.id_map.reviews[r.id]]})).rows[0];const stats=JSON.parse(row.stats_json);assert.equal(stats.plan_id,result.id_map.plans[r.plan_id]);assert.deepEqual(stats.planned.task_ids,JSON.parse(r.stats_json).planned.task_ids.map(id=>result.id_map.tasks[id]));}
assert.equal((await importT06(source,{id:2})).already_imported,true);
const bad=structuredClone(source);bad.tasks[0].plan_id=999999;
await assert.rejects(importT06(bad,{id:3}));
assert.equal((await db().execute('SELECT * FROM plans')).rows.length,source.plans.length+2);
assert.equal((await db().execute('PRAGMA foreign_key_check')).rows.length,0);
console.log('PASS: ID collisions, relationships, review snapshot IDs, existing records, observation preservation, other owner isolation, duplicate prevention, invalid-reference rollback');
db().close();
