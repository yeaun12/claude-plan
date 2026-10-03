// 할 일: 만들기·고치기·완료·되돌리기·지우기·검색·거르기·정렬.
// 검색·거르기·정렬은 서버(SQL)에서 한 번에 한다. 값이 같을 때는 항상 ID 작은 순으로 순서를 고정한다.
import { handler, send, db, one, all, v, nowIso, todayKst, HttpError } from '../lib/db.js';

export const SORTS = {
  due: {
    label: '마감일 빠른 순 → 같으면 우선순위 높은 순 → 같으면 ID 작은 순 (마감일 없는 할 일은 맨 뒤)',
    sql: 't.due_date IS NULL, t.due_date ASC, t.priority ASC, t.id ASC',
  },
  priority: {
    label: '우선순위 높은 순(1→3) → 같으면 마감일 빠른 순 → 같으면 ID 작은 순',
    sql: 't.priority ASC, t.due_date IS NULL, t.due_date ASC, t.id ASC',
  },
  estimate: {
    label: '예상 시간 긴 순 → 같으면 ID 작은 순',
    sql: 't.estimated_minutes DESC, t.id ASC',
  },
  created: {
    label: '만든 순서(ID 작은 순)',
    sql: 't.id ASC',
  },
};

async function loadTask(id) {
  const t = await one('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!t) throw new HttpError(404, '그 할 일을 찾을 수 없습니다. (이미 지웠을 수 있습니다)');
  return t;
}

async function decorate(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const tags = await all(`SELECT task_id, tag FROM task_tags WHERE task_id IN (${marks}) ORDER BY tag`, ids);
  const runs = await all(
    `SELECT task_id, COUNT(*) AS run_count, COALESCE(SUM(actual_minutes), 0) AS actual_minutes,
            SUM(CASE WHEN TRIM(blocker) <> '' THEN 1 ELSE 0 END) AS blocker_count
     FROM runs WHERE task_id IN (${marks}) GROUP BY task_id`, ids);
  const today = todayKst();
  return rows.map((r) => {
    const agg = runs.find((x) => x.task_id === r.id) || {};
    return {
      ...r,
      tags: tags.filter((x) => x.task_id === r.id).map((x) => x.tag),
      run_count: Number(agg.run_count || 0),
      actual_minutes: Number(agg.actual_minutes || 0),
      blocked: Number(agg.blocker_count || 0) > 0,
      overdue: r.status !== 'done' && r.due_date !== null && r.due_date < today,
    };
  });
}

function readTaskFields(body, { partial = false } = {}) {
  const f = {};
  const has = (k) => !partial || Object.prototype.hasOwnProperty.call(body, k);
  if (has('title')) f.title = v.text(body.title, '할 일', { max: 120 });
  if (has('due_date')) f.due_date = v.date(body.due_date, '마감일', { required: false });
  if (has('priority')) f.priority = v.priority(body.priority);
  if (has('estimated_minutes')) f.estimated_minutes = v.minutes(body.estimated_minutes, '예상 시간');
  if (has('tags')) f.tags = v.tags(body.tags);
  return f;
}

export default handler({
  async GET({ res, q, user }) {
    const where = ['t.deleted_at IS NULL', 't.plan_id IN (SELECT id FROM plans WHERE user_id = ? AND deleted_at IS NULL)'];
    const args = [user.id];
    if (q.plan_id) { where.push('t.plan_id = ?'); args.push(v.id(q.plan_id, 'plan_id')); }
    if (q.id) {
      const ids = String(q.id).split(',').map((x) => v.id(x));
      where.push(`t.id IN (${ids.map(() => '?').join(',')})`);
      args.push(...ids);
    }
    if (q.q) {
      const term = `%${String(q.q).trim().slice(0, 50).replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      where.push(`(t.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM task_tags g WHERE g.task_id = t.id AND g.tag LIKE ? ESCAPE '\\'))`);
      args.push(term, term);
    }
    if (q.status === 'open' || q.status === 'done') { where.push('t.status = ?'); args.push(q.status); }
    if (q.status === 'overdue') { where.push("t.status = 'open' AND t.due_date IS NOT NULL AND t.due_date < ?"); args.push(todayKst()); }
    if (q.priority) { where.push('t.priority = ?'); args.push(v.priority(q.priority)); }
    if (q.tag) { where.push('EXISTS (SELECT 1 FROM task_tags g WHERE g.task_id = t.id AND g.tag = ?)'); args.push(String(q.tag)); }
    const sortKey = SORTS[q.sort] ? q.sort : 'due';
    const rows = await all(`SELECT t.* FROM tasks t WHERE ${where.join(' AND ')} ORDER BY ${SORTS[sortKey].sql}`, args);
    send(res, 200, {
      tasks: await decorate(rows),
      sort: { key: sortKey, label: SORTS[sortKey].label },
      sorts: Object.fromEntries(Object.entries(SORTS).map(([k, s]) => [k, s.label])),
      today: todayKst(),
    });
  },

  async POST({ res, q, body, user }) {
    // 완료 / 되돌리기
    if (q.action === 'complete') return complete(res, v.id(q.id), { ...body, request_key: `${user.id}:` + v.text(body.request_key, 'request_key', { max: 60 }) });
    if (q.action === 'reopen') return reopen(res, v.id(q.id));

    const planId = v.id(body.plan_id, 'plan_id');
    if (!(await one('SELECT id FROM plans WHERE id = ?', [planId]))) throw new HttpError(404, '그 계획을 찾을 수 없습니다.');
    const f = readTaskFields(body);
    const now = nowIso();
    const tx = await db().transaction('write');
    try {
      const r = await tx.execute({
        sql: `INSERT INTO tasks (plan_id, title, due_date, priority, estimated_minutes, status, cycle, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'open', 1, ?, ?)`,
        args: [planId, f.title, f.due_date, f.priority, f.estimated_minutes, now, now],
      });
      const id = Number(r.lastInsertRowid);
      for (const tag of f.tags) await tx.execute({ sql: 'INSERT INTO task_tags (task_id, tag) VALUES (?, ?)', args: [id, tag] });
      await tx.commit();
      send(res, 201, (await decorate([await loadTask(id)]))[0]);
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    } finally {
      tx.close();
    }
  },

  async PATCH({ res, q, body }) {
    const id = v.id(q.id);
    await loadTask(id);
    const f = readTaskFields(body, { partial: true });
    const cols = ['title', 'due_date', 'priority', 'estimated_minutes'].filter((k) => k in f);
    const stmts = [];
    if (cols.length) {
      stmts.push({
        sql: `UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        args: [...cols.map((c) => f[c]), nowIso(), id],
      });
    }
    if (f.tags) {
      stmts.push({ sql: 'DELETE FROM task_tags WHERE task_id = ?', args: [id] });
      for (const tag of f.tags) stmts.push({ sql: 'INSERT INTO task_tags (task_id, tag) VALUES (?, ?)', args: [id, tag] });
    }
    if (!stmts.length) throw new HttpError(400, '바꿀 내용이 없습니다.');
    await db().batch(stmts, 'write');
    send(res, 200, (await decorate([await loadTask(id)]))[0]);
  },

  // 지우기: 기록을 없애지 않고 deleted_at 을 남겨 목록·집계에서 뺀다.
  async DELETE({ res, q }) {
    const id = v.id(q.id);
    await loadTask(id);
    await db().execute({ sql: 'UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', args: [nowIso(), nowIso(), id] });
    send(res, 200, { deleted: id });
  },
}, { resource: 'tasks' });

