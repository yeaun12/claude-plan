// 실행 기록(Do): 실제로 언제 시작해 얼마나 걸렸고 어디서 막혔는지. 계획·할 일 값은 건드리지 않는다.
import { handler, send, db, one, all, v, nowIso, HttpError } from '../lib/db.js';

export default handler({
  async GET({ res, q, user }) {
    const where = ['t.deleted_at IS NULL', 't.plan_id IN (SELECT id FROM plans WHERE user_id = ? AND deleted_at IS NULL)'];
    const args = [user.id];
    if (q.task_id) { where.push('r.task_id = ?'); args.push(v.id(q.task_id, 'task_id')); }
    if (q.plan_id) { where.push('t.plan_id = ?'); args.push(v.id(q.plan_id, 'plan_id')); }
    if (q.id) {
      const ids = String(q.id).split(',').map((x) => v.id(x));
      where.push(`r.id IN (${ids.map(() => '?').join(',')})`);
      args.push(...ids);
    }
    const runs = await all(
      `SELECT r.*, t.title AS task_title, t.plan_id FROM runs r JOIN tasks t ON t.id = r.task_id
       WHERE ${where.join(' AND ')} ORDER BY r.started_at DESC, r.id DESC`, args);
    send(res, 200, { runs });
  },

  async POST({ res, body, user }) {
    const taskId = v.id(body.task_id, 'task_id');
    if (!(await one('SELECT id FROM tasks WHERE id = ? AND deleted_at IS NULL', [taskId]))) {
      throw new HttpError(404, '그 할 일을 찾을 수 없습니다.');
    }
    const started = v.instant(body.started_at, '시작 시각');
    const ended = v.instant(body.ended_at, '끝난 시각');
    if (ended < started) throw new HttpError(400, '끝난 시각이 시작 시각보다 앞설 수 없습니다.');
    const actual = body.actual_minutes === undefined || body.actual_minutes === ''
      ? Math.round((Date.parse(ended) - Date.parse(started)) / 60000)
      : v.minutes(body.actual_minutes, '실제로 걸린 시간');
    const blocker = v.text(body.blocker, '막혔던 이유', { max: 300, required: false });
    const note = v.text(body.note, '메모', { max: 300, required: false });
    const r = await db().execute({
      sql: `INSERT INTO runs (task_id, started_at, ended_at, actual_minutes, blocker, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [taskId, started, ended, actual, blocker, note, nowIso()],
    });
    send(res, 201, await one('SELECT * FROM runs WHERE id = ?', [Number(r.lastInsertRowid)]));
  },

  async DELETE({ res, q }) {
    const id = v.id(q.id);
    const r = await db().execute({ sql: 'DELETE FROM runs WHERE id = ?', args: [id] });
    if (!r.rowsAffected) throw new HttpError(404, '그 실행 기록을 찾을 수 없습니다.');
    send(res, 200, { deleted: id });
  },
}, { resource: 'runs' });
