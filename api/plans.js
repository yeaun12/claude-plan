// 계획(Plan): 만들기·목록·고치기. 고칠 때마다 plan_versions 에 새 판을 쌓아 처음 계획(1판)이 그대로 남는다.
import { handler, send, db, one, all, v, nowIso, HttpError } from '../lib/db.js';

function readPlanFields(body) {
  const f = {
    title: v.text(body.title, '계획 이름', { max: 80 }),
    start_date: v.date(body.start_date, '시작일'),
    end_date: v.date(body.end_date, '끝나는 날'),
    priority: v.priority(body.priority),
    success_criteria: v.text(body.success_criteria, '성공 기준', { max: 300 }),
    estimated_minutes: v.minutes(body.estimated_minutes, '예상 시간'),
  };
  if (f.end_date < f.start_date) throw new HttpError(400, '끝나는 날이 시작일보다 앞설 수 없습니다.');
  return f;
}

async function getPlan(id) {
  const plan = await one('SELECT * FROM plans WHERE id = ?', [id]);
  if (!plan) throw new HttpError(404, '그 계획을 찾을 수 없습니다.');
  plan.versions = await all('SELECT * FROM plan_versions WHERE plan_id = ? ORDER BY version', [id]);
  return plan;
}

export default handler({
  async GET({ res, q }) {
    if (q.id) return send(res, 200, await getPlan(v.id(q.id)));
    const plans = await all(
      `SELECT p.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.plan_id = p.id AND t.deleted_at IS NULL) AS task_count
       FROM plans p ORDER BY p.start_date DESC, p.id DESC`
    );
    send(res, 200, { plans });
  },

  async POST({ res, body }) {
    const f = readPlanFields(body);
    let carriedLesson = null;
    let carriedFrom = null;
    if (body.carried_from_review_id) {
      carriedFrom = v.id(body.carried_from_review_id, '돌아보기 ID');
      const review = await one('SELECT id, lesson FROM reviews WHERE id = ?', [carriedFrom]);
      if (!review) throw new HttpError(404, '넘겨받을 돌아보기를 찾을 수 없습니다.');
      carriedLesson = review.lesson;
    }
    const now = nowIso();
    const tx = await db().transaction('write');
    try {
      const r = await tx.execute({
        sql: `INSERT INTO plans (title, start_date, end_date, priority, success_criteria, estimated_minutes,
                carried_from_review_id, carried_lesson, version, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        args: [f.title, f.start_date, f.end_date, f.priority, f.success_criteria, f.estimated_minutes,
          carriedFrom, carriedLesson, now, now],
      });
      const id = Number(r.lastInsertRowid);
      await tx.execute({
        sql: `INSERT INTO plan_versions (plan_id, version, title, start_date, end_date, priority, success_criteria,
                estimated_minutes, change_note, recorded_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, '처음 세운 계획', ?)`,
        args: [id, f.title, f.start_date, f.end_date, f.priority, f.success_criteria, f.estimated_minutes, now],
      });
      await tx.commit();
      send(res, 201, await getPlan(id));
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    } finally {
      tx.close();
    }
  },

  // 고치기: 계획 ID는 그대로, 내용만 바뀐다. 바뀌기 전 판은 plan_versions 에 남아 있다.
  async PATCH({ res, q, body }) {
    const id = v.id(q.id);
    const current = await one('SELECT * FROM plans WHERE id = ?', [id]);
    if (!current) throw new HttpError(404, '그 계획을 찾을 수 없습니다.');
    const f = readPlanFields({ ...current, ...body });
    const changed = Object.keys(f).filter((k) => f[k] !== current[k]);
    if (!changed.length) throw new HttpError(400, '바뀐 내용이 없습니다.');
    const note = v.text(body.change_note, '고친 이유', { max: 200, required: false });
    const next = Number(current.version) + 1;
    const now = nowIso();
    await db().batch([
      {
        sql: `UPDATE plans SET title = ?, start_date = ?, end_date = ?, priority = ?, success_criteria = ?,
                estimated_minutes = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        args: [f.title, f.start_date, f.end_date, f.priority, f.success_criteria, f.estimated_minutes, next, now, id, current.version],
      },
      {
        sql: `INSERT INTO plan_versions (plan_id, version, title, start_date, end_date, priority, success_criteria,
                estimated_minutes, change_note, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, next, f.title, f.start_date, f.end_date, f.priority, f.success_criteria, f.estimated_minutes, note, now],
      },
    ], 'write');
    send(res, 200, await getPlan(id));
  },
});
