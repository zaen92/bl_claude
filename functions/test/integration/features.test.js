'use strict';
// FREE / PRO 정책 통합 테스트 — Firestore 에뮬레이터, Claude = mock (실제 API 아님)
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { ensureUserProfile, adminAdjustCredits } = require('../../src/lib/credits');
const service = require('../../src/generation/service');
const F = require('../../src/account/features');
const { createMockClient } = require('../../src/ai/mockClient');
const { validateGenerateInput } = require('../../src/api/validate');

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('npm run test:emu 로 실행하세요');
const app = getApps()[0] || initializeApp({ projectId: 'demo-jaeinit' });
const db = getFirestore(app);
const CFG = { model: 'claude-sonnet-4-6', maxTokens: 8192, claudeTimeoutMs: 10_000, webSearchMaxUses: 5, webSearchToolType: 'auto', rateLimitPerMinute: 100, dailyLimit: 100, maxConcurrent: 5, leaseSeconds: 360, dailyCostLimitUsd: 0 };
let seq = 0;
const rid = (p = 'r') => `${p}_${Date.now().toString(36)}_${++seq}`;
const input = (over = {}) => validateGenerateInput({ title: '세비야 맛집', type: '맛집', content: '살모레호', volume: 'normal', images: [], clientRequestId: rid('req'), ...over });
const deps = (over = {}) => ({ db, ai: { client: createMockClient(), provider: 'mock' }, naver: null, logger: null, gateCacheMs: 0, ...over });
const newUser = (uid, email) => ensureUserProfile(db, { uid, email: email || `${uid}@x.com`, emailVerified: true });
const user = async (uid) => (await db.doc(`users/${uid}`).get()).data();
const RESULT = { title_1: '제목', title_2: 't2', title_3: 't3', keyword_main: 'k', body: '본문 [사진1]', hashtags: ['#a'], reel: 'r', thumbnail: '메인: x' };
const save = (uid, over = {}) => F.savePost(db, uid, { clientSaveId: rid('save'), data: RESULT, input: { title: 't', imageCount: 1 }, ...over });
async function rejectsReason(p, reason) {
  await assert.rejects(p, (e) => { assert.equal(e.details && e.details.reason, reason, e.message); return true; });
}
async function ledgerSum(uid) {
  return (await db.collection('creditLedger').where('uid', '==', uid).get()).docs.reduce((s, d) => s + d.data().delta, 0);
}

