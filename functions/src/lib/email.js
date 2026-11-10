'use strict';
const crypto = require('node:crypto');

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * 가입 보너스 중복 방지용 이메일 정규화.
 * - 소문자/공백 제거
 * - 모든 도메인: "+태그" 제거 (user+abc@x.com → user@x.com)
 * - Gmail: 로컬파트의 "." 제거, googlemail.com → gmail.com
 */
function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  if (!local) return null;
  return `${local}@${domain}`;
}

/** 이메일 원문을 저장하지 않기 위한 문서 ID (SHA-256 hex). */
function emailKey(email) {
  const n = normalizeEmail(email);
  if (!n) return null;
  return crypto.createHash('sha256').update(n).digest('hex');
}

module.exports = { normalizeEmail, emailKey };
