// 서버 운영자가 환경 변수로 DB를 연결한 상태에서만 실행한다. 웹 API가 아니다.
// node scripts/migrate-owner.mjs <username> [T06-export.json]
// JSON 파일은 빈 데이터 DB로의 리허설에서만 허용. 운영 DB에서는 파일 없이 소유자만 지정.
import { readFile } from 'node:fs/promises';
import { ensureSchema, db, one, nowIso } from '../lib/db.js';
const username=process.argv[2]?.trim().toLowerCase(), filename=process.argv[3];
if(!username || !process.env.TURSO_DATABASE_URL) throw new Error('DB 환경 변수와 기존 계정 아이디가 필요합니다.');
await ensureSchema();
const user=await one('SELECT id FROM users WHERE username=?',[username]);
if(!user) throw new Error('먼저 대상 DB의 앱에서 소유자 계정을 직접 생성하세요.');
const tables=['plans','plan_versions','tasks','task_tags','task_completions','runs','reviews'];
const snapshot=filename ? JSON.parse(await readFile(filename,'utf8')) : null;
if(snapshot && snapshot.schema!=='pds-schema-v2') throw new Error('T06 v2 내보내기 파일만 허용합니다.');
const tx=await db().transaction('write');
try {
  await tx.execute('PRAGMA defer_foreign_keys=ON'); // 계획↔돌아보기 순환 관계는 커밋 시 검사
  const done=await tx.execute("SELECT name FROM migrations WHERE name='t06-owner'");
  if(done.rows.length) throw new Error('소유자 이전은 이미 완료됐습니다.');
  if(snapshot) {
    for(const table of tables) {
      const count=await tx.execute(`SELECT COUNT(*) n FROM ${table}`);
      if(Number(count.rows[0].n)) throw new Error('파일 복원은 기록 테이블이 모두 빈 DB에서만 가능합니다.');
    }
    for(const table of tables) {
      if(!Array.isArray(snapshot[table])) throw new Error('내보내기 테이블 누락');
      const info=await tx.execute(`PRAGMA table_info(${table})`);
      const allowed=info.rows.map(x=>x.name).filter(x=>x!=='user_id');
      for(const row of snapshot[table]) {
        const cols=Object.keys(row);
        if(cols.some(c=>!allowed.includes(c))) throw new Error('허용되지 않은 열');
        await tx.execute({sql:`INSERT INTO ${table} (${cols.map(c=>'"'+c+'"').join(',')}) VALUES (${cols.map(()=>'?').join(',')})`,args:cols.map(c=>row[c])});
      }
    }
  }
  // 이행 중 관계의 주인이 달라지는 경우 중단한다.
  const invalid=await tx.execute({sql:`SELECT p.id FROM plans p JOIN reviews r ON r.id=p.carried_from_review_id
    JOIN plans source ON source.id=r.plan_id WHERE COALESCE(p.user_id,?) <> COALESCE(source.user_id,?)`,args:[user.id,user.id]});
  if(invalid.rows.length) throw new Error('다른 소유자 간 관계가 있어 이전을 중단했습니다.');
  const foreign=await tx.execute('PRAGMA foreign_key_check');
  if(foreign.rows.length) throw new Error('연결이 끊긴 기록이 있어 이전을 중단했습니다.');
  const r=await tx.execute({sql:'UPDATE plans SET user_id=? WHERE user_id IS NULL',args:[user.id]});
  await tx.execute({sql:'INSERT INTO migrations(name,applied_at,detail) VALUES(?,?,?)',args:['t06-owner',nowIso(),JSON.stringify({user_id:user.id,plans:r.rowsAffected})]});
  await tx.commit();
  console.log(JSON.stringify({migrated_plans:r.rowsAffected,owner_id:user.id,ids_preserved:true}));
} catch(e){await tx.rollback().catch(()=>{});throw e;} finally{tx.close();db().close();}