test.beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-jaeinit/databases/(default)/documents`, { method: 'DELETE' });
  service.resetGateCache();
});

test('신규 인증 회원: FREE 등급 + 무료 5크레딧, 사용량 카운터 0', async () => {
  const r = await newUser('n1');
  assert.deepEqual([r.credits, r.signupBonusAmount], [5, 5]);
  const u = await user('n1');
  assert.deepEqual([u.plan, u.credits, u.freeCredits, u.paidCredits, u.exportCount, u.savedPostCount, u.styleCount], ['free', 5, 5, 0, 0, 0, 0]);
});

test('무료 지급량 설정 변경: 신규 가입자부터 적용, 기존 회원 잔액·원장 보존', async () => {
  await newUser('old1');
  await db.doc('config/policy').set({ signupBonusCredits: 3 });
  await newUser('new1');
  assert.equal((await user('new1')).credits, 3);
  await newUser('old1'); // 재로그인
  assert.equal((await user('old1')).credits, 5);
  assert.equal(await ledgerSum('old1'), 5);
  await db.doc('config/policy').set({ signupBonusCredits: 10 });
  await newUser('new2');
  assert.equal((await user('new2')).credits, 10);
  await db.doc('config/policy').set({ signupBonusCredits: -5 }); // 범위 밖 값은 무시하고 기본값 5
  await newUser('new3');
  assert.equal((await user('new3')).credits, 5);
});

test('동시 초기화 20건 → 무료 크레딧 1회만, 같은 이메일 재가입 → 미지급', async () => {
  const rs = await Promise.allSettled(Array.from({ length: 20 }, () => newUser('c1', 'same@gmail.com')));
  assert.equal(rs.filter((r) => r.status === 'fulfilled' && r.value.granted).length, 1);
  assert.equal((await user('c1')).credits, 5);
  const again = await newUser('c2', 'Same+x@gmail.com');
  assert.deepEqual([again.granted, again.credits, again.signupBonusReason], [false, 0, 'email_already_used']);
});

test('AI 생성 5회 → 잔액 0, 6번째 차단 (AI 미호출), 원장=잔액', async () => {
  await newUser('g1');
  for (let i = 0; i < 5; i++) await service.generate(deps(), CFG, { uid: 'g1', input: input() });
  assert.equal((await user('g1')).credits, 0);
  const ai = createMockClient();
  await rejectsReason(service.generate(deps({ ai: { client: ai, provider: 'mock' } }), CFG, { uid: 'g1', input: input() }), 'insufficient_credits');
  assert.equal(ai.calls.length, 0);
  assert.equal(await ledgerSum('g1'), 0);
});

test('저장 글: FREE 5개 → 6번째 차단 → 삭제 후 저장 가능, 수정 저장은 개수 유지', async () => {
  await newUser('s1');
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await save('s1')).postId);
  assert.equal((await user('s1')).savedPostCount, 5);
  await rejectsReason(save('s1'), 'saved_post_limit');
  // 한도 도달 상태에서도 기존 글 수정·확인 가능
  const upd = await F.savePost(db, 's1', { postId: ids[0], data: { ...RESULT, body: '수정한 본문' } });
  assert.deepEqual([upd.created, upd.savedPostCount], [false, 5]);
  assert.equal((await db.doc(`posts/${ids[0]}`).get()).data().data.body, '수정한 본문');
  await F.deletePost(db, 's1', ids[1]);
  assert.equal((await user('s1')).savedPostCount, 4);
  await save('s1');
  assert.equal((await user('s1')).savedPostCount, 5);
  // 같은 저장 요청 재전송 → 같은 문서 (중복 저장 없음)
  await F.deletePost(db, 's1', ids[2]);
  const sid = rid('dup');
  await save('s1', { clientSaveId: sid });
  const dup = await save('s1', { clientSaveId: sid });
  assert.equal(dup.created, false);
  assert.equal((await db.collection('posts').where('uid', '==', 's1').get()).size, 5);
});

test('저장 글 동시 요청: 남은 자리 2개에 6건 동시 → 정확히 2건만 저장', async () => {
  await newUser('s2');
  for (let i = 0; i < 3; i++) await save('s2');
  const rs = await Promise.allSettled(Array.from({ length: 6 }, () => save('s2')));
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 2);
  rs.filter((r) => r.status === 'rejected').forEach((r) => assert.equal(r.reason.details.reason, 'saved_post_limit'));
  assert.equal((await db.collection('posts').where('uid', '==', 's2').get()).size, 5);
  assert.equal((await user('s2')).savedPostCount, 5);
});

test('생성 이력은 저장 글 한도를 쓰지 않음, 같은 생성 결과를 두 번 저장하면 수정으로 처리', async () => {
  await newUser('s3');
  const gens = [];
  for (let i = 0; i < 5; i++) gens.push(await service.generate(deps(), CFG, { uid: 's3', input: input() }));
  assert.equal((await user('s3')).savedPostCount, 0, '생성만으로는 저장 개수 증가 없음');
  const a = await F.savePost(db, 's3', { generationId: gens[0].generationId, data: gens[0].result });
  const b = await F.savePost(db, 's3', { generationId: gens[0].generationId, data: gens[0].result });
  assert.deepEqual([a.created, b.created, b.savedPostCount], [true, false, 1]);
  await assert.rejects(F.savePost(db, 's3', { generationId: 'other_req_x', data: RESULT }), (e) => e.code === 'invalid-argument');
});

test('저장 글에 사진 데이터·HTML 이 섞여도 제거 후 저장 (텍스트만)', async () => {
  await newUser('s4');
  const img = 'data:image/jpeg;base64,' + '/9j/' + 'A'.repeat(3000);
  const r = await save('s4', { data: { ...RESULT, body: '본문 ' + img + ' <img src=x onerror=alert(1)>끝' }, input: { title: 't', images: [img], imageCount: 3 } });
  const p = (await db.doc(`posts/${r.postId}`).get()).data();
  const s = JSON.stringify(p);
  assert.ok(!s.includes('data:image') && !s.includes('/9j/') && !s.includes('<img') && !s.includes('images'));
  assert.equal(p.data.body.replace(/\s+/g, ' '), '본문 끝');
  assert.equal(p.input.imageCount, 3);
});

test('기존 회원(카운터 없음): 실제 저장 글 수로 계산', async () => {
  await db.doc('users/legacy2').set({ uid: 'legacy2', credits: 1, freeCredits: 1, paidCredits: 0 });
  for (let i = 0; i < 5; i++) await db.collection('posts').doc(`legacy2_old_${i}`).set({ uid: 'legacy2', title: 't', data: {} });
  await rejectsReason(save('legacy2'), 'saved_post_limit');
  assert.equal((await user('legacy2')).plan, undefined, '등급 필드는 로그인 시 보정');
});

test('JSON 내보내기: FREE 5회 → 6번째 차단, 같은 요청 재전송은 1회, 동시 요청도 한도 유지', async () => {
  await newUser('e1');
  const first = rid('exp');
  const r1 = await F.authorizeExport(db, 'e1', { requestId: first });
  const r1b = await F.authorizeExport(db, 'e1', { requestId: first });
  assert.deepEqual([r1.exportCount, r1.remaining, r1b.duplicate, r1b.exportCount], [1, 4, true, 1]);
  const rs = await Promise.allSettled(Array.from({ length: 8 }, () => F.authorizeExport(db, 'e1', { requestId: rid('exp') })));
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 4);
  rs.filter((r) => r.status === 'rejected').forEach((r) => assert.equal(r.reason.details.reason, 'export_limit'));
  assert.equal((await user('e1')).exportCount, 5);
  assert.equal((await db.collection('exportGrants').where('uid', '==', 'e1').get()).size, 5);
  await rejectsReason(F.authorizeExport(db, 'e1', { requestId: rid('exp') }), 'export_limit');
  assert.equal((await user('e1')).credits, 5, '내보내기는 AI 크레딧 미차감');
});

test('개인화 스타일: FREE 1개 저장·수정, 2번째 차단 / 다른 회원 스타일로 생성 불가', async () => {
  await newUser('t1'); await newUser('t2');
  const st = await F.saveStyle(db, 't1', { name: '내 스타일', blogName: '하루맛집', greeting: '반가워요 하루예요', tone: 'informative', useEmoji: false, extra: '문장은 짧게 <script>x</script>' });
  await rejectsReason(F.saveStyle(db, 't1', { name: '두번째' }), 'style_limit');
  await F.saveStyle(db, 't1', { styleId: st.styleId, name: '내 스타일', blogName: '하루맛집', greeting: '안녕하세요 하루입니다', tone: 'emotional' });
  const doc = (await db.doc(`styles/${st.styleId}`).get()).data();
  assert.equal(doc.greeting, '안녕하세요 하루입니다');
  assert.equal((await user('t1')).styleCount, 1);
  await rejectsReason(service.generate(deps(), CFG, { uid: 't2', input: input({ style: { styleId: st.styleId } }) }), 'style_not_found');
  assert.equal((await user('t2')).credits, 5, '스타일 오류는 차감 전 거부');
  assert.equal((await user('t1')).credits, 5, '스타일 저장은 크레딧 미차감');
});

test('개인화 스타일로 생성: 프롬프트에 사용자 인사말 적용·잰잇 인사말 미적용, 스타일 스냅샷 저장 / 잰잇 프리셋 선택 가능', async () => {
  await newUser('t3');
  const st = await F.saveStyle(db, 't3', { name: '하루', blogName: '하루맛집', greeting: '반가워요 하루예요', closing: '다음에 또 만나요', tone: 'friendly', useEmoji: true });
  const ai = createMockClient();
  const r = await service.generate(deps({ ai: { client: ai, provider: 'mock' } }), CFG, { uid: 't3', input: input({ style: { styleId: st.styleId } }) });
  const prompt = ai.calls[0].messages[0].content.find((c) => c.type === 'text').text;
  assert.ok(prompt.includes('"반가워요 하루예요"로 시작') && prompt.includes('다음에 또 만나요') && prompt.includes('하루맛집의 팁'));
  assert.ok(!prompt.includes('잰잇'));
  assert.equal(r.style.name, '하루');
  assert.equal((await db.doc(`generations/${r.generationId}`).get()).data().style.greeting, '반가워요 하루예요');
  const ai2 = createMockClient();
  await service.generate(deps({ ai: { client: ai2, provider: 'mock' } }), CFG, { uid: 't3', input: input({ style: { preset: 'jaeinit' } }) });
  assert.ok(ai2.calls[0].messages[0].content.find((c) => c.type === 'text').text.includes('여행블로거 잰잇'));
  const ai3 = createMockClient();
  await service.generate(deps({ ai: { client: ai3, provider: 'mock' } }), CFG, { uid: 't3', input: input() });
  assert.ok(!ai3.calls[0].messages[0].content.find((c) => c.type === 'text').text.includes('잰잇'), '스타일 미지정 → 기본 스타일 (특정 블로그 이름 강제 없음)');
});

test('PRO (관리자 테스트 설정): 저장·내보내기·스타일 제한 해제, 크레딧 0 이어도 PRO 유지·생성은 차단', async () => {
  await newUser('p1');
  await F.adminSetPlan(db, { uid: 'p1', plan: 'pro', reason: '테스트 계정', actorUid: 'admin1' });
  const u = await user('p1');
  assert.deepEqual([u.plan, u.planSource], ['pro', 'admin_test']);
  assert.ok(u.upgradedAt);
  for (let i = 0; i < 8; i++) await save('p1');
  for (let i = 0; i < 8; i++) await F.authorizeExport(db, 'p1', { requestId: rid('pexp') });
  for (let i = 0; i < 3; i++) await F.saveStyle(db, 'p1', { name: `스타일${i}` });
  const p = await user('p1');
  assert.deepEqual([p.savedPostCount, p.exportCount, p.styleCount], [8, 8, 3]);
  await adminAdjustCredits(db, { uid: 'p1', delta: -5, reason: '테스트', requestId: 'req_p1_zero1', actorUid: 'a' });
  assert.equal((await user('p1')).plan, 'pro');
  await rejectsReason(service.generate(deps(), CFG, { uid: 'p1', input: input() }), 'insufficient_credits');
});

test('수정 저장: 요청에 없는 입력값·스타일·유형은 기존 값 유지', async () => {
  const uid = 'keep1';
  await newUser(uid);
  const r = await F.savePost(db, uid, { clientSaveId: 'save_keep_0001', type: '카페', data: { title_1: '제목', body: '본문 [사진1] [사진2]' },
    input: { title: '입력 제목', content: '내용', type: '카페', volume: 'long', imageCount: 2 }, style: { preset: 'jaeinit' } });
  const r2 = await F.savePost(db, uid, { postId: r.postId, data: { title_1: '제목', body: '고친 본문 [사진1] [사진2]' } });
  assert.equal(r2.created, false);
  const d = (await db.doc('posts/' + r.postId).get()).data();
  assert.equal(d.data.body, '고친 본문 [사진1] [사진2]');
  assert.deepEqual([d.input.imageCount, d.input.volume, d.type, d.style.preset, d.title], [2, 'long', '카페', 'jaeinit', '제목']);
});
