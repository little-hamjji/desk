/**
 * 햄찌스 데스크 — 노션·구글 캘린더 중간 서버 (Google Apps Script 웹 앱)
 *
 * 대시보드(little-hamjji.github.io/desk)는 이 주소로만 데이터를 주고받습니다.
 * 노션 키는 여기 「스크립트 속성」에만 저장되고, 페이지나 GitHub에는 올라가지 않습니다.
 *
 * 설정(처음 1번)
 *   1) 프로젝트 설정 ⚙ → 스크립트 속성 추가
 *        NOTION_TOKEN = 노션 연동 키(ntn_… 또는 secret_…)
 *        PASS         = 대시보드 비밀번호(대표님이 정하는 값)
 *   2) 배포 → 새 배포 → 유형: 웹 앱 / 실행: 나 / 액세스: 모든 사용자 → 배포
 *   3) 나온 웹 앱 URL(…/exec)을 대시보드 첫 화면에 붙여넣기
 */

const DB = {
  tasks: 'c7014489707248d889238a4165a4dc8d', // 할 일
  att:   'b0794766c61842caa2c6513d5cd7b6bf', // 근태·야근 기록
  month: 'f2cbbc4c34b944988b6de91a047f1c18', // 월별 야근·수당
  leave: '0d7c2dbd7d9544738d9adfac279edb3e', // 연차 현황
  habit: '8bbb5b4ba81444c8865aa5656e505a2d', // 습관
  memo:  'd4e886a08e0b4b32a2e92b4b1e846e94', // 메모
  job:   'd242f23db7cd4f329a4f0cd84e1ef84e', // 이직 준비
};
const NV = '2022-06-28';
const TZ = 'Asia/Seoul';

/* ───────── 입구 ───────── */
function doGet() {
  return out({ ok: true, hello: '햄찌스 데스크 서버가 켜져 있습니다' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: '요청 형식이 잘못되었습니다' }); }
  const gate = checkPass(req.pass);
  if (gate) return out({ ok: false, error: gate, auth: true });
  try {
    const fn = ACTIONS[req.action];
    if (!fn) return out({ ok: false, error: '알 수 없는 동작: ' + req.action });
    return out({ ok: true, data: fn(req.args || {}) });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  }
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// 비밀번호 확인 + 10분에 10번 틀리면 잠깐 잠금
function checkPass(pass) {
  const P = PropertiesService.getScriptProperties();
  const real = P.getProperty('PASS');
  if (!real) return '서버에 PASS(비밀번호)가 설정되지 않았습니다';
  if (!P.getProperty('NOTION_TOKEN')) return '서버에 NOTION_TOKEN이 설정되지 않았습니다';
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('fails') || 0);
  if (fails >= 10) return '비밀번호를 여러 번 틀려 10분 동안 잠겼습니다';
  if (String(pass || '') !== real) { cache.put('fails', String(fails + 1), 600); return '비밀번호가 맞지 않습니다'; }
  return null;
}

/* ───────── 노션 호출 ───────── */
function nreq(path, method, body) {
  const r = {
    url: 'https://api.notion.com/v1/' + path,
    method: method || 'get',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN'), 'Notion-Version': NV },
    muteHttpExceptions: true,
  };
  if (body) r.payload = JSON.stringify(body);
  return r;
}
function parse(res) {
  const code = res.getResponseCode(), j = JSON.parse(res.getContentText() || '{}');
  if (code >= 300) throw new Error('노션 ' + code + ': ' + (j.message || '응답 오류'));
  return j;
}
function notion(path, method, body) { const r = nreq(path, method, body); return parse(UrlFetchApp.fetch(r.url, r)); }

