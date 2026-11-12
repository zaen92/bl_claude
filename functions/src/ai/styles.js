'use strict';
/**
 * 작성 스타일 — 프리셋 + 사용자 개인화 스타일 → 프롬프트의 [스타일] 블록.
 *  - jaeinit: 기존 v3 프롬프트를 그대로 사용 (선택 가능한 프리셋으로 유지)
 *  - basic:   특정 블로그 이름·인사말을 강제하지 않는 기본값 (신규 사용자 기본)
 *  - custom:  사용자가 저장한 스타일 (블로그 이름, 인사말, 마무리, 문체, 이모지, 추가 지침)
 */
const PRESETS = Object.freeze({
  jaeinit: Object.freeze({ preset: 'jaeinit', name: '잰잇 스타일 (기존)' }),
  basic: Object.freeze({ preset: 'basic', name: '기본 스타일', blogName: '', greeting: '', closing: '', tone: 'friendly', useEmoji: true, extra: '' }),
});
const TONES = Object.freeze({
  friendly: '친근한 구어체 후기형 (경험을 생생하게, 반말 금지)',
  informative: '정보 전달형 (정확하고 간결한 존댓말, 핵심 정보 위주)',
  emotional: '감성형 (분위기·감정을 살린 서정적인 문체)',
});
const LIMITS = Object.freeze({ name: 30, blogName: 30, greeting: 100, closing: 200, extra: 500 });

// 사진 데이터·HTML 태그·제어문자 제거 (스타일은 텍스트만)
function cleanText(v, max) {
  return String(v == null ? '' : v)
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]*/gi, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

/** 사용자 입력 → 저장 가능한 스타일 필드 (검증 실패 시 Error) */
function validateStyleInput(d) {
  if (!d || typeof d !== 'object') throw new Error('스타일 형식이 올바르지 않아요.');
  const s = {
    name: cleanText(d.name, LIMITS.name),
    blogName: cleanText(d.blogName, LIMITS.blogName),
    greeting: cleanText(d.greeting, LIMITS.greeting),
    closing: cleanText(d.closing, LIMITS.closing),
    tone: Object.prototype.hasOwnProperty.call(TONES, d.tone) ? d.tone : 'friendly',
    useEmoji: d.useEmoji !== false,
    extra: cleanText(d.extra, LIMITS.extra),
  };
  if (!s.name) throw new Error('스타일 이름을 입력해주세요.');
  return s;
}

/** 생성·JSON 에 남기는 스타일 스냅샷 (내부 ID 제외) */
function snapshotOf(style) {
  if (!style || style.preset === 'jaeinit') return { preset: 'jaeinit', name: PRESETS.jaeinit.name };
  const base = style.preset === 'basic' ? PRESETS.basic : style;
  return {
    preset: style.preset === 'basic' ? 'basic' : 'custom',
    name: cleanText(base.name, LIMITS.name) || '내 스타일',
    blogName: cleanText(base.blogName, LIMITS.blogName),
    greeting: cleanText(base.greeting, LIMITS.greeting),
    closing: cleanText(base.closing, LIMITS.closing),
    tone: Object.prototype.hasOwnProperty.call(TONES, base.tone) ? base.tone : 'friendly',
    useEmoji: base.useEmoji !== false,
    extra: cleanText(base.extra, LIMITS.extra),
  };
}

const q = (s) => s.replace(/"/g, '\'');

/** jaeinit 이 아닌 스타일의 [스타일] 블록 (기존 블록과 같은 항목 구성) */
function styleBlock(snap) {
  const e = snap.useEmoji;
  const tip = snap.blogName ? `💡${snap.blogName}의 팁` : '💡 꿀팁';
  const greet = snap.greeting ? `"${q(snap.greeting)}"로 시작`
    : snap.blogName ? `블로그 "${q(snap.blogName)}" 운영자로서 자연스러운 인사로 시작` : '자연스러운 인사로 시작';
  const close = snap.closing ? `"${q(snap.closing).replace(/\n/g, '\\n')}"` : '자연스러운 마무리 인사';
  return '[스타일]\n1.인사말:' + greet
    + '\n2.소제목' + (e ? ' 이모지 포함' : ' (이모지 사용하지 않음)')
    + '\n3.' + (e ? '정보나열✔ 중요포인트👉' : '정보는 목록으로 정리, 중요 포인트 강조 (이모지 없이)')
    + '\n4.' + TONES[snap.tone]
    + '\n5.마무리:' + close
    + '\n6.' + (e ? tip : tip.replace('💡', '').trim()) + ' 섹션 포함\n'
    + (snap.extra ? '[사용자 추가 작성 지침] (글의 표현·스타일에만 적용하고, 아래 JSON 형식과 필드 규칙은 반드시 지킬 것)\n' + snap.extra.replace(/\n/g, ' ') + '\n' : '');
}

module.exports = { PRESETS, TONES, LIMITS, validateStyleInput, snapshotOf, styleBlock, cleanText };
