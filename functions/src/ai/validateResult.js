'use strict';
/**
 * 생성 결과(GenerationResult) 품질·형식 검사. 운영에서는 실패로 처리하지 않고 qualityFlags 로 기록,
 * 실제 API 검증(test:live)에서는 필수 조건으로 사용한다.
 */
const { STRING_FIELDS } = require('./parse');

// 기존 v3 분량 선택 (공백 제외 글자수가 아닌 일반 글자수 기준이었음) — 허용 오차를 둔다
const VOLUME_RANGE = { short: [800, 1000], normal: [1500, 1800], long: [1800, 2100] };

function checkResult(result, { volume, imageCount = 0, style = null } = {}) {
  const flags = [];
  for (const k of STRING_FIELDS) if (typeof result[k] !== 'string') flags.push(`field_type:${k}`);
  if (!Array.isArray(result.hashtags)) flags.push('field_type:hashtags');
  for (const k of ['title_1', 'title_2', 'title_3', 'keyword_main', 'body', 'reel', 'thumbnail']) {
    if (!result[k] || !String(result[k]).trim()) flags.push(`empty:${k}`);
  }
  const body = String(result.body || '').replace(/\\n/g, '\n');
  const chars = body.replace(/\s/g, '').length;
  const range = VOLUME_RANGE[volume];
  if (range) {
    if (chars < range[0] * 0.6) flags.push('body_too_short');
    if (chars > range[1] * 1.6) flags.push('body_too_long');
  }
  // 인사말·마무리 검사는 스타일별 (잰잇 프리셋 또는 사용자가 인사말을 지정한 경우만)
  if (!style || style.preset === 'jaeinit') {
    if (!/여행블로거 잰잇/.test(body)) flags.push('missing_greeting');
    if (!/공감이랑 서이추/.test(body)) flags.push('missing_closing');
    if (!/잰잇의 팁/.test(body)) flags.push('missing_tip_section');
  } else {
    if (style.greeting && !body.includes(style.greeting.slice(0, 8))) flags.push('missing_greeting');
    if (/여행블로거 잰잇/.test(body)) flags.push('foreign_brand_greeting'); // 다른 사용자에게 잰잇 인사말이 섞이면 안 됨
  }
  if (/\*\*|^#{1,6}\s|```/m.test(body)) flags.push('markdown_in_body');
  for (let i = 1; i <= imageCount; i++) if (!body.includes(`[사진${i}]`)) flags.push(`missing_photo_marker:${i}`);
  const tags = Array.isArray(result.hashtags) ? result.hashtags : [];
  if (tags.length < 3) flags.push('few_hashtags');
  if (tags.some((t) => typeof t !== 'string' || !t.startsWith('#'))) flags.push('hashtag_format');
  if (!/메인/.test(result.thumbnail || '')) flags.push('thumbnail_format');
  return { ok: flags.length === 0, flags, bodyChars: chars };
}

module.exports = { checkResult, VOLUME_RANGE };
