// 플랜두씨 노트 화면 코드.
// 저장된 글자는 전부 textContent·텍스트 노드로만 화면에 넣는다(HTML 문자열로 해석하지 않음) — 스크립트 모양 글자도 글자 그대로 보인다.
'use strict';

const TZ = 'Asia/Seoul';
const PRIORITY = { 1: '1 · 높음', 2: '2 · 보통', 3: '3 · 낮음' };
const $ = (sel) => document.querySelector(sel);

const state = {
  view: 'plan',
  plans: [],
  planId: null,
  plan: null,
  tasks: [],
  allTags: [],
  filter: { q: '', status: '', priority: '', tag: '', sort: 'due', ids: null, idsLabel: '' },
  openTask: null,
  editTask: null,
  stats: null,
  evidenceKey: null,
  period: { from: '', to: '' },
  completeKeys: new Map(),
  hlTag: null, // 눈으로만 강조하는 태그 (목록을 줄이지 않음)
  cal: { month: null, selected: null, tasks: [], runs: [] },
};

// ---------- 도우미 ----------
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, val] of Object.entries(props || {})) {
    if (val === undefined || val === null || val === false) continue;
    if (k === 'class') el.className = val;
    else if (k === 'text') el.textContent = val;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), val);
    else if (k === 'dataset') Object.assign(el.dataset, val);
    else el.setAttribute(k, val === true ? '' : String(val));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-PDS-Request': '1' },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  let data = null;
  try { data = await res.json(); } catch { /* 빈 응답 */ }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth')) location.reload();
    throw new Error((data && data.error) || `요청 실패 (${res.status})`);
  }
  markSynced();
  return data;
}

function markSynced() {
  const t = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());
  $('#syncState').textContent = `서버 데이터베이스와 연결됨 · 마지막 확인 ${t} (서울 시간)`;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 5000 : 2600);
}
const fail = (err) => toast(err.message || String(err), true);

function fmtMin(n) {
  n = Number(n) || 0;
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a < 60) return `${sign}${a}분`;
  const hr = Math.floor(a / 60), m = a % 60;
  return `${sign}${hr}시간${m ? ` ${m}분` : ''}`;
}
const fmtDate = (d) => (d ? d.replaceAll('-', '.') : '없음');
function fmtInstant(iso) {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}
function todayKst(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(date);
}
// YYYY-MM-DD 날짜 계산 (시간대 영향 없이 날짜만)
const dayMs = 86400000;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
const weekdayMon0 = (d) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; // 월=0 … 일=6
const mondayOf = (d) => addDays(d, -weekdayMon0(d));
function isoWeek(d) {
  const thu = addDays(mondayOf(d), 3);
  const jan1 = `${thu.slice(0, 4)}-01-01`;
  return Math.floor((Date.parse(`${thu}T00:00:00Z`) - Date.parse(`${jan1}T00:00:00Z`)) / dayMs / 7) + 1;
}
const DOW = ['월', '화', '수', '목', '금', '토', '일'];
const fmtMonthDay = (d) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일 (${DOW[weekdayMon0(d)]})`;
// datetime-local 값(서울 시간) ↔ ISO
function kstInputValue(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}
const inputToIso = (val) => (val ? `${val}:00+09:00` : '');

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// ---------- 주소(#보기?p=계획ID)로 위치 기억 ----------
const VIEWS = ['plan', 'do', 'see', 'cal'];
function readHash() {
  const [view, qs] = location.hash.replace(/^#/, '').split('?');
  const p = new URLSearchParams(qs || '');
  return { view: VIEWS.includes(view) ? view : 'plan', planId: Number(p.get('p')) || null };
}
function writeHash() {
  const next = `#${state.view}${state.planId ? `?p=${state.planId}` : ''}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}