// 여러 DB를 한 번에(병렬) 조회. 100건 넘으면 이어서 받음
function queryMany(specs) {
  const results = specs.map(() => []);
  let pending = specs.map((s, i) => ({ i, s, cursor: null }));
  while (pending.length) {
    const reqs = pending.map(p => nreq('databases/' + p.s.db + '/query', 'post',
      Object.assign({ page_size: 100 }, p.s.body || {}, p.cursor ? { start_cursor: p.cursor } : {})));
    const resps = UrlFetchApp.fetchAll(reqs);
    const next = [];
    resps.forEach((r, k) => {
      const j = parse(r), p = pending[k];
      results[p.i].push.apply(results[p.i], j.results);
      if (j.has_more && results[p.i].length < 600) next.push({ i: p.i, s: p.s, cursor: j.next_cursor });
    });
    pending = next;
  }
  return results;
}

// 노션 속성값 → 평범한 값
function pv(p) {
  if (!p) return null;
  switch (p.type) {
    case 'title': case 'rich_text': return p[p.type].map(x => x.plain_text).join('');
    case 'select': return p.select ? p.select.name : null;
    case 'status': return p.status ? p.status.name : null;
    case 'date': return p.date ? p.date.start : null;
    case 'checkbox': return p.checkbox;
    case 'number': return p.number;
    case 'url': return p.url;
    case 'created_time': return p.created_time;
    case 'formula': { const f = p.formula; return f[f.type]; }
    case 'rollup': { const r = p.rollup; return r.type === 'number' ? r.number : r.type === 'date' ? (r.date && r.date.start) : (r.array || []).length; }
    case 'relation': return p.relation.map(x => x.id);
  }
  return null;
}

// 평범한 값 → 노션 속성값
const W = {
  title: v => ({ title: [{ text: { content: String(v || '').slice(0, 1900) } }] }),
  text: v => ({ rich_text: chunks(String(v || '')) }),
  select: v => ({ select: v ? { name: v } : null }),
  status: v => ({ status: { name: v } }),
  date: v => ({ date: v ? { start: v } : null }),
  check: v => ({ checkbox: !!v }),
  num: v => ({ number: v === null || v === '' || v === undefined ? null : Number(v) }),
  url: v => ({ url: v || null }),
  rel: v => ({ relation: (v || []).map(id => ({ id })) }),
};
function chunks(s) { const a = []; for (let i = 0; i < s.length; i += 1900) a.push({ text: { content: s.slice(i, i + 1900) } }); return a; }

// 대시보드 필드 이름 ↔ 노션 속성 이름
const MAP = {
  tasks: { t: ['업무내용', 'title'], s: ['상태', 'status'], d: ['날짜', 'date'], p: ['프로젝트', 'select'], y: ['업무 유형', 'select'],
           r: ['우선순위', 'select'], c: ['분류', 'select'], star: ['⭐ 포트폴리오', 'check'], detail: ['세부 업무', 'text'], note: ['비고', 'text'], out: ['성과·산출물', 'text'] },
  habit: { n: ['습관', 'title'], i: ['아이콘', 'text'], o: ['순서', 'num'], on: ['사용', 'check'], g: ['주간 목표', 'num'], dates: ['체크 날짜', 'text'] },
  memo:  { t: ['내용', 'title'], k: ['종류', 'select'], pin: ['고정', 'check'], st: ['상태', 'select'], at: ['작성', null] },
  job:   { n: ['지원처', 'title'], role: ['직무', 'text'], st: ['단계', 'select'], d: ['마감', 'date'], link: ['링크', 'url'], memo: ['메모', 'text'] },
  att:   { t: ['내용', 'title'], type: ['유형', 'select'], d: ['날짜', 'date'], w15: ['평일 연장(1.5배)', 'num'], w2: ['평일 야간(2배)', 'num'],
           h15: ['휴일근로(1.5배)', 'num'], h2: ['휴일연장(2배)', 'num'], h25: ['휴일야간(2.5배)', 'num'], days: ['휴가 일수', 'num'],
           reason: ['야근사유', 'text'], bonus: ['할증 시간', null], month: ['월', 'rel'], year: ['연도', 'rel'] },
  month: { m: ['월', 'title'], rate: ['시급', 'num'], carry: ['전월 이월', 'num'], sub: ['대체 휴가', 'num'], total: ['총 시간', null], pay: ['수당', null],
           bonus: ['할증 누계', null], used: ['휴가 사용(일)', null] },
  leave: { y: ['연도', 'title'], total: ['총 연차', 'num'], special: ['총 특별휴가', 'num'], used: ['사용 일수', null], left: ['남은 일수', null] },
};
function read(kind, page) {
  const o = { id: page.id, u: page.url };
  const m = MAP[kind];
  for (const k in m) o[k] = pv(page.properties[m[k][0]]);
  return o;
}
function props(kind, fields) {
  const m = MAP[kind], P = {};
  for (const k in fields) { if (!m[k] || !m[k][1]) continue; P[m[k][0]] = W[m[k][1]](fields[k]); }
  return P;
}

