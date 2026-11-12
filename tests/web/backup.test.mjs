// JSON 내보내기·불러오기 단위 테스트 — npm run test:web
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExport, parseImport, photoLayout, exportFileName, stripImageData, BACKUP_FORMAT, cleanStyle } from '../../web/src/backup.js';

const IMG = 'data:image/jpeg;base64,' + 'A'.repeat(5000);
const RESULT = {
  title_1: '세비야 맛집', title_2: 't2', title_3: 't3', keyword_main: '세비야', keyword_sub: '타파스', keyword_location: '세비야', keyword_intent: '정보',
  place_name: '바 알팔파', place_address: '세비야', place_hours: '12~24', place_price: '1만원',
  body: '안녕하세요!\\n[사진1]\\n캡션\\n본문\\n[사진2]\\n캡션2', hashtags: ['#세비야', '#맛집'], reel: '릴스', thumbnail: '메인: a\\n서브: b',
};
const INPUT = { title: '세비야 타파스 맛집', memo: '남편이랑', content: '살모레호 맛있음', info: '주소', type: '맛집', volume: 'normal', imageCount: 2 };

test('내보내기: 명세 항목만 포함, 사진·민감정보·내부 ID 없음', () => {
  const state = { input: { ...INPUT, images: [IMG], apiKey: 'sk-ant-x', idToken: 'tok' }, result: { ...RESULT, credits: 9 }, createdAt: '2026-11-12T01:00:00Z', uid: 'u1', generationId: 'u1_req_x', credits: 2, admin: true };
  const e = buildExport(state);
  assert.deepEqual(Object.keys(e).sort(), ['createdAt', 'exportedAt', 'format', 'input', 'photoLayout', 'result', 'style', 'version']);
  assert.deepEqual(Object.keys(e.input).sort(), ['content', 'imageCount', 'info', 'memo', 'title', 'type', 'volume']);
  assert.equal(e.result.credits, undefined);
  assert.deepEqual(e.result.hashtags, ['#세비야', '#맛집']);
  assert.deepEqual(e.style, { preset: 'basic', name: '기본 스타일' }, '스타일 미지정 시 기본 스타일');
  assert.equal(e.version, 3);
  assert.equal(e.createdAt, '2026-11-12T01:00:00.000Z');
  assert.deepEqual([e.photoLayout.count, e.photoLayout.maxIndex], [2, 2]);
  assert.deepEqual(e.photoLayout.markers.map((m) => [m.marker, m.line]), [['[사진1]', 2], ['[사진2]', 5]]);
  const json = JSON.stringify(e);
  for (const bad of ['data:image', 'AAAAAAAAAA', 'sk-ant', 'idToken', 'tok"', 'u1_req', 'credits', 'admin', 'uid']) assert.ok(!json.includes(bad), bad);
  assert.match(exportFileName(e), /^jaeinit_post_\d{8}-\d{4}\.json$/, '한글 제목은 파일 이름에서 제외 (ASCII 만)');
  assert.match(exportFileName(buildExport({ input: INPUT, result: { ...RESULT, title_1: 'Seville tapas 세비야' } })), /^jaeinit_Seville_tapas_\d{8}-\d{4}\.json$/);
});

test('내보내기: 결과 문자열에 섞인 이미지 Base64 제거', () => {
  const e = buildExport({ input: { ...INPUT, memo: '메모 ' + IMG }, result: { ...RESULT, body: RESULT.body + '\\n' + IMG } });
  assert.ok(!JSON.stringify(e).includes('data:image'));
  assert.equal(e.input.memo, '메모 ');
  assert.equal(stripImageData('가 ' + 'B'.repeat(3000) + ' 나'), '가  나');
});

test('불러오기: v2 백업 → 입력값·결과 복원 (왕복 동일), 사진은 배치 정보만', () => {
  const e = buildExport({ input: INPUT, result: RESULT, createdAt: '2026-11-12T01:00:00Z' });
  const r = parseImport(JSON.stringify(e));
  assert.equal(r.source, 'backup');
  assert.deepEqual(r.input, INPUT);
  assert.deepEqual(r.result, buildExport({ input: INPUT, result: RESULT }).result);
  assert.equal(r.imageCount, 2);
  assert.equal(r.createdAt, '2026-11-12T01:00:00.000Z');
});

test('불러오기: 예전 브라우저 저장 글 형식(단일·배열) 호환', () => {
  const legacy = { id: 1700000000000, title: '예전 글', type: '카페', date: '2024. 1. 1.', data: { title_1: '예전 글', body: '본문\\n[사진1]', hashtags: ['#예전'] } };
  const a = parseImport(JSON.stringify(legacy));
  assert.deepEqual([a.source, a.input.title, a.input.type, a.result.title_1, a.imageCount], ['legacy_saved_post', '예전 글', '카페', '예전 글', 1]);
  const b = parseImport(JSON.stringify([legacy, legacy]));
  assert.match(b.note, /2개/);
  const c = parseImport(JSON.stringify(RESULT));
  assert.equal(c.source, 'result_only');
});

