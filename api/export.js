// 내 자료 전체를 JSON 파일 하나로 내려받는다.
import { handler, send, all, nowIso, todayKst, SCHEMA_VERSION, TIME_ZONE } from '../lib/db.js';

export default handler({
  async GET({ res, user }) {
    const data = {
      schema: SCHEMA_VERSION,
      account: {id:user.id, username:user.username, created_at:user.created_at},
      exported_at: nowIso(),
      rules: {
        date_fields: 'YYYY-MM-DD, 서울 시간(Asia/Seoul) 기준 날짜',
        instant_fields: 'ISO 8601 UTC(끝에 Z). 화면에서는 서울 시간으로 바꿔 보여 줌',
        minutes_fields: '분(minutes) 단위 정수',
        priority: '1=높음, 2=보통, 3=낮음',
        time_zone: TIME_ZONE,
      },
      observation_archives: await all('SELECT * FROM observation_archives WHERE user_id=? ORDER BY id', [user.id]),
      observations: await all('SELECT * FROM observations WHERE user_id=?', [user.id]),
      observation_days: await all('SELECT * FROM observation_days WHERE observation_id IN (SELECT id FROM observations WHERE user_id=?) ORDER BY date', [user.id]),
      plans: await all('SELECT * FROM plans WHERE user_id=? ORDER BY id', [user.id]),
      plan_versions: await all('SELECT * FROM plan_versions WHERE plan_id IN (SELECT id FROM plans WHERE user_id=?) ORDER BY plan_id, version', [user.id]),
      tasks: await all('SELECT * FROM tasks WHERE plan_id IN (SELECT id FROM plans WHERE user_id=?) ORDER BY id', [user.id]),
      task_tags: await all('SELECT * FROM task_tags WHERE task_id IN (SELECT id FROM tasks WHERE plan_id IN (SELECT id FROM plans WHERE user_id=?)) ORDER BY task_id, tag', [user.id]),
      task_completions: await all('SELECT * FROM task_completions WHERE task_id IN (SELECT id FROM tasks WHERE plan_id IN (SELECT id FROM plans WHERE user_id=?)) ORDER BY id', [user.id]),
      runs: await all('SELECT * FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE plan_id IN (SELECT id FROM plans WHERE user_id=?)) ORDER BY id', [user.id]),
      reviews: await all('SELECT * FROM reviews WHERE plan_id IN (SELECT id FROM plans WHERE user_id=?) ORDER BY id', [user.id]),
    };
    send(res, 200, data, {
      'Content-Disposition': `attachment; filename="pds-note-export-${todayKst().replaceAll('-', '')}.json"`,
    });
  },
});
