// 스테이징 종합 점검 — 배포된 스테이징의 실제 Claude·Firestore 로 크레딧·사진 분석·사진 미저장·탈퇴 시나리오 확인
//
//   에뮬레이터(점검 스크립트 자체 검증, Claude=mock):
//     npx firebase emulators:exec --project demo-jaeinit --only auth,firestore,functions "node scripts/staging-check.mjs --emulator"
//   스테이징 (⚠️ 실제 Claude 호출 3~4회, 약 $0.2~0.5):
//     gcloud auth application-default login
//     node scripts/staging-check.mjs --project <스테이징 프로젝트ID> --yes [--photos-dir ./samples]
//
//   준비: 스테이징에 배포 완료, ENFORCE_APP_CHECK=false 상태 (App Check 강제 전),
//         실행 계정(ADC)에 Firebase Admin 권한. 테스트 계정은 자동 생성·삭제됩니다.
//   이 스크립트는 API 키를 읽거나 출력하지 않습니다 (서버의 Secret Manager 키로 실제 호출).
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fnRequire = createRequire(join(ROOT, 'functions/package.json'));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const flag = (k) => args.includes('--' + k);
const EMU = flag('emulator');
const REGION = 'asia-northeast3';

let projectId = opt('project');
let webConfig;
if (EMU) {
  projectId = 'demo-jaeinit';
  process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
  webConfig = { apiKey: 'demo-key', projectId, storageBucket: 'demo-jaeinit.appspot.com', authDomain: 'demo-jaeinit.firebaseapp.com', appId: 'demo-app' };
} else {
  if (!projectId) { console.error('--project <스테이징 프로젝트ID> 또는 --emulator'); process.exit(2); }
  if (projectId.startsWith('demo-')) { console.error('demo- 프로젝트는 --emulator 로'); process.exit(2); }
  if (!flag('yes')) { console.error('⚠️ 실제 Claude 호출(약 $0.2~0.5)과 스테이징 데이터 쓰기가 발생합니다. 진행하려면 --yes'); process.exit(1); }
  const url = opt('config-url', `https://${projectId}.web.app/__/firebase/init.json`);
  const res = await fetch(url);
  if (!res.ok) { console.error(`웹 설정을 가져오지 못했습니다 (${url}) — Hosting 배포 여부 확인`); process.exit(2); }
  webConfig = await res.json();
}

// ── Admin SDK (functions 의 모듈 재사용) ──
const { initializeApp: adminInit } = fnRequire('firebase-admin/app');
const { getFirestore } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const adminApp = adminInit({ projectId }, 'admin');
const adb = getFirestore(adminApp);
const aauth = getAuth(adminApp);
const credits = fnRequire('./src/lib/credits');
const { deleteAccountData } = fnRequire('./src/account/deleteAccount');
const { png } = fnRequire('./test/fixtures/images');

// ── 클라이언트 SDK (실제 사용자와 같은 경로) ──
const { initializeApp, deleteApp } = await import('firebase/app');
const { getAuth: cAuth, signInWithEmailAndPassword, connectAuthEmulator } = await import('firebase/auth');
const { getFunctions, httpsCallable, connectFunctionsEmulator } = await import('firebase/functions');
const { getFirestore: cFs, connectFirestoreEmulator, collection, query, where, getDocs, addDoc, deleteDoc, doc, serverTimestamp } = await import('firebase/firestore');

const runId = Date.now().toString(36);
const PW = `Pw-${runId}-${Math.random().toString(36).slice(2)}`;
const steps = [];
const log = (ok, msg, extra) => { steps.push({ ok, msg, ...(extra ? { extra } : {}) }); console.log(`${ok ? '✅' : '❌'} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`); };

async function clientFor(email, name) {
  const app = initializeApp(webConfig, name);
  const auth = cAuth(app); const fns = getFunctions(app, REGION); const fs = cFs(app);
  if (EMU) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(fns, '127.0.0.1', 5001);
    connectFirestoreEmulator(fs, '127.0.0.1', 8080);
  }
  const cred = await signInWithEmailAndPassword(auth, email, PW);
  const call = (n, d) => httpsCallable(fns, n, { timeout: 310_000 })(d).then((r) => r.data);
  return { app, uid: cred.user.uid, call, fs };
}