// ---------- 보기 전환 ----------
function setView(view) {
  state.view = view;
  for (const tab of document.querySelectorAll('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  writeHash();
  return renderView();
}

async function renderView() {
  const hasPlan = Boolean(state.planId);
  for (const el of document.querySelectorAll('.need-plan')) el.hidden = hasPlan;
  for (const el of document.querySelectorAll('.has-plan')) el.hidden = !hasPlan;
  if (state.view === 'plan') return renderPlan();
  if (!hasPlan) return;
  if (state.view === 'do') return loadTasks();
  if (state.view === 'see') return loadSee();
  if (state.view === 'cal') return loadCalendar();
}

// ---------- 계획 ----------
async function loadPlans() {
  const { plans } = await api('/api/plans');
  state.plans = plans;
  if (!plans.some((p) => p.id === state.planId)) state.planId = plans[0] ? plans[0].id : null;
  const sel = $('#planSelect');
  sel.replaceChildren(...(plans.length
    ? plans.map((p) => h('option', { value: p.id, text: `#${p.id} ${p.title} (${fmtDate(p.start_date)}~${fmtDate(p.end_date)})` }))
    : [h('option', { value: '', text: '계획 없음' })]));
  sel.value = state.planId || '';
}

async function renderPlan() {
  const form = $('#planForm');
  $('#planEmpty').hidden = state.plans.length > 0;
  if (!state.planId) {
    $('#planDetail').hidden = true;
    if (!state.plans.length && form.hidden) openPlanForm();
    return;
  }
  const plan = await api(`/api/plans?id=${state.planId}`);
  state.plan = plan;
  $('#planDetail').hidden = !form.hidden;
  $('#pdTitle').textContent = plan.title;
  $('#pdId').textContent = `계획 ID #${plan.id}`;
  $('#pdPeriod').textContent = `${fmtDate(plan.start_date)} ~ ${fmtDate(plan.end_date)}`;
  $('#pdPriority').textContent = PRIORITY[plan.priority];
  $('#pdEstimate').textContent = `${fmtMin(plan.estimated_minutes)} (${plan.estimated_minutes}분)`;
  $('#pdVersion').textContent = `${plan.version}판`;
  $('#pdCriteria').textContent = plan.success_criteria;
  const carried = $('#pdCarried');
  carried.hidden = !plan.carried_lesson;
  if (plan.carried_lesson) {
    carried.replaceChildren('지난 돌아보기(#', String(plan.carried_from_review_id), ')에서 넘어온 고칠 점: ', h('span', { class: 'hand', text: plan.carried_lesson }));
  }
  const fields = [
    ['title', '이름', (x) => x],
    ['start_date', '시작', fmtDate],
    ['end_date', '끝', fmtDate],
    ['priority', '우선순위', (x) => PRIORITY[x]],
    ['estimated_minutes', '예상', (x) => `${x}분`],
    ['success_criteria', '성공 기준', (x) => x],
  ];
  $('#pdVersions').replaceChildren(...plan.versions.slice().reverse().map((ver) => {
    const prev = plan.versions.find((x) => x.version === ver.version - 1);
    return h('li', {},
      h('div', { class: 'v-head' },
        h('span', { class: 'v-no', text: `${ver.version}판` }),
        ver.version === 1 ? h('span', { class: 'v-original', text: '처음 세운 계획' }) : null,
        h('span', { class: 'muted small', text: `${fmtInstant(ver.recorded_at)} 저장` }),
        ver.version > 1 && ver.change_note ? h('span', { class: 'small', text: `고친 이유: ${ver.change_note}` }) : null),
      h('div', { class: 'v-fields' }, fields.map(([k, label, f]) =>
        h('span', { class: [prev && prev[k] !== ver[k] ? 'changed' : '', k === 'title' || k === 'success_criteria' ? 'wide' : ''].join(' ').trim() || null, title: prev && prev[k] !== ver[k] ? `이전 판: ${f(prev[k])}` : null }, `${label}: ${f(ver[k])}`))));
  }));
}

function openPlanForm({ mode = 'new', carried = null } = {}) {
  const form = $('#planForm');
  form.reset();
  form.dataset.mode = mode;
  form.hidden = false;
  $('#planEmpty').hidden = state.plans.length > 0;
  $('#changeNoteLabel').hidden = mode !== 'edit';
  $('#planFormTitle').textContent = mode === 'edit' ? `계획 고치기 (#${state.plan.id})` : '새 계획';
  $('#planSubmit').textContent = mode === 'edit' ? '고친 내용 저장 (새 판으로)' : '계획 저장';
  const c = $('#planFormCarried');
  c.hidden = !carried;
  form.elements.carried_from_review_id.value = carried ? carried.id : '';
  if (carried) c.replaceChildren('돌아보기 #', String(carried.id), '에서 넘겨받는 고칠 점: ', h('span', { class: 'hand', text: carried.lesson }));
  if (mode === 'edit') {
    for (const k of ['title', 'start_date', 'end_date', 'priority', 'estimated_minutes', 'success_criteria']) form.elements[k].value = state.plan[k];
    $('#planDetail').hidden = true;
  } else {
    const today = todayKst();
    form.elements.start_date.value = today;
    form.elements.end_date.value = today;
    $('#planDetail').hidden = true;
  }
  form.elements.title.focus();
}

function closePlanForm() {
  $('#planForm').hidden = true;
  renderPlan().catch(fail);
}

async function submitPlan(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const d = formData(form);
  const body = {
    title: d.title, start_date: d.start_date, end_date: d.end_date, priority: Number(d.priority),
    estimated_minutes: d.estimated_minutes === '' ? '' : Number(d.estimated_minutes), success_criteria: d.success_criteria,
  };
  try {
    if (form.dataset.mode === 'edit') {
      await api(`/api/plans?id=${state.plan.id}`, { method: 'PATCH', body: { ...body, change_note: d.change_note } });
      toast('계획을 고쳤습니다. 고치기 전 판은 이력에 남아 있습니다.');
    } else {
      if (d.carried_from_review_id) body.carried_from_review_id = Number(d.carried_from_review_id);
      const plan = await api('/api/plans', { method: 'POST', body });
      state.planId = plan.id;
      toast('계획을 서버에 저장했습니다.');
    }
    form.hidden = true;
    await loadPlans();
    writeHash();
    await renderPlan();
  } catch (err) { fail(err); }
}

// ---------- 할 일 ----------
function taskQuery() {
  const f = state.filter;
  const p = new URLSearchParams({ plan_id: state.planId, sort: f.sort });
  if (f.ids) p.set('id', f.ids.join(','));
  else {
    if (f.q) p.set('q', f.q);
    if (f.status) p.set('status', f.status);
    if (f.priority) p.set('priority', f.priority);
    if (f.tag) p.set('tag', f.tag);
  }
  return p.toString();
}

async function loadTasks() {
  if (state.filter.ids && !state.filter.ids.length) {
    state.tasks = [];
  } else {
    const data = await api(`/api/tasks?${taskQuery()}`);
    state.tasks = data.tasks;
    $('#sortNote').replaceChildren('정렬 기준: ', h('b', { text: data.sort.label }), ' · 검색·거르기·정렬은 서버에서 합니다.');
  }
  const all = await api(`/api/tasks?plan_id=${state.planId}&sort=created`);
  const tags = [...new Set(all.tasks.flatMap((t) => t.tags))].sort();
  const tagSel = $('#fTag');
  const cur = state.filter.tag;
  tagSel.replaceChildren(h('option', { value: '', text: '전체' }), ...tags.map((t) => h('option', { value: t, text: `#${t}` })));
  tagSel.value = tags.includes(cur) ? cur : '';
  renderTasks();
}

function renderTasks() {
  const note = $('#filterNote');
  note.hidden = !state.filter.ids;
  if (state.filter.ids) $('#filterNoteText').textContent = `${state.filter.idsLabel}에서 고른 할 일 ${state.filter.ids.length}개만 보고 있습니다.`;
  $('#taskEmpty').hidden = state.tasks.length > 0;
  $('#taskList').replaceChildren(...state.tasks.map(renderTask));
  renderHlNote('#hlNote');
}

function completeKey(task) {
  const k = `${task.id}:${task.cycle}`;
  if (!state.completeKeys.has(k)) state.completeKeys.set(k, crypto.randomUUID());
  return state.completeKeys.get(k);
}

function renderTask(t) {
  const done = t.status === 'done';
  const li = h('li', { class: `task${done ? ' done' : ''}${hlClass(t.tags)}`, id: `task-${t.id}`, dataset: { id: t.id } });
  const check = h('button', {
    type: 'button', class: 'check', 'aria-label': done ? `${t.title} 완료 되돌리기` : `${t.title} 완료로 바꾸기`,
    title: done ? '다시 진행 중으로 되돌리기' : '완료로 바꾸기', text: done ? '✓' : '',
    onclick: () => (done ? reopenTask(t) : completeTask(t)),
  });
  const meta = h('div', { class: 'meta' },
    h('span', { class: 'chip num', text: `#${t.id}` }),
    h('span', { class: 'chip', text: `마감 ${fmtDate(t.due_date)}` }),
    h('span', { class: 'chip', text: `우선 ${PRIORITY[t.priority]}` }),
    h('span', { class: 'chip', text: `예상 ${t.estimated_minutes}분` }),
    h('span', { class: 'chip', text: `실제 ${t.actual_minutes}분 · 기록 ${t.run_count}건` }),
    t.overdue ? h('span', { class: 'chip warn', text: '지연' }) : null,
    t.blocked ? h('span', { class: 'chip block', text: '막힘 있었음' }) : null,
    done && t.completed_at ? h('span', { class: 'chip', text: `완료 ${fmtInstant(t.completed_at)}` }) : null,
    t.tags.map((g) => tagButton(g, 'chip tag')));
  const actions = h('div', { class: 'task-actions' },
    h('button', { type: 'button', class: 'btn small', text: state.openTask === t.id ? '기록 닫기' : '실행 기록', 'aria-expanded': String(state.openTask === t.id), onclick: () => toggleRuns(t.id) }),
    h('button', { type: 'button', class: 'btn small', text: '고치기', onclick: () => { state.editTask = state.editTask === t.id ? null : t.id; renderTasks(); } }),
    done ? h('button', { type: 'button', class: 'btn small', text: '되돌리기', onclick: () => reopenTask(t) }) : null,
    h('button', { type: 'button', class: 'btn small danger', text: '지우기', onclick: () => deleteTask(t) }));
  li.append(h('div', { class: 'task-main' }, check, h('div', {}, h('div', { class: 'task-title', text: t.title }), meta), actions));
  if (state.editTask === t.id) li.append(renderEditForm(t));
  if (state.openTask === t.id) {
    const extra = h('div', { class: 'task-extra' }, h('p', { class: 'muted small', text: '실행 기록을 불러오는 중…' }));
    li.append(extra);
    loadRuns(t, extra).catch(fail);
  }
  return li;
}

function renderEditForm(t) {
  const form = h('form', { class: 'task-extra edit-form', autocomplete: 'off' },
    h('div', { class: 'row' },
      h('label', { class: 'grow' }, '할 일', h('input', { name: 'title', required: true, maxlength: 120, value: t.title })),
      h('label', {}, '마감일', h('input', { type: 'date', name: 'due_date', value: t.due_date || '' })),
      h('label', {}, '우선순위', h('select', { name: 'priority' }, [1, 2, 3].map((p) => h('option', { value: p, text: PRIORITY[p], selected: p === t.priority })))),
      h('label', {}, '예상(분)', h('input', { type: 'number', name: 'estimated_minutes', min: 0, step: 1, required: true, value: t.estimated_minutes })),
      h('label', {}, '태그', h('input', { name: 'tags', maxlength: 120, value: t.tags.join(', ') }))),
    h('div', { class: 'actions' },
      h('button', { type: 'submit', class: 'btn primary small', text: '고친 내용 저장' }),
      h('button', { type: 'button', class: 'btn ghost small', text: '취소', onclick: () => { state.editTask = null; renderTasks(); } })));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    try {
      await api(`/api/tasks?id=${t.id}`, { method: 'PATCH', body: { title: d.title, due_date: d.due_date || null, priority: Number(d.priority), estimated_minutes: d.estimated_minutes === '' ? '' : Number(d.estimated_minutes), tags: d.tags.split(',') } });
      state.editTask = null;
      toast('할 일을 고쳤습니다.');
      await loadTasks();
    } catch (err) { fail(err); }
  });
  return form;
}

