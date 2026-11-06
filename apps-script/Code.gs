/**
 * 광야교회 홈페이지 관리자 저장 서버 (Google Apps Script)
 *
 * 하는 일
 *  - 홈페이지가 읽어 가는 내용(교회 소식, 예배 시간, 기도 제목, 헌금 안내, 교회 정보)을 구글 시트에 보관합니다.
 *  - 관리자 페이지에서 비밀번호가 맞을 때만 저장합니다.
 *  - 저장할 때마다 '기록' 시트에 이전 내용을 남겨, 언제든 되돌릴 수 있습니다.
 *
 * 처음 한 번 할 일 (설치 안내서 참고)
 *  1) 아래 '비밀번호 정하기' 줄의 따옴표 안을 원하는 비밀번호로 바꾸고, 위쪽 실행할 함수에서 setup 을 골라 ▶실행
 *  2) 배포 > 새 배포 > 웹 앱 / 실행: 나 / 액세스 권한: 모든 사용자 > 배포 → 나오는 주소(…/exec)를 복사
 */

// ▼ 비밀번호 정하기 (setup 을 실행하면 안전한 곳에 저장되고, 그 뒤에는 이 줄을 지워도 됩니다)
const INITIAL_PASSWORD = '여기에-비밀번호를-적으세요';

const DATA_SHEET = '내용';
const LOG_SHEET = '기록';
const MAX_CHARS = 45000;       // 시트 칸 하나에 들어가는 글자 수 한도보다 조금 작게
const MAX_FAILS = 8;           // 10분 동안 비밀번호를 이만큼 틀리면 잠시 막습니다

/** 처음 한 번 실행: 시트 만들기 + 비밀번호 저장 + 기본 내용 넣기 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('이 스크립트는 구글 시트의 [확장 프로그램 > Apps Script]에서 만들어야 합니다.');
  let data = ss.getSheetByName(DATA_SHEET) || ss.insertSheet(DATA_SHEET);
  let log = ss.getSheetByName(LOG_SHEET) || ss.insertSheet(LOG_SHEET);
  data.getRange('A1').setValue('홈페이지 내용 (직접 고치지 마세요. 관리자 페이지에서 고칩니다)');
  if (log.getLastRow() === 0) log.appendRow(['저장 시각', '내용', '저장 전 내용(되돌리기용)']);
  log.getRange('A:A').setNumberFormat('@');   // 시각을 글자 그대로 보관
  if (INITIAL_PASSWORD && INITIAL_PASSWORD.indexOf('여기에') !== 0) {
    PropertiesService.getScriptProperties().setProperty('ADMIN_PASSWORD', INITIAL_PASSWORD);
  }
  if (!PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD')) {
    throw new Error('맨 위 INITIAL_PASSWORD 를 원하는 비밀번호로 바꾼 뒤 다시 실행해 주세요.');
  }
  if (!data.getRange('A2').getValue()) {
    data.getRange('A2').setValue(JSON.stringify(DEFAULT_CONTENT));
  }
  return '준비 완료';
}

/** 홈페이지·관리자 페이지가 내용을 읽어 갈 때 (누구나 읽기 가능) */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'content';
  if (action === 'content') return json_(readContent_());
  if (action === 'videos') return json_(videos_());
  return json_({ ok: false, error: '알 수 없는 요청입니다.' });
}

/** 관리자 페이지에서 저장·로그인·기록 요청 (비밀번호 필요) */
function doPost(e) {
  let req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: '요청 형식이 올바르지 않습니다.' }); }

  const gate = checkPassword_(req.password);
  if (gate) return json_({ ok: false, error: gate });

  switch (req.action) {
    case 'login':
      return json_({ ok: true });
    case 'save':
      return json_(save_(req.content, req.note));
    case 'history':
      return json_({ ok: true, items: history_() });
    case 'restore':
      return json_(restore_(req.time));
    case 'upload':
      return json_(upload_(req));
    case 'trash':
      return json_(trash_(req.ids));
    default:
      return json_({ ok: false, error: '알 수 없는 요청입니다.' });
  }
}

/* ---------------- 유튜브 최신 설교 ----------------
 * Apps Script 왼쪽 [서비스 +] 에서 'YouTube Data API v3' 를 추가해야 동작합니다.
 * 30분마다 새로 가져오고, 그 사이에는 저장해 둔 목록을 돌려줍니다. */
const CHANNEL_ID = 'UC7EtxWFmYMIRFxp2ZxnZaLw';