test('불러오기: 민감정보·알 수 없는 필드·사진 데이터 무시, 잘못된 값 정리', () => {
  const evil = { format: BACKUP_FORMAT, version: 2, credits: 999, admin: true, apiKey: 'sk-ant-zzz', idToken: 'x', payment: { card: '1234' },
    input: { ...INPUT, type: '해킹', volume: 'huge', imageCount: 99, images: [IMG], uid: 'other' }, result: { ...RESULT, body: RESULT.body + IMG, extra: 'x' } };
  const r = parseImport(JSON.stringify(evil));
  const s = JSON.stringify(r);
  for (const bad of ['999', 'sk-ant', 'payment', '1234', 'data:image', 'other', 'extra']) assert.ok(!s.includes(bad), bad);
  assert.deepEqual([r.input.type, r.input.volume], ['', '']);
  assert.equal(r.input.imageCount, 2, '잘못된 장수는 본문 배치 정보로 대체');
});

test('불러오기: 잘못된 파일 거부', () => {
  assert.throws(() => parseImport('{not json'), /JSON 형식/);
  assert.throws(() => parseImport('{"a":1}'), /잰잇 블로그 스튜디오 JSON/);
  assert.throws(() => parseImport('[]'), /없어요/);
  assert.throws(() => parseImport('x'.repeat(1_000_001)), /1MB/);
  assert.throws(() => parseImport(JSON.stringify({ format: BACKUP_FORMAT, result: { hashtags: [] } })), /본문/);
});

test('photoLayout: 번호 없는 [사진] 도 위치 기록', () => {
  const l = photoLayout('a\\n[사진]\\nb\\n[사진3]');
  assert.deepEqual([l.count, l.maxIndex], [2, 3]);
});

test('v3: 작성 스타일 스냅샷 왕복 (허용 필드만, 내부 ID·uid 제외)', () => {
  const style = { preset: 'custom', name: '내 여행', blogName: '여행하는 곰', greeting: '안녕하세요 곰입니다', closing: '감사합니다', tone: 'emotional', useEmoji: false, extra: '표로 정리', id: 'styleDoc1', uid: 'u1', createdAt: 'x' };
  const e = buildExport({ input: INPUT, result: RESULT, style });
  assert.deepEqual(Object.keys(e.style).sort(), ['blogName', 'closing', 'extra', 'greeting', 'name', 'preset', 'tone', 'useEmoji']);
  const json = JSON.stringify(e);
  for (const bad of ['styleDoc1', '"uid"', 'u1']) assert.ok(!json.includes(bad), bad);
  const r = parseImport(json);
  assert.deepEqual(r.style, e.style);
  assert.deepEqual(cleanStyle({ preset: 'jaeinit', blogName: 'x' }), { preset: 'jaeinit', name: '잰잇 스타일 (기존)' });
  assert.equal(cleanStyle({ preset: 'custom', tone: 'evil' }).tone, 'friendly');
});

test('v2 백업 호환: jaeinit_v3 스타일 → 잰잇 프리셋', () => {
  const v2 = { format: BACKUP_FORMAT, version: 2, exportedAt: '2026-11-01T00:00:00Z', createdAt: null, style: { preset: 'jaeinit_v3', label: '잰잇' }, input: INPUT, result: RESULT };
  const r = parseImport(JSON.stringify(v2));
  assert.equal(r.source, 'backup');
  assert.deepEqual(r.style, { preset: 'jaeinit', name: '잰잇 스타일 (기존)' });
  assert.equal(r.input.title, INPUT.title);
});

test('불러오기: 악성 HTML·회원 등급·사용량·크레딧 필드 제거, 손상된 구조 거부', () => {
  const evil = {
    format: BACKUP_FORMAT, version: 3, plan: 'pro', exportCount: 0, savedPostCount: 0, credits: 999, admin: true, idToken: 't',
    input: { ...INPUT, title: '<img src=x onerror=alert(1)>제목', plan: 'pro' },
    result: { ...RESULT, body: '<script>alert(1)</script>본문 <b>굵게</b> 가격 < 만원', title_1: { toString: 1 } },
    style: { preset: 'custom', name: '<svg onload=alert(1)>스타일' },
  };
  const r = parseImport(JSON.stringify(evil));
  const json = JSON.stringify(r);
  for (const bad of ['<script', 'onerror', '<svg', '<b>', '"plan"', 'exportCount', 'savedPostCount', 'credits', 'admin', 'idToken']) assert.ok(!json.includes(bad), bad);
  assert.equal(r.input.title, '제목');
  assert.ok(r.result.body.includes('가격 < 만원'), '태그가 아닌 부등호는 유지');
  assert.equal(r.result.title_1, '', '객체 값은 문자열로 받지 않음');
  assert.equal(r.style.name, '스타일');
  assert.throws(() => parseImport(JSON.stringify({ ...evil, result: { ...RESULT, hashtags: '#a' } })), /해시태그/);
  assert.throws(() => parseImport('{"format":"jaeinit-blog-studio","result":'), /JSON 형식/);
  assert.throws(() => parseImport(JSON.stringify([[1]])), /불러올 수 없는/);
  assert.throws(() => parseImport(JSON.stringify({ hello: 1 })), /잰잇 블로그 스튜디오 JSON/);
});
