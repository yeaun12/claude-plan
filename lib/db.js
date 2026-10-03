// 서버 전용 모듈: 데이터베이스 연결, 표 만들기, 요청·응답 도우미.
// 비밀값(TURSO_AUTH_TOKEN)은 환경 변수로만 읽고, 응답이나 로그에 절대 싣지 않는다.
import { createClient } from '@libsql/client';
import { authenticate, protectMutation, own } from './auth.js';

export const SCHEMA_VERSION = 'pds-schema-v3-auth';
export const TIME_ZONE = 'Asia/Seoul';

let client;
export function db() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    if (!url) throw new HttpError(500, '서버에 데이터베이스 주소(TURSO_DATABASE_URL)가 설정되지 않았습니다.');
    client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  }
  return client;
}

// 표·항목·관계. contracts/pds-schema-v2.json 과 같은 내용이어야 한다.
const DDL = [
  `CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    priority INTEGER NOT NULL CHECK (priority IN (1, 2, 3)),
    success_criteria TEXT NOT NULL,
    estimated_minutes INTEGER NOT NULL CHECK (estimated_minutes >= 0),
    carried_from_review_id INTEGER REFERENCES reviews(id),
    carried_lesson TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (end_date >= start_date)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS plans_carried_review_uq ON plans(carried_from_review_id) WHERE carried_from_review_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS plan_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES plans(id),
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    priority INTEGER NOT NULL,
    success_criteria TEXT NOT NULL,
    estimated_minutes INTEGER NOT NULL,
    change_note TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL,
    UNIQUE (plan_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES plans(id),
    title TEXT NOT NULL,
    due_date TEXT,
    priority INTEGER NOT NULL CHECK (priority IN (1, 2, 3)),
    estimated_minutes INTEGER NOT NULL DEFAULT 0 CHECK (estimated_minutes >= 0),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    cycle INTEGER NOT NULL DEFAULT 1,
    completed_at TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS tasks_plan_idx ON tasks(plan_id)`,
  `CREATE TABLE IF NOT EXISTS task_tags (
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    tag TEXT NOT NULL,
    PRIMARY KEY (task_id, tag)
  )`,
  `CREATE TABLE IF NOT EXISTS task_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    cycle INTEGER NOT NULL,
    request_key TEXT NOT NULL UNIQUE,
    completed_at TEXT NOT NULL,
    reopened_at TEXT,
    UNIQUE (task_id, cycle)
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    actual_minutes INTEGER NOT NULL CHECK (actual_minutes >= 0),
    blocker TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    CHECK (ended_at >= started_at)
  )`,
  `CREATE INDEX IF NOT EXISTS runs_task_idx ON runs(task_id)`,
  `CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES plans(id),
    period_from TEXT,
    period_to TEXT,
    stats_json TEXT NOT NULL,
    went_well TEXT NOT NULL DEFAULT '',
    lesson TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
];

let ready;
export function ensureSchema() {
  if (!ready) {
    ready = schemaReady().catch((err) => {
      ready = undefined;
      throw err;
    });
  }
  return ready;
}

// 이미 적용된 DB는 읽기 한 번으로 확인한다. 새 DB만 전체 마이그레이션한다.
async function schemaReady() {
  try {
    const result = await db().execute("SELECT name FROM migrations WHERE name='v5-observation-archives'");
    if (result.rows.length) return;
  } catch (err) {
    if (!String(err.message).includes('no such table: migrations')) throw err;
  }
  await migrate();
}

// 명시적인 트랜잭션 마이그레이션: 기존 ID/관계/내용을 변경하지 않고 소유자 열을 추가한다.
async function migrate() {
  const tx = await db().transaction('write');
  try {
    for (const sql of DDL) await tx.execute(sql);
    await tx.execute(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)`);
    const columns = await tx.execute('PRAGMA table_info(plans)');
    if (!columns.rows.some(x => x.name === 'user_id')) await tx.execute('ALTER TABLE plans ADD COLUMN user_id INTEGER REFERENCES users(id)');
    await tx.execute('CREATE INDEX IF NOT EXISTS plans_owner_idx ON plans(user_id)');
    await tx.execute(`CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, created_at TEXT NOT NULL)`);
    await tx.execute('CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)');
    await tx.execute(`CREATE TABLE IF NOT EXISTS auth_limits(key TEXT NOT NULL,bucket INTEGER NOT NULL,attempts INTEGER NOT NULL,PRIMARY KEY(key,bucket))`);
    await tx.execute(`CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id), config_json TEXT NOT NULL, created_at TEXT NOT NULL,
      change_json TEXT, changed_at TEXT)`);
    await tx.execute(`CREATE TABLE IF NOT EXISTS observation_days(id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id INTEGER NOT NULL REFERENCES observations(id), date TEXT NOT NULL, value INTEGER NOT NULL CHECK(value>=0),
      note TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(observation_id,date))`);
    await tx.execute(`CREATE TABLE IF NOT EXISTS migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL, detail TEXT NOT NULL)`);
    await tx.execute(`INSERT OR IGNORE INTO migrations VALUES('v3-auth',datetime('now'),'Legacy plans remain unowned until operator migration')`);
    const dayColumns = await tx.execute('PRAGMA table_info(observation_days)');
    if (!dayColumns.rows.some(x => x.name === 'corrections_json')) await tx.execute("ALTER TABLE observation_days ADD COLUMN corrections_json TEXT NOT NULL DEFAULT '[]'");
    await tx.execute("INSERT OR IGNORE INTO migrations VALUES('v4-observation-corrections',datetime('now'),'Preserve observation correction history')");
    await tx.execute(`CREATE TABLE IF NOT EXISTS observation_archives(id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id), archived_at TEXT NOT NULL, reason TEXT NOT NULL, snapshot_json TEXT NOT NULL)`);
    await tx.execute("INSERT OR IGNORE INTO migrations VALUES('v5-observation-archives',datetime('now'),'Separate preliminary observations from active study')");
    await tx.commit();
  } catch(err) { await tx.rollback().catch(()=>{}); throw err; } finally { tx.close(); }
}

