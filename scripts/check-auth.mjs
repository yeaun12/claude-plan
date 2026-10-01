// 독립 로컬 DB에서만 실행. 비밀번호·쿠키는 메모리에서 생성하며 출력하지 않는다.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {createClient} from '@libsql/client';
const base=process.argv[2]||'http://localhost:3107';
if(!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error('로컬 검사만 허용');
const sql=createClient({url:process.env.TURSO_DATABASE_URL||'file:/tmp/t07-auth-test.db'});
const evidence=[];let passed=0;
const sessionLabels=new Map();
function sanitize(value){
 if(Array.isArray(value)) return value.map(sanitize);
 if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/password|token|cookie|secret/i.test(k)?'[REDACTED]':sanitize(v)]));
 return value;
}
async function request(path,method='GET',body,cookie='',extra={}) {
 const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-PDS-Request':'1',...(cookie?{Cookie:cookie}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await r.json();
 // 화이트리스트만 증빙. auth 요청/응답의 쿠키·비밀번호·해시는 기록하지 않는다.
 if(cookie && !sessionLabels.has(cookie)) sessionLabels.set(cookie,'S'+(sessionLabels.size+1));
 evidence.push({method,path,status:r.status,account:cookie?'authenticated':'anonymous',
   headers:{...(cookie?{Cookie:'[REDACTED '+sessionLabels.get(cookie)+']'}:{}),...extra},
   ...(body?{body:sanitize(body)}:{}),response:sanitize(data)});
 return {status:r.status,data,cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
function check(desc,ok){assert.ok(ok,desc);passed++;console.log('PASS '+desc);}
const suffix=randomBytes(4).toString('hex');const password=randomBytes(24).toString('base64url');
const users=[];
for(const label of ['a','b']) {
 const username='test_'+label+'_'+suffix;
 const s=await request('/api/auth?action=signup','POST',{username,password});check('signup '+label,s.status===201);
 const l=await request('/api/auth?action=login','POST',{username,password});check('login '+label,l.status===200 && !!l.cookie);users.push({username,id:s.data.user.id,cookie:l.cookie});
}
const [a,b]=users;
check('duplicate normalized username',(await request('/api/auth?action=signup','POST',{username:a.username.toUpperCase(),password})).status===409);
const wrong=await request('/api/auth?action=login','POST',{username:a.username,password:randomBytes(24).toString('hex')});
const missing=await request('/api/auth?action=login','POST',{username:'missing_'+suffix,password});
check('generic login error',wrong.status===401 && missing.status===401 && wrong.data.error===missing.data.error);
const hashes=await sql.execute({sql:'SELECT password_hash FROM users WHERE id IN (?,?)',args:[a.id,b.id]});
check('same password different salt/hash',hashes.rows.length===2 && hashes.rows[0].password_hash!==hashes.rows[1].password_hash && hashes.rows.every(r=>r.password_hash.startsWith('scrypt$131072$8$1$')&&!r.password_hash.includes(password)));
for(const u of users) {
 u.plan=(await request('/api/plans','POST',{title:'test '+u.username,start_date:'2026-09-30',end_date:'2026-10-10',priority:2,success_criteria:'test',estimated_minutes:30},u.cookie)).data;
 check('create owned plan '+u.id,!!u.plan.id);
 u.task=(await request('/api/tasks','POST',{plan_id:u.plan.id,title:'test task',priority:2,estimated_minutes:10,tags:['test']},u.cookie)).data;
 check('create owned task '+u.id,!!u.task.id);
 u.run=(await request('/api/runs','POST',{task_id:u.task.id,started_at:'2026-09-30T01:00:00Z',ended_at:'2026-09-30T01:10:00Z',actual_minutes:10},u.cookie)).data;
 check('create owned run '+u.id,!!u.run.id);
 u.review=(await request('/api/reviews','POST',{plan_id:u.plan.id,lesson:'test'},u.cookie)).data;
 check('create owned review '+u.id,!!u.review.id);
}
for(const [u,other] of [[a,b],[b,a]]) {
 const before=(await request('/api/export','GET',undefined,other.cookie)).data;
 for(const method of ['GET','PATCH','DELETE']) check('cross-account task '+method+' '+u.id,(await request('/api/tasks?id='+other.task.id,method,method==='PATCH'?{title:'changed'}:undefined,u.cookie)).status===404);
 for(const [path,method,body] of [
 ['/api/plans?id='+other.plan.id,'GET'],['/api/plans?id='+other.plan.id,'PATCH',{title:'changed'}],
 ['/api/runs?id='+other.run.id,'GET'],['/api/runs?id='+other.run.id,'DELETE'],
 ['/api/reviews?plan_id='+other.plan.id,'GET'],['/api/stats?plan_id='+other.plan.id,'GET'],
 ['/api/tasks?action=complete&id='+other.task.id,'POST',{request_key:'test'}],
 ['/api/tasks?action=reopen&id='+other.task.id,'POST',{}],
 ['/api/tasks','POST',{plan_id:other.plan.id,title:'forged',priority:2,estimated_minutes:1}],
 ['/api/runs','POST',{task_id:other.task.id}],['/api/reviews','POST',{plan_id:other.plan.id,lesson:'forged'}],
 ['/api/plans','POST',{...u.plan,carried_from_review_id:other.review.id}],
 ]) check('foreign ID rejected '+path+' '+method,(await request(path,method,body,u.cookie)).status===404);
 for(const path of ['/api/plans','/api/tasks','/api/runs','/api/reviews','/api/export']) {
 const r=await request(path+'?user_id='+other.id,'GET',undefined,u.cookie,{'X-User-Id':String(other.id)});
 check('scoped list '+path,r.status===200 && !JSON.stringify(r.data).includes('test '+other.username));
 if(path==='/api/tasks') check('scoped task IDs',r.data.tasks.every(t=>t.plan_id===u.plan.id));
 }
 const forged=await request('/api/plans','POST',{title:'spoof owner',start_date:'2026-09-30',end_date:'2026-09-30',priority:2,success_criteria:'test',estimated_minutes:1,user_id:other.id},u.cookie,{'X-User-Id':String(other.id)});
 check('body owner ignored',forged.status===201 && forged.data.user_id===u.id);
 const after=(await request('/api/export','GET',undefined,other.cookie)).data;
 delete before.exported_at;delete after.exported_at;
 check('denials and spoof leave victim snapshot unchanged',JSON.stringify(before)===JSON.stringify(after));
}
for(const path of ['/api/plans','/api/tasks','/api/runs','/api/reviews','/api/stats?plan_id='+a.plan.id,'/api/export','/api/observation']) check('anonymous blocked '+path,(await request(path)).status===401);
check('foreign origin rejected',(await request('/api/plans','POST',{},a.cookie,{Origin:'https://evil.invalid'})).status===403);
check('missing CSRF header rejected',(await request('/api/plans','POST',{},a.cookie,{'X-PDS-Request':''})).status===403);
const session=await request('/api/auth','GET',undefined,a.cookie);
check('8h expiry',Date.parse(session.data.expires_at)>Date.now()+7.9*3600000 && Date.parse(session.data.expires_at)<Date.now()+8.1*3600000);
const beforeLogout=await request('/api/plans','GET',undefined,a.cookie);
await request('/api/auth?action=logout','POST',{},a.cookie);
const afterLogout=await request('/api/plans','GET',undefined,a.cookie);
check('same cookie same GET URL after logout rejected',beforeLogout.status===200 && afterLogout.status===401);
a.cookie=(await request('/api/auth?action=login','POST',{username:a.username,password})).cookie;
const second=(await request('/api/auth?action=login','POST',{username:a.username,password})).cookie;
const nextPassword=randomBytes(24).toString('base64url');
check('password change',(await request('/api/auth?action=password','POST',{current_password:password,new_password:nextPassword},a.cookie)).status===200);
for(const cookie of [a.cookie,second]) check('old session invalid after password change',(await request('/api/plans','GET',undefined,cookie)).status===401);
check('old password rejected',(await request('/api/auth?action=login','POST',{username:a.username,password})).status===401);
a.cookie=(await request('/api/auth?action=login','POST',{username:a.username,password:nextPassword})).cookie;
await sql.execute({sql:"UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=?",args:[a.id]});
check('expired session rejected',(await request('/api/plans','GET',undefined,a.cookie)).status===401);
a.cookie=(await request('/api/auth?action=login','POST',{username:a.username,password:nextPassword})).cookie;
const config={question:'TEST ONLY',metric:'test minutes',unit:'minutes',calculation:'sum',plan_rule:'rule one',missing:'exclude',duplicate:'ID once',outlier:'retain verified',rounding:'2 decimals',week_start:'Monday',value:10,note:'AUTOMATED TEST FIXTURE, NOT REAL OBSERVATION'};
check('observation day1',(await request('/api/observation?action=start','POST',config,a.cookie)).status===201);
check('same day duplicate rejected',(await request('/api/observation?action=day','POST',{value:20,note:'test'},a.cookie)).status===409);
check('early rule change rejected',(await request('/api/observation?action=change','POST',{plan_rule:'two',reason:'test'},a.cookie)).status===409);
const obs=(await request('/api/observation','GET',undefined,a.cookie)).data;
check('other account observation empty',(await request('/api/observation','GET',undefined,b.cookie)).data.observation===null);
// 로컬 경계 검사 전용 가상 fixture. 실제 5일 관찰 기록으로 사용하지 않는다.
await sql.execute({sql:"UPDATE observation_days SET date='2000-01-01' WHERE observation_id=?",args:[obs.observation.id]});
check('observation day2',(await request('/api/observation?action=day','POST',{value:20,note:'TEST FIXTURE'},a.cookie)).status===201);
await sql.execute({sql:"UPDATE observation_days SET date='2000-01-02' WHERE observation_id=? AND date<>'2000-01-01'",args:[obs.observation.id]});
check('day3 requires rule change',(await request('/api/observation?action=day','POST',{value:30,note:'TEST FIXTURE'},a.cookie)).status===409);
check('change after day2',(await request('/api/observation?action=change','POST',{plan_rule:'rule two',reason:'TEST FIXTURE'},a.cookie)).status===201);
check('day3 after change',(await request('/api/observation?action=day','POST',{value:30,note:'TEST FIXTURE'},a.cookie)).status===201);
const totals=(await request('/api/observation','GET',undefined,a.cookie)).data;
check('independent sum/mean',totals.total.sum===60 && totals.total.mean===20 && totals.before.mean===15 && totals.after.mean===30);
check('change references exact day1/day2',JSON.stringify(totals.observation.change.reference_day_ids)===JSON.stringify(totals.days.slice(0,2).map(d=>d.id)));
const exported=(await request('/api/export','GET',undefined,a.cookie)).data;
check('export includes observation and no auth secrets',exported.observation_days.length===3 && !JSON.stringify(exported).includes('password_hash')&&!JSON.stringify(exported).includes('token_hash'));
const bBefore=(await request('/api/export','GET',undefined,b.cookie)).data;
check('delete account',(await request('/api/auth','DELETE',{password:nextPassword},a.cookie)).status===200);
check('deleted session rejected',(await request('/api/plans','GET',undefined,a.cookie)).status===401);
for(const table of ['users','sessions','plans','observations']) {
 const r=await sql.execute({sql:`SELECT COUNT(*) n FROM ${table} WHERE ${table==='users'?'id':'user_id'}=?`,args:[a.id]});check('deleted account cascade '+table,Number(r.rows[0].n)===0);
}
const orphan=await sql.execute('PRAGMA foreign_key_check');check('no dangling foreign keys',orphan.rows.length===0);
const bAfter=(await request('/api/export','GET',undefined,b.cookie)).data;delete bBefore.exported_at;delete bAfter.exported_at;check('account deletion leaves other user unchanged',JSON.stringify(bBefore)===JSON.stringify(bAfter));
await writeFile('evidence/t07-api-results.json',JSON.stringify({environment:'local isolated test DB',observations:'synthetic boundary fixtures; NOT user five-day observations',executed_at:new Date().toISOString(),passed,password_storage_examples:hashes.rows.map(r=>r.password_hash),requests:evidence},null,2));
console.log(`TOTAL ${passed} PASS`);sql.close();
