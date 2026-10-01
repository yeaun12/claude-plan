// 돌아보기 집계 조회. 기간을 주면 마감일이 그 기간에 드는 할 일만 센다.
import { handler, send, v, HttpError } from '../lib/db.js';
import { computeStats } from '../lib/stats.js';

export default handler({
  async GET({ res, q, user }) {
    const from = v.date(q.from, '기간 시작', { required: false });
    const to = v.date(q.to, '기간 끝', { required: false });
    if (from && to && to < from) throw new HttpError(400, '기간 끝이 기간 시작보다 앞설 수 없습니다.');
    send(res, 200, await computeStats(v.id(q.plan_id, 'plan_id'), { from, to }));
  },
}, { resource: 'plans' });
