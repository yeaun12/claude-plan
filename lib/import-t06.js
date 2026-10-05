import { createHash, randomUUID } from 'node:crypto';
import { db, HttpError, nowIso } from './db.js';
const fields={
 plans:['title','start_date','end_date','priority','success_criteria','estimated_minutes','carried_from_review_id','carried_lesson','version','created_at','updated_at'],
 plan_versions:['plan_id','version','title','start_date','end_date','priority','success_criteria','estimated_minutes','change_note','recorded_at'],
 tasks:['plan_id','title','due_date','priority','estimated_minutes','status','cycle','completed_at','deleted_at','created_at','updated_at'],
 runs:['task_id','started_at','ended_at','actual_minutes','blocker','note','created_at'],
 reviews:['plan_id','period_from','period_to','stats_json','went_well','lesson','created_at'],
 task_completions:['task_id','cycle','request_key','completed_at','reopened_at'],
 task_tags:['task_id','tag']};
export async function importT06(data,user){
 if(data?.schema!=='pds-schema-v2') throw new HttpError(400,'T06 자료 형식이 아닙니다.');
 for(const [t,cols] of Object.entries(fields)){
  if(!Array.isArray(data[t])||data[t].length>10000) throw new HttpError(400,'자료 목록이 올바르지 않습니다.');
  const ids=new Set();
  for(const row of data[t]){
   if(!row||cols.some(k=>!(k in row))||Object.values(row).some(v=>v!==null&&!['string','number'].includes(typeof v))) throw new HttpError(400,'자료 필드가 올바르지 않습니다.');
   if(t!=='task_tags') {if(!Number.isSafeInteger(row.id)||row.id<=0||ids.has(row.id)) throw new HttpError(400,'원본 ID가 올바르지 않습니다.');ids.add(row.id);}
  }
 }
 const fingerprint=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(fields).map(k=>[k,data[k]])))).digest('hex');
 const key='t06-copy-v1:'+user.id;
 const tx=await db().transaction('write');
 const maps=Object.fromEntries(Object.keys(fields).map(k=>[k,{}]));
 const ref=(table,id)=>{if(id==null)return null;const v=maps[table][id];if(!v)throw new HttpError(400,'원본 자료의 연결이 끊겨 있습니다.');return v;};
 try{
  const done=await tx.execute({sql:'SELECT detail FROM migrations WHERE name=?',args:[key]});
  if(done.rows.length){await tx.rollback();return {already_imported:true,...JSON.parse(done.rows[0].detail)};}
  async function insert(t,row){
   const cols=Object.keys(row);const result=await tx.execute({sql:`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`,args:cols.map(k=>row[k])});return Number(result.lastInsertRowid);
  }
  for(const t of ['plans','tasks','plan_versions','runs','reviews','task_completions','task_tags']){
   for(const old of data[t]){
    const row=Object.fromEntries(fields[t].map(k=>[k,old[k]]));
    if(t==='plans'){row.carried_from_review_id=null;row.user_id=user.id;}
    if('plan_id' in row) row.plan_id=ref('plans',old.plan_id);
    if('task_id' in row) row.task_id=ref('tasks',old.task_id);
    if(t==='task_completions') row.request_key='t06-import:'+randomUUID();
    if(t==='reviews'){
     const rewrite=(v,k)=>{if(k==='plan_id')return ref('plans',v);if(k==='task_ids')return v.map(id=>ref('tasks',id));if(k==='run_ids')return v.map(id=>ref('runs',id));if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([a,b])=>[a,rewrite(b,a)]));return v;};
     row.stats_json=JSON.stringify(rewrite(JSON.parse(old.stats_json),''));
    }
    const id=await insert(t,row);if(t!=='task_tags') maps[t][old.id]=id;
   }
  }
  for(const old of data.plans) if(old.carried_from_review_id!=null) await tx.execute({sql:'UPDATE plans SET carried_from_review_id=? WHERE id=? AND user_id=?',args:[ref('reviews',old.carried_from_review_id),ref('plans',old.id),user.id]});
  const result={source:'https://claude-plan.vercel.app',source_exported_at:data.exported_at,imported_at:nowIso(),fingerprint,counts:Object.fromEntries(Object.keys(fields).map(t=>[t,data[t].length])),id_map:maps};
  await tx.execute({sql:'INSERT INTO migrations(name,applied_at,detail) VALUES(?,?,?)',args:[key,result.imported_at,JSON.stringify(result)]});
  await tx.commit();return result;
 }catch(e){await tx.rollback().catch(()=>{});throw e;}finally{tx.close();}
}
