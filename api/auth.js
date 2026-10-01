import { handler, send, db, one, HttpError, nowIso } from '../lib/db.js';
import { authenticate, passwordInput, hashPassword, verifyPassword, issueSession, setCookie, limitAttempts } from '../lib/auth.js';
const safeUser = u => ({id:u.id, username:u.username, created_at:u.created_at});
export default handler({
  async GET({req,res}) {
    const u = await authenticate(req);
    send(res,200,{user:safeUser(u),expires_at:u.expires_at});
  },
  async POST({req,res,q,body}) {
    if (q.action === 'signup' || q.action === 'login') {
      const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
      if (!/^[a-z0-9_]{3,32}$/.test(username)) throw new HttpError(400,'아이디는 영문 소문자·숫자·밑줄 3~32자로 입력해 주세요.');
      await limitAttempts(req, username);
      if (q.action === 'signup') {
        const hash = await hashPassword(passwordInput(body.password));
        let r;
        try { r=await db().execute({sql:'INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)',args:[username,hash,nowIso()]}); }
        catch(e) { if(String(e.message).includes('UNIQUE constraint')) throw new HttpError(409,'이미 사용 중인 아이디입니다.'); throw e; }
        const u=await one('SELECT id,username,created_at FROM users WHERE id=?',[Number(r.lastInsertRowid)]);
        // 가입은 자동 로그인하지 않는다. 실제 로그인 흐름을 거쳐 세션을 발급한다.
        return send(res,201,{user:safeUser(u)});
      }
      const u=await one('SELECT * FROM users WHERE username=?',[username]);
      const ok=await verifyPassword(body.password,u?.password_hash);
      if (!ok || !u) throw new HttpError(401,'아이디 또는 비밀번호가 올바르지 않습니다.');
      return send(res,200,{user:safeUser(u),expires_at:await issueSession(res,u.id,u.password_hash)});
    }
    const u=await authenticate(req);
    if (q.action === 'logout') {
      await db().execute({sql:'DELETE FROM sessions WHERE user_id=?',args:[u.id]});
      setCookie(res,'',0);
      return send(res,200,{logged_out:true});
    }
    if (q.action === 'password') {
      await limitAttempts(req,u.username);
      const current=await one('SELECT password_hash FROM users WHERE id=?',[u.id]);
      if (!await verifyPassword(body.current_password,current?.password_hash)) throw new HttpError(401,'현재 비밀번호가 올바르지 않습니다.');
      const hash=await hashPassword(passwordInput(body.new_password));
      await db().batch([
        {sql:'UPDATE users SET password_hash=? WHERE id=?',args:[hash,u.id]},
        {sql:'DELETE FROM sessions WHERE user_id=?',args:[u.id]},
      ],'write');
      setCookie(res,'',0);
      return send(res,200,{changed:true,login_required:true});
    }
    throw new HttpError(400,'지원하지 않는 작업입니다.');
  },
  async DELETE({req,res,body}) {
    const u=await authenticate(req);
    await limitAttempts(req,u.username);
    const current=await one('SELECT password_hash FROM users WHERE id=?',[u.id]);
    if (!await verifyPassword(body.password,current?.password_hash)) throw new HttpError(401,'현재 비밀번호가 올바르지 않습니다.');
    const plans='SELECT id FROM plans WHERE user_id=?';
    const tasks=`SELECT id FROM tasks WHERE plan_id IN (${plans})`;
    const statements=[
      {sql:'DELETE FROM observation_days WHERE observation_id IN (SELECT id FROM observations WHERE user_id=?)',args:[u.id]},
      {sql:'DELETE FROM observations WHERE user_id=?',args:[u.id]},
      ...['task_tags','task_completions','runs'].map(t=>({sql:`DELETE FROM ${t} WHERE task_id IN (${tasks})`,args:[u.id]})),
      {sql:`UPDATE plans SET carried_from_review_id=NULL WHERE user_id=?`,args:[u.id]},
      ...['reviews','plan_versions','tasks'].map(t=>({sql:`DELETE FROM ${t} WHERE plan_id IN (${plans})`,args:[u.id]})),
      {sql:'DELETE FROM plans WHERE user_id=?',args:[u.id]},
      {sql:'DELETE FROM sessions WHERE user_id=?',args:[u.id]},
      {sql:'DELETE FROM users WHERE id=?',args:[u.id]},
    ];
    await db().batch(statements,'write');
    setCookie(res,'',0);send(res,200,{deleted:true});
  },
},{publicRoute:true});