// ---------- 시간·날짜 ----------
export const nowIso = () => new Date().toISOString();

export function todayKst(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(date);
}

// ---------- 오류·응답 ----------
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function send(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export async function readBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    if (typeof req.body === 'string') return parseJson(req.body);
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8'));
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000) throw new HttpError(413, '보낸 자료가 너무 큽니다.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? parseJson(text) : {};
}

function parseJson(text) {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'JSON 형식이 올바르지 않습니다.');
  }
}

export function query(req) {
  if (req.query) return req.query;
  const u = new URL(req.url, 'http://localhost');
  return Object.fromEntries(u.searchParams);
}

// 모든 API 핸들러를 감싸 표 만들기·오류 응답을 한곳에서 처리한다.
export function handler(routes, { publicRoute = false, resource = null } = {}) {
  return async (req, res) => {
    try {
      const fn = routes[req.method];
      if (!fn) throw new HttpError(405, '지원하지 않는 요청 방식입니다.');
      await ensureSchema();
      protectMutation(req);
      const user = publicRoute ? null : await authenticate(req);
      const q = query(req);
      const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      // 모든 직접 ID와 외래키를 쓰기 전에 검사한다. 소유자 변경 API는 제공하지 않는다.
      if (user && resource) {
        for (const input of [q, body]) {
          for (const [key, table] of Object.entries({id:resource,plan_id:'plans',task_id:'tasks',carried_from_review_id:'reviews'})) {
            if (input[key] !== undefined && input[key] !== null && input[key] !== '') {
              for (const id of String(input[key]).split(',')) await own(user.id, table, v.id(id));
            }
          }
        }
      }
      await fn({ req, res, q, body, user });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      const msg = String(err && err.message || '');
      if (/UNIQUE constraint failed: plans\.carried_from_review_id/.test(msg)) {
        return send(res, 409, { error: '이 고칠 점은 이미 다른 계획으로 넘어갔습니다.' });
      }
      if (/UNIQUE constraint failed: plan_versions/.test(msg)) {
        return send(res, 409, { error: '다른 곳에서 이 계획을 먼저 고쳤습니다. 새로고침한 뒤 다시 고쳐 주세요.' });
      }
      if (/CHECK constraint failed/.test(msg)) {
        return send(res, 400, { error: '저장 규칙에 맞지 않는 값이 있습니다. (끝이 시작보다 앞서거나 음수 등)' });
      }
      console.error('[api] unexpected error'); // 입력값·SQL·비밀값을 로그에 남기지 않는다.
      send(res, 500, { error: '서버에서 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    }
  };
}

// ---------- 입력 검사 ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const v = {
  id(value, name = 'id') {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} 값이 올바르지 않습니다.`);
    return n;
  },
  text(value, name, { max = 200, required = true } = {}) {
    if (value === undefined || value === null) value = '';
    if (typeof value !== 'string') throw new HttpError(400, `${name}은(는) 글자여야 합니다.`);
    const t = value.trim();
    if (required && !t) throw new HttpError(400, `${name}을(를) 적어 주세요.`);
    if (t.length > max) throw new HttpError(400, `${name}은(는) ${max}자 이하로 적어 주세요.`);
    return t;
  },
  date(value, name, { required = true } = {}) {
    if (value === undefined || value === null || value === '') {
      if (required) throw new HttpError(400, `${name}을(를) 정해 주세요.`);
      return null;
    }
    if (typeof value !== 'string' || !DATE_RE.test(value)) throw new HttpError(400, `${name}은(는) YYYY-MM-DD 형식이어야 합니다.`);
    const d = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new HttpError(400, `${name}이(가) 없는 날짜입니다.`);
    return value;
  },
  // 시각은 반드시 시간대(Z 또는 +09:00)를 붙여 받고, UTC ISO 문자열로 저장한다.
  instant(value, name) {
    if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
      throw new HttpError(400, `${name}에는 시간대가 붙은 시각이 필요합니다.`);
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, `${name}이(가) 올바른 시각이 아닙니다.`);
    return d.toISOString();
  },
  minutes(value, name) {
    const n = Number(value);
    if (value === '' || value === null || value === undefined || !Number.isInteger(n) || n < 0 || n > 100000) {
      throw new HttpError(400, `${name}은(는) 0 이상의 분 단위 정수여야 합니다.`);
    }
    return n;
  },
  priority(value) {
    const n = Number(value);
    if (![1, 2, 3].includes(n)) throw new HttpError(400, '우선순위는 1(높음)·2(보통)·3(낮음) 중 하나입니다.');
    return n;
  },
  tags(value) {
    if (value === undefined || value === null) return [];
    const list = Array.isArray(value) ? value : String(value).split(',');
    const out = [];
    for (const raw of list) {
      if (typeof raw !== 'string') throw new HttpError(400, '태그는 글자여야 합니다.');
      const t = raw.trim().replace(/^#/, '');
      if (!t) continue;
      if (t.length > 20) throw new HttpError(400, '태그는 20자 이하로 적어 주세요.');
      if (!out.includes(t)) out.push(t);
    }
    if (out.length > 10) throw new HttpError(400, '태그는 10개까지 붙일 수 있습니다.');
    return out;
  },
};

export async function one(sql, args = []) {
  const r = await db().execute({ sql, args });
  return r.rows[0] ? { ...r.rows[0] } : null;
}

export async function all(sql, args = []) {
  const r = await db().execute({ sql, args });
  return r.rows.map((row) => ({ ...row }));
}
