'use strict';
// Firestore 에뮬레이터 대상 크레딧 로직 테스트 — `npm run test:emu`
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { ensureUserProfile, adminAdjustCredits } = require('../../src/lib/credits');

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST 가 필요합니다 (에뮬레이터에서 실행).');
const app = getApps()[0] || initializeApp({ projectId: 'demo-jaeinit' });
const db = getFirestore(app);

async function clear() {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-jaeinit/databases/(default)/documents`, { method: 'DELETE' });
}
async function ledgerOf(uid) {
  const s = await db.collection('creditLedger').where('uid', '==', uid).get();
  return s.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function creditsOf(uid) {
  return (await db.doc(`users/${uid}`).get()).data().credits;
}

test.beforeEach(clear);

test('신규 인증 회원: 크레딧 5개(기본 설정) + 원장 1건', async () => {
  const r = await ensureUserProfile(db, { uid: 'u1', email: 'u1@x.com', emailVerified: true, displayName: '유저1' });
  assert.equal(r.created, true);
  assert.equal(r.granted, true);
  assert.equal(r.credits, 5);
  const u = (await db.doc('users/u1').get()).data();
  assert.equal(u.credits, 5);
  assert.deepEqual([u.freeCredits, u.paidCredits, u.plan], [5, 0, 'free']);
  assert.equal(u.signupBonus.status, 'granted');
  assert.equal(u.displayName, '유저1');
  const l = await ledgerOf('u1');
  assert.equal(l.length, 1);
  assert.equal(l[0].id, 'signup_bonus_u1');
  assert.deepEqual([l[0].type, l[0].delta, l[0].balanceBefore, l[0].balanceAfter], ['signup_bonus', 5, 0, 5]);
});

test('중복 로그인: 여러 번 호출해도 1번만 지급', async () => {
  const user = { uid: 'u2', email: 'u2@x.com', emailVerified: true };
  for (let i = 0; i < 5; i++) await ensureUserProfile(db, user);
  assert.equal(await creditsOf('u2'), 5);
  assert.equal((await ledgerOf('u2')).length, 1);
});

test('동시 요청: 20건 동시 호출해도 정확히 1번만 지급', async () => {
  const user = { uid: 'u3', email: 'u3@x.com', emailVerified: true };
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => ensureUserProfile(db, user)));
  const ok = results.filter((r) => r.status === 'fulfilled');
  assert.ok(ok.length >= 1, '최소 1건은 성공해야 함');
  assert.equal(ok.filter((r) => r.value.granted).length, 1, 'granted=true 는 정확히 1건');
  assert.equal(await creditsOf('u3'), 5);
  assert.equal((await ledgerOf('u3')).length, 1);
});

test('재가입: 계정 삭제 후 같은 이메일(정규화 변형 포함)로 새 uid 가입 시 미지급', async () => {
  await ensureUserProfile(db, { uid: 'old', email: 'jae.nit@gmail.com', emailVerified: true });
  // 계정 삭제 시뮬레이션: users 문서까지 삭제돼도 signupGrants 는 남는다
  await db.doc('users/old').delete();
  const r1 = await ensureUserProfile(db, { uid: 'new1', email: 'jaenit@gmail.com', emailVerified: true });
  const r2 = await ensureUserProfile(db, { uid: 'new2', email: 'Jae.Nit+2@googlemail.com', emailVerified: true });
  for (const r of [r1, r2]) {
    assert.equal(r.granted, false);
    assert.equal(r.credits, 0);
    assert.equal(r.signupBonusStatus, 'ineligible');
    assert.equal(r.signupBonusReason, 'email_already_used');
  }
  assert.equal((await ledgerOf('new1')).length, 0);
});

test('이메일 미인증: 보류 → 인증 후 1번 지급', async () => {
  const r1 = await ensureUserProfile(db, { uid: 'u4', email: 'u4@x.com', emailVerified: false });
  assert.equal(r1.created, true);
  assert.equal(r1.credits, 0);
  assert.equal(r1.signupBonusStatus, 'pending_verification');
  const r2 = await ensureUserProfile(db, { uid: 'u4', email: 'u4@x.com', emailVerified: true });
  assert.equal(r2.granted, true);
  assert.equal(r2.credits, 5);
  await ensureUserProfile(db, { uid: 'u4', email: 'u4@x.com', emailVerified: true });
  assert.equal(await creditsOf('u4'), 5);
});

test('미인증 상태에서 다른 사람이 같은 이메일을 선점할 수 없음 (먼저 인증한 계정만 지급)', async () => {
  await ensureUserProfile(db, { uid: 'squatter', email: 'victim@x.com', emailVerified: false });
  const r = await ensureUserProfile(db, { uid: 'victim', email: 'victim@x.com', emailVerified: true });
  assert.equal(r.granted, true);
});

test('이메일 없는 계정: 지급 불가(ineligible)', async () => {
  const r = await ensureUserProfile(db, { uid: 'u5', email: null, emailVerified: false });
  assert.equal(r.signupBonusStatus, 'ineligible');
  assert.equal(r.credits, 0);
});

test('재로그인 시 사용자가 바꾼 displayName 을 덮어쓰지 않음', async () => {
  await ensureUserProfile(db, { uid: 'u6', email: 'u6@x.com', emailVerified: true, displayName: '구글이름' });
  await db.doc('users/u6').update({ displayName: '잰잇' });
  await ensureUserProfile(db, { uid: 'u6', email: 'u6@x.com', emailVerified: true, displayName: '구글이름' });
  assert.equal((await db.doc('users/u6').get()).data().displayName, '잰잇');
});

test('관리자 조정: 원장 기록 + 멱등 + 음수 잔액 방지', async () => {
  await ensureUserProfile(db, { uid: 'u7', email: 'u7@x.com', emailVerified: true });
  const a = await adminAdjustCredits(db, { uid: 'u7', delta: 5, reason: 'CS 보상', requestId: 'req_00000001', actorUid: 'admin1' });
  assert.deepEqual([a.applied, a.balanceAfter], [true, 10]);
  const dup = await adminAdjustCredits(db, { uid: 'u7', delta: 5, reason: 'CS 보상', requestId: 'req_00000001', actorUid: 'admin1' });
  assert.deepEqual([dup.applied, dup.duplicate, dup.balanceAfter], [false, true, 10]);
  assert.equal(await creditsOf('u7'), 10);
  await assert.rejects(adminAdjustCredits(db, { uid: 'u7', delta: -11, reason: '회수', requestId: 'req_00000002', actorUid: 'admin1' }), { code: 'failed-precondition' });
  assert.equal(await creditsOf('u7'), 10);
  await assert.rejects(adminAdjustCredits(db, { uid: 'nobody', delta: 1, reason: 'x', requestId: 'req_00000003', actorUid: 'a' }), { code: 'not-found' });
  await assert.rejects(adminAdjustCredits(db, { uid: 'u7', delta: 1.5, reason: 'x', requestId: 'req_00000004', actorUid: 'a' }), { code: 'invalid-argument' });
  const l = await ledgerOf('u7');
  assert.equal(l.length, 2);
  const adj = l.find((x) => x.type === 'admin_adjust');
  assert.deepEqual(adj.actor, { type: 'admin', uid: 'admin1' });
});
