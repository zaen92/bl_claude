'use strict';
// Functions + Auth 에뮬레이터를 통한 callable 엔드투엔드 테스트 — `npm run test:emu`
const test = require('node:test');
const assert = require('node:assert/strict');

const PROJECT = 'demo-jaeinit';
const REGION = 'asia-northeast3';
const FN = `http://127.0.0.1:5001/${PROJECT}/${REGION}`;
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099'}`;
const FS = `http://${process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'}`;

async function call(name, data, idToken) {
  const res = await fetch(`${FN}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ data }),
  });
  return { status: res.status, body: await res.json() };
}

async function signUp(email, password = 'pw123456') {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const j = await r.json();
  return { uid: j.localId, idToken: j.idToken };
}

async function verifyEmail(uid) {
  // 에뮬레이터 관리 API (owner 토큰)로 이메일 인증 처리
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ localId: uid, emailVerified: true }),
  });
  assert.equal(r.status, 200);
}

test.before(async () => {
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await fetch(`${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
});

test('비로그인: 모든 callable 이 unauthenticated', async () => {
  for (const name of ['ensureUserProfile', 'generatePost', 'getGenerationStatus', 'createOrder', 'confirmPayment', 'adminAdjustCredits', 'deleteAccount', 'adminCheckAiConfig', 'savePost', 'deletePost', 'authorizeExport', 'saveStyle', 'deleteStyle', 'adminSetPlan']) {
    const r = await call(name, {});
    assert.equal(r.status, 401, name);
    assert.equal(r.body.error.status, 'UNAUTHENTICATED', name);
  }
});

test('이메일 가입 → 미인증 0크레딧 → 인증 후 5크레딧 (동시 호출 포함)', async () => {
  const u = await signUp('flow@x.com');
  const r1 = await call('ensureUserProfile', {}, u.idToken);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.result.signupBonusStatus, 'pending_verification');
  assert.equal(r1.body.result.credits, 0);

  await verifyEmail(u.uid);
  // 서버는 토큰이 아닌 Admin Auth 의 최신 emailVerified 를 사용 → 기존 토큰으로도 지급됨
  const many = await Promise.all(Array.from({ length: 8 }, () => call('ensureUserProfile', {}, u.idToken)));
  const ok = many.filter((r) => r.status === 200);
  assert.ok(ok.length >= 1);
  assert.equal(ok.filter((r) => r.body.result.granted).length, 1);
  const again = await call('ensureUserProfile', {}, u.idToken);
  assert.equal(again.body.result.credits, 5);
});

const GOOD = (id) => ({ title: '세비야 맛집', type: '맛집', content: '살모레호 맛있음', volume: 'normal', images: ['data:image/jpeg;base64,/9j/AAAA', 'data:image/jpeg;base64,/9j/BBBB'], clientRequestId: id });

test('generatePost: 이메일 미인증 사용자는 생성 불가 (차감 없음)', async () => {
  const u = await signUp('unverified@x.com');
  await call('ensureUserProfile', {}, u.idToken);
  const r = await call('generatePost', GOOD('req_unverified1'), u.idToken);
  assert.equal(r.status, 400);
  assert.equal(r.body.error.status, 'FAILED_PRECONDITION');
  assert.equal(r.body.error.details.reason, 'email_not_verified');
});