// 사진: 실제 사진 폴더 또는 1000x750 합성 (서버 검증 한도 이내)
let photos;
if (opt('photos-dir')) {
  photos = readdirSync(opt('photos-dir')).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).slice(0, 3).map((f) => {
    const ext = extname(f).slice(1).toLowerCase();
    return `data:${ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'};base64,${readFileSync(join(opt('photos-dir'), f)).toString('base64')}`;
  });
} else {
  // 색상 블록 패턴 (압축이 잘 돼 서버 검증 한도 이내, 이미지 토큰은 해상도로 결정되므로 비용 측정에는 동일)
  photos = [0, 1, 2].map((s) => png(1000, 750, (x, y) => [(Math.floor(x / 50) * 30 + s * 60) % 256, (Math.floor(y / 50) * 40 + s * 90) % 256, (s * 70 + 40) % 256]));
}
const BAD_IMAGE = 'data:image/jpeg;base64,' + Buffer.from('INVALID-NOT-AN-IMAGE').toString('base64');
const req = (n) => `req_stg_${runId}_${n}`;
const base = (over) => ({ title: '서울 명동교자 본점 칼국수 후기', type: '맛집', content: '칼국수와 만두를 먹었다. 마늘 김치가 강렬했다. 점심 웨이팅 15분.', memo: '', info: '', volume: 'short', images: [], ...over });

const emailA = `staging-check-a-${runId}@example.com`;
const emailB = `staging-check-b-${runId}@example.com`;
let userA; let userB; let configBefore = null; let configTouched = false;
const generationIds = [];

