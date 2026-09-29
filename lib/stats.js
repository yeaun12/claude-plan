// 돌아보기 집계. 숫자마다 그 숫자가 나온 기록 ID 목록을 함께 돌려줘 화면에서 근거로 따라갈 수 있게 한다.
import { all, one, todayKst, HttpError } from './db.js';

export async function computeStats(planId, { from = null, to = null } = {}) {
  const plan = await one('SELECT id, title FROM plans WHERE id = ?', [planId]);
  if (!plan) throw new HttpError(404, '그 계획을 찾을 수 없습니다.');
  const where = ['t.plan_id = ?', 't.deleted_at IS NULL'];
  const args = [planId];
  if (from) { where.push('t.due_date >= ?'); args.push(from); }
  if (to) { where.push('t.due_date <= ?'); args.push(to); }
  const tasks = await all(
    `SELECT t.id, t.status, t.due_date, t.estimated_minutes,
       EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND TRIM(r.blocker) <> '') AS blocked
     FROM tasks t WHERE ${where.join(' AND ')} ORDER BY t.id`, args);
  const ids = tasks.map((t) => t.id);
  const runs = ids.length
    ? await all(`SELECT id, actual_minutes FROM runs WHERE task_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ids)
    : [];
  const today = todayKst();
  const pick = (fn) => tasks.filter(fn).map((t) => t.id);
  const estimated = tasks.reduce((s, t) => s + Number(t.estimated_minutes), 0);
  const actual = runs.reduce((s, r) => s + Number(r.actual_minutes), 0);
  return {
    plan_id: plan.id,
    plan_title: plan.title,
    period: { from, to },
    today_kst: today,
    unit: 'minutes',
    planned: { count: ids.length, task_ids: ids },
    done: { count: pick((t) => t.status === 'done').length, task_ids: pick((t) => t.status === 'done') },
    delayed: {
      count: pick((t) => t.status !== 'done' && t.due_date && t.due_date < today).length,
      task_ids: pick((t) => t.status !== 'done' && t.due_date && t.due_date < today),
    },
    blocked: { count: pick((t) => Number(t.blocked) === 1).length, task_ids: pick((t) => Number(t.blocked) === 1) },
    estimated_minutes: { value: estimated, task_ids: ids },
    actual_minutes: { value: actual, run_ids: runs.map((r) => r.id) },
    diff_minutes: { value: actual - estimated, task_ids: ids, run_ids: runs.map((r) => r.id) },
  };
}