async function loadRuns(t, box) {
  const { runs } = await api(`/api/runs?task_id=${t.id}`);
  const now = new Date();
  const start = new Date(now.getTime() - 30 * 60000);
  const form = h('form', { class: 'run-form', autocomplete: 'off' },
    h('div', { class: 'row' },
      h('label', {}, '시작 시각', h('input', { type: 'datetime-local', name: 'started_at', required: true, value: kstInputValue(start) })),
      h('label', {}, '끝난 시각', h('input', { type: 'datetime-local', name: 'ended_at', required: true, value: kstInputValue(now) })),
      h('label', {}, '실제로 걸린 시간(분)', h('input', { type: 'number', name: 'actual_minutes', min: 0, step: 1, required: true, value: 30 })),
      h('label', { class: 'grow' }, '막혔던 이유 (없으면 비움)', h('input', { name: 'blocker', maxlength: 300 })),
      h('label', { class: 'grow' }, '메모', h('input', { name: 'note', maxlength: 300 })),
      h('button', { type: 'submit', class: 'btn primary', text: '기록 저장' })),
    h('p', { class: 'muted small', text: '시각은 서울 시간으로 적습니다. 시작·끝 시각을 바꾸면 걸린 시간이 자동으로 다시 계산됩니다(직접 고쳐도 됩니다). 실행 기록은 계획과 할 일의 원래 값을 바꾸지 않습니다.' }));
  const recalc = () => {
    const a = Date.parse(inputToIso(form.elements.started_at.value));
    const b = Date.parse(inputToIso(form.elements.ended_at.value));
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) form.elements.actual_minutes.value = Math.round((b - a) / 60000);
  };
  form.elements.started_at.addEventListener('change', recalc);
  form.elements.ended_at.addEventListener('change', recalc);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    try {
      await api('/api/runs', { method: 'POST', body: { task_id: t.id, started_at: inputToIso(d.started_at), ended_at: inputToIso(d.ended_at), actual_minutes: d.actual_minutes === '' ? '' : Number(d.actual_minutes), blocker: d.blocker, note: d.note } });
      toast('실행 기록을 저장했습니다.');
      await loadTasks();
    } catch (err) { fail(err); }
  });
  const list = runs.length
    ? h('ul', { class: 'runs' }, runs.map((r) => h('li', { id: `run-${r.id}` },
      h('div', {},
        h('span', { class: 'num', text: `기록 #${r.id} · ` }),
        `${fmtInstant(r.started_at)} → ${fmtInstant(r.ended_at)} · `, h('b', { text: `${r.actual_minutes}분` }),
        r.blocker ? h('div', { class: 'blocker', text: `막힘: ${r.blocker}` }) : null,
        r.note ? h('div', { class: 'muted', text: r.note }) : null),
      h('button', { type: 'button', class: 'btn small danger', text: '삭제', onclick: () => deleteRun(r) }))))
    : h('p', { class: 'muted small', text: '아직 실행 기록이 없습니다.' });
  box.replaceChildren(h('h3', { text: `"${t.title}" 실행 기록` }), list, form);
}

function toggleRuns(id) {
  state.openTask = state.openTask === id ? null : id;
  renderTasks();
}

async function completeTask(t) {
  try {
    const r = await api(`/api/tasks?id=${t.id}&action=complete`, { method: 'POST', body: { request_key: completeKey(t) } });
    toast(r.created ? '완료로 바꿨습니다. 완료 기록 1건 저장.' : '이미 완료된 할 일이라 기록을 더 만들지 않았습니다.');
    await loadTasks();
  } catch (err) { fail(err); }
}

async function reopenTask(t) {
  try {
    await api(`/api/tasks?id=${t.id}&action=reopen`, { method: 'POST' });
    toast('다시 진행 중으로 되돌렸습니다.');
    await loadTasks();
  } catch (err) { fail(err); }
}

async function deleteTask(t) {
  if (!confirm(`"${t.title}" 할 일을 지울까요? 목록과 돌아보기 집계에서 빠집니다.`)) return;
  try {
    await api(`/api/tasks?id=${t.id}`, { method: 'DELETE' });
    toast('할 일을 지웠습니다.');
    if (state.openTask === t.id) state.openTask = null;
    await loadTasks();
  } catch (err) { fail(err); }
}

async function deleteRun(r) {
  if (!confirm(`실행 기록 #${r.id}을(를) 삭제할까요?`)) return;
  try {
    await api(`/api/runs?id=${r.id}`, { method: 'DELETE' });
    toast('실행 기록을 삭제했습니다.');
    await loadTasks();
  } catch (err) { fail(err); }
}

