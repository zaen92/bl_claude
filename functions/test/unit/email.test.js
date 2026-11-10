'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEmail, emailKey } = require('../../src/lib/email');

test('normalizeEmail: 대소문자/공백/+태그', () => {
  assert.equal(normalizeEmail('  Foo+promo@Example.COM '), 'foo@example.com');
});
test('normalizeEmail: Gmail 점 제거 & googlemail 통합', () => {
  assert.equal(normalizeEmail('J.a.e+x@googlemail.com'), 'jae@gmail.com');
  assert.equal(emailKey('jae@gmail.com'), emailKey('J.AE+again@gmail.com'));
});
test('normalizeEmail: 비정상 입력', () => {
  for (const v of [null, undefined, '', 'abc', '@x.com', 'a@', '+x@y.com', 123]) assert.equal(normalizeEmail(v), null);
  assert.equal(emailKey(null), null);
});
test('emailKey: sha256 hex, 원문 미포함', () => {
  const k = emailKey('a@b.com');
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.ok(!k.includes('a@b'));
});
