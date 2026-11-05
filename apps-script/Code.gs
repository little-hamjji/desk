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
  gong:  '0b31df1ebf6f43e9b33e56ac9988f1de', // 공문 대장
  tasks: 'c7014489707248d889238a4165a4dc8d', // 할 일
  att:   'b0794766c61842caa2c6513d5cd7b6bf', // 근태·야근 기록
  month: 'f2cbbc4c34b944988b6de91a047f1c18', // 월별 야근·수당
  leave: '0d7c2dbd7d9544738d9adfac279edb3e', // 연차 현황
  habit: '8bbb5b4ba81444c8865aa5656e505a2d', // 습관
  memo:  'd4e886a08e0b4b32a2e92b4b1e846e94', // 메모
  job:   'd242f23db7cd4f329a4f0cd84e1ef84e', // 이직 준비
  log:   'b5d849ec6f384340a436e579b21216f5', // 햄꾼 일일 업무일지
  sorry: '811a235fff054bf388139f6685f0b5f4', // 햄꾼 시말서
  jplog: 'b09a05363d15437cbf02ef0030a0e11b', // 지피리 일일 업무일지
  jpsorry: '678f0d66b2314290a7183528249e4202', // 지피리 시말서
  news:  '98b92fcd3e3945ee8a935ba09a06f6a1', // 이슈 팔로잉 아카이브(매일 뉴스 브리핑 메일)
  appr:  '6e0e599bc9b2409f9cbe09110028df29', // 이카운트 결재현황
  cash:  '538ee6b62ed74a47b12afbc6396d0cd6', // 출납부 미작성 지결
  bank:  '656b3c146e6c4850b76ef6e0f9301bcd', // 통장 검수
  pay:   'adb31cb4bdb44afabcc0bba517301fef', // 급여 현황
  staff: '2668397c44f04260839b1c84eb51987d', // 직원 상태
  doc:   'ee0e7d3d318c46b791449950c8325c67', // 지원 서류
  reply: '4da591057288497a8410fa10c7411c5f', // 회신 요청(데스크 → PC 회신 도우미)
};
// 회사 계정(chlee@hamkke.org)에는 NOTION_TOKEN 없이 PASS만 넣고 배포 → 메일·캘린더만 담당
const NV = '2022-06-28';
const VERSION = '2026-11-05c'; // 대시보드 「원인 확인」에 표시
// 스캔본을 PC 폴더(개인 드라이브 G:\내 드라이브\CLUDE\클로드 작업물(회사컴)\스캔본\월)로 보관
const SCAN_DIR = ['CLUDE', '클로드 작업물(회사컴)', '스캔본'];
const SCAN_FROM = 'ascan@sindate.cafe24.com'; // 회사 복합기 스캔 메일
const SCAN_LABEL = '데스크/스캔처리';
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
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('fails') || 0);
  if (fails >= 10) return '비밀번호를 여러 번 틀려 10분 동안 잠겼습니다';
  if (String(pass || '') !== real) { cache.put('fails', String(fails + 1), 600); return '비밀번호가 맞지 않습니다'; }
  if (fails) cache.remove('fails'); // 맞게 넣으면 틀린 횟수 초기화
  return null;
}