test('generatePost(에뮬레이터 mock AI): 무료 5회 성공 → 6회째 차단, 상태 조회, 타인 조회 차단, 응답에 키 없음', async () => {
  const u = await signUp('gen@x.com');
  await verifyEmail(u.uid);
  await call('ensureUserProfile', {}, u.idToken);
  const bad = await call('generatePost', { ...GOOD('req_badinput1'), title: '' }, u.idToken);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.status, 'INVALID_ARGUMENT');

  const r1 = await call('generatePost', GOOD('req_gen_00001'), u.idToken);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const g1 = r1.body.result;
  assert.deepEqual([g1.status, g1.mock, g1.creditsRemaining, g1.imageCount], ['succeeded', true, 4, 2]);
  assert.ok(!JSON.stringify(r1.body).includes('/9j/'), '응답에 사진 데이터 없음');
  assert.ok(g1.result.body.includes('[사진1]') && g1.result.body.includes('[사진2]'));
  assert.ok(!JSON.stringify(r1.body).match(/sk-ant|x-api-key|ANTHROPIC/i));

  // 같은 요청 재전송 → 중복 차감 없이 같은 결과
  const dup = await call('generatePost', GOOD('req_gen_00001'), u.idToken);
  assert.deepEqual([dup.body.result.duplicate, dup.body.result.generationId], [true, g1.generationId]);

  let last;
  for (const n of [2, 3, 4, 5]) last = await call('generatePost', GOOD(`req_gen_0000${n}`), u.idToken);
  assert.equal(last.body.result.creditsRemaining, 0);
  const r3 = await call('generatePost', GOOD('req_gen_00006'), u.idToken);
  assert.equal(r3.body.error.status, 'FAILED_PRECONDITION');
  assert.equal(r3.body.error.details.reason, 'insufficient_credits');

  const st = await call('getGenerationStatus', { generationId: g1.generationId }, u.idToken);
  assert.equal(st.body.result.status, 'succeeded');
  const other = await signUp('other@x.com');
  const st2 = await call('getGenerationStatus', { generationId: g1.generationId }, other.idToken);
  assert.equal(st2.body.error.status, 'NOT_FOUND');
});

test('generatePost(mock AI 오류): 실패 응답에 크레딧 복구 안내 + 잔액 유지', async () => {
  const u = await signUp('fail@x.com');
  await verifyEmail(u.uid);
  await call('ensureUserProfile', {}, u.idToken);
  const r = await call('generatePost', { ...GOOD('req_fail_0001'), memo: '[[mock:error]]' }, u.idToken);
  assert.equal(r.body.error.status, 'UNAVAILABLE');
  assert.deepEqual([r.body.error.details.refunded, r.body.error.details.creditsRemaining], [true, 5]);
  assert.match(r.body.error.message, /복구/);
});

test('createOrder / confirmPayment: 인터페이스만 존재 (unimplemented)', async () => {
  const u = await signUp('pay@x.com');
  const r = await call('createOrder', { packageId: 'p10' }, u.idToken);
  assert.equal(r.body.error.status, 'UNIMPLEMENTED');
});

test('adminAdjustCredits: 일반 사용자 거부', async () => {
  const u = await signUp('notadmin@x.com');
  const r = await call('adminAdjustCredits', { uid: u.uid, delta: 100, reason: 'x', requestId: 'req_self0001' }, u.idToken);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.status, 'PERMISSION_DENIED');
});

test('adminAdjustCredits: admin claim 사용자는 조정 가능 + 원장 기록', async () => {
  const target = await signUp('target@x.com');
  await verifyEmail(target.uid);
  await call('ensureUserProfile', {}, target.idToken);
  const adm = await signUp('boss@x.com');
  // 에뮬레이터 관리 API 로 custom claim 부여 후 재로그인해서 새 토큰 획득
  await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId: adm.uid, customAttributes: JSON.stringify({ admin: true }) }),
  });
  const r0 = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'boss@x.com', password: 'pw123456', returnSecureToken: true }),
  });
  const adminToken = (await r0.json()).idToken;
  const r = await call('adminAdjustCredits', { uid: target.uid, delta: 3, reason: 'CS 보상', requestId: 'req_cs000001' }, adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.result.balanceAfter, 8);
  const again = await call('adminAdjustCredits', { uid: target.uid, delta: 3, reason: 'CS 보상', requestId: 'req_cs000001' }, adminToken);
  assert.equal(again.body.result.duplicate, true);
  assert.equal(again.body.result.balanceAfter, 8);
});

