'use strict';
// 안정화: 이중 환급 방지, 서비스 게이트, 회원 탈퇴, 허용 목록
// Firestore 에뮬레이터, Claude = mock (실제 API 아님)
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { ensureUserProfile } = require('../../src/lib/credits');
const service = require('../../src/generation/service');
const { deleteAccountData } = require('../../src/account/deleteAccount');
const { createMockClient } = require('../../src/ai/mockClient');
const { validateGenerateInput } = require('../../src/api/validate');

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('npm run test:emu 로 실행하세요');
const app = getApps()[0] || initializeApp({ projectId: 'demo-jaeinit' });
const db = getFirestore(app);
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const CFG = { model: 'claude-sonnet-4-6', maxTokens: 8192, claudeTimeoutMs: 10_000, webSearchMaxUses: 5, webSearchToolType: 'auto', rateLimitPerMinute: 100, dailyLimit: 100, maxConcurrent: 5, leaseSeconds: 360, dailyCostLimitUsd: 0 };
let seq = 0;
const input = (over = {}) => validateGenerateInput({ title: '세비야 맛집', type: '맛집', content: '살모레호', volume: 'normal', images: [], clientRequestId: `req_st_${Date.now()}_${++seq}`, ...over });
const deps = (over = {}) => ({ db, ai: { client: createMockClient(), provider: 'mock' }, naver: null, logger: null, gateCacheMs: 0, ...over });
const newUser = (uid) => ensureUserProfile(db, { uid, email: `${uid}@x.com`, emailVerified: true });
const user = async (uid) => (await db.doc(`users/${uid}`).get()).data();
const ledger = async (uid) => (await db.collection('creditLedger').where('uid', '==', uid).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
async function invariant(uid) {
  const u = await user(uid); const l = await ledger(uid);
  assert.equal(u.credits, l.reduce((s, x) => s + x.delta, 0));
  assert.equal(u.credits, u.freeCredits + u.paidCredits);
  return u;
}
// 이 파일의 시나리오는 "가입 무료 2크레딧" 기준 — 운영 설정(config/policy)으로 2개를 지정해 유지 (기본값 5 검증은 features.test.js)
test.beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-jaeinit/databases/(default)/documents`, { method: 'DELETE' });
  await db.doc('config/policy').set({ signupBonusCredits: 2 });
  if (service.resetGateCache) service.resetGateCache();
});

test('이중 환급 방지: 함수 중단 건에 조회·스케줄러·실패처리가 동시에 복구를 시도해도 환급 1회', async () => {
  await newUser('d1');
  const now = Date.now();
  const inp = input();
  const id = service.generationIdOf('d1', inp.clientRequestId);
  await service.reserve(db, { uid: 'd1', generationId: id, input: inp, imageBytes: 0, cfg: CFG, provider: 'mock', nowMs: now });
  const later = now + 400_000;
  await Promise.all([
    service.recoverIfStale(db, id, later),
    service.recoverIfStale(db, id, later),
    service.sweepStale(db, later),
    service.getStatus(db, { uid: 'd1', generationId: id, nowMs: later }),
    service.refund(db, { generationId: id, reason: 'ai_timeout', retryable: true, nowMs: later }),
  ]);
  const l = await ledger('d1');
  assert.equal(l.filter((x) => x.type === 'refund').length, 1);
  const u = await invariant('d1');
  assert.deepEqual([u.credits, u.activeGenerations], [2, 0]);
  // 복구 후 늦게 도착한 성공 결과는 반영되지 않음 (이중 처리 없음)
  const fin = await service.finalize(db, { uid: 'd1', generationId: id, result: { body: 'x' }, naver: null, aiMeta: { usage: null, model: 'm' }, photos: [], nowMs: later });
  assert.equal(fin.finalized, false);
  assert.equal((await invariant('d1')).credits, 2);
});

test('타임아웃 후 같은 요청 재전송: 추가 차감·추가 AI 호출 없이 실패(복구됨) 상태 반환', async () => {
  await newUser('d2');
  const ai = createMockClient();
  const inp = input({ memo: '[[mock:slow:3000]]' });
  await assert.rejects(service.generate(deps({ ai: { client: ai, provider: 'mock' } }), { ...CFG, claudeTimeoutMs: 200 }, { uid: 'd2', input: inp }), (e) => e.details.reason === 'ai_timeout');
  const again = await service.generate(deps({ ai: { client: ai, provider: 'mock' } }), CFG, { uid: 'd2', input: inp });
  assert.deepEqual([again.duplicate, again.status, again.refunded], [true, 'failed', true]);
  assert.equal(ai.calls.length, 1);
  const m = (await db.doc(`generationMetrics/${again.generationId}`).get()).data();
  assert.equal(m.failureReason, 'ai_timeout');
  assert.ok(['partial_lower_bound', 'unknown'].includes(m.billing), m.billing);
  assert.equal((await invariant('d2')).credits, 2);
});

test('서비스 게이트: 일시중지·일일 비용 상한 → 차감 없이 거부, 기존 요청 재조회는 허용', async () => {
  await newUser('d3');
  const done = await service.generate(deps(), CFG, { uid: 'd3', input: input() });
  await db.doc('config/service').set({ generationEnabled: false, pauseMessage: '점검 중이에요' });
  const ai = createMockClient();
  await assert.rejects(service.generate(deps({ ai: { client: ai, provider: 'mock' } }), CFG, { uid: 'd3', input: input() }), (e) => e.details.reason === 'service_paused' && e.message === '점검 중이에요');
  assert.equal(ai.calls.length, 0);
  // 이미 끝난 요청의 재전송은 게이트와 무관하게 결과 반환
  const dup = await service.generate(deps(), CFG, { uid: 'd3', input: { ...input(), clientRequestId: done.generationId.split('_').slice(1).join('_') } });
  assert.equal(dup.duplicate, true);
  await db.doc('config/service').set({ generationEnabled: true, dailyCostLimitUsd: 0.000001 });
  await assert.rejects(service.generate(deps(), CFG, { uid: 'd3', input: input() }), (e) => e.details.reason === 'daily_budget_exceeded');
  await db.doc('config/service').delete();
  await assert.rejects(service.generate(deps(), { ...CFG, dailyCostLimitUsd: 0.000001 }, { uid: 'd3', input: input() }), (e) => e.details.reason === 'daily_budget_exceeded');
  assert.equal((await invariant('d3')).credits, 1);
});

test('회원 탈퇴: 글·생성 기록·프로필 삭제, 원장·비용 지표·가입이력은 보관, 다른 회원 데이터는 그대로, 재실행 멱등', async () => {
  await newUser('w1'); await newUser('w2');
  const a = await service.generate(deps(), CFG, { uid: 'w1', input: input({ images: [JPEG, JPEG] }) });
  const o = await service.generate(deps(), CFG, { uid: 'w2', input: input() });
  await db.collection('posts').doc('pw1').set({ uid: 'w1', title: 't', data: a.result, generationId: a.generationId, input: { title: 't', imageCount: 2 }, createdAt: new Date(), updatedAt: new Date() });
  const r = await deleteAccountData(db, 'w1', { source: 'test' });
  assert.deepEqual([r.posts, r.generations], [1, 1]);
  assert.equal((await db.doc('users/w1').get()).exists, false);
  assert.equal((await db.collection('posts').where('uid', '==', 'w1').get()).size, 0);
  assert.equal((await db.collection('generations').where('uid', '==', 'w1').get()).size, 0);
  assert.ok((await ledger('w1')).length >= 2, '원장 보관');
  assert.ok((await db.doc(`generationMetrics/${a.generationId}`).get()).exists, '비용 지표 보관 (입력 내용 없음)');
  assert.equal((await db.collection('signupGrants').get()).size, 2, '재가입 악용 방지 해시 보관');
  assert.equal((await db.doc('accountDeletions/w1').get()).data().status, 'done');
  assert.ok((await db.doc(`generations/${o.generationId}`).get()).exists, '다른 회원 영향 없음');
  assert.ok((await db.doc('users/w2').get()).exists);
  const r2 = await deleteAccountData(db, 'w1', { source: 'auth_trigger' });
  assert.deepEqual([r2.posts, r2.generations], [0, 0]);
});

test('스테이징 허용 목록: allowlist 모드에서 초대된 이메일·관리자만 생성, 그 외 차감 없이 거부 (설정 없으면 관리자만)', async () => {
  await newUser('al1'); await newUser('al2');
  const cfg = { ...CFG, accessMode: 'allowlist' };
  const ai = createMockClient();
  // 설정 문서 없음 → 일반 사용자 거부 (fail closed)
  await assert.rejects(service.generate(deps({ ai: { client: ai, provider: 'mock' } }), cfg, { uid: 'al1', input: input(), caller: { email: 'al1@x.com' } }), (e) => e.details.reason === 'not_allowlisted' && e.code === 'permission-denied');
  // 관리자는 허용
  await service.generate(deps(), cfg, { uid: 'al2', input: input(), caller: { email: 'al2@x.com', admin: true } });
  // 초대 이메일 (대소문자 무시)
  await db.doc('config/service').set({ allowedEmails: ['AL1@x.com'] });
  service.resetGateCache();
  await service.generate(deps(), cfg, { uid: 'al1', input: input(), caller: { email: 'al1@X.com' } });
  // config 의 accessMode 가 env 보다 우선
  await db.doc('config/service').set({ accessMode: 'open' });
  service.resetGateCache();
  await service.generate(deps(), cfg, { uid: 'al1', input: input(), caller: { email: 'someone@x.com' } });
  assert.equal(ai.calls.length, 0);
  assert.equal((await user('al1')).credits, 0);
  assert.equal((await user('al2')).credits, 1);
});
