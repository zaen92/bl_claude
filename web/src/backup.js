// JSON 내보내기·불러오기 (순수 함수 — 브라우저 API 없음, Node 테스트 가능)
//
// 포함: 입력 원문·장소 정보, 글 유형·분량, SEO 제목, 키워드, 본문, 해시태그, 릴스, 썸네일,
//       사진 배치 정보([사진N] 위치·장수), 작성 스타일, 작성 일시
// 제외: 사진·Base64 데이터, API 키, 인증 토큰, 크레딧 잔액·원장, 회원 등급, 관리자 권한, 결제 정보, 내보내기 횟수,
//       내부 ID(uid 포함 generationId, 스타일 문서 ID 등)
// 버전: v3(작성 스타일 스냅샷 포함) — v2 백업과 예전 브라우저 저장 글도 불러올 수 있음

export const BACKUP_FORMAT = 'jaeinit-blog-studio';
export const BACKUP_VERSION = 3;
export const MAX_IMPORT_BYTES = 1_000_000;
// 작성 스타일 스냅샷 — 서버 functions/src/ai/styles.js 의 snapshotOf 와 같은 필드 (내부 ID 없음)
const STYLE_LIMITS = { name: 30, blogName: 30, greeting: 100, closing: 200, extra: 500 };
const TONES = ['friendly', 'informative', 'emotional'];
export const DEFAULT_STYLE = { preset: 'basic', name: '기본 스타일' };
export function cleanStyle(st) {
  const x = st && typeof st === 'object' ? st : null;
  if (!x) return null;
  if (x.preset === 'jaeinit' || x.preset === 'jaeinit_v3') return { preset: 'jaeinit', name: '잰잇 스타일 (기존)' }; // v2 의 jaeinit_v3 포함
  const out = { preset: x.preset === 'basic' ? 'basic' : 'custom' };
  for (const [k, max] of Object.entries(STYLE_LIMITS)) out[k] = str(x[k], max);
  if (!out.name) out.name = out.preset === 'basic' ? '기본 스타일' : '내 스타일';
  out.tone = TONES.includes(x.tone) ? x.tone : 'friendly';
  out.useEmoji = x.useEmoji !== false;
  return out;
}

const TYPES = ['맛집', '카페', '여행', '숙소', '캠핑', '미용', '쇼핑', '투어', '전시'];
const VOLUMES = ['short', 'normal', 'long'];
const RESULT_STRING_FIELDS = ['title_1', 'title_2', 'title_3', 'keyword_main', 'keyword_sub', 'keyword_location', 'keyword_intent',
  'place_name', 'place_address', 'place_hours', 'place_price', 'body', 'reel', 'thumbnail'];
const INPUT_LIMITS = { title: 200, memo: 2000, content: 5000, info: 2000 };

/** 이미지 dataURL·긴 Base64 덩어리 제거 */
const IMAGE_DATA_RE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]*/gi;
const LONG_BASE64_RE = /[A-Za-z0-9+/]{2000,}={0,2}/g;
export function stripImageData(s) {
  return String(s == null ? '' : s).replace(IMAGE_DATA_RE, '').replace(LONG_BASE64_RE, '');
}
// HTML 태그 제거 (화면에는 textContent 로만 표시하지만, 파일 단계에서도 한 번 더 걸러냄)
const HTML_TAG_RE = /<\/?[a-z!][^>]*>/gi;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const str = (v, max) => stripImageData(typeof v === 'string' ? v : (v == null || typeof v === 'object') ? '' : String(v))
  .replace(HTML_TAG_RE, '').replace(CONTROL_RE, '').slice(0, max || 20000);

/** 본문 \\n 이스케이프를 실제 줄바꿈으로 본 뒤 [사진N] 위치 정보 */
export function photoLayout(body) {
  const text = String(body || '').replace(/\\n/g, '\n');
  const markers = [];
  const re = /\[사진(\d*)\]/g;
  let m;
  while ((m = re.exec(text))) {
    const line = text.slice(0, m.index).split('\n').length;
    markers.push({ marker: m[0], index: m[1] ? Number(m[1]) : null, line });
  }
  const numbered = markers.map((x) => x.index).filter((n) => n != null);
  return { count: markers.length, maxIndex: numbered.length ? Math.max(...numbered) : 0, markers };
}