async function submitTask(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const d = formData(form);
  try {
    await api('/api/tasks', { method: 'POST', body: { plan_id: state.planId, title: d.title, due_date: d.due_date || null, priority: Number(d.priority), estimated_minutes: d.estimated_minutes === '' ? '' : Number(d.estimated_minutes), tags: d.tags.split(',') } });
    form.elements.title.value = '';
    form.elements.tags.value = '';
    form.elements.title.focus();
    toast('할 일을 추가했습니다.');
    await loadTasks();
  } catch (err) { fail(err); }
}

// ---------- 돌아보기 ----------
const TILES = [
  { key: 'planned', label: '계획 수', rule: '이 계획에 딸린, 지우지 않은 할 일' },
  { key: 'done', label: '완료 수', rule: '그중 지금 완료 상태인 할 일' },
  { key: 'delayed', label: '지연 수', rule: '완료하지 않았고 마감일이 서울 시간 오늘보다 앞선 할 일 (완료한 할 일은 세지 않음)' },
  { key: 'blocked', label: '막힘 수', rule: '실행 기록에 막힌 이유가 하나라도 적힌 할 일' },
  { key: 'estimated_minutes', label: '예상 시간', rule: '대상 할 일의 예상 시간 합계', minutes: true },
  { key: 'actual_minutes', label: '실제 시간', rule: '대상 할 일의 실행 기록 시간 합계', minutes: true },
  { key: 'diff_minutes', label: '차이 (실제−예상)', rule: '실제 시간 − 예상 시간. +면 예상보다 오래 걸림', minutes: true },
];

async function loadSee() {
  const plan = state.plans.find((p) => p.id === state.planId);
  $('#seePlanName').textContent = plan ? `#${plan.id} ${plan.title}` : '';
  $('#seeToday').textContent = fmtDate(todayKst());
  syncPeriodForm();
  const p = new URLSearchParams({ plan_id: state.planId });
  if (state.period.from) p.set('from', state.period.from);
  if (state.period.to) p.set('to', state.period.to);
  const [stats, reviews] = await Promise.all([api(`/api/stats?${p}`), api(`/api/reviews?plan_id=${state.planId}`)]);
  state.stats = stats;
  renderTiles();
  renderEvidence().catch(fail);
  renderReviews(reviews.reviews);
}

function renderTiles() {
  const s = state.stats;
  $('#tiles').replaceChildren(...TILES.map((tile) => {
    const val = tile.minutes ? s[tile.key].value : s[tile.key].count;
    const cls = tile.key === 'diff_minutes' ? (val > 0 ? ' diff-over' : val < 0 ? ' diff-under' : '') : '';
    return h('button', {
      type: 'button', class: `tile${cls}`, 'aria-pressed': String(state.evidenceKey === tile.key),
      onclick: () => { state.evidenceKey = state.evidenceKey === tile.key ? null : tile.key; renderTiles(); renderEvidence().catch(fail); },
    },
    h('span', { class: 't-label', text: tile.label }),
    h('span', { class: 't-value', text: tile.minutes && val > 0 && tile.key === 'diff_minutes' ? `+${val}` : String(val) }),
    h('span', { class: 't-unit', text: tile.minutes ? `분 (${fmtMin(val)})` : '개' }));
  }));
}

async function renderEvidence() {
  const box = $('#evidence');
  const key = state.evidenceKey;
  if (!key || !state.stats) { box.hidden = true; return; }
  const tile = TILES.find((x) => x.key === key);
  const s = state.stats[key];
  const val = tile.minutes ? s.value : s.count;
  box.hidden = false;
  $('#evTitle').replaceChildren(`${tile.label} `, h('span', { class: 'num', text: tile.minutes ? `${val}분` : String(val) }), ' 의 근거 기록');
  $('#evRule').textContent = `세는 규칙: ${tile.rule}`;
  const items = [];
  if (s.task_ids && s.task_ids.length) {
    const { tasks } = await api(`/api/tasks?plan_id=${state.planId}&sort=created&id=${s.task_ids.join(',')}`);
    for (const t of tasks) {
      items.push(h('li', {},
        h('span', {}, h('b', { class: 'num', text: `할 일 #${t.id} ` }), t.title,
          h('span', { class: 'muted small', text: ` · ${t.status === 'done' ? '완료' : '진행 중'} · 마감 ${fmtDate(t.due_date)} · 예상 ${t.estimated_minutes}분 · 실제 ${t.actual_minutes}분` })),
        h('button', { type: 'button', class: 'link', text: 'Do에서 이 기록 보기', onclick: () => gotoTask(t.id, s.task_ids, `돌아보기 "${tile.label}"`) })));
    }
  }
  if (s.run_ids && s.run_ids.length) {
    const { runs } = await api(`/api/runs?plan_id=${state.planId}&id=${s.run_ids.join(',')}`);
    for (const r of runs) {
      items.push(h('li', {},
        h('span', {}, h('b', { class: 'num', text: `실행 기록 #${r.id} ` }), `${r.task_title} · ${fmtInstant(r.started_at)} → ${fmtInstant(r.ended_at)} · ${r.actual_minutes}분`,
          r.blocker ? h('span', { class: 'muted small', text: ` · 막힘: ${r.blocker}` }) : null),
        h('button', { type: 'button', class: 'link', text: 'Do에서 이 기록 보기', onclick: () => gotoTask(r.task_id, null, `돌아보기 "${tile.label}"`, true) })));
    }
  }
  if (!items.length) items.push(h('li', { class: 'muted', text: '이 숫자에 해당하는 기록이 없습니다 (0).' }));
  $('#evList').replaceChildren(...items);
}

async function gotoTask(taskId, ids, label, openRuns = false) {
  state.filter = { ...state.filter, q: '', status: '', priority: '', tag: '', ids: ids || [taskId], idsLabel: label };
  syncFilterInputs();
  state.openTask = openRuns ? taskId : state.openTask;
  await setView('do');
  const el = document.getElementById(`task-${taskId}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }
}

function renderReviews(reviews) {
  $('#reviewList').replaceChildren(...(reviews.length ? reviews.map((r) => {
    const s = r.stats;
    const period = r.period_from || r.period_to ? `${fmtDate(r.period_from)} ~ ${fmtDate(r.period_to)}` : '전체 기간';
    return h('li', {},
      h('div', { class: 'muted small', text: `돌아보기 #${r.id} · ${fmtInstant(r.created_at)} · ${period}` }),
      h('div', { class: 'snap', text: `계획 ${s.planned.count} · 완료 ${s.done.count} · 지연 ${s.delayed.count} · 막힘 ${s.blocked.count} · 예상 ${s.estimated_minutes.value}분 · 실제 ${s.actual_minutes.value}분 · 차이 ${s.diff_minutes.value > 0 ? '+' : ''}${s.diff_minutes.value}분` }),
      r.went_well ? h('div', {}, h('b', { text: '잘된 점 ' }), r.went_well) : null,
      h('div', {}, h('b', { text: '고칠 점 ' }), h('span', { class: 'lesson', text: r.lesson })),
      r.next_plan_id
        ? h('div', { class: 'small' }, '→ 다음 계획 ', h('button', { type: 'button', class: 'link', text: `#${r.next_plan_id} ${r.next_plan_title}`, onclick: () => selectPlan(r.next_plan_id, 'plan') }), ' 으로 넘어갔습니다.')
        : h('div', {}, h('button', { type: 'button', class: 'btn small', text: '이 고칠 점으로 다음 계획 세우기', onclick: () => carryToNext(r) })));
  }) : [h('li', { class: 'muted', text: '아직 남긴 돌아보기가 없습니다.' })]));
}