/* ───────── 회신 ───────── */
// 답장 대상: 내가 보낸 메일이 아닌 마지막 메일
function replyTarget(th) {
  const me = Session.getEffectiveUser().getEmail(), msgs = th.getMessages();
  return msgs.slice().reverse().find(m => m.getFrom().indexOf(me) < 0) || msgs[msgs.length - 1];
}
function replyRows(filter) {
  const [rows] = queryMany([{ db: DB.reply, body: { filter, sorts: [{ timestamp: 'created_time', direction: 'descending' }] }, max: 30 }]);
  return rows.map(p => read('reply', p));
}
function replyView(r) {
  const at = PropertiesService.getScriptProperties().getProperty('relayAt');
  return { job: r, pcOn: !!at && Date.now() - new Date(at).getTime() < 2 * 60e3 };
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

const WARN = []; // 연결 안 된 페이지 등 일부만 실패한 경우
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
      const p = pending[k];
      let j;
      try { j = parse(r); } catch (e) { if (!p.s.opt) throw e; WARN.push(p.s.opt + ': ' + e.message); return; }
      results[p.i].push.apply(results[p.i], j.results);
      if (j.has_more && results[p.i].length < (p.s.max || 600)) next.push({ i: p.i, s: p.s, cursor: j.next_cursor });
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
    case 'multi_select': return p.multi_select.map(x => x.name);
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
  gong: { t: ['제목', 'title'], k: ['키', 'text'], no: ['시행번호', 'text'], d: ['시행일', 'date'], to: ['수신', 'text'], att: ['붙임', 'text'], files: ['파일', 'text'], warn: ['확인', 'text'], link: ['링크', 'url'], at: ['수정일', 'date'], st: ['상태', 'select'] },
  tasks: { t: ['업무내용', 'title'], s: ['상태', 'status'], d: ['날짜', 'date'], p: ['프로젝트', 'select'], y: ['업무 유형', 'select'],
           r: ['우선순위', 'select'], c: ['분류', 'select'], star: ['⭐ 포트폴리오', 'check'], detail: ['세부 업무', 'text'], note: ['비고', 'text'], out: ['성과·산출물', 'text'] },
  habit: { n: ['습관', 'title'], i: ['아이콘', 'text'], o: ['순서', 'num'], on: ['사용', 'check'], g: ['주간 목표', 'num'], dates: ['체크 날짜', 'text'] },
  memo:  { t: ['내용', 'title'], k: ['종류', 'select'], pin: ['고정', 'check'], st: ['상태', 'select'], at: ['작성', null] },
  job:   { n: ['지원처', 'title'], role: ['직무', 'text'], st: ['단계', 'select'], d: ['마감', 'date'], link: ['링크', 'url'], memo: ['메모', 'text'], chk: ['진행 체크', 'text'], post: ['공고 내용', 'text'] },
  att:   { t: ['내용', 'title'], type: ['유형', 'select'], d: ['날짜', 'date'], w15: ['평일 연장(1.5배)', 'num'], w2: ['평일 야간(2배)', 'num'],
           h15: ['휴일근로(1.5배)', 'num'], h2: ['휴일연장(2배)', 'num'], h25: ['휴일야간(2.5배)', 'num'], days: ['휴가 일수', 'num'],
           reason: ['야근사유', 'text'], bonus: ['할증 시간', null], month: ['월', 'rel'], year: ['연도', 'rel'] },
  month: { m: ['월', 'title'], rate: ['시급', 'num'], carry: ['전월 이월', 'num'], sub: ['대체 휴가', 'num'], total: ['총 시간', null], pay: ['수당', null],
           bonus: ['할증 누계', null], used: ['휴가 사용(일)', null] },
  leave: { y: ['연도', 'title'], total: ['총 연차', 'num'], special: ['총 특별휴가', 'num'], used: ['사용 일수', null], left: ['남은 일수', null] },
  log:   { t: ['제목', 'title'], d: ['날짜', 'date'], kind: ['근무구분', 'select'], hours: ['근무시간', 'text'], sum: ['한 줄 요약', 'text'],
           ev: ['대표님 평가', 'select'], sorry: ['시말서 제출', 'check'] },
  sorry: { t: ['제목', 'title'], d: ['날짜', 'date'], cat: ['분류', 'select'], sev: ['심각도', 'select'], sum: ['사건 요약', 'text'],
           fix: ['재발 방지책', 'text'], st: ['처리상태', 'select'] },
  news:  { t: ['제목', 'title'], d: ['날짜', null], got: ['수집일', null], src: ['매체', null], kind: ['구분', null],
           rules: ['관련 원칙', null], issue: ['이슈', null], link: ['원문 URL', null] },
  appr:  { t: ['제목', 'title'], no: ['기안번호', 'text'], st: ['진행상태', 'text'], steps: ['결재 단계', 'text'], amt: ['총액', 'text'],
           files: ['첨부', 'text'], detail: ['문서 내용', 'text'],
           who: ['구분', 'select'], drafter: ['기안자', 'text'], label: ['라벨', 'text'], use: ['출납부 후보', 'check'] },
  cash:  { t: ['내역', 'title'], key: ['묶음키', 'text'], sum: ['금액', 'num'], n: ['줄 수', 'num'], from: ['시작일', 'date'], to: ['종료일', 'date'],
           vendors: ['거래처', 'text'], rows: ['출납부 행', 'text'] },
  pay:   { m: ['월', 'title'], d: ['지급일', 'date'], g: ['지급총액', 'num'], ded: ['공제총액', 'num'], net: ['실수령액', 'num'],
    b: ['기본급여', 'num'], ot: ['연장근로수당', 'num'], ga: ['가계지원비', 'num'], fam: ['가족수당', 'num'], tr: ['교통비', 'num'], lu: ['중식보조비', 'num'], etc: ['기타 지급', 'num'], etcN: ['기타 지급 내역', null],
    tax: ['소득세', 'num'], loc: ['주민세', 'num'], np: ['국민연금', 'num'], hi: ['건강보험', 'num'], lt: ['장기요양', 'num'], ei: ['고용보험', 'num'], cl: ['사우회비', 'num'], ye: ['연말정산', 'num'] },
  staff: { n: ['직원', 'title'], st: ['근무', 'select'], left: ['남은 사용량', 'num'], ver: ['버전', 'text'], at: ['확인 시각', 'text'] },
  reply: { t: ['제목', 'title'], st: ['상태', 'select'], mid: ['메일ID', 'text'], src: ['계정', 'select'], from: ['보낸이', 'text'], ask: ['지시', 'text'],
           body: ['회신', 'text'], cc: ['참조', 'text'], rev: ['검수', 'text'], err: ['오류', 'text'], at: ['요청 시각', 'text'] },
  doc:   { t: ['서류', 'title'], job: ['지원처', 'rel'], kind: ['종류', 'select'], st: ['상태', 'select'], lim: ['글자 제한', 'num'], o: ['순서', 'num'],
           body: ['내용', 'text'], memo: ['메모', 'text'], file: ['파일', 'text'] },
  bank:  { t: ['거래', 'title'], k: ['키', 'text'], d: ['거래일', 'date'], out: ['지급', 'num'], in: ['입금', 'num'], bal: ['잔액', 'num'], chk: ['검수', 'select'],
           flags: ['확인 사항', 'text'], led: ['출납부', 'text'], ap: ['지결', 'text'], j: ['연결', 'text'] },
};
const hasNotion = () => !!PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
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
    const base = { today, at: new Date().toISOString(), account: Session.getEffectiveUser().getEmail(), notion: hasNotion() };
    let events = [], calError = null, mail = null, mailError = null;
    try { events = calendarEvents(addDays(today, -45), addDays(today, 90)); } catch (e) { calError = String(e.message || e); }
    try { mail = mailList(); } catch (e) { mailError = String(e.message || e); }
    let scans = [];
    try { scans = scanList(); } catch (e) { base.scanError = String(e.message || e); }
    Object.assign(base, { events, calError, mail, mailError, scans, v: VERSION });
    if (!base.notion) return base; // 회사 계정: 메일·캘린더만
    return Object.assign(base, loadNotion(today));
  },

  // 연결 확인용
  // 오른쪽 직원 패널 1분 갱신용(전체 불러오기 없이)
  staffNow() { const [rows] = queryMany([{ db: DB.staff }]); return rows.map(p => read('staff', p)); },
  ping() { return { account: Session.getEffectiveUser().getEmail(), notion: hasNotion(), v: VERSION }; },

  // 스캔 메일 첨부 내려받기(대시보드에서 바로 저장)
  scanFile({ id, i }) {
    const m = GmailApp.getMessageById(id);
    if (!m) throw new Error('스캔 메일을 찾지 못했습니다');
    const a = m.getAttachments({ includeInlineImages: false })[i];
    if (!a) throw new Error('첨부 파일을 찾지 못했습니다');
    if (a.getSize() > 30e6) throw new Error('30MB가 넘는 파일은 Gmail에서 직접 받아 주세요');
    return { name: a.getName(), type: a.getContentType(), b64: Utilities.base64Encode(a.getBytes()) };
  },
  // 스캔 처리 표시(Gmail 라벨 「데스크/스캔처리」)
  scanDone({ th, on }) {
    const label = GmailApp.getUserLabelByName(SCAN_LABEL) || GmailApp.createLabel(SCAN_LABEL);
    const t = GmailApp.getThreadById(th);
    if (!t) throw new Error('스캔 메일을 찾지 못했습니다');
    on ? t.addLabel(label) : t.removeLabel(label);
    return { th, on };
  },
  // 답장 초안을 Gmail 임시보관함에 저장(보내기는 대표님이 Gmail에서)
  draftReply({ id, body, cc }) {
    const th = GmailApp.getThreadById(id);
    if (!th) throw new Error('메일을 찾지 못했습니다');
    const d = replyTarget(th).createDraftReply(String(body || ''), cc ? { cc: String(cc) } : {});
    return { draft: d.getId(), cc: cc || '' };
  },

  // 회신 채우기: 데스크가 요청을 넣고, PC 회신 도우미가 처리해 결과를 돌려준다(발송은 대표님만)
  replyRequest({ id, src, subj, from, ask }) {
    const cur = replyRows({ property: '메일ID', rich_text: { equals: String(id) } })[0];
    if (cur && (cur.st === '대기' || cur.st === '작성 중') && Date.now() - new Date(cur.at).getTime() < 10 * 60e3) return replyView(cur);
    const at = new Date().toISOString();
    const page = notion('pages', 'post', { parent: { database_id: DB.reply }, properties: props('reply',
      { t: subj || '(제목 없음)', st: '대기', mid: id, src: src === 'work' ? '회사' : '개인', from, ask, at }) });
    return replyView(read('reply', page));
  },
  replyStatus({ id }) { return replyView(replyRows({ property: '메일ID', rich_text: { equals: String(id) } })[0] || null); },
  // PC 회신 도우미 전용: 대기 목록과 직원 상태. 부를 때마다 PC가 켜져 있다고 기록
  replyPending() {
    PropertiesService.getScriptProperties().setProperty('relayAt', new Date().toISOString());
    const [staff] = queryMany([{ db: DB.staff }]);
    return { jobs: replyRows({ property: '상태', select: { equals: '대기' } }).reverse(), staff: staff.map(p => read('staff', p)) };
  },
  // 여러 PC가 돌아도 한 곳만 맡도록 잠그고 대기 → 작성 중으로 바꾼다
  replyClaim({ rid }) {
    const L = LockService.getScriptLock();
    L.waitLock(20000);
    try {
      if (read('reply', notion('pages/' + rid, 'get')).st !== '대기') return { ok: false };
      notion('pages/' + rid, 'patch', { properties: props('reply', { st: '작성 중' }) });
      return { ok: true };
    } finally { L.releaseLock(); }
  },
  replyUpdate({ rid, fields }) {
    const allow = {}; ['st', 'body', 'cc', 'rev', 'err'].forEach(k => { if (fields && k in fields) allow[k] = fields[k]; });
    return read('reply', notion('pages/' + rid, 'patch', { properties: props('reply', allow) }));
  },

  // 스캔본 PC 보관(개인 계정 서버에서 실행): 회사 서버에서 받은 파일을 드라이브 폴더에 저장, 같은 파일은 한 번만
  saveScan({ id, i, name, at, type, b64 }) {
    const P = PropertiesService.getScriptProperties(), key = 'scan:' + id + ':' + i, had = P.getProperty(key);
    if (had) { try { DriveApp.getFileById(had); return { key, file: had, dup: true }; } catch (e) {} }
    const day = String(at || '').slice(0, 10) || Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
    let f = DriveApp.getRootFolder();
    SCAN_DIR.concat([day.slice(0, 7)]).forEach(n => { const it = f.getFoldersByName(n); f = it.hasNext() ? it.next() : f.createFolder(n); });
    const file = f.createFile(Utilities.newBlob(Utilities.base64Decode(b64), type || 'application/pdf', day + '_' + name));
    file.setDescription('회사 메일 스캔 ' + key);
    P.setProperty(key, file.getId());
    return { key, file: file.getId(), path: SCAN_DIR.join('/') + '/' + day.slice(0, 7) + '/' + day + '_' + name };
  },
  scanSavedKeys() { return Object.keys(PropertiesService.getScriptProperties().getProperties()).filter(k => k.indexOf('scan:') === 0); },

  // 포트폴리오: 완료 업무 전체(3월~)
  history() {
    const [rows] = queryMany([{ db: DB.tasks, body: { filter: { property: '상태', status: { equals: '완료' } }, sorts: [{ property: '날짜', direction: 'ascending' }] }, max: 2000 }]);
    return rows.map(p => { const o = read('tasks', p); return { id: o.id, t: o.t, d: o.d, p: o.p, y: o.y, r: o.r, out: o.out, star: o.star, s: o.s }; });
  },

  // 답장 바로 보내기(대표님이 대시보드에서 직접 누를 때만)
  sendReply({ id, body, cc }) {
    const th = GmailApp.getThreadById(id);
    if (!th) throw new Error('메일을 찾지 못했습니다');
    const target = replyTarget(th);
    target.reply(String(body || ''), cc ? { cc: String(cc) } : {});
    return { to: target.getFrom(), cc: cc || '' };
  },

  // 주식 시세(Yahoo Finance 공개 차트, 약 15~20분 지연)
  stocks({ syms, range }) {
    const R = { '1d': ['1d', '5m'], '5d': ['5d', '30m'], '1mo': ['1mo', '1d'], '6mo': ['6mo', '1d'], '1y': ['1y', '1wk'] }[range] || ['1mo', '1d'];
    const list = (syms || []).slice(0, 12);
    const reqs = list.map(sym => ({ url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=' + R[0] + '&interval=' + R[1],
      muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } }));
    return UrlFetchApp.fetchAll(reqs).map((r, k) => {
      try {
        const j = JSON.parse(r.getContentText()).chart.result[0], m = j.meta, q = j.indicators.quote[0];
        const pts = (j.timestamp || []).map((t, i) => q.close[i]).filter(v => v != null).map(v => Math.round(v * 100) / 100);
        return { sym: list[k], name: m.shortName || m.longName || list[k], cur: m.currency, price: m.regularMarketPrice,
          prev: m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose, pts, t: m.regularMarketTime };
      } catch (e) { return { sym: list[k], error: '시세를 불러오지 못했습니다(코드 확인)' }; }
    });
  },

  // 메일: 읽음/안읽음/별표/보관
  mailAct({ id, op }) {
    const th = GmailApp.getThreadById(id);
    if (!th) throw new Error('메일을 찾지 못했습니다');
    if (op === 'read') th.markRead();
    else if (op === 'unread') th.markUnread();
    else if (op === 'archive') th.moveToArchive();
    else if (op === 'star') th.getMessages().slice(-1)[0].star();
    else if (op === 'unstar') th.getMessages().forEach(m => m.unstar());
    else throw new Error('알 수 없는 메일 동작');
    return { id, op };
  },
  // 공고 메일: 받은편지함 밖(라벨·보관)도 포함해 검색 조건으로 찾음. 개인 서버에서만 호출
  jobMail({ q }) {
    return GmailApp.search('newer_than:30d ' + (q || 'subject:(공고알림 OR 공고 OR 채용 OR NGO) -subject:입사지원서'), 0, 40).map(mailRow);
  },
  mailBody({ id }) {
    const th = GmailApp.getThreadById(id);
    if (!th) throw new Error('메일을 찾지 못했습니다');
    return th.getMessages().slice(-3).map(m => ({
      from: m.getFrom(), to: m.getTo(), cc: m.getCc(), date: m.getDate().toISOString(), subject: m.getSubject(),
      body: m.getPlainBody().replace(/\n{3,}/g, '\n\n').slice(0, 6000),
    }));
  },

  // 노션 페이지 본문(업무일지 등)을 글자로
  pageText({ id }) {
    const lines = [];
    let cursor = null;
    do {
      const j = notion('blocks/' + id + '/children?page_size=100' + (cursor ? '&start_cursor=' + cursor : ''));
      j.results.forEach(b => {
        const v = b[b.type] || {};
        const txt = (v.rich_text || []).map(x => x.plain_text).join('');
        const pre = { heading_1: '# ', heading_2: '## ', heading_3: '### ', bulleted_list_item: '• ', numbered_list_item: '• ', to_do: v.checked ? '☑ ' : '☐ ', quote: '│ ', callout: '💡 ' }[b.type] || '';
        if (b.type === 'divider') lines.push('───');
        else if (txt) lines.push(pre + txt);
      });
      cursor = j.has_more ? j.next_cursor : null;
    } while (cursor && lines.length < 400);
    return lines.join('\n');
  },

  // 유튜브(편집기 왼쪽 「서비스 +」에서 YouTube Data API v3를 추가해야 함)
  ytPlaylists() {
    yt();
    const r = YouTube.Playlists.list('snippet,contentDetails', { mine: true, maxResults: 50 });
    const out = [{ id: 'LL', n: '좋아요 표시한 동영상', count: null, thumb: null }];
    (r.items || []).forEach(p => out.push({ id: p.id, n: p.snippet.title, count: p.contentDetails.itemCount, thumb: thumbOf(p.snippet.thumbnails) }));
    return out;
  },
  ytItems({ list }) {
    yt();
    const r = YouTube.PlaylistItems.list('snippet', { playlistId: list, maxResults: 50 });
    return (r.items || []).map(i => ({ v: i.snippet.resourceId.videoId, n: i.snippet.title, ch: i.snippet.videoOwnerChannelTitle || '', thumb: thumbOf(i.snippet.thumbnails) }));
  },
  ytSearch({ q }) {
    yt();
    const r = YouTube.Search.list('snippet', { q, type: 'video', maxResults: 15, videoEmbeddable: 'true', regionCode: 'KR' });
    return (r.items || []).map(i => ({ v: i.id.videoId, n: i.snippet.title, ch: i.snippet.channelTitle, thumb: thumbOf(i.snippet.thumbnails) }));
  },
};
function yt() { if (typeof YouTube === 'undefined') throw new Error('Apps Script 편집기에서 「서비스 +」→ YouTube Data API v3를 추가해 주세요'); }
function thumbOf(t) { t = t || {}; return (t.medium || t.default || t.high || {}).url || null; }

