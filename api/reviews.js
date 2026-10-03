// 돌아보기(See) 기록: 그때의 집계를 그대로 담고, 다음 계획으로 넘길 고칠 점 한 줄을 남긴다.
import { handler, send, db, one, all, v, nowIso, HttpError } from '../lib/db.js';
import { computeStats } from '../lib/stats.js';

export default handler({
  async GET({ res, q, user }) {
    const args = [user.id];
    let where = 'WHERE p.user_id = ? AND p.deleted_at IS NULL';
    if (q.plan_id) { where += ' AND r.plan_id = ?'; args.push(v.id(q.plan_id, 'plan_id')); }
    const reviews = await all(
      `SELECT r.*, p.title AS plan_title, n.id AS next_plan_id, n.title AS next_plan_title
       FROM reviews r JOIN plans p ON p.id = r.plan_id
       LEFT JOIN plans n ON n.carried_from_review_id = r.id
       ${where} ORDER BY r.id DESC`, args);
    send(res, 200, { reviews: reviews.map((r) => ({ ...r, stats: JSON.parse(r.stats_json) })) });
  },

  async POST({ res, body, user }) {
    const planId = v.id(body.plan_id, 'plan_id');
    const from = v.date(body.period_from, '기간 시작', { required: false });
    const to = v.date(body.period_to, '기간 끝', { required: false });
    if (from && to && to < from) throw new HttpError(400, '기간 끝이 기간 시작보다 앞설 수 없습니다.');
    const wentWell = v.text(body.went_well, '잘된 점', { max: 300, required: false });
    const lesson = v.text(body.lesson, '다음 계획으로 넘길 고칠 점', { max: 120 });
    const stats = await computeStats(planId, { from, to });
    const r = await db().execute({
      sql: `INSERT INTO reviews (plan_id, period_from, period_to, stats_json, went_well, lesson, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [planId, from, to, JSON.stringify(stats), wentWell, lesson, nowIso()],
    });
    const saved = await one('SELECT * FROM reviews WHERE id = ?', [Number(r.lastInsertRowid)]);
    send(res, 201, { ...saved, stats });
  },
}, { resource: 'reviews' });
