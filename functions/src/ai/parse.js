'use strict';
/**
 * 기존 HTML 의 응답 파싱 로직(JSON 추출 → 실패 시 recover()) 을 서버로 이전.
 * 결과 객체 형태(GenerationResult)는 기존 resultData 와 동일하다.
 */

function recover(raw, fallbackTitle) {
  function pk(k) { const re = new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'); const m = raw.match(re); return m ? m[1] : ''; }
  function pa(k) { const re = new RegExp('"' + k + '"\\s*:\\s*\\[([\\s\\S]*?)\\]'); const m = raw.match(re); if (!m) return []; const it = m[1].match(/"((?:[^"\\]|\\.)*)"/g); return it ? it.map((s) => s.replace(/^"|"$/g, '')) : []; }
  const o = {
    title_1: pk('title_1') || fallbackTitle, title_2: pk('title_2'), title_3: pk('title_3'),
    keyword_main: pk('keyword_main') || '-', keyword_sub: pk('keyword_sub') || '-', keyword_location: pk('keyword_location') || '-', keyword_intent: pk('keyword_intent') || '-',
    place_name: pk('place_name'), place_address: pk('place_address'), place_hours: pk('place_hours'), place_price: pk('place_price'),
    body: pk('body'), hashtags: pa('hashtags'), reel: pk('reel'), thumbnail: pk('thumbnail'),
  };
  if (!o.body) { const cl = raw.replace(/^[\s\S]*?"body"\s*:\s*"/, '').replace(/",\s*"hashtags"[\s\S]*$/, ''); o.body = cl || raw; }
  return o;
}

const STRING_FIELDS = ['title_1', 'title_2', 'title_3', 'keyword_main', 'keyword_sub', 'keyword_location', 'keyword_intent',
  'place_name', 'place_address', 'place_hours', 'place_price', 'body', 'reel', 'thumbnail'];

/** 모델 원문 → GenerationResult. 필드 타입을 정규화해 Firestore/클라이언트에 안전하게 넘긴다. */
function parseGeneration(full, fallbackTitle) {
  let parsed = null;
  try { const jm = full.match(/\{[\s\S]*\}/); if (jm) parsed = JSON.parse(jm[0]); } catch (e) { /* recover 로 폴백 */ }
  if (!parsed || typeof parsed !== 'object') parsed = recover(full, fallbackTitle);
  const out = {};
  for (const k of STRING_FIELDS) out[k] = typeof parsed[k] === 'string' ? parsed[k] : (parsed[k] == null ? '' : String(parsed[k]));
  out.hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.filter((t) => typeof t === 'string').slice(0, 30) : [];
  return out;
}

module.exports = { recover, parseGeneration, STRING_FIELDS };
