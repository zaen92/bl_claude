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
  for (const name of ['ensureUserProfile', 'generatePost', 'createOrder', 'confirmPayment', 'adminAdjustCredits']) {
    const r = await call(name, {});
    assert.equal(r.status, 401, name);
    assert.equal(r.body.error.status, 'UNAUTHENTICATED', name);
  }
});

test('이메일 가입 → 미인증 0크레딧 → 인증 후 2크레딧 (동시 호출 포함)', async () => {
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
  assert.equal(again.body.result.credits, 2);
});

test('generatePost: 로그인 사용자 입력 검증 + 에뮬레이터 모의 결과', async () => {
  const u = await signUp('gen@x.com');
  await call('ensureUserProfile', {}, u.idToken);
  const bad = await call('generatePost', { title: '', type: '맛집', content: 'x', volume: 'short', clientRequestId: 'req_abcdefgh' }, u.idToken);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.status, 'INVALID_ARGUMENT');
  const good = await call('generatePost', { title: '세비야 맛집', type: '맛집', content: '살모레호 맛있음', volume: 'normal', images: ['data:image/jpeg;base64,AAAA'], clientRequestId: 'req_abcdefgh' }, u.idToken);
  assert.equal(good.status, 200);
  assert.equal(good.body.result.mock, true);
  assert.ok(good.body.result.result.body.includes('[사진1]'));
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
  assert.equal(r.body.result.balanceAfter, 5);
  const again = await call('adminAdjustCredits', { uid: target.uid, delta: 3, reason: 'CS 보상', requestId: 'req_cs000001' }, adminToken);
  assert.equal(again.body.result.duplicate, true);
  assert.equal(again.body.result.balanceAfter, 5);
});
