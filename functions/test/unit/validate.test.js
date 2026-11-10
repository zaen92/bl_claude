'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGenerateInput } = require('../../src/api/validate');

const ok = { title: ' 제목 ', type: '카페', content: '내용', volume: 'short', clientRequestId: 'abcDEF12_-' };

test('정상 입력은 trim 되어 통과', () => {
  const r = validateGenerateInput(ok);
  assert.equal(r.title, '제목');
  assert.equal(r.memo, '');
  assert.deepEqual(r.images, []);
});
test('필수값/선택지 검증', () => {
  assert.throws(() => validateGenerateInput({ ...ok, title: '  ' }), /제목/);
  assert.throws(() => validateGenerateInput({ ...ok, type: '해킹' }), /글 유형/);
  assert.throws(() => validateGenerateInput({ ...ok, volume: 'huge' }), /분량/);
  assert.throws(() => validateGenerateInput({ ...ok, content: 'x'.repeat(5001) }), /5000자/);
  assert.throws(() => validateGenerateInput({ ...ok, clientRequestId: 'a' }), /clientRequestId/);
  assert.throws(() => validateGenerateInput(null), /요청/);
});
test('사진 검증', () => {
  assert.equal(validateGenerateInput({ ...ok, images: ['data:image/jpeg;base64,AAAA'] }).images.length, 1);
  assert.throws(() => validateGenerateInput({ ...ok, images: ['http://evil/x.jpg'] }), /사진/);
  assert.throws(() => validateGenerateInput({ ...ok, images: new Array(11).fill('data:image/jpeg;base64,AA') }), /최대/);
});
