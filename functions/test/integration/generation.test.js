'use strict';
// AI 생성 + 크레딧 차감/복구 통합 테스트 — Firestore + Storage 에뮬레이터, Claude 는 mock 클라이언트 (실제 API 호출 아님)
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { ensureUserProfile, adminAdjustCredits } = require('../../src/lib/credits');
const service = require('../../src/generation/service');
const { createMockClient } = require('../../src/ai/mockClient');
const { validateGenerateInput } = require('../../src/api/validate');

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) throw new Error('Firestore/Storage 에뮬레이터에서 실행하세요 (npm run test:emu)');
const app = getApps()[0] || initializeApp({ projectId: 'demo-jaeinit', storageBucket: 'demo-jaeinit.appspot.com' });
const db = getFirestore(app);
const bucket = getStorage(app).bucket();

// 1x1 JPEG
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

const CFG = {
  model: 'claude-sonnet-4-6', maxTokens: 8192, claudeTimeoutMs: 10_000, webSearchMaxUses: 5, webSearchToolType: 'auto',
  rateLimitPerMinute: 100, dailyLimit: 100, maxConcurrent: 5, storageQuotaBytes: 200 * 1024 * 1024, leaseSeconds: 360,
};

let seq = 0;
function input(over = {}) {
  seq++;
  return validateGenerateInput({ title: '세비야 타파스 맛집 바 알팔파', type: '맛집', content: '살모레호 맛있음', memo: '', info: '', volume: 'normal', images: [], clientRequestId: `req_test_${Date.now()}_${seq}`, ...over });
}
function deps(over = {}) {
  return { db, bucket, ai: { client: createMockClient(), provider: 'mock' }, naver: null, logger: null, ...over };
}
async function newUser(uid) {
  await ensureUserProfile(db, { uid, email: `${uid}@x.com`, emailVerified: true });
}
async function clear() {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-jaeinit/databases/(default)/documents`, { method: 'DELETE' });
}
async function user(uid) { return (await db.doc(`users/${uid}`).get()).data(); }
async function ledger(uid) { return (await db.collection('creditLedger').where('uid', '==', uid).get()).docs.map((d) => ({ id: d.id, ...d.data() })); }
/** 불변식: credits == free + paid == Σ ledger.delta, 음수 없음 */
async function assertInvariant(uid) {
  const u = await user(uid);
  const l = await ledger(uid);
  const sum = l.reduce((s, x) => s + x.delta, 0);
  assert.equal(u.credits, sum, `credits(${u.credits}) == Σledger(${sum})`);
  assert.equal(u.credits, u.freeCredits + u.paidCredits, 'credits == free + paid');
  assert.ok(u.credits >= 0 && u.freeCredits >= 0 && u.paidCredits >= 0, 'no negative balance');
  return u;
}
async function rejectsWith(p, reason) {
  await assert.rejects(p, (e) => { assert.equal(e.details && e.details.reason, reason, `expected ${reason}, got ${e.details && e.details.reason} (${e.message})`); return true; });
}

test.beforeEach(clear);

test('① 신규 가입 후 무료 2회 사용 → 잔액 0, 원장 +2 −1 −1', async () => {
  await newUser('u1');
  for (let i = 0; i < 2; i++) {
    const r = await service.generate(deps(), CFG, { uid: 'u1', input: input() });
    assert.equal(r.status, 'succeeded');
    assert.equal(r.creditsRemaining, 1 - i);
    assert.ok(r.result.title_1 && r.result.body);
  }
  const u = await assertInvariant('u1');
  assert.deepEqual([u.credits, u.freeCredits, u.activeGenerations], [0, 0, 0]);
  const l = await ledger('u1');
  assert.deepEqual(l.map((x) => x.type).sort(), ['generation', 'generation', 'signup_bonus']);
  const gens = await db.collection('generations').where('uid', '==', 'u1').get();
  assert.equal(gens.size, 2);
  gens.forEach((g) => assert.equal(g.data().charge.status, 'captured'));
});

test('② 2회 사용 후 세 번째 생성 차단 (차감·기록 없음)', async () => {
  await newUser('u2');
  await service.generate(deps(), CFG, { uid: 'u2', input: input() });
  await service.generate(deps(), CFG, { uid: 'u2', input: input() });
  const ai = createMockClient();
  await rejectsWith(service.generate(deps({ ai: { client: ai, provider: 'mock' } }), CFG, { uid: 'u2', input: input() }), 'insufficient_credits');
  assert.equal(ai.calls.length, 0, 'AI 를 호출하지 않음');
  assert.equal((await db.collection('generations').where('uid', '==', 'u2').get()).size, 2);
  await assertInvariant('u2');
});

test('③ Claude 요청 구성 (mock 이 받은 파라미터 검증 — 실제 API 호출 아님)', async () => {
  await newUser('u3');
  const ai = createMockClient();
  const naver = { clientId: 'x', clientSecret: 'y', find: async () => ({ name: '바 알팔파', address: '세비야 알팔파 광장', tel: '', category: '스페인음식' }) };
  const r = await service.generate(deps({ ai: { client: ai, provider: 'mock' }, naver }), CFG, { uid: 'u3', input: input({ memo: '남편이랑 방문', images: [JPEG, JPEG] }) });
  const p = ai.calls[0];
  assert.equal(p.model, 'claude-sonnet-4-6');
  assert.equal(p.max_tokens, 8192);
  assert.equal(p.tools[0].type, 'web_search_20260209');
  const content = p.messages[0].content;
  assert.deepEqual(content.map((c) => c.type), ['image', 'image', 'text']);
  const prompt = content[2].text;
  for (const s of ['SEO 전문 작성자', '메모:남편이랑 방문', '분량:1500~1800자', '사진:2장', '[사진 배치 규칙]', '[네이버 지도 검색 결과]', '업체명: 바 알팔파', '"reel"', '"thumbnail"', '"hashtags"', '💡잰잇의 팁']) {
    assert.ok(prompt.includes(s), `prompt includes ${s}`);
  }
  assert.equal(r.naver.name, '바 알팔파');
});

for (const [marker, reason] of [['[[mock:error]]', 'ai_unavailable'], ['[[mock:overloaded]]', 'ai_unavailable'], ['[[mock:auth]]', 'ai_config'], ['[[mock:refusal]]', 'ai_refusal'], ['[[mock:empty]]', 'ai_empty_result']]) {
  test(`④ API 오류 시 크레딧 복구: ${marker} → ${reason}`, async () => {
    await newUser('u4');
    const inp = input({ memo: marker, images: [JPEG] });
    await assert.rejects(service.generate(deps(), CFG, { uid: 'u4', input: inp }), (e) => {
      assert.equal(e.details.reason, reason);
      assert.equal(e.details.refunded, true);
      assert.equal(e.details.creditsRemaining, 2);
      assert.match(e.message, /복구/);
      return true;
    });
    const u = await assertInvariant('u4');
    assert.deepEqual([u.credits, u.activeGenerations, u.storageBytes], [2, 0, 0]);
    const g = (await db.doc(`generations/${service.generationIdOf('u4', inp.clientRequestId)}`).get()).data();
    assert.equal(g.status, 'failed');
    assert.equal(g.charge.status, 'refunded');
    assert.equal(g.error.reason, reason);
    const [files] = await bucket.getFiles({ prefix: 'users/u4/' });
    assert.equal(files.length, 0, '실패 시 업로드 사진 삭제');
    const l = await ledger('u4');
    assert.deepEqual(l.map((x) => x.type).sort(), ['generation', 'refund', 'signup_bonus']);
  });
}

test('④ AI 응답 시간 초과(타임아웃) → 복구', async () => {
  await newUser('u4t');
  await rejectsWith(service.generate(deps(), { ...CFG, claudeTimeoutMs: 200 }, { uid: 'u4t', input: input({ memo: '[[mock:slow:3000]]' }) }), 'ai_timeout');
  assert.equal((await assertInvariant('u4t')).credits, 2);
});

test('⑤ 함수 중단(네트워크·인스턴스 종료)으로 processing 에 남은 건 → lease 만료 후 조회/스케줄러가 복구', async () => {
  await newUser('u5');
  const now = Date.now();
  const a = input(); const b = input();
  const idA = service.generationIdOf('u5', a.clientRequestId);
  const idB = service.generationIdOf('u5', b.clientRequestId);
  // 예약까지만 하고 AI 단계에서 죽은 상황
  await service.reserve(db, { uid: 'u5', generationId: idA, input: a, imageBytes: 0, cfg: CFG, provider: 'mock', nowMs: now });
  await service.reserve(db, { uid: 'u5', generationId: idB, input: b, imageBytes: 0, cfg: CFG, provider: 'mock', nowMs: now });
  assert.equal((await user('u5')).credits, 0);
  // lease 전: 아직 처리 중
  assert.equal((await service.getStatus(db, bucket, { uid: 'u5', generationId: idA, nowMs: now + 1000 })).status, 'processing');
  // lease 후 조회 → 즉시 복구
  const s = await service.getStatus(db, bucket, { uid: 'u5', generationId: idA, nowMs: now + 361_000 });
  assert.deepEqual([s.status, s.refunded, s.error.reason], ['failed', true, 'timeout_recovered']);
  // 나머지는 스케줄러가 복구
  assert.equal(await service.sweepStale(db, bucket, now + 361_000), 1);
  assert.equal(await service.sweepStale(db, bucket, now + 400_000), 0, '두 번 복구하지 않음');
  const u = await assertInvariant('u5');
  assert.deepEqual([u.credits, u.activeGenerations], [2, 0]);
  // 다른 사용자는 조회 불가
  await assert.rejects(service.getStatus(db, bucket, { uid: 'someone', generationId: idB, nowMs: now }), (e) => e.code === 'not-found');
});

test('⑥ 더블클릭: 같은 요청 5번 동시 전송 → 1번만 실행·차감', async () => {
  await newUser('u6');
  const ai = createMockClient();
  const inp = input();
  const rs = await Promise.allSettled(Array.from({ length: 5 }, () => service.generate(deps({ ai: { client: ai, provider: 'mock' } }), CFG, { uid: 'u6', input: inp })));
  const ok = rs.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  assert.ok(ok.length >= 1);
  assert.ok(ok.every((v) => v.generationId === service.generationIdOf('u6', inp.clientRequestId)));
  assert.equal(ok.filter((v) => !v.duplicate).length, 1, '실제 실행은 1건');
  assert.equal(ai.calls.length, 1, 'AI 호출 1회');
  const u = await assertInvariant('u6');
  assert.equal(u.credits, 1);
  // 완료 후 같은 요청을 다시 보내면 저장된 결과를 차감 없이 반환
  const again = await service.generate(deps(), CFG, { uid: 'u6', input: inp });
  assert.deepEqual([again.duplicate, again.status], [true, 'succeeded']);
  assert.equal((await user('u6')).credits, 1);
});

test('⑦ 여러 기기 동시 요청: 잔액 1개에 서로 다른 요청 4건 → 정확히 1건만 성공, 잔액 음수 불가', async () => {
  await newUser('u7');
  await adminAdjustCredits(db, { uid: 'u7', delta: -1, reason: '테스트용 회수', requestId: 'req_u7_setup', actorUid: 't' });
  const rs = await Promise.allSettled(Array.from({ length: 4 }, () => service.generate(deps(), CFG, { uid: 'u7', input: input() })));
  const ok = rs.filter((r) => r.status === 'fulfilled');
  const bad = rs.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  bad.forEach((r) => assert.equal(r.reason.details.reason, 'insufficient_credits'));
  const u = await assertInvariant('u7');
  assert.equal(u.credits, 0);
});

test('⑦ 동시 실행 상한: 생성 중인 건이 있으면 추가 요청 거부 (크레딧 차감 없음)', async () => {
  await newUser('u7b');
  const slow = service.generate(deps(), { ...CFG, maxConcurrent: 1 }, { uid: 'u7b', input: input({ memo: '[[mock:slow:1500]]' }) });
  await new Promise((r) => setTimeout(r, 300));
  await rejectsWith(service.generate(deps(), { ...CFG, maxConcurrent: 1 }, { uid: 'u7b', input: input() }), 'too_many_concurrent');
  await slow;
  const u = await assertInvariant('u7b');
  assert.deepEqual([u.credits, u.activeGenerations], [1, 0]);
});

test('⑧ 사진 여러 장: Storage 저장 + 분석 요청 + 본문 [사진N] 배치 + 용량 집계', async () => {
  await newUser('u8');
  const ai = createMockClient();
  const r = await service.generate(deps({ ai: { client: ai, provider: 'mock' } }), CFG, { uid: 'u8', input: input({ images: [JPEG, JPEG, JPEG] }) });
  assert.equal(ai.calls[0].messages[0].content.filter((c) => c.type === 'image').length, 3);
  assert.equal(r.photos.length, 3);
  for (let i = 1; i <= 3; i++) assert.ok(r.result.body.includes(`[사진${i}]`));
  const [files] = await bucket.getFiles({ prefix: `users/u8/generations/${r.generationId}/` });
  assert.equal(files.length, 3);
  const [meta] = await files[0].getMetadata();
  assert.equal(meta.contentType, 'image/jpeg');
  const bytes = Buffer.from(JPEG.split(',')[1], 'base64').length;
  assert.equal((await user('u8')).storageBytes, bytes * 3);
});

test('속도 제한(분당)·일일 한도·저장 용량 초과는 차감 없이 거부', async () => {
  await newUser('u9');
  await adminAdjustCredits(db, { uid: 'u9', delta: 10, reason: '테스트', requestId: 'req_u9_setup', actorUid: 't' });
  const cfg = { ...CFG, rateLimitPerMinute: 2 };
  const t0 = Date.parse('2026-11-10T03:00:00Z');
  await service.generate({ ...deps(), now: () => t0 }, cfg, { uid: 'u9', input: input() });
  await service.generate({ ...deps(), now: () => t0 + 1000 }, cfg, { uid: 'u9', input: input() });
  await rejectsWith(service.generate({ ...deps(), now: () => t0 + 2000 }, cfg, { uid: 'u9', input: input() }), 'rate_limited');
  // 1분 지나면 다시 가능
  await service.generate({ ...deps(), now: () => t0 + 61_000 }, cfg, { uid: 'u9', input: input() });
  // 일일 한도 3
  await rejectsWith(service.generate({ ...deps(), now: () => t0 + 130_000 }, { ...CFG, dailyLimit: 3 }, { uid: 'u9', input: input() }), 'daily_limit');
  // 용량
  await rejectsWith(service.generate({ ...deps(), now: () => t0 + 200_000 }, { ...CFG, storageQuotaBytes: 10 }, { uid: 'u9', input: input({ images: [JPEG] }) }), 'storage_quota');
  const u = await assertInvariant('u9');
  assert.equal(u.credits, 12 - 3);
  assert.equal(u.usage.dayCount, 3);
});

test('토큰 사용량·예상 비용·지연시간 기록', async () => {
  await newUser('u10');
  const r = await service.generate(deps(), CFG, { uid: 'u10', input: input({ images: [JPEG] }) });
  const g = (await db.doc(`generations/${r.generationId}`).get()).data();
  assert.ok(g.usage.inputTokens > 0 && g.usage.outputTokens > 0);
  assert.equal(g.usage.webSearchRequests, 2);
  const expected = Math.round((g.usage.inputTokens * 3 / 1e6 + g.usage.outputTokens * 15 / 1e6 + 2 * 0.01) * 1e6) / 1e6;
  assert.equal(g.costUsd, expected);
  assert.equal(g.model, 'claude-sonnet-4-6');
  assert.equal(typeof g.latencyMs, 'number');
  assert.equal(g.provider, 'mock');
  assert.ok(!JSON.stringify(g).includes('sk-ant'), '키 미기록');
});

test('무료 우선 사용 & 실패 시 차감했던 버킷으로 복구', async () => {
  await newUser('u11');
  await adminAdjustCredits(db, { uid: 'u11', delta: 3, reason: '유료 가정', requestId: 'req_u11_paid', actorUid: 't', bucket: 'paid' });
  await service.generate(deps(), CFG, { uid: 'u11', input: input() });
  await service.generate(deps(), CFG, { uid: 'u11', input: input() });
  let u = await assertInvariant('u11');
  assert.deepEqual([u.freeCredits, u.paidCredits], [0, 3], '무료 2개 먼저 사용');
  await assert.rejects(service.generate(deps(), CFG, { uid: 'u11', input: input({ memo: '[[mock:error]]' }) }));
  u = await assertInvariant('u11');
  assert.deepEqual([u.freeCredits, u.paidCredits], [0, 3], '유료에서 차감 → 유료로 복구');
  await service.generate(deps(), CFG, { uid: 'u11', input: input() });
  u = await assertInvariant('u11');
  assert.deepEqual([u.freeCredits, u.paidCredits], [0, 2]);
});

test('STEP 1 형식 사용자(버킷 필드 없음)도 정상 차감', async () => {
  await db.doc('users/legacy1').set({ uid: 'legacy1', email: 'l@x.com', credits: 2, signupBonus: { status: 'granted', amount: 2 } });
  await db.doc('creditLedger/signup_bonus_legacy1').set({ uid: 'legacy1', type: 'signup_bonus', delta: 2, balanceAfter: 2 });
  await service.generate(deps(), CFG, { uid: 'legacy1', input: input() });
  const u = await assertInvariant('legacy1');
  assert.deepEqual([u.credits, u.freeCredits, u.paidCredits], [1, 1, 0]);
});
