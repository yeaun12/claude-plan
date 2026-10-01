import {spawn} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
const dir=await mkdtemp(tmpdir()+'/pds-check-');
const env={...process.env,PORT:process.env.PORT||'3107',TURSO_DATABASE_URL:'file:'+dir+'/test.db'};
const server=spawn(process.execPath,['scripts/dev-server.mjs'],{env,stdio:['ignore','pipe','inherit']});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);});
try {
 for(const script of process.argv.slice(2).length?process.argv.slice(2):['scripts/check-auth.mjs','scripts/check.mjs']) {
  // 로컬 검증 전용 서버. 실제 배포의 제한 정책은 바꾸지 않는다.
  const result=await new Promise(resolve=>spawn(process.execPath,[script,'http://localhost:'+env.PORT],{env,stdio:'inherit'}).on('exit',resolve));
  if(result!==0){process.exitCode=result||1;break;}
 }
}finally{server.kill();}