async function carryToNext(review) {
  await setView('plan');
  openPlanForm({ mode: 'new', carried: review });
}

async function submitReview(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const d = formData(form);
  try {
    await api('/api/reviews', { method: 'POST', body: { plan_id: state.planId, period_from: state.period.from || null, period_to: state.period.to || null, went_well: d.went_well, lesson: d.lesson } });
    form.reset();
    toast('돌아보기를 저장했습니다. 고칠 점을 다음 계획으로 넘길 수 있습니다.');
    await loadSee();
  } catch (err) { fail(err); }
}

// ---------- 태그 강조: 같은 태그는 테두리, 나머지는 흐리게 (보기만 바뀜) ----------
function hlClass(tags) {
  if (!state.hlTag) return '';
  return tags && tags.includes(state.hlTag) ? ' hl-match' : ' hl-dim';
}
function runTags(run) {
  const t = state.cal.tasks.find((x) => x.id === run.task_id);
  return t ? t.tags : [];
}
function tagButton(tag, cls) {
  const on = state.hlTag === tag;
  return h('button', {
    type: 'button', class: `${cls}${on ? ' on' : ''}`, text: `#${tag}`, 'aria-pressed': String(on),
    title: on ? '강조 해제' : `#${tag} 강조하기`,
    onclick: (e) => { e.stopPropagation(); setHlTag(on ? null : tag); },
  });
}
function setHlTag(tag) {
  state.hlTag = tag;
  if (state.view === 'do') renderTasks();
  if (state.view === 'cal') renderCalendar();
}
function renderHlNote(sel) {
  const el = $(sel);
  if (!el) return;
  el.hidden = !state.hlTag;
  if (state.hlTag) {
    el.replaceChildren(`#${state.hlTag} 태그를 강조하고 있습니다. `,
      h('button', { type: 'button', class: 'link', text: '강조 해제', onclick: () => setHlTag(null) }));
  }
}

// ---------- 기간 빠른 선택 ----------
function quickPeriod(kind) {
  const today = todayKst();
  const mon = mondayOf(today);
  if (kind === 'thisWeek') return { from: mon, to: addDays(mon, 6) };
  if (kind === 'lastWeek') return { from: addDays(mon, -7), to: addDays(mon, -1) };
  const first = `${today.slice(0, 7)}-01`;
  const nextFirst = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1)).toISOString().slice(0, 10);
  return { from: first, to: addDays(nextFirst, -1) };
}

function syncPeriodForm() {
  const f = $('#periodForm');
  f.elements.from.value = state.period.from;
  f.elements.to.value = state.period.to;
  for (const b of document.querySelectorAll('[data-quick]')) {
    const q = quickPeriod(b.dataset.quick);
    b.setAttribute('aria-pressed', String(q.from === state.period.from && q.to === state.period.to));
  }
}

// ---------- 달력 (저장된 기록을 날짜별로 보여 주기만 함) ----------
async function loadCalendar() {
  if (!state.cal.month) state.cal.month = todayKst().slice(0, 7);
  const [t, r] = await Promise.all([
    api(`/api/tasks?plan_id=${state.planId}&sort=due`),
    api(`/api/runs?plan_id=${state.planId}`),
  ]);
  state.cal.tasks = t.tasks;
  state.cal.runs = r.runs.map((x) => ({ ...x, day: todayKst(new Date(x.started_at)) }));
  renderCalendar();
}

function calDayData(day) {
  const today = todayKst();
  const tasks = state.cal.tasks.filter((t) => t.due_date === day).map((t) => ({
    ...t, kind: t.status === 'done' ? 'done' : t.due_date < today ? 'late' : 'due',
  }));
  const runs = state.cal.runs.filter((x) => x.day === day);
  return { tasks, runs, minutes: runs.reduce((a, x) => a + Number(x.actual_minutes), 0) };
}

function shiftMonth(n) {
  const [y, m] = state.cal.month.split('-').map(Number);
  state.cal.month = new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
  state.cal.selected = null;
  renderCalendar();
}

function renderCalendar() {
  const month = state.cal.month;
  const [y, m] = month.split('-').map(Number);
  $('#calTitle').textContent = `${y}년 ${m}월`;
  const plan = state.plans.find((p) => p.id === state.planId);
  const today = todayKst();
  const first = `${month}-01`;
  const start = mondayOf(first);
  const nextFirst = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const end = addDays(mondayOf(addDays(nextFirst, -1)), 6);
  const cells = [h('div', { class: 'cal-dow', text: '주' }), ...DOW.map((d, i) => h('div', { class: `cal-dow${i === 6 ? ' sun' : ''}`, text: d }))];
  for (let wk = start; wk <= end; wk = addDays(wk, 7)) {
    const sun = addDays(wk, 6);
    cells.push(h('button', {
      type: 'button', class: 'cal-week', text: `W${isoWeek(wk)}`,
      title: `${fmtDate(wk)} ~ ${fmtDate(sun)} 을 See 기간으로`, 'aria-label': `${fmtMonthDay(wk)}부터 ${fmtMonthDay(sun)}까지를 돌아보기 기간으로 설정`,
      onclick: () => { state.period = { from: wk, to: sun }; state.evidenceKey = null; setView('see').catch(fail); },
    }));
    for (let i = 0; i < 7; i++) {
      const day = addDays(wk, i);
      const d = calDayData(day);
      const inPlan = plan && day >= plan.start_date && day <= plan.end_date;
      const cls = ['cal-cell', day.slice(0, 7) !== month && 'out', inPlan && 'in-plan', day === today && 'today', day === state.cal.selected && 'selected'].filter(Boolean).join(' ');
      const items = [
        ...d.tasks.map((t) => h('span', { class: `cal-item ${t.kind}${hlClass(t.tags)}`, text: t.title })),
        ...d.runs.map((x) => h('span', { class: `cal-item run${hlClass(runTags(x))}`, text: `▶ ${x.task_title}` })),
      ];
      const count = d.tasks.length + d.runs.length;
      cells.push(h('button', {
        type: 'button', class: cls, role: 'gridcell',
        'aria-label': `${fmtMonthDay(day)}${inPlan ? ', 계획 기간' : ''}, 마감 ${d.tasks.length}건, 실행 기록 ${d.runs.length}건`,
        onclick: () => { state.cal.selected = day; renderCalendar(); $('#calDay').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); },
      },
      h('span', { class: 'cal-num' }, h('span', { text: String(Number(day.slice(8))) }), d.minutes ? h('span', { class: 'cal-mins', text: `${d.minutes}분` }) : null),
      items.slice(0, 3),
      items.length > 3 ? h('span', { class: 'cal-more', text: `+${items.length - 3}` }) : null,
      count ? h('span', { class: 'cal-dots', 'aria-hidden': 'true' },
        d.tasks.map((t) => h('i', { class: `d-${t.kind}${hlClass(t.tags)}` })), d.runs.map((x) => h('i', { class: `d-run${hlClass(runTags(x))}` }))) : null));
    }
  }
  $('#calGrid').replaceChildren(...cells);
  const tags = [...new Set(state.cal.tasks.flatMap((t) => t.tags))].sort();
  $('#calTags').replaceChildren(...(tags.length
    ? [h('span', { class: 'muted small', text: '태그 강조' }), ...tags.map((g) => tagButton(g, 'chip tag'))]
    : []));
  renderHlNote('#calHlNote');
  renderCalDay();
}