function cleanResult(r) {
  const out = {};
  for (const k of RESULT_STRING_FIELDS) out[k] = str(r && r[k]);
  out.hashtags = Array.isArray(r && r.hashtags) ? r.hashtags.filter((t) => typeof t === 'string').map((t) => str(t, 100)).slice(0, 30) : [];
  return out;
}

function cleanInput(i) {
  const x = i || {};
  const out = {};
  for (const [k, max] of Object.entries(INPUT_LIMITS)) out[k] = str(x[k], max);
  out.type = TYPES.includes(x.type) ? x.type : '';
  out.volume = VOLUMES.includes(x.volume) ? x.volume : '';
  const n = Number(x.imageCount);
  out.imageCount = Number.isInteger(n) && n >= 0 && n <= 10 ? n : 0;
  return out;
}

/**
 * 내보낼 JSON 객체.
 * @param {{input?:object, result:object, createdAt?:string|Date, style?:object}} p
 */
export function buildExport({ input, result, createdAt, style }) {
  if (!result) throw new Error('내보낼 생성 결과가 없어요.');
  const r = cleanResult(result);
  const i = cleanInput(input);
  const layout = photoLayout(r.body);
  if (!i.imageCount) i.imageCount = layout.maxIndex || layout.count;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    style: cleanStyle(style) || { ...DEFAULT_STYLE },
    input: i,
    result: r,
    photoLayout: { ...layout, note: '실제 사진은 포함되지 않습니다. 필요하면 다시 첨부해주세요.' },
  };
}

export function exportFileName(exp) {
  // 파일 이름은 영문·숫자만 (일부 브라우저가 한글 파일 이름을 "download" 로 바꿔 확장자가 사라지는 문제 방지). 제목은 파일 안에 그대로 있음
  const t = (exp.result.title_1 || exp.input.title || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'post';
  const d = new Date(exp.exportedAt);
  const pad = (n) => String(n).padStart(2, '0');
  return `jaeinit_${t}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

/**
 * 불러오기: 문자열 → { input, result, createdAt, imageCount, style, source, note }
 * 지원 형식: v3·v2 백업 / 예전 브라우저 저장 글({id,title,type,date,data}) 단일 또는 배열 / 생성 결과 객체만
 * 알 수 없는 필드(크레딧·토큰·키·권한 등)는 모두 버린다.
 */
export function parseImport(text) {
  if (typeof text !== 'string') throw new Error('파일을 읽을 수 없어요.');
  if (text.length > MAX_IMPORT_BYTES) throw new Error('파일이 너무 커요 (1MB 이하).');
  let j;
  try { j = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error('JSON 형식이 올바르지 않아요.'); }
  let note = '';
  if (Array.isArray(j)) {
    if (!j.length) throw new Error('불러올 글이 없어요.');
    if (j.length > 1) note = `파일에 글이 ${j.length}개 있어 첫 번째 글을 불러왔어요.`;
    j = j[0];
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('불러올 수 없는 파일이에요.');

  let input; let result; let createdAt = null; let source; let style = null;
  if (j.format === BACKUP_FORMAT && j.result) {
    if (Number(j.version) > BACKUP_VERSION) note = '더 새로운 버전에서 만든 파일이에요. 알 수 있는 항목만 불러왔어요.';
    source = 'backup';
    input = j.input; result = j.result; style = cleanStyle(j.style);
    createdAt = typeof j.createdAt === 'string' && !Number.isNaN(Date.parse(j.createdAt)) ? new Date(j.createdAt).toISOString() : null;
  } else if (j.data && typeof j.data === 'object' && (j.data.body != null || j.data.title_1 != null)) {
    source = 'legacy_saved_post'; // 예전 v3 저장 글 형식
    input = { title: j.title || j.data.title_1 || '', type: j.type || '' };
    result = j.data; createdAt = null;
  } else if (j.body != null || j.title_1 != null) {
    source = 'result_only';
    input = {}; result = j;
  } else {
    throw new Error('잰잇 블로그 스튜디오 JSON 이 아니에요.');
  }
  const r = cleanResult(result);
  if (!r.body && !r.title_1) throw new Error('불러올 본문이 없어요.');
  if (result.hashtags != null && !Array.isArray(result.hashtags)) throw new Error('해시태그 형식이 올바르지 않아요.');
  const i = cleanInput(input);
  const layout = photoLayout(r.body);
  const imageCount = i.imageCount || layout.maxIndex || layout.count;
  return { input: { ...i, imageCount }, result: r, createdAt, imageCount, style, source, note };
}
