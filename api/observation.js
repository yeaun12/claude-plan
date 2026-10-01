// 실제 날짜는 서버의 Asia/Seoul 오늘을 사용. 소급·미래 날짜 입력을 받지 않는다.
import { handler, send, db, one, all, v, todayKst, nowIso, HttpError } from '../lib/db.js';
const summary = days => {
  const sum=days.reduce((s,d)=>s+Number(d.value),0);
  return {count:days.length,sum,mean:days.length ? Math.round(sum/days.length*100)/100 : null};
};
export default handler({
  async GET({res,user}) {
    const o=await one('SELECT * FROM observations WHERE user_id=?',[user.id]);
    const days=o ? await all('SELECT * FROM observation_days WHERE observation_id=? ORDER BY date',[o.id]):[];
    send(res,200,{observation:o ? {...o,config:JSON.parse(o.config_json),change:o.change_json?JSON.parse(o.change_json):null}:null,
      days,today:todayKst(),total:summary(days),before:summary(days.slice(0,2)),after:summary(days.slice(2))});
  },
  async POST({res,user,q,body}) {
    const tx=await db().transaction('write');
    try {
      const existing=await tx.execute({sql:'SELECT * FROM observations WHERE user_id=?',args:[user.id]});
      const o=existing.rows[0];
      const now=nowIso(), date=todayKst();
      if(q.action==='start') {
        if(o) throw new HttpError(409,'이미 관찰을 시작했습니다. 질문과 계산 규칙은 고정됩니다.');
        const config={};
        for(const k of ['question','metric','unit','calculation','plan_rule','missing','duplicate','outlier','rounding','week_start']) config[k]=v.text(body[k],k,{max:500});
        const value=v.minutes(body.value,'오늘 관찰값');
        const note=v.text(body.note,'오늘 기록 근거',{max:1000});
        const r=await tx.execute({sql:'INSERT INTO observations(user_id,config_json,created_at) VALUES(?,?,?)',args:[user.id,JSON.stringify(config),now]});
        await tx.execute({sql:'INSERT INTO observation_days(observation_id,date,value,note,created_at) VALUES(?,?,?,?,?)',args:[Number(r.lastInsertRowid),date,value,note,now]});
      } else {
        if(!o) throw new HttpError(400,'먼저 1일차 관찰을 시작해 주세요.');
        const r=await tx.execute({sql:'SELECT * FROM observation_days WHERE observation_id=? ORDER BY date',args:[o.id]});
        const days=r.rows;
        if(q.action==='change') {
          if(days.length!==2 || o.changed_at) throw new HttpError(409,'계획 규칙은 2일차 기록 뒤, 3일차 기록 전에 한 번만 바꿀 수 있습니다.');
          const rule=v.text(body.plan_rule,'새 계획 규칙',{max:500});
          if(rule===JSON.parse(o.config_json).plan_rule) throw new HttpError(400,'변경 전과 다른 계획 규칙을 입력해 주세요.');
          const change={plan_rule:rule,reason:v.text(body.reason,'변경 이유',{max:500}),reference_day_ids:days.map(d=>d.id)};
          await tx.execute({sql:'UPDATE observations SET change_json=?,changed_at=? WHERE id=?',args:[JSON.stringify(change),now,o.id]});
        } else if(q.action==='day') {
          if(days.length>=5) throw new HttpError(409,'5일 관찰을 완료했습니다.');
          if(days.some(d=>d.date===date)) throw new HttpError(409,'오늘 기록은 이미 저장됐습니다. 하루 한 번 기록합니다.');
          if(days.length===2 && !o.changed_at) throw new HttpError(409,'3일차 전에 계획 규칙 하나를 변경하고 이유를 남겨 주세요.');
          const value=v.minutes(body.value,'오늘 관찰값');
          const note=v.text(body.note,'오늘 기록 근거',{max:1000});
          await tx.execute({sql:'INSERT INTO observation_days(observation_id,date,value,note,created_at) VALUES(?,?,?,?,?)',args:[o.id,date,value,note,now]});
        } else throw new HttpError(400,'지원하지 않는 작업입니다.');
      }
      await tx.commit();send(res,201,{saved:true,date});
    } catch(e) {await tx.rollback().catch(()=>{});throw e;} finally {tx.close();}
  },
});