function renderCalDay() {
  const box = $('#calDay');
  const day = state.cal.selected;
  if (!day) { box.hidden = true; return; }
  const d = calDayData(day);
  box.hidden = false;
  $('#calDayTitle').textContent = `${fmtMonthDay(day)} · 마감 ${d.tasks.length}건 · 실행 기록 ${d.runs.length}건${d.minutes ? ` (${d.minutes}분)` : ''}`;
  const label = `달력 ${fmtMonthDay(day)}`;
  const kindText = { due: '마감', late: '마감 · 지연', done: '마감 · 완료' };
  const items = [
    ...d.tasks.map((t) => h('li', {},
      h('span', {}, h('span', { class: `kind ${t.kind}`, text: kindText[t.kind] }), h('b', { class: 'num', text: `할 일 #${t.id} ` }), t.title,
        h('span', { class: 'muted small', text: ` · 예상 ${t.estimated_minutes}분 · 실제 ${t.actual_minutes}분` })),
      h('button', { type: 'button', class: 'link', text: 'Do에서 보기', onclick: () => gotoTask(t.id, null, label) }))),
    ...d.runs.map((x) => h('li', {},
      h('span', {}, h('span', { class: 'kind run', text: '실제로 한 일' }), h('b', { class: 'num', text: `기록 #${x.id} ` }),
        `${x.task_title} · ${fmtInstant(x.started_at)} → ${fmtInstant(x.ended_at)} · ${x.actual_minutes}분`,
        x.blocker ? h('span', { class: 'muted small', text: ` · 막힘: ${x.blocker}` }) : null),
      h('button', { type: 'button', class: 'link', text: 'Do에서 보기', onclick: () => gotoTask(x.task_id, null, label, true) }))),
  ];
  if (!items.length) items.push(h('li', { class: 'muted', text: '이날은 마감인 할 일도, 실행 기록도 없습니다.' }));
  $('#calDayList').replaceChildren(...items);
}

// ---------- 공통 ----------
function syncFilterInputs() {
  $('#fQ').value = state.filter.q;
  $('#fStatus').value = state.filter.status;
  $('#fPriority').value = state.filter.priority;
  $('#fSort').value = state.filter.sort;
}

async function selectPlan(id, view) {
  state.planId = id;
  state.openTask = null;
  state.editTask = null;
  state.evidenceKey = null;
  state.filter.ids = null;
  $('#planSelect').value = id;
  $('#planForm').hidden = true;
  await setView(view || state.view);
}

async function exportAll() {
  try {
    const res = await fetch('/api/export', { cache: 'no-store' });
    if (!res.ok) throw new Error('내보내기에 실패했습니다.');
    const blob = await res.blob();
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    const a = h('a', { href: URL.createObjectURL(blob), download: name ? name[1] : 'pds-note-export.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('내 자료 전체를 JSON 파일 하나로 내보냈습니다.');
  } catch (err) { fail(err); }
}

let searchTimer;
function bind() {
  for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => setView(tab.dataset.view).catch(fail));
  $('#planSelect').addEventListener('change', (e) => selectPlan(Number(e.target.value) || null).catch(fail));
  $('#newPlanBtn').addEventListener('click', () => setView('plan').then(() => openPlanForm()).catch(fail));
  $('#planForm').addEventListener('submit', submitPlan);
  $('#planCancel').addEventListener('click', closePlanForm);
  $('#editPlanBtn').addEventListener('click', () => openPlanForm({ mode: 'edit' }));
  $('#taskForm').addEventListener('submit', submitTask);
  $('#fQ').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filter.q = e.target.value.trim(); state.filter.ids = null; loadTasks().catch(fail); }, 250);
  });
  for (const [id, key] of [['#fStatus', 'status'], ['#fPriority', 'priority'], ['#fTag', 'tag'], ['#fSort', 'sort']]) {
    $(id).addEventListener('change', (e) => { state.filter[key] = e.target.value; if (key !== 'sort') state.filter.ids = null; loadTasks().catch(fail); });
  }
  $('#clearFilter').addEventListener('click', () => { state.filter.ids = null; loadTasks().catch(fail); });
  $('#periodForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const d = formData(e.currentTarget);
    state.period = { from: d.from, to: d.to };
    loadSee().catch(fail);
  });
  $('#periodAll').addEventListener('click', () => { $('#periodForm').reset(); state.period = { from: '', to: '' }; loadSee().catch(fail); });
  for (const b of document.querySelectorAll('[data-quick]')) {
    b.addEventListener('click', () => { state.period = quickPeriod(b.dataset.quick); state.evidenceKey = null; loadSee().catch(fail); });
  }
  $('#calPrev').addEventListener('click', () => shiftMonth(-1));
  $('#calNext').addEventListener('click', () => shiftMonth(1));
  $('#calToday').addEventListener('click', () => { state.cal.month = todayKst().slice(0, 7); state.cal.selected = null; renderCalendar(); });
  $('#reviewForm').addEventListener('submit', submitReview);
  $('#exportBtn').addEventListener('click', exportAll);
  window.addEventListener('hashchange', () => {
    if ($('#privateApp').hidden) return;
    const r = readHash();
    if (r.planId && r.planId !== state.planId && state.plans.some((p) => p.id === r.planId)) {
      selectPlan(r.planId, r.view).catch(fail);
    } else if (r.view !== state.view) setView(r.view).catch(fail);
  });
}

async function init() {
  $('#today').textContent = `Today ${fmtDate(todayKst())} KST`;
  $('#today').title = '한국 표준시(서울 시간) 기준 날짜입니다. 지연 판단도 이 날짜로 합니다.';
  const notice = $('#publicNotice');
  notice.addEventListener('toggle', () => { notice.querySelector('.notice-hint').textContent = notice.open ? '접기' : '펼치기'; });
  bind();
  try {
    await enterApp(await api('/api/auth'));
  } catch (err) {
    $('#authPanel').hidden = false;
    $('#authMessage').textContent = err.message;
  } finally {
    $('#sessionLoading').hidden = true;
  }
}