function videos_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('videos');
  if (hit) return JSON.parse(hit);
  let list = [];
  try {
    const res = YouTube.PlaylistItems.list('snippet', { playlistId: 'UU' + CHANNEL_ID.slice(2), maxResults: 12 });
    list = (res.items || []).filter(function (it) {
      return it.snippet && it.snippet.resourceId && ['Private video', 'Deleted video'].indexOf(it.snippet.title) < 0;
    }).map(function (it) {
      const sn = it.snippet, p = parseTitle_(sn.title), th = sn.thumbnails || {};
      const t = th.maxres || th.standard || th.high || th.medium || th.default || {};
      return { id: sn.resourceId.videoId, title: p.title, scripture: p.scripture, date: p.date || sn.publishedAt.slice(0, 10).replace(/-/g, '.'),
               kind: p.kind, note: p.note, published: sn.publishedAt, thumb: t.url || '' };
    });
    list.sort(function (a, b) { return String(b.published).localeCompare(String(a.published)); });
    PropertiesService.getScriptProperties().setProperty('VIDEOS_BACKUP', JSON.stringify(list).slice(0, 8500));
  } catch (err) {
    const backup = PropertiesService.getScriptProperties().getProperty('VIDEOS_BACKUP');
    list = backup ? JSON.parse(backup) : [];
  }
  cache.put('videos', JSON.stringify(list), 1800);
  return list;
}

function parseTitle_(t) {
  const parts = String(t).split('|').map(function (x) { return x.trim(); });
  const date = parts.filter(function (x) { return /^\d{4}\.\d{2}\.\d{2}$/.test(x); })[0] || '';
  const rest = parts.slice(2).join(' ');
  let kind = '말씀';
  if (/큐티|QT/.test(t)) kind = '큐티말씀';
  else if (/금요/.test(rest)) kind = '금요기도회';
  else if (/주일/.test(rest)) kind = '주일설교';
  const m = kind === '주일설교' ? /\(([^)]*)\)/.exec(parts[parts.length - 1]) : null;
  const q = kind === '큐티말씀' ? /\(([^)]*)\)/.exec(t) : null;
  return { title: parts[0], scripture: parts[1] || '', date: date, kind: kind,
           note: m ? m[1] : (kind === '큐티말씀' && parts[2] ? parts[2].replace(/\s*\(.*\)$/, '') : '') };
}

/** 편집기에서 직접 실행해 유튜브 연결을 시험해 볼 수 있습니다 */
function testVideos() {
  CacheService.getScriptCache().remove('videos');
  Logger.log(JSON.stringify(videos_(), null, 1));
}

/* ---------------- 주보 파일 (구글 드라이브 '광야교회 주보' 폴더) ---------------- */
const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_UPLOAD_MB = 20;

function bulletinFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('BULLETIN_FOLDER');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const folder = DriveApp.createFolder('광야교회 주보');
  props.setProperty('BULLETIN_FOLDER', folder.getId());
  return folder;
}

function upload_(req) {
  try {
    const mime = String(req.mime || '');
    if (UPLOAD_TYPES.indexOf(mime) < 0) return { ok: false, error: '사진(JPG·PNG) 또는 PDF 파일만 올릴 수 있습니다.' };
    const bytes = Utilities.base64Decode(String(req.data || ''));
    if (bytes.length > MAX_UPLOAD_MB * 1024 * 1024) return { ok: false, error: '파일이 너무 큽니다. ' + MAX_UPLOAD_MB + 'MB 이하로 올려 주세요.' };
    const name = String(req.name || '주보').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    const file = bulletinFolder_().createFile(Utilities.newBlob(bytes, mime, name));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return { ok: true, id: file.getId() };
  } catch (err) {
    return { ok: false, error: '파일을 저장하지 못했습니다: ' + err.message };
  }
}

/** 주보를 지울 때 드라이브 파일은 휴지통으로 보냅니다 (30일 안에는 드라이브에서 되살릴 수 있음) */
function trash_(ids) {
  const folderId = bulletinFolder_().getId();
  let n = 0;
  (ids || []).forEach(function (id) {
    try {
      const f = DriveApp.getFileById(String(id));
      const parents = f.getParents();
      let inFolder = false;
      while (parents.hasNext()) { if (parents.next().getId() === folderId) inFolder = true; }
      if (inFolder) { f.setTrashed(true); n++; }
    } catch (e) {}
  });
  return { ok: true, trashed: n };
}