// 받은편지함 최근 30개 대화
function mailList() {
  return GmailApp.search('in:inbox -from:' + SCAN_FROM, 0, 30).map(mailRow);
}
function mailRow(th) {
  const m = th.getMessages().slice(-1)[0];
  return { id: th.getId(), subj: th.getFirstMessageSubject() || '(제목 없음)', from: m.getFrom().replace(/<.*>/, '').replace(/"/g, '').trim() || m.getFrom(),
    at: th.getLastMessageDate().toISOString(), snip: m.getPlainBody().replace(/\s+/g, ' ').slice(0, 140),
    unread: th.isUnread(), star: th.hasStarredMessages(), imp: th.isImportant(), n: th.getMessageCount() };
}

// 스캔 메일(회사 복합기 → chlee@hamkke.org) 최근 120일
function scanList() {
  const label = GmailApp.getUserLabelByName(SCAN_LABEL);
  const done = new Set(label ? label.getThreads(0, 300).map(t => t.getId()) : []);
  const out = [];
  GmailApp.search('from:' + SCAN_FROM + ' newer_than:120d', 0, 40).forEach(th => {
    th.getMessages().forEach(m => {
      if (m.getFrom().indexOf(SCAN_FROM) < 0) return;
      const files = m.getAttachments({ includeInlineImages: false }).map((a, i) => ({ i, name: a.getName(), size: a.getSize(), type: a.getContentType() }));
      if (files.length) out.push({ id: m.getId(), th: th.getId(), at: m.getDate().toISOString(), subj: m.getSubject(), files, done: done.has(th.getId()) });
    });
  });
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

function loadNotion(today) {
    const since = addDays(today, -60);
    const [tasks, att, months, leave, habits, memos, jobs, logs, sorries, news, apprs, cashes, banks, jpLogs, jpSorries, docs, staffRows, pays, gongs] = queryMany([
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
      { db: DB.log, body: { page_size: 40, sorts: [{ property: '날짜', direction: 'descending' }] }, max: 40, opt: '햄꾼 업무일지' },
      { db: DB.sorry, body: { page_size: 30, sorts: [{ property: '날짜', direction: 'descending' }] }, max: 30, opt: '햄꾼 시말서' },
      { db: DB.news, body: { filter: { property: '수집일', date: { on_or_after: addDays(today, -45) } }, sorts: [{ property: '수집일', direction: 'descending' }] }, max: 400, opt: '뉴스 브리핑' },
      { db: DB.appr, opt: '이카운트 결재현황' },
      { db: DB.cash, opt: '출납부 미작성 지결' },
      { db: DB.bank, body: { filter: { property: '거래일', date: { on_or_after: addDays(today, -200) } } }, max: 1000, opt: '통장 검수' },
      { db: DB.jplog, body: { page_size: 40, sorts: [{ property: '날짜', direction: 'descending' }] }, max: 40, opt: '지피리 업무일지' },
      { db: DB.jpsorry, body: { page_size: 30, sorts: [{ property: '날짜', direction: 'descending' }] }, max: 30, opt: '지피리 시말서' },
      { db: DB.doc, max: 300, opt: '지원 서류' },
      { db: DB.staff, opt: '직원 상태' },
      { db: DB.pay, opt: '급여 현황' },
      { db: DB.gong, body: { sorts: [{ property: '수정일', direction: 'descending' }] }, max: 300, opt: '공문 대장' },
    ]);
    const okDb = n => !WARN.some(w => w.indexOf(n) === 0); // 못 읽은 표는 빈 표로 보내지 않음
    return {
      gongRows: okDb('공문 대장') ? gongs.slice(0, 300).map(p => read('gong', p)) : undefined,
      apprRows: okDb('이카운트 결재현황') ? apprs.map(p => read('appr', p)) : undefined,
      cashRows: okDb('출납부 미작성 지결') ? cashes.map(p => read('cash', p)) : undefined,
      bankRows: okDb('통장 검수') ? banks.map(p => read('bank', p)) : undefined,
      syncMeta: JSON.parse(PropertiesService.getScriptProperties().getProperty('syncMeta') || '{}'),
      logs: logs.map(p => read('log', p)),
      jpLogs: jpLogs.map(p => read('log', p)),
      jpSorries: jpSorries.map(p => read('sorry', p)),
      sorries: sorries.map(p => read('sorry', p)),
      news: news.map(p => read('news', p)),
      warn: WARN.slice(),
      tasks: tasks.map(p => read('tasks', p)),
      att: att.map(p => read('att', p)),
      months: months.map(p => read('month', p)).sort((a, b) => (b.m || '').localeCompare(a.m || '')),
      leave: leave.map(p => read('leave', p)).sort((a, b) => (b.y || '').localeCompare(a.y || '')),
      habits: habits.map(p => read('habit', p)).sort((a, b) => (a.o || 99) - (b.o || 99)),
      memos: memos.map(p => read('memo', p)),
      pays: okDb('급여 현황') ? pays.map(p => read('pay', p)) : undefined,
      staff: okDb('직원 상태') ? staffRows.map(p => read('staff', p)) : undefined,
      docs: okDb('지원 서류') ? docs.map(p => read('doc', p)) : undefined,
      jobs: jobs.map(p => read('job', p)),
    };
}

// HWPX의 문단 텍스트만 읽음. 표 안 문단도 순서를 유지한다.
function gongText(blob) {
  const section = Utilities.unzip(blob.setContentType('application/zip')).find(f => f.getName() === 'Contents/section0.xml');
  if (!section) throw new Error('HWPX section0.xml 없음');
  const root = XmlService.parse(section.getDataAsString('UTF-8')).getRootElement(), lines = [];
  function walk(el, paragraph) {
    if (el.getName() === 'p') {
      const line = []; lines.push(line);
      el.getChildren().forEach(c => walk(c, line));
    } else if (el.getName() === 't' && paragraph) paragraph.push(el.getText());
    else el.getChildren().forEach(c => walk(c, paragraph));
  }
  walk(root, null);
  return lines.map(x => x.join('')).join('\n');
}
function gongFields(folder, files, at) {
  const name = folder.getName(), m = name.match(/(\d{4})-(\d{3})/);
  const f = { t: name.replace(/^창업육성팀\s+\d{4}-\d{3}\s*/, ''), k: folder.getId(), no: m ? m[0] : '', d: null, to: '', att: '', files: files.map(x => x.getName()).sort().join('\n'), link: folder.getUrl(), at };
  const hwpx = files.filter(x => /\.hwpx$/i.test(x.getName())).sort((a,b) => a.getName().localeCompare(b.getName()));
  const main = hwpx.find(x => /\[(공문|내부기안)\]/.test(x.getName())) || hwpx[0], warnings = [];
  if (main) {
    const text = gongText(main.getBlob()), lines = text.split('\n').map(x => x.trim());
    lines.forEach(line => {
      let v = line.match(/^수\s*신(?!\s*자)\s*[:：]?\s*(.+)/); if (v && !f.to) f.to = v[1].trim(); // 「수신자 참조」 목록 줄 제외
      v = line.match(/^제\s*목\s*[:：]?\s*(.+)/); if (v) f.t = v[1];
    });
    const issue = text.match(/시행\s*창업육성팀\s*(\d{4}-\d{3})\s*\(\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*\)/);
    if (issue) {
      f.no = issue[1];
      const y = +issue[2], mo = +issue[3], d = +issue[4], date = new Date(Date.UTC(y, mo - 1, d));
      if (date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d) f.d = [issue[2], String(mo).padStart(2,'0'), String(d).padStart(2,'0')].join('-');
    }
    const attachments = []; let taking = false;
    lines.map(x => x.trim()).forEach(line => {
      if (/^붙임/.test(line)) { taking = true; attachments.push(line.replace(/^붙임\s*[:：]?\s*/, '').replace(/끝\./g, '').trim()); }
      else if (taking && /^\d+\./.test(line)) attachments.push(line.replace(/끝\./g, '').trim());
      else if (line) taking = false;
    });
    f.att = attachments.filter(Boolean).join('\n');
    if (/:\s{2,}[^\d\n]*원/.test(text) || /금\s+원/.test(text)) warnings.push('금액 빈칸');
  } else {
    warnings.push('hwpx 없음');
    if (files.some(x => /\.hwp$/i.test(x.getName()))) warnings.push('hwp(내용 미확인)');
  }
  if (!f.no || /-000$/.test(f.no)) warnings.unshift('시행번호 미정');
  if (!f.d) warnings.push('시행일 미정');
  f.warn = warnings.join(' · ');
  return f;
}
function gongScan({ cursor, force } = {}) { // force: 바뀌지 않은 폴더도 다시 해석(규칙 수정 후 1회)
  if (!hasNotion()) throw new Error('개인 서버에서 실행해 주세요');
  const lock = LockService.getScriptLock(); lock.waitLock(8000);
  try {
    const started = Date.now(), dirs = DriveApp.getFolderById('1RVQtrosWq3lQ4M4ymGBJoSo6KbybyZku').getFoldersByName('공문');
    if (!dirs.hasNext()) throw new Error('공문 폴더를 찾을 수 없습니다');
    const parent = dirs.next();
    if (dirs.hasNext()) throw new Error('공문 폴더가 여러 개입니다');
    const folders = [], it = parent.getFolders();
    while (it.hasNext()) folders.push(it.next());
    const [pages] = queryMany([{ db: DB.gong, max: 10000 }]), rows = pages.map(p => read('gong', p)), have = new Map(rows.map(r => [r.k, r]));
    const present = new Set(folders.map(f => f.getId()));
    const work = folders.map(folder => ({ key: 'f:' + folder.getId(), folder })).concat(rows.filter(r => r.k && !present.has(r.k)).map(row => ({ key: 'r:' + row.id, row }))).sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    let scanned = 0, added = 0, updated = 0, last = cursor || '';
    const todo = work.filter(x => x.key > last);
    for (const item of todo) {
      if (scanned >= 40 || Date.now() - started > 240000) break;
      if (item.folder) {
        const folder = item.folder, files = [], fi = folder.getFiles(); let at = folder.getLastUpdated().getTime();
        while (fi.hasNext()) { const file = fi.next(); files.push(file); at = Math.max(at, file.getLastUpdated().getTime()); }
        at = new Date(at).toISOString();
        const old = have.get(folder.getId()), names = files.map(f => f.getName()).sort().join('\n');
        if (force || !old || Math.floor(Date.parse(old.at) / 6e4) !== Math.floor(Date.parse(at) / 6e4) || old.files !== names || (old.warn || '').includes('드라이브에 없음')) {
          const fields = gongFields(folder, files, at);
          if (old) { notion('pages/' + old.id, 'patch', { properties: props('gong', fields) }); updated++; }
          else {
            fields.st = /시행번호 미정|금액 빈칸/.test(fields.warn) ? '작성 중' : '시행 완료';
            notion('pages', 'post', { parent: { database_id: DB.gong }, properties: props('gong', fields) }); added++;
          }
        }
      } else if (!(item.row.warn || '').includes('드라이브에 없음')) {
        notion('pages/' + item.row.id, 'patch', { properties: props('gong', { warn: [item.row.warn, '드라이브에 없음'].filter(Boolean).join(' · ') }) }); updated++;
      }
      scanned++; last = item.key;
    }
    const more = todo.length > scanned, at = new Date().toISOString();
    if (!more) {
      const P = PropertiesService.getScriptProperties(), meta = JSON.parse(P.getProperty('syncMeta') || '{}');
      meta.gong = { at }; P.setProperty('syncMeta', JSON.stringify(meta));
    }
    return { ok: true, scanned, added, updated, more, at, cursor: more ? last : null };
  } finally { lock.releaseLock(); }
}

Object.assign(ACTIONS, {
  gongScan,
  // 공통: 추가·수정·휴지통
  add({ kind, fields }) {
    if (!DB[kind] || kind === 'month' || kind === 'leave') throw new Error('추가할 수 없는 종류입니다');
    if (kind === 'att') fields = linkAttendance(fields);
    const page = notion('pages', 'post', { parent: { database_id: DB[kind] }, properties: props(kind, fields) });
    return read(kind, page);
  },
  update({ kind, id, fields }) {
    if (!MAP[kind]) throw new Error('알 수 없는 종류입니다');
    if (kind === 'gong') {
      if (!fields || !['작성 중', '결재 중', '시행 완료'].includes(fields.st) || Object.keys(fields).some(k => k !== 'st')) throw new Error('공문은 상태만 변경할 수 있습니다');
    }
    if (kind === 'att') fields = linkAttendance(fields);
    const page = notion('pages/' + id, 'patch', { properties: props(kind, fields) });
    return read(kind, page);
  },
  trash({ kind, id }) {
    if (!['tasks', 'memo', 'job', 'habit', 'att', 'appr', 'cash', 'doc'].includes(kind)) throw new Error('지울 수 없는 종류입니다');
    notion('pages/' + id, 'patch', { archived: true }); // 노션 휴지통으로(30일 안에 복구 가능)
    return { id };
  },

  // 결재현황·출납부를 언제 불러왔는지 기록(줄을 다 올린 뒤 마지막에)
  syncMark({ kind, meta }) {
    if (!['appr', 'cash', 'bank', 'gong'].includes(kind)) throw new Error('알 수 없는 종류입니다');
    const lock = LockService.getScriptLock(); lock.waitLock(8000);
    try {
      const P = PropertiesService.getScriptProperties(), all = JSON.parse(P.getProperty('syncMeta') || '{}');
      all[kind] = meta;
      P.setProperty('syncMeta', JSON.stringify(all));
      return all;
    } finally { lock.releaseLock(); }
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
});

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
  if (!d.notion) { // 회사 계정·음악 계정(노션 키 없음)
    Logger.log("계정 %s · 메일 %s건 · 일정 %s건%s%s", d.account, (d.mail || []).length, d.events.length,
      d.mailError ? " · 메일 오류: " + d.mailError : "", d.calError ? " · 캘린더 오류: " + d.calError : "");
    return;
  }
  Logger.log("할 일 %s건 · 일정 %s건 · 메일 %s건 · 습관 %s개 · 메모 %s건 · 이직 %s건 · 근태 %s건 · 업무일지 %s건 · 브리핑 %s건%s%s",
    d.tasks.length, d.events.length, (d.mail || []).length, d.habits.length, d.memos.length, d.jobs.length, d.att.length, d.logs.length, d.news.length,
    d.warn && d.warn.length ? " · 연결 안 된 곳: " + d.warn.join(", ") : "", d.calError ? " · 캘린더 오류: " + d.calError : "");
}