async function enterApp(session) {
  const r = readHash();
  state.planId = r.planId;
  $('#authPanel').hidden = true;
  $('#sessionLoading').hidden = true;
  $('#privateApp').hidden = false;
  $('#accountName').textContent = session.user.username + ' 님의 노트';
  $('#syncState').textContent = '기록을 불러오는 중…';
  mountFocusClock(session.user.id);
  const results = await Promise.allSettled([
    loadPlans().then(() => setView(r.view)),
    renderObservation(),
  ]);
  for (const result of results) if (result.status === 'rejected') fail(result.reason);
}

let signupMode = false;
$('#authToggle').addEventListener('click', () => {
  signupMode = !signupMode;
  $('#authTitle').textContent = signupMode ? '나만의 노트 만들기' : '내 기록에 로그인';
  $('#authSubmit').textContent = signupMode ? '회원가입' : '로그인';
  $('#authToggle').textContent = signupMode ? '로그인으로 전환' : '회원가입으로 전환';
  $('#authForm').elements.password.autocomplete = signupMode ? 'new-password' : 'current-password';
  $('#authMessage').textContent = '';
});
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#authSubmit');btn.disabled = true;
  const registering = signupMode;
  $('#authToggle').disabled = true;
  btn.textContent = registering ? '가입 중…' : '로그인 중…';
  $('#authMessage').textContent = '잠시만 기다려 주세요.';
  try {
    const session = await api('/api/auth?action=' + (registering ? 'signup' : 'login'), {method:'POST',body:Object.fromEntries(new FormData(e.target))});
    e.target.elements.password.value = '';
    if(registering) { $('#authToggle').disabled = false;$('#authToggle').click();$('#authMessage').textContent = '가입했습니다. 로그인해 주세요.'; }
    else await enterApp(session);
  } catch(err) {$('#authMessage').textContent = err.message;} finally {btn.disabled=false;$('#authToggle').disabled=false;btn.textContent=signupMode?'회원가입':'로그인';}
});
$('#logoutBtn').addEventListener('click', async () => {
  try {await api('/api/auth?action=logout',{method:'POST',body:{}});location.replace('/');} catch(err){fail(err);}
});
for(const [id,action,method] of [['passwordForm','password','POST'],['deleteForm','delete','DELETE']]) {
  $("#"+id).addEventListener('submit',async e=>{
    e.preventDefault();
    if(action==='delete' && !confirm('계정과 모든 기록을 영구 삭제할까요? 되돌릴 수 없습니다.')) return;
    const button=e.target.querySelector('button');button.disabled=true;
    try {await api('/api/auth?action='+action,{method,body:Object.fromEntries(new FormData(e.target))});e.target.reset();location.replace('/');}
    catch(err){fail(err);}finally{button.disabled=false;}
  });
}
init();

async function renderObservation() {
  const data=await api('/api/observation');
  const box=$('#observationContent');box.dataset.unit=data.observation?.config.unit||'분';box.replaceChildren();
  const input=(name,label,value='',multiline=false)=>h('label',{},label,h(multiline?'textarea':'input',{name,required:true,value:multiline?undefined:value,rows:multiline?2:undefined},...(multiline?[value]:[])));
  const submitForm=(form,action)=>{
    form.addEventListener('submit',async e=>{
      e.preventDefault();const button=form.querySelector('button');button.disabled=true;
      try {await api('/api/observation?action='+action,{method:'POST',body:Object.fromEntries(new FormData(form))});await renderObservation();toast('관찰 기록을 저장했습니다.');}
      catch(err){fail(err);button.disabled=false;}
    });
    box.append(form);
  };
  const dailyFields=()=>[
    h('label',{},'오늘 관찰값 (정수)',h('input',{name:'value',type:'number',min:0,max:100000,step:1,required:true})),
    input('note','근거 기록·오늘 실제로 한 일','',true),
  ];
  if(!data.observation) {
    const form=h('form',{},
      input('question','관찰 질문','하루 첫 작업을 미리 정하면 실제 집중 시간이 늘어날까?'),
      input('metric','지표 한 개','하루 실제 집중 시간 합계'),
      input('unit','단위','분'),
      input('calculation','같게 유지할 계산 규칙','서울 날짜별 실제 집중 시간(분)을 합산한다. 휴식은 제외한다.',true),
      input('plan_rule','변경 전 계획 규칙','하루 할 일을 시작할 때 정한다.'),
      input('missing','누락 처리','기록이 없는 날은 제외하고 실제 기록일 5일을 채운다. 0으로 대체하지 않는다.'),
      input('duplicate','중복 처리','같은 실행 기록 ID는 한 번만 합산한다. 하루 관찰은 한 번 저장한다.'),
      input('outlier','이상치 처리','큰 값도 원기록을 확인하고 실제 값이면 그대로 포함한다.'),
      input('rounding','반올림','원기록은 정수 분. 합계는 반올림하지 않고 평균은 소수 둘째 자리까지 반올림한다.'),
      input('week_start','주 시작 요일','월요일'),...dailyFields(),
      h('button',{type:'submit',class:'btn primary'},'규칙 확정 및 실제 1일차 기록 저장'));
    submitForm(form,'start');return;
  }
  const o=data.observation;
  box.append(h('h3',{},o.config.question));
  const labels={metric:'지표',unit:'단위',calculation:'계산',plan_rule:'변경 전 규칙',missing:'누락',duplicate:'중복',outlier:'이상치',rounding:'반올림',week_start:'주 시작'};
  const detail=h('details',{},h('summary',{},'1일차에 고정한 규칙 보기'));
  for(const [k,label] of Object.entries(labels)) detail.append(h('p',{},`${label}: ${o.config[k]}`));
  box.append(detail);
  const table=h('table',{},h('thead',{},h('tr',{},...['날짜 (서울)','값 · '+o.config.unit,'근거'].map(x=>h('th',{},x)))),h('tbody',{},...data.days.map(d=>h('tr',{},h('td',{},d.date),h('td',{},d.value),h('td',{},d.note)))));
  box.append(table,h('p',{},`총 ${data.total.count}/5일 · 합계 ${data.total.sum} ${o.config.unit} · 평균 ${data.total.mean ?? '—'} ${o.config.unit}`),h('p',{},`변경 전(1~2일): 합계 ${data.before.sum}, 평균 ${data.before.mean ?? '—'} / 변경 후(3~5일): 합계 ${data.after.sum}, 평균 ${data.after.mean ?? '—'} (${o.config.unit})`));
  if(o.change) box.append(h('p',{},`규칙 변경: ${o.change.plan_rule}`),h('p',{},`이유: ${o.change.reason} · ${fmtInstant(o.changed_at)} KST · 참조 기록 #${o.change.reference_day_ids.join(', #')}`));
  if(data.days.length===2 && !o.change) {
    submitForm(h('form',{},h('h3',{},'3일차 전, 계획 규칙 하나 바꾸기'),input('plan_rule','새 계획 규칙'),input('reason','1~2일차를 근거로 한 변경 이유','',true),h('button',{type:'submit',class:'btn'},'규칙 변경 기록 저장')),'change');
  } else if(data.days.length<5 && !data.days.some(d=>d.date===data.today)) {
    submitForm(h('form',{},h('h3',{},`${data.days.length+1}일차 · ${data.today}`),...dailyFields(),h('button',{type:'submit',class:'btn'},'오늘 실제 관찰 저장')),'day');
  } else box.append(h('p',{},data.days.length===5?'5일 기록을 완료했습니다. 화면 합계·평균을 직접 계산한 값과 대조해 주세요.':'오늘 기록이 저장됐습니다. 다음 실제 날짜에 이어서 기록하세요.'));
}