/* ---------------- 내부 함수 ---------------- */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkPassword_(pw) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('fails') || 0);
  if (fails >= MAX_FAILS) return '비밀번호를 여러 번 틀려서 10분 동안 잠겼습니다. 잠시 후 다시 시도해 주세요.';
  const real = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  if (!real) return '관리자 비밀번호가 아직 설정되지 않았습니다. setup 을 먼저 실행해 주세요.';
  if (String(pw || '') !== real) {
    cache.put('fails', String(fails + 1), 600);
    return '비밀번호가 맞지 않습니다.';
  }
  return '';
}

function sheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return { data: ss.getSheetByName(DATA_SHEET), log: ss.getSheetByName(LOG_SHEET) };
}

function readContent_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('content');
  if (hit) return JSON.parse(hit);
  const raw = sheets_().data.getRange('A2').getValue();
  const content = raw ? JSON.parse(raw) : DEFAULT_CONTENT;
  const text = JSON.stringify(content);
  if (text.length < 90000) cache.put('content', text, 300);
  return content;
}

function clean_(c) {
  // 꼭 필요한 모양만 확인합니다.
  if (!c || typeof c !== 'object') throw new Error('저장할 내용이 비어 있습니다.');
  ['news', 'worship', 'prayers', 'bulletins'].forEach(function (k) {
    if (c[k] != null && !Array.isArray(c[k])) throw new Error(k + ' 형식이 올바르지 않습니다.');
  });
  const text = JSON.stringify(c);
  if (text.length > MAX_CHARS) throw new Error('내용이 너무 깁니다. 오래된 소식을 몇 개 지운 뒤 다시 저장해 주세요.');
  return text;
}

