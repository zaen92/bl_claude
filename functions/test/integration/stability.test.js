'use strict';
// STEP 2.5 안정화: 이중 환급 방지, 서비스 게이트, 사진 보관 정책, 삭제 작업 재시도, 회원 탈퇴
// Firestore + Storage 에뮬레이터, Claude = mock (실제 API 아님)
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { ensureUserProfile } = require('../../src/lib/credits');
const service = require('../../src/generation/service');
const retention = require('../../src/storage/retention');
const jobs = require('../../src/storage/deletionJobs');
const { deleteAccountData } = require('../../src/account/deleteAccount');
const { createMockClient } = require('../../src/ai/mockClient');
const { validateGenerateInput } = require('../../src/api/validate');

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) throw new Error('npm run test:emu 로 실행하세요');
const app = getApps()[0] || initializeApp({ projectId: 'demo-jaeinit', storageBucket: 'demo-jaeinit.appspot.com' });
const db = getFirestore(app);
const bucket = getStorage(app).bucket();
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const CFG = { model: 'claude-sonnet-4-6', maxTokens: 8192, claudeTimeoutMs: 10_000, webSearchMaxUses: 5, webSearchToolType: 'auto', rateLimitPerMinute: 100, dailyLimit: 100, maxConcurrent: 5, storageQuotaBytes: 200 * 1024 * 1024, leaseSeconds: 360, dailyCostLimitUsd: 0 };
const DAY = 86400000;
let seq = 0;
const input = (over = {}) => validateGenerateInput({ title: '세비야 맛집', type: '맛집', content: '살모레호', volume: 'normal', images: [], clientRequestId: `req_st_${Date.now()}_${++seq}`, ...over });
const deps = (over = {}) => ({ db, bucket, ai: { client: createMockClient(), provider: 'mock' }, naver: null, logger: null, gateCacheMs: 0, ...over });
const newUser = (uid) => ensureUserProfile(db, { uid, email: `${uid}@x.com`, emailVerified: true });
const user = async (uid) => (await db.doc(`users/${uid}`).get()).data();
const ledger = async (uid) => (await db.collection('creditLedger').where('uid', '==', uid).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const files = async (prefix) => (await bucket.getFiles({ prefix }))[0];
async function invariant(uid) {
  const u = await user(uid); const l = await ledger(uid);
  assert.equal(u.credits, l.reduce((s, x) => s + x.delta, 0));
  assert.equal(u.credits, u.freeCredits + u.paidCredits);
  return u;
}
test.beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-jaeinit/databases/(default)/documents`, { method: 'DELETE' });
  service.resetGateCache();
});

test('이중 환급 방지: 함수 중단 건에 조회·스케줄러·실패처리가 동시에 복구를 시도해도 환급 1회', async () => {
  await newUser('d1');
  const now = Date.now();
  const inp = input();
  const id = service.generationIdOf('d1', inp.clientRequestId);
  await service.reserve(db, { uid: 'd1', generationId: id, input: inp, imageBytes: 0, cfg: CFG, provider: 'mock', nowMs: now });
  const later = now + 400_000;
  await Promise.all([
    service.recoverIfStale(db, bucket, id, later),
    service.recoverIfStale(db, bucket, id, later),
    service.sweepStale(db, bucket, later),
    service.getStatus(db, bucket, { uid: 'd1', generationId: id, nowMs: later }),
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

test('사진 보관: 90일 지난 미저장 생성 사진 삭제 / 저장 글이 참조하면 유지 / 글 삭제 후 다음 검사에서 삭제', async () => {
  await newUser('r1');
  const a = await service.generate(deps(), CFG, { uid: 'r1', input: input({ images: [JPEG, JPEG] }) }); // 저장 안 함
  const b = await service.generate(deps(), CFG, { uid: 'r1', input: input({ images: [JPEG] }) });      // 저장함
  await db.collection('posts').doc('p_b').set({ uid: 'r1', title: 't', data: b.result, generationId: b.generationId, photos: b.photos, createdAt: new Date(), updatedAt: new Date() });
  const bytesBefore = (await user('r1')).storageBytes;
  assert.ok(bytesBefore > 0);

  // 89일: 아무것도 안 함
  assert.deepEqual(await retention.scanExpired(db, Date.now() + 89 * DAY), { kept: 0, queued: 0, skipped: 0 });
  // 91일: a 는 삭제 작업 등록, b 는 저장 글 때문에 유지(7일 뒤 재검사)
  const t91 = Date.now() + 91 * DAY;
  assert.deepEqual(await retention.scanExpired(db, t91), { kept: 1, queued: 1, skipped: 0 });
  assert.equal((await db.doc(`generations/${a.generationId}`).get()).data().photosState, 'deleting');
  const rj = await jobs.processJobs(db, bucket, t91);
  assert.equal(rj.done, 1);
  const ga = (await db.doc(`generations/${a.generationId}`).get()).data();
  assert.deepEqual([ga.photosState, ga.photos.length, ga.status], ['deleted', 0, 'succeeded']);
  assert.ok(ga.result.body, '생성 결과(글)는 보존');
  assert.equal((await files(`users/r1/generations/${a.generationId}/`)).length, 0);
  assert.equal((await files(`users/r1/generations/${b.generationId}/`)).length, 1, '저장 글 사진 유지');
  const u = await user('r1');
  assert.ok(u.storageBytes < bytesBefore && u.storageBytes > 0, '삭제한 만큼 용량 반환');
  // 저장 글 데이터 손상 없음
  const post = (await db.doc('posts/p_b').get()).data();
  assert.equal(post.photos.length, 1);

  // 글 삭제 → 다음 재검사(7일 후)에서 삭제
  await db.doc('posts/p_b').delete();
  const t99 = t91 + 8 * DAY;
  assert.deepEqual(await retention.scanExpired(db, t99), { kept: 0, queued: 1, skipped: 0 });
  await jobs.processJobs(db, bucket, t99);
  assert.equal((await files('users/r1/')).length, 0);
  assert.equal((await user('r1')).storageBytes, 0);
  // 다시 실행해도 변화 없음 (멱등)
  assert.deepEqual(await retention.scanExpired(db, t99 + DAY), { kept: 0, queued: 0, skipped: 0 });
});

test('삭제 작업 실패 → 지수 백오프 재시도 → 5회 실패 시 failed (관리자 확인) → 관리자 재시도로 완료', async () => {
  const now = Date.now();
  let failing = true;
  const flaky = {
    file: (p) => ({ delete: async () => { if (failing) { const e = new Error('storage unavailable'); e.code = 503; throw e; } return bucket.file(p).delete({ ignoreNotFound: true }); } }),
    deleteFiles: (o) => bucket.deleteFiles(o), getFiles: (o) => bucket.getFiles(o),
  };
  await bucket.file('users/j1/generations/g/photo_1.jpg').save(Buffer.from('x'), { resumable: false });
  await jobs.enqueue(db, 'gen_test', { type: 'paths', uid: null, paths: ['users/j1/generations/g/photo_1.jpg'], bytesToRelease: 0 }, now);
  let t = now;
  for (let i = 1; i <= 5; i++) {
    const r = await jobs.processJobs(db, flaky, t);
    const j = (await db.doc('photoDeletionJobs/gen_test').get()).data();
    assert.equal(j.attempts, i);
    if (i < 5) { assert.equal(r.retry, 1); assert.equal(j.status, 'pending'); assert.equal(j.lastError.code, 503); }
    else { assert.equal(r.failed, 1); assert.equal(j.status, 'failed'); }
    // 백오프 전에는 다시 실행되지 않음
    assert.equal((await jobs.processJobs(db, flaky, t + 1000)).retry + (await jobs.processJobs(db, flaky, t + 1000)).failed, 0);
    t = j.nextAttemptAt.toMillis();
  }
  assert.equal((await jobs.processJobs(db, flaky, t + 1e9)).skipped + (await jobs.processJobs(db, flaky, t + 1e9)).done, 0, 'failed 는 자동 재시도 안 함');
  failing = false;
  await jobs.resetJob(db, 'gen_test', t);
  assert.equal(await jobs.runJob(db, flaky, 'gen_test', t), 'done');
  assert.equal((await files('users/j1/')).length, 0);
});

test('생성 실패 시 사진 즉시 삭제 실패 → 삭제 작업으로 넘어감 (용량은 즉시 반환)', async () => {
  await newUser('j2');
  const brokenDelete = { file: (p) => bucket.file(p), deleteFiles: async () => { throw new Error('down'); }, getFiles: (o) => bucket.getFiles(o) };
  const inp = input({ memo: '[[mock:error]]', images: [JPEG] });
  await assert.rejects(service.generate(deps({ bucket: brokenDelete }), CFG, { uid: 'j2', input: inp }));
  const id = service.generationIdOf('j2', inp.clientRequestId);
  const job = (await db.doc(`photoDeletionJobs/failed_${id}`).get()).data();
  assert.equal(job.type, 'prefix');
  assert.equal((await user('j2')).storageBytes, 0);
  assert.equal((await files(`users/j2/`)).length, 1);
  await jobs.processJobs(db, bucket, Date.now() + 1000);
  assert.equal((await files(`users/j2/`)).length, 0);
});

test('회원 탈퇴: 사진·글·생성 기록·프로필 삭제, 원장·비용 지표·가입이력은 보관, 다른 회원 데이터는 그대로, 재실행 멱등', async () => {
  await newUser('w1'); await newUser('w2');
  const a = await service.generate(deps(), CFG, { uid: 'w1', input: input({ images: [JPEG, JPEG] }) });
  const o = await service.generate(deps(), CFG, { uid: 'w2', input: input({ images: [JPEG] }) });
  await db.collection('posts').doc('pw1').set({ uid: 'w1', title: 't', data: a.result, generationId: a.generationId, photos: a.photos, createdAt: new Date(), updatedAt: new Date() });
  const r = await deleteAccountData(db, bucket, 'w1', { source: 'test' });
  assert.deepEqual([r.storage, r.posts, r.generations], ['deleted', 1, 1]);
  assert.equal((await files('users/w1/')).length, 0);
  assert.equal((await db.doc('users/w1').get()).exists, false);
  assert.equal((await db.collection('posts').where('uid', '==', 'w1').get()).size, 0);
  assert.equal((await db.collection('generations').where('uid', '==', 'w1').get()).size, 0);
  assert.ok((await ledger('w1')).length >= 2, '원장 보관');
  assert.ok((await db.doc(`generationMetrics/${a.generationId}`).get()).exists, '비용 지표 보관 (입력 내용 없음)');
  assert.equal((await db.collection('signupGrants').get()).size, 2, '재가입 악용 방지 해시 보관');
  assert.equal((await db.doc('accountDeletions/w1').get()).data().status, 'done');
  // 다른 회원 영향 없음
  assert.equal((await files(`users/w2/generations/${o.generationId}/`)).length, 1);
  assert.ok((await db.doc('users/w2').get()).exists);
  // 재실행(트리거 중복 등) 안전
  const r2 = await deleteAccountData(db, bucket, 'w1', { source: 'auth_trigger' });
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