window.addEventListener('pageshow', e => { if(e.persisted) location.reload(); });

// 날짜별 측정은 브라우저에 보관하고 관찰 입력 반영 후 서버에 저장한다.
function mountFocusClock(userId) {
  const key = `pds-focus-clock-v1:${userId}`;
  const panel = h('section', {class:'page'}, h('h2',{},'오늘의 집중 스톱워치'));
  const time = h('p',{class:'focus-clock-time'},'00:00:00');
  const message = h('p',{'role':'status'},'작업할 때 시작하고, 쉬는 동안 일시정지하세요.');
  const estimate = h('input',{type:'number',min:0,max:1440,step:1,value:0,'aria-label':'오늘 이미 작업한 추정 시간(분)'});
  const start = h('button',{type:'button',class:'btn primary'},'시작 / 이어하기');
  const pause = h('button',{type:'button',class:'btn'},'일시정지');
  const apply = h('button',{type:'button',class:'btn'},'오늘 관찰값에 반영');
  const saveEstimate = h('button',{type:'button',class:'btn'},'추정 시간 저장');
  const total = h('p',{});
  panel.append(time,h('div',{class:'actions'},start,pause,apply),message,
    h('details',{},h('summary',{},'타이머 시작 전에 한 작업 추가'),h('p',{},'휴식을 뺀 추정 시간만 입력하세요. 타이머로 잰 구간과 중복하지 마세요.'),estimate,' 분 ',saveEstimate),total,
    h('p',{},'같은 브라우저·계정에서 새로고침 후 이어집니다. 다른 기기와 동기화되지 않아요. 실행 중 탭을 닫아도 시간은 흐르므로 자리를 비울 때 멈춰주세요. 서울 자정에는 전날 측정을 종료합니다. 리추얼을 제외한다면 끝난 뒤 시작하세요.'));
  $('#observationPanel').before(panel);
  let current, storageOK=true;
  function read() {
    try {const raw=JSON.parse(localStorage.getItem(key)||'{}');return raw&&typeof raw==='object'?raw:{};}
    catch {storageOK=false;message.textContent='브라우저 저장을 사용할 수 없어 타이머를 시작할 수 없습니다.';return {};}
  }
  function write(data) {try{localStorage.setItem(key,JSON.stringify(data));}catch{storageOK=false;throw new Error('시간을 저장하지 못했습니다. 브라우저 저장 설정을 확인하세요.');}}
  function load() {
    const all=read(), day=todayKst();
    for(const [date,r] of Object.entries(all)) if(date!==day&&r.started) {
      const end=Date.parse(date+'T00:00:00+09:00')+86400000;
      r.ms+=Math.max(0,end-r.started);r.started=null;write(all);
    }
    current=all[day]||{ms:0,started:null,estimate:0};return {all,day};
  }
  const elapsed=()=>current.ms+(current.started?Math.max(0,Date.now()-current.started):0);
  function render() {
    try {load();const seconds=Math.floor(elapsed()/1000);
      time.textContent=[Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0')).join(':');
      start.disabled=!storageOK||!!current.started;pause.disabled=!storageOK||!current.started;
      total.textContent=`${todayKst()} · 측정 ${Math.floor(seconds/60)}분 ${seconds%60}초 + 추정 ${current.estimate}분 = 관찰 반영 ${Math.floor(seconds/60)+current.estimate}분 (초는 버림)`;
    }catch(err){message.textContent=err.message;start.disabled=true;pause.disabled=true;}
  }
  async function change(fn) {
    try {
      const auth=await api('/api/auth');if(auth.user.id!==userId){location.reload();return;}
      const run=()=>{const {all,day}=load();fn();all[day]=current;write(all);render();};
      if(navigator.locks) await navigator.locks.request(key,run);else run();
    }catch(err){message.textContent=err.message;}
  }
  start.onclick=()=>change(()=>{if(!current.started)current.started=Date.now();message.textContent='집중 시간을 측정하고 있어요.';});
  pause.onclick=()=>change(()=>{current.ms=elapsed();current.started=null;message.textContent='일시정지했어요. 쉬는 시간은 더해지지 않습니다.';});
  saveEstimate.onclick=()=>change(()=>{const n=Number(estimate.value);if(!Number.isInteger(n)||n<0||n>1440)throw new Error('추정 시간은 0~1440분의 정수로 입력하세요.');current.estimate=n;message.textContent='추정 시간을 따로 저장했어요.';});
  apply.onclick=()=>change(()=>{
    const value=$('#observationContent input[name="value"]'),note=$('#observationContent textarea[name="note"]');
    if(!value||!note)throw new Error('오늘 입력할 관찰 칸이 없습니다. 이미 저장했거나 규칙 변경이 필요한지 확인하세요.');
    const unit=$('#observationContent input[name="unit"]');
    if((unit?unit.value.trim():$('#observationContent').dataset.unit)!=='분')throw new Error('분 단위 관찰에서 사용할 수 있습니다.');
    if(value.value&&!confirm('입력해 둔 관찰값을 오늘 집중 시간으로 바꿀까요?'))return;
    current.ms=elapsed();current.started=null;
    const minutes=Math.floor(current.ms/60000),line=`[집중 시간] 측정 ${minutes}분 ${Math.floor(current.ms/1000)%60}초(초 버림), 추정 ${current.estimate}분. 휴식 제외. 합계 ${minutes+current.estimate}분.`;
    value.value=String(minutes+current.estimate);
    note.value=note.value.split('\n').filter(x=>!x.startsWith('[집중 시간]')).concat(line).join('\n').trim();
    message.textContent='타이머를 멈추고 입력 칸에 반영했어요. 실제로 한 일을 덧붙인 뒤 관찰 저장을 눌러주세요.';
  });
  render();estimate.value=current?.estimate||0;setInterval(render,1000);
  $('#logoutBtn').addEventListener('click',()=>{try{const {all,day}=load();current.ms=elapsed();current.started=null;all[day]=current;write(all);}catch{}},true);
}
