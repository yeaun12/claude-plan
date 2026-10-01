// T06 통과 기준 자동 검사. 검사용 자료를 새로 만들므로 반드시 "빈 검사용 DB"로 띄운 로컬 서버에 대고 실행한다.
//   TURSO_DATABASE_URL=file:check.db node scripts/dev-server.mjs   (다른 터미널)
//   node scripts/check.mjs [http://localhost:3000]
// 배포된 실제 다이어리 주소에 대고 돌리면 내 기록 사이에 검사용 자료가 섞이므로 localhost 외에는 거부한다.
const BASE = process.argv[2] || 'http://localhost:3000';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error('검사는 로컬 검사용 서버(localhost)에서만 실행합니다.');
  process.exit(2);
}

const password = (await import('node:crypto')).randomBytes(24).toString('base64url');
let cookie = '';
const results = [];
function check(id, desc, ok, detail = '') {
  results.push({ id, desc, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${desc}${detail ? `  — ${detail}` : ''}`);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-PDS-Request':'1', Cookie:cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

const kstToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const username='regression_'+Date.now();
await api('/api/auth?action=signup',{method:'POST',body:{username,password}});
const login=await api('/api/auth?action=login',{method:'POST',body:{username,password}});
if(login.status!==200) throw new Error('검사용 로그인 실패');
cookie=login.headers.get('set-cookie').split(';')[0];
const before = await api('/api/plans');
if (before.data.plans.length) {
  console.error('빈 검사용 DB가 아닙니다. 새 DB 파일로 서버를 띄운 뒤 다시 실행해 주세요.');
  process.exit(2);
}

// ---------- 카드 1: 계획 ----------
const planBody = {
  title: 'ALEPH T06 플랜두씨 다이어리 완성', start_date: kstToday, end_date: addDays(kstToday, 6),
  priority: 1, success_criteria: '통과 기준을 모두 확인하고 제출한다', estimated_minutes: 540,
};
const created = await api('/api/plans', { method: 'POST', body: planBody });
const plan = created.data;
check('T06-C04', '계획에 기간이 저장된다', plan.start_date === planBody.start_date && plan.end_date === planBody.end_date);
check('T06-C05', '계획에 우선순위가 저장된다', plan.priority === 1);
check('T06-C06', '계획에 성공 기준이 저장된다', plan.success_criteria === planBody.success_criteria);
check('T06-C07', '계획에 예상 시간이 저장된다', plan.estimated_minutes === 540);
const edited = await api(`/api/plans?id=${plan.id}`, { method: 'PATCH', body: { estimated_minutes: 600, end_date: addDays(kstToday, 7), change_note: '범위가 커서 늘림' } });
const v1 = edited.data.versions.find((x) => x.version === 1);
check('T06-C08', '계획을 고쳐도 고치기 전 계획이 그대로 남아 있다',
  edited.data.id === plan.id && edited.data.estimated_minutes === 600 && v1.estimated_minutes === 540 && v1.end_date === planBody.end_date && edited.data.versions.length === 2,
  `ID ${plan.id} 유지, 1판 예상 ${v1.estimated_minutes}분 / 2판 ${edited.data.estimated_minutes}분`);

// ---------- 카드 2: 할 일 ----------
const taskDefs = [
  { title: '카드1 계획 기능', due_date: addDays(kstToday, -2), priority: 1, tags: ['plan'], estimated_minutes: 90 },
  { title: '카드2 할 일 기능', due_date: addDays(kstToday, -1), priority: 2, tags: ['do', 'ui'], estimated_minutes: 120 },
  { title: '카드3 실행 기록', due_date: addDays(kstToday, 1), priority: 1, tags: ['do'], estimated_minutes: 60 },
  { title: '카드4 돌아보기', due_date: addDays(kstToday, 1), priority: 1, tags: ['see'], estimated_minutes: 100 },
  { title: '카드5 배포·점검', due_date: null, priority: 3, tags: ['ops'], estimated_minutes: 45 },
  { title: '지울 할 일', due_date: kstToday, priority: 2, tags: [], estimated_minutes: 10 },
];
const tasks = [];
for (const t of taskDefs) tasks.push((await api('/api/tasks', { method: 'POST', body: { plan_id: plan.id, ...t } })).data);
check('T06-C09', '할 일을 만들 수 있다', tasks.length === 6 && tasks.every((t) => t.id));
const patched = await api(`/api/tasks?id=${tasks[4].id}`, { method: 'PATCH', body: { title: '카드5 배포·보안 점검', tags: ['ops', 'security'] } });
check('T06-C10', '할 일의 내용을 고칠 수 있다', patched.data.title === '카드5 배포·보안 점검' && patched.data.tags.includes('security'));
const c1 = await api(`/api/tasks?id=${tasks[0].id}&action=complete`, { method: 'POST', body: { request_key: 'k-a' } });
check('T06-C11', '할 일을 완료로 바꿀 수 있다', c1.data.task.status === 'done' && c1.data.created === true);
const re = await api(`/api/tasks?id=${tasks[0].id}&action=reopen`, { method: 'POST' });
check('T06-C12', '완료한 할 일을 다시 진행 중으로 되돌릴 수 있다', re.data.task.status === 'open' && re.data.task.completed_at === null);
const del = await api(`/api/tasks?id=${tasks[5].id}`, { method: 'DELETE' });
const afterDel = await api(`/api/tasks?plan_id=${plan.id}`);
check('T06-C13', '할 일을 지울 수 있다', del.status === 200 && !afterDel.data.tasks.some((t) => t.id === tasks[5].id));
check('T06-C14', '할 일에 마감일을 저장할 수 있다', tasks[1].due_date === taskDefs[1].due_date);
check('T06-C15', '할 일에 우선순위를 저장할 수 있다', tasks[4].priority === 3);
check('T06-C16', '할 일에 태그를 저장할 수 있다', JSON.stringify(tasks[1].tags) === JSON.stringify(['do', 'ui']));
check('T06-C17', '할 일에 예상 시간을 저장할 수 있다', tasks[3].estimated_minutes === 100);
const s1 = await api(`/api/tasks?plan_id=${plan.id}&q=${encodeURIComponent('돌아보기')}`);
const s2 = await api(`/api/tasks?plan_id=${plan.id}&q=security`);
check('T06-C18', '할 일을 검색할 수 있다', s1.data.tasks.length === 1 && s1.data.tasks[0].id === tasks[3].id && s2.data.tasks.length === 1, '이름 검색 1건, 태그 검색 1건');
const fp = await api(`/api/tasks?plan_id=${plan.id}&priority=1`);
const ft = await api(`/api/tasks?plan_id=${plan.id}&tag=do`);
check('T06-C19', '할 일을 조건으로 걸러 볼 수 있다',
  fp.data.tasks.length === 3 && fp.data.tasks.every((t) => t.priority === 1) && ft.data.tasks.length === 2);
const sorted = await api(`/api/tasks?plan_id=${plan.id}&sort=due`);
const order = sorted.data.tasks.map((t) => t.id);
const again = (await api(`/api/tasks?plan_id=${plan.id}&sort=due`)).data.tasks.map((t) => t.id);
const expect = [tasks[0].id, tasks[1].id, tasks[2].id, tasks[3].id, tasks[4].id]; // 마감 같은 C3·C4는 우선순위 같음 → ID 순, 마감 없음은 맨 뒤
check('T06-C20', '화면에 밝혀 둔 기준대로 할 일이 정렬된다',
  JSON.stringify(order) === JSON.stringify(expect) && JSON.stringify(order) === JSON.stringify(again) && Boolean(sorted.data.sort.label),
  sorted.data.sort.label);

// ---------- 카드 3: 실행 기록 ----------
const planBeforeRuns = (await api(`/api/plans?id=${plan.id}`)).data;
const taskBeforeRuns = (await api(`/api/tasks?id=${tasks[1].id}`)).data.tasks[0];
const runDefs = [
  { task_id: tasks[0].id, started_at: `${addDays(kstToday, -2)}T19:00:00+09:00`, ended_at: `${addDays(kstToday, -2)}T21:10:00+09:00`, blocker: '' },
  { task_id: tasks[1].id, started_at: `${addDays(kstToday, -1)}T09:00:00+09:00`, ended_at: `${addDays(kstToday, -1)}T11:30:00+09:00`, blocker: '정렬이 볼 때마다 달라짐' },
  { task_id: tasks[2].id, started_at: `${kstToday}T08:50:00+09:00`, ended_at: `${kstToday}T09:40:00+09:00`, blocker: '', actual_minutes: 45 },
];
const runs = [];
for (const r of runDefs) runs.push((await api('/api/runs', { method: 'POST', body: r })).data);
check('T06-C23', '실행 기록에 시작 시각이 저장된다', runs[0].started_at === new Date(runDefs[0].started_at).toISOString(), runs[0].started_at);
check('T06-C24', '실행 기록에 끝난 시각이 저장된다', runs[0].ended_at === new Date(runDefs[0].ended_at).toISOString(), runs[0].ended_at);
check('T06-C25', '실행 기록에 실제로 걸린 시간이 저장된다', runs[0].actual_minutes === 130 && runs[2].actual_minutes === 45, '130분(자동), 45분(직접)');
check('T06-C26', '실행 기록에 막혔던 이유가 저장된다', runs[1].blocker === '정렬이 볼 때마다 달라짐');
const planAfterRuns = (await api(`/api/plans?id=${plan.id}`)).data;
const taskAfterRuns = (await api(`/api/tasks?id=${tasks[1].id}`)).data.tasks[0];
const same = (a, b, keys) => keys.every((k) => a[k] === b[k]);
check('T06-C27', '실행 기록을 저장해도 원래 계획 값은 덮어쓰이지 않는다',
  same(planBeforeRuns, planAfterRuns, ['title', 'start_date', 'end_date', 'priority', 'success_criteria', 'estimated_minutes', 'version', 'updated_at'])
  && same(taskBeforeRuns, taskAfterRuns, ['title', 'due_date', 'priority', 'estimated_minutes', 'status', 'updated_at']));

const statsBefore = (await api(`/api/stats?plan_id=${plan.id}`)).data;
const key = 'double-click-key';
// 같은 키로 연달아 두 번 + 다른 키로 동시에 한 번 더 (버튼 잠금 없이 서버·DB가 막는지)
const [d1, d2, d3] = await Promise.all([
  api(`/api/tasks?id=${tasks[2].id}&action=complete`, { method: 'POST', body: { request_key: key } }),
  api(`/api/tasks?id=${tasks[2].id}&action=complete`, { method: 'POST', body: { request_key: key } }),
  api(`/api/tasks?id=${tasks[2].id}&action=complete`, { method: 'POST', body: { request_key: 'another-tab-key' } }),
]);
const exported1 = (await api('/api/export')).data;
const completionRows = exported1.task_completions.filter((c) => c.task_id === tasks[2].id);
check('T06-C21', '완료 버튼을 연달아 두 번 눌러도 완료 기록은 한 건만 남는다',
  completionRows.length === 1 && [d1, d2, d3].filter((d) => d.data.created).length === 1,
  `동시 요청 3건 → 완료 기록 ${completionRows.length}건`);
const statsAfter = (await api(`/api/stats?plan_id=${plan.id}`)).data;
check('T06-C22', '그때 돌아보기의 완료 수도 정확히 1만 늘어난다', statsAfter.done.count - statsBefore.done.count === 1,
  `${statsBefore.done.count} → ${statsAfter.done.count}`);

// ---------- 카드 4: 돌아보기 ----------
// 독립 계산: export 자료로 직접 센다
const ex = (await api('/api/export')).data;
const live = ex.tasks.filter((t) => t.plan_id === plan.id && !t.deleted_at);
const liveIds = new Set(live.map((t) => t.id));
const st = statsAfter;
check('T06-C28', '계획 수 = 그 계획에 딸린, 지우지 않은 할 일 수', st.planned.count === live.length, `${st.planned.count} = ${live.length}`);
check('T06-C29', '완료 수 = 그중 지금 완료 상태인 할 일 수', st.done.count === live.filter((t) => t.status === 'done').length);
const delayed = live.filter((t) => t.status !== 'done' && t.due_date && t.due_date < kstToday);
check('T06-C30', '지연 수 = 미완료 & 마감일 < 서울 오늘, 완료는 세지 않음',
  st.delayed.count === delayed.length && !st.delayed.task_ids.some((id) => st.done.task_ids.includes(id)), `${st.delayed.count}건 (서울 오늘 ${kstToday})`);
const blockedIds = new Set(ex.runs.filter((r) => liveIds.has(r.task_id) && r.blocker.trim()).map((r) => r.task_id));
check('T06-C31', '막힘 수 = 막힌 이유가 하나라도 적힌 할 일 수', st.blocked.count === blockedIds.size);
const est = live.reduce((s, t) => s + t.estimated_minutes, 0);
const act = ex.runs.filter((r) => liveIds.has(r.task_id)).reduce((s, r) => s + r.actual_minutes, 0);
check('T06-C32', '예상=예상 합, 실제=실행 기록 합, 차이=실제−예상',
  st.estimated_minutes.value === est && st.actual_minutes.value === act && st.diff_minutes.value === act - est,
  `예상 ${est} · 실제 ${act} · 차이 ${act - est}`);
const empty = (await api('/api/plans', { method: 'POST', body: { ...planBody, title: '빈 계획' } })).data;
const emptyStats = (await api(`/api/stats?plan_id=${empty.id}`)).data;
check('T06-C32b', '아무것도 없으면 0', emptyStats.estimated_minutes.value === 0 && emptyStats.actual_minutes.value === 0 && emptyStats.diff_minutes.value === 0);
check('T06-C83', '집계 숫자마다 근거 기록 ID가 함께 온다(화면에서 눌러 이동)',
  st.done.task_ids.length === st.done.count && st.delayed.task_ids.length === st.delayed.count && st.actual_minutes.run_ids.length === ex.runs.filter((r) => liveIds.has(r.task_id)).length);
const review = (await api('/api/reviews', { method: 'POST', body: { plan_id: plan.id, went_well: '카드별로 나눠서 진행', lesson: '예상 시간을 1.5배로 잡는다' } })).data;
const next = (await api('/api/plans', { method: 'POST', body: { ...planBody, title: 'T07 로그인 붙이기', carried_from_review_id: review.id } })).data;
const dup = await api('/api/plans', { method: 'POST', body: { ...planBody, title: '중복', carried_from_review_id: review.id } });
check('T06-C33', '돌아보기의 고칠 점 한 건이 다음 계획으로 넘어간다',
  next.carried_lesson === '예상 시간을 1.5배로 잡는다' && next.carried_from_review_id === review.id && dup.status === 409);

// ---------- 카드 5 ----------
const reload = (await api(`/api/tasks?id=${tasks[1].id}`)).data.tasks[0];
const reloadRun = (await api(`/api/runs?id=${runs[0].id}`)).data.runs[0];
check('T06-C35', '새로고침(다시 불러오기) 뒤 ID·날짜·값·단위가 같다',
  reload.id === tasks[1].id && reload.due_date === tasks[1].due_date && reload.estimated_minutes === 120
  && reloadRun.started_at === runs[0].started_at && reloadRun.actual_minutes === 130);
const exp = await api('/api/export');
check('T06-C36', '내 자료 전체를 파일 하나로 내보낼 수 있다',
  /attachment; filename="pds-note-export-\d{8}\.json"/.test(exp.headers.get('content-disposition') || '')
  && ['plans', 'plan_versions', 'tasks', 'task_tags', 'task_completions', 'runs', 'reviews'].every((k) => Array.isArray(exp.data[k])));
const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
const xt = (await api('/api/tasks', { method: 'POST', body: { plan_id: plan.id, title: xss, priority: 2, estimated_minutes: 1 } })).data;
check('T06-C57(API)', '스크립트 모양 글자가 바뀌지 않고 글자 그대로 저장·반환된다', xt.title === xss);
const html = await (await fetch(BASE + '/')).text();
check('T07-C97', 'T06 공개 안내를 계정 보호 안내로 교체', html.includes('내 기록 보호 안내') && html.includes('id="privateApp" hidden'));
const appJs = await (await fetch(BASE + '/app.js')).text();
check('T06-C58(화면)', '브라우저 코드에 innerHTML·비밀값 이름이 없다', !/innerHTML|TURSO|authToken/i.test(appJs));

const bad = await api('/api/runs', { method: 'POST', body: { task_id: tasks[0].id, started_at: '2026-09-29T10:00', ended_at: '2026-09-29T11:00' } });
check('EXTRA', '시간대 없는 시각은 거부된다(시간대 혼동 방지)', bad.status === 400);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
if (process.env.CHECK_REPORT) {
  const { writeFile } = await import('node:fs/promises');
  const lines = [
    '# T06 자동 검사 결과', '',
    `- 실행 시각: ${new Date().toISOString()} (서울 날짜 ${kstToday})`,
    `- 대상: 로컬 검사용 서버 + 빈 검사용 DB (${BASE})`,
    `- 결과: ${results.length - failed.length}/${results.length} 통과`, '',
    '| 결과 | 기준 | 내용 | 근거 |', '|---|---|---|---|',
    ...results.map((r) => `| ${r.ok ? 'PASS' : 'FAIL'} | ${r.id} | ${r.desc} | ${r.detail.replaceAll('|', '\\|')} |`),
  ];
  await writeFile(process.env.CHECK_REPORT, lines.join('\n') + '\n');
}
process.exit(failed.length ? 1 : 0);
