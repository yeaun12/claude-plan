// 내 자료 전체를 JSON 파일 하나로 내려받는다.
import { handler, send, all, nowIso, todayKst, SCHEMA_VERSION, TIME_ZONE } from '../lib/db.js';

export default handler({
  async GET({ res }) {
    const data = {
      schema: SCHEMA_VERSION,
      exported_at: nowIso(),
      rules: {
        date_fields: 'YYYY-MM-DD, 서울 시간(Asia/Seoul) 기준 날짜',
        instant_fields: 'ISO 8601 UTC(끝에 Z). 화면에서는 서울 시간으로 바꿔 보여 줌',
        minutes_fields: '분(minutes) 단위 정수',
        priority: '1=높음, 2=보통, 3=낮음',
        time_zone: TIME_ZONE,
      },
      plans: await all('SELECT * FROM plans ORDER BY id'),
      plan_versions: await all('SELECT * FROM plan_versions ORDER BY plan_id, version'),
      tasks: await all('SELECT * FROM tasks ORDER BY id'),
      task_tags: await all('SELECT * FROM task_tags ORDER BY task_id, tag'),
      task_completions: await all('SELECT * FROM task_completions ORDER BY id'),
      runs: await all('SELECT * FROM runs ORDER BY id'),
      reviews: await all('SELECT * FROM reviews ORDER BY id'),
    };
    send(res, 200, data, {
      'Content-Disposition': `attachment; filename="pds-note-export-${todayKst().replaceAll('-', '')}.json"`,
    });
  },
});
