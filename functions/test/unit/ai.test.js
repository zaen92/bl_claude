'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt, mergePlaceInfo } = require('../../src/ai/prompt');
const { parseGeneration, recover } = require('../../src/ai/parse');
const { mockGeneration } = require('../../src/ai/mock');

const base = { title: '세비야 타파스 맛집', type: '맛집', content: '살모레호 맛있음', memo: '', info: '', volume: 'normal', imageCount: 0 };

test('buildPrompt: 원본 프롬프트 핵심 요소 유지', () => {
  const p = buildPrompt(base);
  assert.ok(p.startsWith('당신은 네이버 블로그 SEO 전문 작성자입니다.'));
  assert.ok(p.includes('제목:세비야 타파스 맛집\n유형:맛집\n'));
  assert.ok(p.includes('메모:없음'));
  assert.ok(p.includes('분량:1500~1800자'));
  assert.ok(p.includes('안녕하세요! 여행블로거 잰잇입니다 ^ㅎ^'));
  assert.ok(!p.includes('[사진 배치 규칙]'));
  assert.ok(p.trim().endsWith('"thumbnail":"메인: ...\\n서브: ..."}'));
});
test('buildPrompt: 사진 배치 규칙 & 분량', () => {
  const p = buildPrompt({ ...base, imageCount: 3, volume: 'long' });
  assert.ok(p.includes('사진:3장'));
  assert.ok(p.includes('7.[사진 배치 규칙] 사진 3장이'));
  assert.ok(p.includes('분량:1800~2100자'));
});
test('mergePlaceInfo: 네이버 결과 병합 (원본 형식)', () => {
  const s = mergePlaceInfo('메모', { name: '바 알팔파', address: '세비야', tel: '', category: '스페인음식' });
  assert.equal(s, '메모\n\n[네이버 지도 검색 결과]\n업체명: 바 알팔파\n주소: 세비야\n카테고리: 스페인음식\n');
  assert.equal(mergePlaceInfo('', null), '');
});
test('parseGeneration: 정상 JSON (앞뒤 잡음 포함)', () => {
  const r = parseGeneration('설명...\n{"title_1":"A","body":"줄1\\n줄2","hashtags":["#a","#b"],"place_name":null}\n끝', 'F');
  assert.equal(r.title_1, 'A');
  assert.equal(r.body, '줄1\n줄2');
  assert.deepEqual(r.hashtags, ['#a', '#b']);
  assert.equal(r.place_name, '');
  assert.equal(r.title_2, '');
});
test('parseGeneration: 깨진 JSON → recover 폴백', () => {
  const raw = '{"title_1":"T1","keyword_main":"세비야","body":"안녕\\n하세요","hashtags":["#x","#y"],"reel":"r"'; // 닫는 괄호 없음
  const r = parseGeneration(raw, 'F');
  assert.equal(r.title_1, 'T1');
  assert.equal(r.keyword_main, '세비야');
  assert.equal(r.body, '안녕\\n하세요'); // recover 는 이스케이프를 유지 → 클라이언트 nl() 이 변환 (원본 동작과 동일)
  assert.deepEqual(r.hashtags, ['#x', '#y']);
  assert.equal(r.keyword_sub, '-');
});
test('recover: 제목 없을 때 폴백 제목', () => {
  assert.equal(recover('그냥 텍스트', '폴백').title_1, '폴백');
});
test('mockGeneration: [사진N] 마커 & 결과 스키마', () => {
  const r = mockGeneration({ ...base, imageCount: 2 });
  assert.ok(r.body.includes('[사진1]') && r.body.includes('[사진2]'));
  for (const k of ['title_1', 'keyword_main', 'body', 'reel', 'thumbnail']) assert.equal(typeof r[k], 'string');
  assert.ok(Array.isArray(r.hashtags));
});