/* ───────── 날짜 ───────── */
function ymd(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function addDays(s, n) { const d = new Date(s + 'T00:00:00+09:00'); d.setDate(d.getDate() + n); return ymd(d); }

/* ───────── 구글 캘린더 ───────── */
function calendarEvents(from, to) {
  const start = new Date(from + 'T00:00:00+09:00'), end = new Date(to + 'T23:59:59+09:00');
  const out = [];
  CalendarApp.getAllCalendars().forEach(cal => {
    if (cal.isHidden && cal.isHidden()) return;
    let evs = [];
    try { evs = cal.getEvents(start, end); } catch (e) { return; }
    evs.forEach(ev => out.push({
      id: ev.getId(), t: ev.getTitle(), all: ev.isAllDayEvent(),
      s: ev.isAllDayEvent() ? ymd(ev.getAllDayStartDate()) : ev.getStartTime().toISOString(),
      e: ev.isAllDayEvent() ? ymd(new Date(ev.getAllDayEndDate().getTime() - 1)) : ev.getEndTime().toISOString(),
      cal: cal.getName(), color: cal.getColor(), loc: ev.getLocation() || '',
    }));
  });
  return out.sort((a, b) => a.s < b.s ? -1 : 1);
}

/* ───────── 동작 ───────── */
const ACTIONS = {
  load() {
    const today = ymd(new Date());
    const since = addDays(today, -60);
    const [tasks, att, months, leave, habits, memos, jobs] = queryMany([
      { db: DB.tasks, body: { filter: { or: [
        { property: '상태', status: { does_not_equal: '완료' } },
        { property: '날짜', date: { on_or_after: since } },
        { property: '⭐ 포트폴리오', checkbox: { equals: true } },
      ] }, sorts: [{ property: '날짜', direction: 'ascending' }] } },
      { db: DB.att, body: { filter: { property: '날짜', date: { on_or_after: addDays(today, -400) } }, sorts: [{ property: '날짜', direction: 'descending' }] } },
      { db: DB.month },
      { db: DB.leave },
      { db: DB.habit },
      { db: DB.memo, body: { filter: { property: '상태', select: { does_not_equal: '옮김' } }, sorts: [{ timestamp: 'created_time', direction: 'descending' }] } },
      { db: DB.job },
    ]);
    let events = [], calError = null;
    try { events = calendarEvents(addDays(today, -14), addDays(today, 60)); } catch (e) { calError = String(e.message || e); }
    return {
      today, at: new Date().toISOString(), calError,
      tasks: tasks.map(p => read('tasks', p)),
      att: att.map(p => read('att', p)),
      months: months.map(p => read('month', p)).sort((a, b) => (b.m || '').localeCompare(a.m || '')),
      leave: leave.map(p => read('leave', p)).sort((a, b) => (b.y || '').localeCompare(a.y || '')),
      habits: habits.map(p => read('habit', p)).sort((a, b) => (a.o || 99) - (b.o || 99)),
      memos: memos.map(p => read('memo', p)),
      jobs: jobs.map(p => read('job', p)),
      events,
    };
  },

  // 공통: 추가·수정·휴지통
  add({ kind, fields }) {
    if (!DB[kind] || kind === 'month' || kind === 'leave') throw new Error('추가할 수 없는 종류입니다');
    if (kind === 'att') fields = linkAttendance(fields);
    const page = notion('pages', 'post', { parent: { database_id: DB[kind] }, properties: props(kind, fields) });
    return read(kind, page);
  },
  update({ kind, id, fields }) {
    if (!MAP[kind]) throw new Error('알 수 없는 종류입니다');
    if (kind === 'att') fields = linkAttendance(fields);
    const page = notion('pages/' + id, 'patch', { properties: props(kind, fields) });
    return read(kind, page);
  },
  trash({ kind, id }) {
    if (!['tasks', 'memo', 'job', 'habit', 'att'].includes(kind)) throw new Error('지울 수 없는 종류입니다');
    notion('pages/' + id, 'patch', { archived: true }); // 노션 휴지통으로(30일 안에 복구 가능)
    return { id };
  },

  // 습관 체크/해제 — 동시에 눌러도 꼬이지 않게 잠금
  habitToggle({ id, date }) {
    const lock = LockService.getScriptLock(); lock.waitLock(8000);
    try {
      const cur = read('habit', notion('pages/' + id));
      const set = new Set(String(cur.dates || '').split(',').map(s => s.trim()).filter(Boolean));
      set.has(date) ? set.delete(date) : set.add(date);
      const keep = Array.from(set).sort().filter(d => d >= addDays(ymd(new Date()), -400));
      return read('habit', notion('pages/' + id, 'patch', { properties: props('habit', { dates: keep.join(',') }) }));
    } finally { lock.releaseLock(); }
  },

  // 메모 → 할 일
  memoToTask({ id, text, date }) {
    const t = ACTIONS.add({ kind: 'tasks', fields: { t: text, d: date || null, s: '시작 전' } });
    notion('pages/' + id, 'patch', { properties: props('memo', { st: '옮김' }) });
    return t;
  },

  // 구글 캘린더 일정 추가
  eventAdd({ title, date, start, end }) {
    const cal = CalendarApp.getDefaultCalendar();
    if (!start) cal.createAllDayEvent(title, new Date(date + 'T00:00:00+09:00'));
    else cal.createEvent(title, new Date(date + 'T' + start + ':00+09:00'), new Date(date + 'T' + (end || start) + ':00+09:00'));
    return { ok: true };
  },
};

// 근태 기록에 「월」「연도」 연결을 자동으로 붙임(월 표 제목 예: 2026.11, 연차 표 제목 예: 2026)
function linkAttendance(fields) {
  if (!fields.d) return fields;
  const y = fields.d.slice(0, 4), m = fields.d.slice(5, 7);
  const [months, years] = queryMany([{ db: DB.month }, { db: DB.leave }]);
  const norm = s => String(s || '').replace(/[^0-9]/g, '');
  const mp = months.find(p => { const n = norm(pv(p.properties['월'])); return n === y + m || n === y + String(Number(m)); });
  const yp = years.find(p => norm(pv(p.properties['연도'])).indexOf(y) === 0);
  const f = Object.assign({}, fields);
  if (mp) f.month = [mp.id];
  if (yp && ['연차', '반차', '특별휴가'].includes(f.type)) f.year = [yp.id];
  if (!f.t) f.t = f.type + ' ' + f.d.slice(5).replace('-', '/');
  return f;
}

// 편집기에서 ▶ 실행해 보면 연결 상태를 확인할 수 있습니다(로그에 건수 표시)
function testConnection() {
  const d = ACTIONS.load();
  Logger.log('할 일 %s건 · 일정 %s건 · 습관 %s개 · 메모 %s건 · 이직 %s건 · 근태 %s건%s',
    d.tasks.length, d.events.length, d.habits.length, d.memos.length, d.jobs.length, d.att.length, d.calError ? ' · 캘린더 오류: ' + d.calError : '');
}