try {
  console.log(`\n스테이징 점검 시작: ${projectId} ${EMU ? '(에뮬레이터, Claude=mock)' : '(실제 Claude)'}\n`);
  // 테스트 계정 (이메일 인증 완료 상태로 생성)
  userA = await aauth.createUser({ email: emailA, password: PW, emailVerified: true });
  userB = await aauth.createUser({ email: emailB, password: PW, emailVerified: true });
  // 허용 목록 모드면 테스트 계정 임시 추가 (끝나면 원래대로)
  const cfgRef = adb.doc('config/service');
  const cfgSnap = await cfgRef.get();
  configBefore = cfgSnap.exists ? cfgSnap.data() : null;
  await cfgRef.set({ allowedEmails: [...((configBefore && configBefore.allowedEmails) || []), emailA, emailB] }, { merge: true });
  configTouched = true;
  if (!EMU) await new Promise((r) => setTimeout(r, 31_000)); // 서버의 설정 캐시(30초) 만료 대기

  const A = await clientFor(emailA, 'A');
  const B = await clientFor(emailB, 'B');

  // 1) 가입 무료 2크레딧
  const p = await A.call('ensureUserProfile', {});
  assert.equal(p.credits, 2); log(true, '가입 시 무료 크레딧 2개', { credits: p.credits });

  // 2) 텍스트 + 웹 검색 (짧은 글) → 1개
  const g1 = await A.call('generatePost', base({ clientRequestId: req(1) }));
  generationIds.push(g1.generationId);
  assert.equal(g1.status, 'succeeded'); assert.equal(g1.creditsRemaining, 1);
  for (const k of ['title_1', 'title_2', 'title_3', 'keyword_main', 'keyword_sub', 'keyword_location', 'body', 'reel', 'thumbnail']) assert.ok(typeof g1.result[k] === 'string', k);
  assert.ok(Array.isArray(g1.result.hashtags) && g1.result.hashtags.length > 0);
  log(true, '1회 생성(텍스트·웹검색·짧은 글) 성공 → 잔여 1', { title_1: g1.result.title_1, place: g1.result.place_address || '(없음)', mock: g1.mock });

  // 3) 사진 3장 (보통 글) → 0개. 사진은 Claude 분석용으로만 전달, 서버에 저장 안 함
  const g2 = await A.call('generatePost', base({ title: '제주 애월 카페 | 오션뷰 디저트 후기', content: '통창 바다뷰, 딸기 케이크와 라떼. 주차 가능.', volume: 'normal', images: photos, clientRequestId: req(2) }));
  generationIds.push(g2.generationId);
  assert.equal(g2.creditsRemaining, 0); assert.equal(g2.imageCount, photos.length);
  const markers = [1, 2, 3].slice(0, photos.length).filter((i) => g2.result.body.includes(`[사진${i}]`)).length;
  log(markers === photos.length, `2회 생성(사진 ${photos.length}장 분석·보통 글) 성공 → 잔여 0, 본문 사진 배치 ${markers}/${photos.length}`);

  // 4) 사진 미저장 확인: 생성 기록·비용 지표·프로필 어디에도 사진·Base64 없음
  const snippet = photos[0].split(',')[1].slice(100, 160);
  const saved = JSON.stringify((await adb.doc(`generations/${g2.generationId}`).get()).data())
    + JSON.stringify((await adb.doc(`generationMetrics/${g2.generationId}`).get()).data())
    + JSON.stringify((await adb.doc(`users/${A.uid}`).get()).data());
  assert.ok(!saved.includes(snippet) && !saved.includes('data:image'));
  const g2doc0 = (await adb.doc(`generations/${g2.generationId}`).get()).data();
  assert.equal(g2doc0.photos, undefined);
  log(true, '서버(Firestore)에 사진·Base64 저장 없음, 사진 장수·[사진N] 배치만 기록');

  // 5) 세 번째 차단 (차감·AI 호출 없음)
  try { await A.call('generatePost', base({ clientRequestId: req(3) })); assert.fail('차단되어야 함'); } catch (e) { assert.equal(e.details && e.details.reason, 'insufficient_credits', e.message); }
  log(true, '3회째 생성 차단 (insufficient_credits)');

  // 6) 같은 요청 재전송 → 중복 차감 없음
  const dup = await A.call('generatePost', base({ title: '제주 애월 카페 | 오션뷰 디저트 후기', content: '통창 바다뷰, 딸기 케이크와 라떼. 주차 가능.', volume: 'normal', images: photos, clientRequestId: req(2) }));
  assert.equal(dup.duplicate, true); log(true, '같은 요청 재전송 → 기존 결과 반환, 추가 차감 없음');

  // 7) 실패 → 복구 (실제 API 가 거부하는 손상된 이미지)
  await credits.adminAdjustCredits(adb, { uid: A.uid, delta: 1, reason: 'staging-check', requestId: `stg_${runId}_1`, actorUid: 'staging-check' });
  try { await A.call('generatePost', base({ images: [BAD_IMAGE], clientRequestId: req(4) })); assert.fail('실패해야 함'); } catch (e) {
    assert.equal(e.details && e.details.refunded, true, e.message); assert.equal(e.details.creditsRemaining, 1);
    log(true, 'AI 오류(손상된 이미지) → 크레딧 자동 복구', { reason: e.details.reason });
  }
  generationIds.push(`${A.uid}_${req(4)}`);

  // 8) 동시 요청: 잔액 1 에 3건 → 1건만 성공
  const conc = await Promise.allSettled([5, 6, 7].map((n) => A.call('generatePost', base({ volume: 'long', clientRequestId: req(n) }))));
  const okN = conc.filter((r) => r.status === 'fulfilled').length;
  conc.forEach((r) => r.status === 'fulfilled' && generationIds.push(r.value.generationId));
  const prof = (await adb.doc(`users/${A.uid}`).get()).data();
  assert.equal(okN, 1); assert.equal(prof.credits, 0);
  log(true, '동시 요청 3건(잔액 1) → 1건만 성공(긴 글), 잔액 0');

  // 9) 원장·잔액 불변식
  const led = (await adb.collection('creditLedger').where('uid', '==', A.uid).get()).docs.map((d) => d.data());
  assert.equal(led.reduce((s, x) => s + x.delta, 0), prof.credits); assert.equal(prof.credits, prof.freeCredits + prof.paidCredits);
  log(true, `원장 합계 == 잔액 (원장 ${led.length}건)`);

  // 10) 새로고침 후 이력 복구 (사용자 권한으로 조회)
  const hist = await getDocs(query(collection(A.fs, 'generations'), where('uid', '==', A.uid)));
  const st2 = await A.call('getGenerationStatus', { generationId: g2.generationId });
  assert.ok(hist.size >= 4); assert.equal(st2.status, 'succeeded');
  let otherDenied = false; try { await B.call('getGenerationStatus', { generationId: g2.generationId }); } catch (e) { otherDenied = e.code === 'functions/not-found'; }
  assert.ok(otherDenied); log(true, `생성 이력 ${hist.size}건 조회·상태 복구, 다른 회원 조회 차단`);

  // 11) 글 저장(무료): 텍스트 결과·입력값만, 사진 없음 → 다시 열기
  const before = (await adb.doc(`users/${A.uid}`).get()).data().credits;
  const post = await addDoc(collection(A.fs, 'posts'), { uid: A.uid, title: g2.result.title_1, type: '카페', data: g2.result, generationId: g2.generationId,
    input: { title: '제주 애월 카페 | 오션뷰 디저트 후기', memo: '', content: '통창 바다뷰', info: '', type: '카페', volume: 'normal', imageCount: photos.length }, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  const reopened = await getDocs(query(collection(A.fs, 'posts'), where('uid', '==', A.uid)));
  const pd = reopened.docs.find((d) => d.id === post.id).data();
  assert.ok(pd.data.body.includes('[사진1]')); assert.equal(pd.photos, undefined); assert.equal(pd.input.imageCount, photos.length);
  let rejected = false;
  try { await addDoc(collection(A.fs, 'posts'), { uid: A.uid, title: 'x', data: { body: 'a ' + photos[0] }, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }); } catch (e) { rejected = true; }
  assert.ok(rejected, '본문에 사진 데이터가 섞인 저장은 규칙이 거부');
  assert.equal((await adb.doc(`users/${A.uid}`).get()).data().credits, before);
  log(true, '글 저장·다시 열기 무료, [사진N] 배치 유지·사진 데이터 없음, 사진 섞인 저장 거부');
  await deleteDoc(doc(A.fs, 'posts', post.id));

  // 12) 비용 (관리자 전용 지표)
  const metrics = [];
  for (const id of generationIds) { const m = await adb.doc(`generationMetrics/${id}`).get(); if (m.exists) metrics.push(m.data()); }
  const ok = metrics.filter((m) => m.status === 'succeeded');
  for (const m of metrics) log(true, `비용 ${m.status} 사진${m.imageCount} ${m.volume}`, { model: m.model, usage: m.usage, costUsd: m.costUsd, billing: m.billing, latencyMs: m.latencyMs, quality: m.qualityFlags });
  const avg = ok.reduce((s, m) => s + (m.costUsd || 0), 0) / (ok.length || 1);
  console.log(`\n성공 ${ok.length}건 평균 예상 비용 $${avg.toFixed(4)} ${EMU ? '(mock — 실제 비용 아님)' : '(정가 기준 — Console Usage 와 대조하세요)'}`);

  // 13) 회원 탈퇴 → 문서·계정 삭제
  await A.call('deleteAccount', { confirm: '탈퇴' });
  assert.equal((await adb.doc(`users/${A.uid}`).get()).exists, false);
  assert.equal((await adb.collection('generations').where('uid', '==', A.uid).get()).size, 0);
  let gone = false; try { await aauth.getUser(A.uid); } catch (e) { gone = e.code === 'auth/user-not-found'; }
  assert.ok(gone); log(true, '회원 탈퇴 → Auth 계정·글·생성 기록 삭제');
  userA = null;

  mkdirSync(join(ROOT, 'cost-reports'), { recursive: true });
  const out = join(ROOT, 'cost-reports', `staging-check-${EMU ? 'emulator-' : ''}${runId}.json`);
  writeFileSync(out, JSON.stringify({ projectId, emulator: EMU, steps, metrics }, null, 2));
  console.log(`\n✅ 스테이징 점검 통과 (${steps.length}개 확인) — 결과: ${out}`);
  await Promise.all([deleteApp(A.app), deleteApp(B.app)]);
} catch (e) {
  log(false, `실패: ${e.message}`);
  process.exitCode = 1;
} finally {
  // 정리: 테스트 계정·설정 원복
  for (const u of [userA, userB]) {
    if (!u) continue;
    try { await deleteAccountData(adb, u.uid, { source: 'staging_check_cleanup' }); await aauth.deleteUser(u.uid); } catch (e) { /* 이미 삭제됨 */ }
  }
  if (configTouched) {
    const cfgRef = adb.doc('config/service');
    if (configBefore) await cfgRef.set(configBefore); else await cfgRef.delete();
  }
  setTimeout(() => process.exit(process.exitCode || 0), 500);
}
