// T07 인증 v1: Node crypto.scrypt + DB-backed opaque sessions.
import { randomBytes, createHash, scrypt as rawScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db, one, HttpError } from './db.js';
const scrypt = promisify(rawScrypt);
export const SESSION_SECONDS = 8 * 60 * 60;
const production = () => !!process.env.VERCEL || process.env.NODE_ENV === 'production';
const cookieName = () => production() ? '__Host-pds_session' : 'pds_session';
export const digest = value => createHash('sha256').update(value).digest('hex');
export function passwordInput(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) throw new HttpError(400, '비밀번호는 12~128자로 입력해 주세요.');
  return value;
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
  return `scrypt$131072$8$1$${salt}$${key.toString('hex')}`;
}
// 동일한 연산으로 존재하지 않는 계정도 확인한다. 원문은 저장·로그에 기록하지 않는다.
const dummy = `scrypt$131072$8$1$${'0'.repeat(32)}$${'0'.repeat(128)}`;
export async function verifyPassword(password, stored = dummy) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [scheme, n, r, p, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || n !== '131072' || r !== '8' || p !== '1' || !/^[a-f0-9]{128}$/.test(expected || '')) return false;
  const key = await scrypt(password, salt, 64, { N: +n, r: +r, p: +p, maxmem: 160 * 1024 * 1024 });
  return timingSafeEqual(key, Buffer.from(expected, 'hex'));
}
export function readSession(req) {
  const cookies = String(req.headers.cookie || '').split(';').map(x => x.trim());
  const value = cookies.find(x => x.startsWith(cookieName() + '='))?.slice(cookieName().length + 1);
  return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
}
export async function authenticate(req) {
  const token = readSession(req);
  if (!token) throw new HttpError(401, '로그인이 필요합니다.');
  const user = await one(`SELECT u.id, u.username, u.created_at, s.token_hash, s.expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`, [digest(token), new Date().toISOString()]);
  if (!user) throw new HttpError(401, '로그인이 만료됐습니다. 다시 로그인해 주세요.');
  return user;
}
export function setCookie(res, token, seconds = SESSION_SECONDS) {
  res.setHeader('Set-Cookie', `${cookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${production() ? '; Secure' : ''}`);
}
export async function issueSession(res, userId, expectedHash) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  const inserted = await db().execute({sql:'INSERT INTO sessions(token_hash,user_id,expires_at,created_at) SELECT ?,id,?,? FROM users WHERE id=? AND password_hash=?',args:[digest(token),expires,new Date().toISOString(),userId,expectedHash]});
  if (!inserted.rowsAffected) throw new HttpError(401, '다시 로그인해 주세요.');
  setCookie(res, token);
  return expires;
}
// 사용자 ID는 오직 DB 세션에서 얻는다. URL/본문/임의 헤더의 ID는 인증에 사용하지 않는다.
export async function own(userId, table, id) {
  const paths = {
    plans: 'SELECT id FROM plans WHERE id=? AND user_id=?',
    tasks: 'SELECT t.id FROM tasks t JOIN plans p ON p.id=t.plan_id WHERE t.id=? AND p.user_id=?',
    runs: 'SELECT r.id FROM runs r JOIN tasks t ON t.id=r.task_id JOIN plans p ON p.id=t.plan_id WHERE r.id=? AND p.user_id=?',
    reviews: 'SELECT r.id FROM reviews r JOIN plans p ON p.id=r.plan_id WHERE r.id=? AND p.user_id=?',
  };
  if (!paths[table] || !(await one(paths[table], [id, userId]))) throw new HttpError(404, '기록을 찾을 수 없습니다.');
}
// JSON + custom header preflight + same-origin check; no cross-origin CORS is enabled.
export function protectMutation(req) {
  if (['GET', 'HEAD'].includes(req.method)) return;
  if (req.headers['x-pds-request'] !== '1') throw new HttpError(403, '허용되지 않은 요청입니다.');
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { throw new HttpError(403, '허용되지 않은 요청입니다.'); }
    if (host !== req.headers.host) throw new HttpError(403, '허용되지 않은 요청입니다.');
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '허용되지 않은 요청입니다.');
  if (req.method !== 'DELETE' && !String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'JSON 요청이 필요합니다.');
}
export async function limitAttempts(req, username) {
  // Vercel이 제공하는 IP 헤더. 로컬에서는 소켓 주소만 사용한다.
  const ip = process.env.VERCEL ? String(req.headers['x-vercel-forwarded-for'] || 'unknown').split(',')[0] : (req.socket?.remoteAddress || 'local');
  const bucket = Math.floor(Date.now() / 900000);
  for (const [key, max] of [[digest('ip:' + ip), 60], [digest('user:' + username), 15]]) {
    const r = await db().execute({sql:`INSERT INTO auth_limits(key,bucket,attempts) VALUES(?,?,1)
      ON CONFLICT(key,bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts`,args:[key,bucket]});
    if (Number(r.rows[0].attempts) > max) throw new HttpError(429, '시도가 많습니다. 15분 뒤 다시 시도해 주세요.');
  }
  await db().execute({sql:'DELETE FROM auth_limits WHERE bucket < ?',args:[bucket - 1]});
}