// 완료는 (할 일, 회차)마다 한 건만 쌓인다. 두 번 눌러도, 요청 두 개가 동시에 와도
// task_completions 의 UNIQUE(task_id, cycle)·UNIQUE(request_key) 제약이 두 번째를 막는다.
async function complete(res, id, body) {
  const key = v.text(body.request_key, 'request_key', { max: 80 });
  await loadTask(id);
  const now = nowIso();
  const [ins] = await db().batch([
    {
      sql: `INSERT OR IGNORE INTO task_completions (task_id, cycle, request_key, completed_at)
            SELECT id, cycle, ?, ? FROM tasks WHERE id = ? AND status = 'open' AND deleted_at IS NULL`,
      args: [key, now, id],
    },
    {
      sql: `UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ?
            WHERE id = ? AND status = 'open' AND EXISTS (
              SELECT 1 FROM task_completions c WHERE c.task_id = tasks.id AND c.cycle = tasks.cycle)`,
      args: [now, now, id],
    },
  ], 'write');
  const task = (await decorate([await loadTask(id)]))[0];
  send(res, 200, { task, created: ins.rowsAffected === 1 });
}

async function reopen(res, id) {
  await loadTask(id);
  const now = nowIso();
  await db().batch([
    {
      sql: `UPDATE task_completions SET reopened_at = ?
            WHERE task_id = ? AND cycle = (SELECT cycle FROM tasks WHERE id = ? AND status = 'done') AND reopened_at IS NULL`,
      args: [now, id, id],
    },
    {
      sql: `UPDATE tasks SET status = 'open', cycle = cycle + 1, completed_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'done'`,
      args: [now, id],
    },
  ], 'write');
  send(res, 200, { task: (await decorate([await loadTask(id)]))[0] });
}