async function adminToken(email) {
  const adm = await signUp(email);
  await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId: adm.uid, customAttributes: JSON.stringify({ admin: true }) }),
  });
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pw123456', returnSecureToken: true }),
  });
  return (await r.json()).idToken;
}

test('adminCheckAiConfig: 관리자만, 키 값은 응답에 없음 (에뮬레이터 mock)', async () => {
  const u = await signUp('plain@x.com');
  assert.equal((await call('adminCheckAiConfig', {}, u.idToken)).body.error.status, 'PERMISSION_DENIED');
  const t = await adminToken('boss2@x.com');
  const r = await call('adminCheckAiConfig', {}, t);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = r.body.result;
  assert.deepEqual([c.provider, c.model, c.webSearchToolType, c.modelAvailable, c.webSearchSupported], ['mock', 'claude-sonnet-4-6', 'web_search_20260209', true, true]);
  assert.ok(!JSON.stringify(c).match(/sk-ant|secret/i));
});

test('deleteAccount: 확인 문구 필요 → 데이터·Auth 계정 삭제, 다시 로그인 불가', async () => {
  const u = await signUp('bye@x.com');
  await verifyEmail(u.uid);
  await call('ensureUserProfile', {}, u.idToken);
  await call('generatePost', GOOD('req_bye_00001'), u.idToken);
  assert.equal((await call('deleteAccount', { confirm: '아니요' }, u.idToken)).body.error.status, 'INVALID_ARGUMENT');
  const r = await call('deleteAccount', { confirm: '탈퇴' }, u.idToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.deleted, true);
  const login = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'bye@x.com', password: 'pw123456', returnSecureToken: true }),
  });
  assert.equal(login.status, 400);
  assert.equal((await fetch(`${FS}/v1/projects/${PROJECT}/databases/(default)/documents/users/${u.uid}`, { headers: { Authorization: 'Bearer owner' } })).status, 404);
});

test('기능 한도 callable: 저장 글·내보내기·스타일 (FREE), adminSetPlan 은 관리자만, 응답에 내부 정보 없음', async () => {
  const u = await signUp('feat@x.com');
  await verifyEmail(u.uid);
  await call('ensureUserProfile', {}, u.idToken);
  const RES = { title_1: '제목', body: '본문 [사진1]', hashtags: ['#a'] };
  for (let i = 0; i < 5; i++) {
    const r = await call('savePost', { clientSaveId: `save_feat_${i}000`, data: RES, input: { title: 't', imageCount: 1 } }, u.idToken);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const over = await call('savePost', { clientSaveId: 'save_feat_over', data: RES }, u.idToken);
  assert.deepEqual([over.body.error.status, over.body.error.details.reason, over.body.error.details.limit], ['RESOURCE_EXHAUSTED', 'saved_post_limit', 5]);
  const ex = await call('authorizeExport', { requestId: 'exp_feat_0001' }, u.idToken);
  assert.deepEqual([ex.body.result.allowed, ex.body.result.remaining], [true, 4]);
  const st = await call('saveStyle', { name: '내 스타일', greeting: '안녕하세요' }, u.idToken);
  assert.equal(st.status, 200);
  assert.equal((await call('saveStyle', { name: '둘째' }, u.idToken)).body.error.details.reason, 'style_limit');
  const deny = await call('adminSetPlan', { uid: u.uid, plan: 'pro', reason: 'self' }, u.idToken);
  assert.equal(deny.body.error.status, 'PERMISSION_DENIED');
  const t = await adminToken('boss3@x.com');
  const ok = await call('adminSetPlan', { uid: u.uid, plan: 'pro', reason: '테스트 계정' }, t);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const more = await call('savePost', { clientSaveId: 'save_feat_pro1', data: RES }, u.idToken);
  assert.deepEqual([more.status, more.body.result.limit, more.body.result.plan], [200, null, 'pro']);
});