function save_(content, note) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: '다른 저장이 진행 중입니다. 잠시 후 다시 눌러 주세요.' };
  try {
    content.updated = new Date().toISOString();
    const text = clean_(content);
    const s = sheets_();
    const before = s.data.getRange('A2').getValue();
    s.data.getRange('A2').setValue(text);
    s.log.appendRow([content.updated, String(note || '저장').slice(0, 200), before]);
    trimLog_(s.log);
    CacheService.getScriptCache().remove('content');
    return { ok: true, updated: content.updated };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

function trimLog_(log) {
  const keep = 200;                      // 최근 200번 저장 기록만 보관
  const rows = log.getLastRow() - 1;
  if (rows > keep) log.deleteRows(2, rows - keep);
}

function history_() {
  const log = sheets_().log;
  const n = log.getLastRow() - 1;
  if (n <= 0) return [];
  const take = Math.min(n, 20);
  const vals = log.getRange(log.getLastRow() - take + 1, 1, take, 2).getValues();
  return vals.reverse().map(function (r) {
    return { time: r[0] instanceof Date ? r[0].toISOString() : String(r[0]), note: String(r[1]) };
  });
}

/** 'time' 에 저장한 바로 그때의 내용으로 되돌립니다. (그 다음 저장 기록의 '저장 전 내용'을 사용) */
function restore_(time) {
  const log = sheets_().log;
  const n = log.getLastRow() - 1;
  if (n <= 0) return { ok: false, error: '되돌릴 기록이 없습니다.' };
  const vals = log.getRange(2, 1, n, 3).getValues();
  const t = function (v) { return v instanceof Date ? v.toISOString() : String(v); };
  for (let i = 0; i < vals.length - 1; i++) {
    if (t(vals[i][0]) === String(time)) {
      const snapshot = vals[i + 1][2];   // 다음 저장 직전의 내용 = 이 시점에 저장된 내용
      if (!snapshot) break;
      return save_(JSON.parse(snapshot), '되돌리기: ' + String(vals[i][1]));
    }
  }
  return { ok: false, error: '그 시점의 내용을 찾지 못했습니다.' };
}

/* 처음 넣어 둘 내용 (현재 홈페이지와 같음) */
const DEFAULT_CONTENT = {
  "version": 1,
  "hero": {
    "sub": "척박한 광야 길을 걷는 듯한 일상 속에서, 광야교회가 여러분의 따뜻한 영적 오아시스가 되기를 소망합니다."
  },
  "worship": [
    {
      "name": "주일 예배",
      "desc": "인도 박규성 담임목사",
      "time": "오후 5:00"
    },
    {
      "name": "금요기도회",
      "desc": "경배와 찬양 · 말씀",
      "time": "오후 8:30"
    }
  ],
  "place": {
    "name": "일산은광교회 예배당 (임시 예배당)",
    "short": "다인타운 4층",
    "address": "경기도 고양시 일산동구 숲속마을1로 26 다인타운 4층",
    "jibun": "풍동 1293",
    "transit": "버스: ‘숲속마을1단지’ 또는 ‘숲속마을1단지.풍동성당’ 정류장 하차 (81 · 83 · 84 · 98 · 100번)\n지하철: 경의중앙선 풍산역에서 81번 버스로 갈아타기",
    "parking": "주차 가능"
  },
  "news": [
    {
      "id": "n1",
      "date": "2026-11-01",
      "tag": "새소식",
      "title": "유튜브 채널에 매일 ‘큐티말씀’이 올라옵니다",
      "body": "매일 밤 12시, 광야교회 유튜브 채널 [게시물] 코너에 매일성경 본문을 따라 큐티말씀이 올라옵니다. 댓글로 함께 참여해 주세요."
    },
    {
      "id": "n2",
      "date": "2026-11-01",
      "tag": "공지",
      "title": "추수감사주일 예배를 드렸습니다",
      "body": "성찬식과 특별찬양(4팀)으로 함께 감사의 예배를 드렸습니다."
    },
    {
      "id": "n3",
      "date": "2026-11-01",
      "tag": "",
      "title": "봉사자를 모집합니다",
      "body": "예배안내 · 찬양팀 · 반주자 · 중창팀 · 주차안내 · 새가족환영팀 · 차량카풀 · 청소 · 식당 봉사를 희망하시는 분은 자원해 주세요."
    },
    {
      "id": "n4",
      "date": "2026-11-01",
      "tag": "",
      "title": "심방이 필요하신 분은 알려 주세요",
      "body": "가정 심방, 새가족 등록 심방, 환우 심방 등 기도와 심방이 필요하신 분은 알려 주세요."
    },
    {
      "id": "n5",
      "date": "2026-11-01",
      "tag": "",
      "title": "머문 자리를 정돈해 주세요",
      "body": "광야교회는 일산은광교회의 섬김으로 예배드리고 있습니다. 머문 자리는 깨끗하게 사용하고 정돈해 주세요."
    }
  ],
  "prayers": [
    {
      "label": "예배 장소",
      "text": "재정적으로 자립하여 현장 예배 장소를 속히 마련할 수 있도록"
    },
    {
      "label": "교회학교",
      "text": "교회학교 예배가 마련되도록"
    },
    {
      "label": "담임목사",
      "text": "박규성 담임목사의 성령충만함을 위해"
    },
    {
      "label": "가정과 일터",
      "text": "성도들의 가정과 일터마다 하나님의 은혜와 축복이 넘쳐나도록"
    },
    {
      "label": "건강",
      "text": "환우들과 연로하신 어르신들의 건강을 위해"
    },
    {
      "label": "자녀",
      "text": "학업 중에 있는 자녀손들을 위해"
    }
  ],
  "offering": {
    "bank": "국민은행",
    "account": "293201-04-362488",
    "holder": "대한예수교장로회광야교회",
    "howto": "이름 + 헌금 종류 첫 글자 + 휴대폰 끝 4자리",
    "example": "예) 홍길동십9191 · 김헌금감3927 · 박예물건0691",
    "kinds": "십(십일조) · 감(감사) · 주(주일) · 구(구제) · 선(선교) · 건(건축) · 장(장학) · 목(목적) · 추(추수감사)"
  },
  "greeting": {
    "lead": "하나님을 가장 깊이 만나는 곳,\n광야교회입니다.",
    "body": "광야교회는 아직 이 땅에 건물이 없습니다. 그러나 하나님의 은혜로 일산은광교회에서 예배당을 무상으로 사용할 수 있도록 허락해 주셔서, 2026년 9월 18일 개척을 위한 준비기도회를 시작으로 현장에서 예배를 드리게 되었습니다.\n\n척박한 광야 길을 걷는 듯한 일상 속에서, 광야교회가 여러분의 따뜻한 영적 오아시스가 되기를 소망합니다. 함께 은혜를 나누고 서로를 위로하며, 평안이 넘치는 신앙 공동체를 함께 만들어가요."
  },
  "bulletins": [
    {
      "id": "b20261101",
      "date": "2026-11-01",
      "no": "제2026-45호",
      "title": "추수감사주일",
      "files": [
        {
          "src": "bulletins/2026-11-01-1.jpg",
          "type": "image"
        },
        {
          "src": "bulletins/2026-11-01-2.jpg",
          "type": "image"
        }
      ]
    }
  ]
};
