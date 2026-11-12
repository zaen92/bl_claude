// 브라우저 E2E 스모크 테스트 (선택). Claude 는 에뮬레이터 mock — 실제 API 호출 아님.
// 사전 조건: `npm run emulators:clean` + `npm run dev` 실행 중
//   npm i --no-save playwright && npx playwright install chromium && node tests/e2e/smoke.cjs
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const { initializeApp } = require(path.join(__dirname, '../../functions/node_modules/firebase-admin/lib/app'));
const { getFirestore } = require(path.join(__dirname, '../../functions/node_modules/firebase-admin/lib/firestore'));
const { adminAdjustCredits } = require('../../functions/src/lib/credits');
const { adminSetPlan } = require('../../functions/src/account/features');

const OUT = path.join(__dirname, 'screenshots'); fs.mkdirSync(OUT, { recursive: true });
const AUTH = 'http://127.0.0.1:9099';
const APP = process.env.APP_URL || 'http://127.0.0.1:5173/';
const db = getFirestore(initializeApp({ projectId: 'demo-jaeinit' }));
const log = (...a) => console.log('✔', ...a);
// 작은 JPEG 3장 (색이 다른 1x1)
const JPEGS = ['/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='];

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  const errs = [];
  const bodies = [];
  const reqs = [];
  p.on('pageerror', (e) => errs.push('pageerror ' + e.message));
  const limit429 = []; // FREE 한도 초과 시 서버가 돌려주는 resource-exhausted(429) — 의도된 거부만 따로 셈
  p.on('console', (m) => { if (m.type() === 'error' && /status of 429/.test(m.text())) { limit429.push(m.text()); return; } if (m.type() === 'error' && !/net::ERR_INTERNET_DISCONNECTED|Failed to fetch|ERR_NETWORK|Could not reach Cloud Firestore|WebChannelConnection/.test(m.text())) errs.push('console ' + m.text()); });
  p.on('dialog', async (d) => { await d.accept(d.type() === 'prompt' ? '탈퇴' : undefined); });
  p.on('request', (r) => { const pd = r.postData(); reqs.push({ url: r.url(), body: pd || '' }); if (pd) bodies.push(pd); });
  const credits = async () => p.textContent('#stxStatus');
  const historyCount = () => p.locator('#historyList > div').count();
  // 앱의 importJson() 처럼 선택값을 비운 뒤 파일 선택 (같은 파일 재선택 허용)
  const importFile = async (f) => { await p.$eval('#jsonFile', (e) => { e.value = ''; }); await p.setInputFiles('#jsonFile', f); };

  // 이 시나리오는 "가입 무료 2크레딧" 기준 — 운영 설정(config/policy)으로 지정 (기본값 5 는 통합 테스트에서 검증)
  // FREE 한도는 기본값(저장 5 · 내보내기 5 · 스타일 1)
  await db.doc('config/policy').set({ signupBonusCredits: 2, freeExportLimit: 5, freeSavedPostLimit: 5, freeStyleLimit: 1 });

  // ── 이전 버전 데이터 (API 키 + 저장 글) ──
  await p.goto(APP);
  await p.evaluate(() => {
    localStorage.setItem('jaeinit_claude_key', 'sk-ant-api03-OLD');
    localStorage.setItem('jaeinit_naver_id', 'nid'); localStorage.setItem('jaeinit_naver_sec', 'nsec');
    localStorage.setItem('jaeinit_saved_posts', JSON.stringify([{ id: 1700000000000, title: '예전 글', type: '맛집', date: '2024. 1. 1.', data: { title_1: '예전 글', body: '예전 본문', hashtags: ['#예전'] } }]));
  });
  await p.reload(); await p.waitForTimeout(1200);
  assert.deepEqual(await p.evaluate(() => ['jaeinit_claude_key', 'jaeinit_naver_id', 'jaeinit_naver_sec'].map((k) => localStorage.getItem(k))), [null, null, null]);
  log('기존 브라우저 API 키 3종 삭제');
  await p.click('#gb');
  assert.ok(await p.isVisible('#viewLogin'));
  await p.waitForFunction(() => document.querySelector('#viewLogin .bonusN').textContent === '2');
  log('비로그인 생성 → 로그인 모달 (무료 크레딧 수는 운영 설정값 표시)');

  // ── 가입·인증 ──
  const email = 'e2e' + Date.now() + '@example.com';
  await p.fill('#authEmail', email); await p.fill('#authPw', 'pw123456');
  await p.click('#btnSignup');
  await p.waitForSelector('#viewVerify.on');
  const oob = await (await fetch(`${AUTH}/emulator/v1/projects/demo-jaeinit/oobCodes`)).json();
  await fetch(oob.oobCodes.filter((c) => c.email === email && c.requestType === 'VERIFY_EMAIL').pop().oobLink);
  await p.click('#viewVerify .modal-b >> nth=0');
  await p.waitForFunction(() => document.getElementById('acctCredits').textContent === '2개');
  await p.click('#viewAccount .modal-b >> nth=-1');
  assert.equal(await credits(), '크레딧 2개');
  assert.equal(await p.textContent('#planBadge'), 'FREE');
  assert.match(await p.textContent('#genHint'), /첫 무료 생성 2회.*1크레딧.*자동 복구/);
  log('가입·인증 → FREE · 크레딧 2개, 첫 무료 생성·차감·복구 안내 표시');

  async function fill(memo, nImg) {
    await p.fill('#ti', '세비야 타파스 맛집 바 알팔파');
    await p.fill('#ci', '살모레호 맛있음, 웨이팅 20분');
    await p.fill('#mi', memo || '');
    await p.click('.tb >> text=맛집');
    await p.click('.vb >> nth=1');
    if (nImg) {
      await p.setInputFiles('#fi', Array.from({ length: nImg }, (_, i) => ({ name: `p${i}.jpg`, mimeType: 'image/jpeg', buffer: Buffer.from(JPEGS[0], 'base64') })));
      await p.waitForFunction((n) => document.querySelectorAll('.pi').length === n, nImg);
    }
  }

  // ── ① 사진 3장 생성 성공 ──
  await fill('', 3);
  await p.click('#gb');
  await p.waitForSelector('#rb3.on', { timeout: 20000 });
  assert.ok((await p.textContent('#sb')).includes('1크레딧 예약'));
  await p.waitForFunction(() => document.getElementById('stxStatus').textContent === '크레딧 1개');
  await p.click('#tabPreview');
  assert.equal(await p.locator('.pp-img img').count(), 3);
  await p.screenshot({ path: OUT + '/1-preview-3photos.png' });
  log('사진 3장 생성 성공 → 크레딧 1개, 미리보기 사진 3장');
  await p.click('#tabResult');
  await p.click('#saveBtn');
  await p.waitForFunction(() => document.getElementById('savedCount').textContent === '1');
  log('저장 완료');

  // ── ② API 오류 → 복구 안내 + 재시도 버튼 ──
  await p.fill('#mi', '[[mock:error]]');
  await p.waitForTimeout(1100); // 완료 직후 1초는 재클릭 무시(더블클릭 방지)
  await p.click('#gb');
  await p.waitForSelector('#eb.on .err-retry', { timeout: 20000 });
  assert.match(await p.textContent('#eb'), /복구/);
  await p.waitForTimeout(800);
  assert.equal(await credits(), '크레딧 1개');
  await p.screenshot({ path: OUT + '/2-error-refund.png' });
  log('AI 오류 → "1크레딧 자동 복구" 안내 + 다시 시도 버튼, 잔액 1개 유지');

  // ── ③ 생성 중 새로고침 → 상태 복구 ──
  await p.fill('#mi', '[[mock:slow:4000]]');
  await p.waitForTimeout(1100);
  await p.click('#gb');
  await p.waitForTimeout(1200);
  await p.reload();
  await p.waitForSelector('#rb3.on', { timeout: 30000 });
  await p.waitForFunction(() => document.getElementById('stxStatus').textContent === '크레딧 0개');
  assert.equal(await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('jaeinit_pending_generation_')).length), 0);
  log('생성 중 새로고침 → 서버 결과 자동 복구, 크레딧 0개');

  // ── ④ 크레딧 0 → 충전 예정 안내 (서버 호출 없음) ──
  await fill('', 0);
  await p.click('#tabHistory');
  const before = await historyCount();
  await p.waitForTimeout(1100);
  await p.click('#gb');
  assert.match(await p.textContent('#eb'), /충전 기능은 곧 오픈/);
  assert.match(await p.textContent('#genHint'), /곧 오픈/);
  await p.waitForTimeout(800);
  assert.equal(await historyCount(), before);
  log('크레딧 0개 → 생성 차단 + 충전 예정 안내');

  // 관리자 보상 +3 (테스트 진행용)
  const userUid = (await db.collection('users').where('email', '==', email).get()).docs[0].id;
  await adminAdjustCredits(db, { uid: userUid, delta: 3, reason: 'E2E', requestId: 'req_e2e_' + Date.now(), actorUid: 'e2e' });
  await p.waitForFunction(() => document.getElementById('stxStatus').textContent === '크레딧 3개');

  // ── ⑤ 더블클릭 → 1건만 ──
  await p.waitForTimeout(1100);
  // 더블클릭 + 같은 순간 3회 호출 (버튼 비활성화 전 경합 상황)
  await Promise.all([p.dblclick('#gb'), p.evaluate(() => { window.gen(); window.gen(); window.gen(); })]);
  await p.waitForSelector('#rb3.on', { timeout: 20000 });
  await p.waitForTimeout(1000);
  assert.equal(await credits(), '크레딧 2개');
  assert.equal(await historyCount(), before + 1);
  log('더블클릭·동시 호출 → 생성 1건, 1크레딧만 차감');

  // ── ⑥ 네트워크 끊김: 요청은 서버에 도착했지만 브라우저가 응답을 잃음 ──
  await p.fill('#mi', '[[mock:slow:3000]]');
  await p.route('**/generatePost', async (route) => {
    route.fetch().catch(() => {}); // 서버에는 그대로 전달
    await new Promise((r) => setTimeout(r, 800));
    await route.abort('internetdisconnected'); // 브라우저 쪽 연결만 끊김
  });
  await p.waitForTimeout(1100);
  await p.click('#gb');
  await p.waitForSelector('#eb.on', { timeout: 15000 });
  assert.match(await p.textContent('#eb'), /연결이 불안정/);
  await p.screenshot({ path: OUT + '/3-network-lost.png' });
  await p.unroute('**/generatePost');
  await p.waitForSelector('#rb3.on', { timeout: 40000 });
  await p.waitForFunction(() => document.getElementById('stxStatus').textContent === '크레딧 1개', null, { timeout: 15000 });
  await p.waitForTimeout(1500);
  assert.equal(await credits(), '크레딧 1개');
  log('응답 유실(네트워크 끊김) → 서버 기록으로 결과 복구, 중복 차감 없음 (크레딧 1개)');

  // ── ⑦ 새로고침 후 저장 글 다시 열기: [사진N] 배치만, 실제 사진은 표시 안 함 → 다시 첨부하면 표시 ──
  await p.reload();
  await p.waitForFunction(() => document.getElementById('savedCount').textContent === '1');
  await p.click('#tabSaved');
  assert.match(await p.textContent('#savedList'), /사진 3장 배치/);
  await p.click('#savedList >> text=📄 불러오기');
  await p.waitForSelector('#rb3.on');
  await p.click('#tabPreview');
  assert.equal(await p.locator('.pp-img img').count(), 0, '저장 글에는 사진 없음');
  assert.equal(await p.locator('.pp-img-empty').count(), 3, '[사진1~3] 자리 표시');
  await p.screenshot({ path: OUT + '/4-saved-reopen-no-photos.png' });
  await p.setInputFiles('#fi', [0, 1].map((i) => ({ name: `re${i}.jpg`, mimeType: 'image/jpeg', buffer: Buffer.from(JPEGS[0], 'base64') })));
  await p.waitForFunction(() => document.querySelectorAll('.pi').length === 2);
  await p.click('#tabResult'); await p.click('#tabPreview');
  assert.equal(await p.locator('.pp-img img').count(), 2, '다시 첨부한 사진이 [사진1][사진2] 에 표시');
  assert.equal(await p.locator('.pp-img-empty').count(), 1);
  log('저장 글 다시 열기 → 사진 배치 자리만 표시, 사진을 다시 첨부하면 미리보기에 표시');

  // ── ⑦-2 사진 순서 변경·삭제 → [사진N] 번호가 새 순서를 따름 ──
  const colors = await p.evaluate(() => ['#ff0000', '#0000ff'].map((c) => { const cv = document.createElement('canvas'); cv.width = 4; cv.height = 4; const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, 4, 4); return cv.toDataURL('image/png').split(',')[1]; }));
  await p.click('.pi .db'); await p.click('.pi .db');
  await p.setInputFiles('#fi', colors.map((b64, i) => ({ name: `c${i}.png`, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') })));
  await p.waitForFunction(() => document.querySelectorAll('.pi').length === 2);
  const srcs = () => p.$$eval('.pi img', (a) => a.map((x) => x.src));
  const [s1, s2] = await srcs();
  assert.notEqual(s1, s2);
  await p.click('.pi >> nth=0 >> .pi-mv button >> nth=1'); // 1번 사진을 뒤로
  assert.deepEqual(await srcs(), [s2, s1]);
  assert.deepEqual(await p.$$eval('.pi-n', (a) => a.map((x) => x.textContent)), ['1', '2']);
  await p.click('#tabPreview');
  assert.deepEqual(await p.$$eval('.pp-img img', (a) => a.map((x) => x.src)), [s2, s1], '미리보기 [사진1]=바뀐 1번');
  await p.click('.pi >> nth=0 >> .db');
  assert.deepEqual(await srcs(), [s1]);
  log('사진 순서 변경(◀▶)·삭제 → 번호 재정렬, 미리보기 반영');

  // ── ⑦-3 저장 글 본문 수정 → 다시 저장 = 같은 글 수정 (개수 증가 없음, 크레딧 없음) ──
  await p.click('#tabResult');
  await p.click('#editBtn');
  await p.fill('#btxt', '수정한 본문입니다\n[사진1]\n[사진2]\n[사진3]\n끝');
  await p.click('#editBtn');
  await p.click('#saveBtn');
  await p.waitForFunction(() => document.getElementById('saveBtn').textContent.includes('수정 저장됨'));
  assert.equal(await p.textContent('#savedCount'), '1');
  const editedDocs = (await db.collection('posts').where('uid', '==', (await db.collection('users').where('email', '==', email).get()).docs[0].id).get()).docs;
  assert.equal(editedDocs.length, 1);
  assert.match(editedDocs[0].data().data.body, /^수정한 본문입니다/);
  log('본문 수정 후 저장 → 기존 글 수정(저장 개수 1 유지, 크레딧 변화 없음)');

  // ── ⑧ JSON 내보내기 (무료, 사진·민감정보 없음) ──
  const creditsBefore = await credits();
  await p.click('#tabResult');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#exportBtn')]);
  const jsonPath = OUT + '/export.json';
  await dl.saveAs(jsonPath);
  const exported = fs.readFileSync(jsonPath, 'utf8');
  const ej = JSON.parse(exported);
  assert.match(dl.suggestedFilename(), /^jaeinit_.+\.json$/);
  assert.equal(ej.format, 'jaeinit-blog-studio');
  for (const k of ['title_1', 'title_2', 'title_3', 'keyword_main', 'body', 'reel', 'thumbnail']) assert.ok(ej.result[k], k);
  assert.ok(ej.result.hashtags.length && ej.photoLayout.count === 3 && ej.input.imageCount === 3);
  assert.equal(ej.input.title, '세비야 타파스 맛집 바 알팔파');
  assert.ok(!/data:image|\/9j\/|sk-ant|idToken|credits|admin|"uid"/.test(exported), '사진·키·토큰·크레딧·권한·uid 없음');
  assert.equal(await credits(), creditsBefore, '내보내기는 크레딧 없음');
  assert.equal(ej.version, 3);
  assert.ok(ej.style && ej.style.preset, '작성 스타일 포함');
  await p.waitForFunction(() => /무료 내보내기 1 \/ 5회 사용/.test(document.getElementById('exportUsage').textContent));
  log('JSON 내보내기: 서버 승인 후 다운로드, 입력·결과·사진 배치·스타일만, 사진/Base64·민감정보 없음, 크레딧 그대로, 1 / 5회 표시');

  // ── ⑨ JSON 불러오기: 입력값·결과 복원, 사진은 복원 안 함 ──
  await p.click('#tabResult');
  await p.click('text=🔄 새로 작성');
  assert.equal(await p.inputValue('#ti'), '');
  await importFile(jsonPath);
  await p.waitForSelector('#rb3.on');
  assert.equal(await p.inputValue('#ti'), '세비야 타파스 맛집 바 알팔파');
  assert.equal(await p.inputValue('#ci'), '살모레호 맛있음, 웨이팅 20분');
  assert.equal(await p.textContent('.tb.on'), '🍜맛집');
  assert.match(await p.textContent('.vb.on'), /보통/);
  assert.equal(await p.textContent('.tc-x >> nth=0'), ej.result.title_1);
  assert.equal(await p.locator('.pi').count(), 0, '사진은 복원하지 않음');
  await p.click('#tabPreview');
  assert.equal(await p.locator('.pp-img-empty').count(), 3);
  assert.equal(await credits(), creditsBefore, '불러오기 무료');
  // 예전 v3 저장 글 형식도 불러오기
  const legacyPath = OUT + '/legacy.json';
  fs.writeFileSync(legacyPath, JSON.stringify([{ id: 1, title: '예전 글', type: '카페', date: '2024. 1. 1.', data: { title_1: '예전 제목', body: '예전 본문', hashtags: ['#예전'] } }]));
  await importFile(legacyPath);
  await p.waitForFunction(() => document.querySelector('.tc-x') && document.querySelector('.tc-x').textContent === '예전 제목');
  log('JSON 불러오기: 입력값·생성 결과 복원, 사진은 복원 안 함(배치 자리만), 예전 형식 호환, 무료');

  // ── 생성 이력 ──
  await p.click('#tabHistory');
  const ht = await p.textContent('#historyList');
  assert.match(ht, /✅ 완료/); assert.match(ht, /❌ 실패 · 크레딧 복구됨/);
  await p.screenshot({ path: OUT + '/5-history.png' });
  log('생성 이력: 완료/실패(복구) 표시');

  // ── 이전 글 가져오기 (STEP 1 회귀) ──
  await p.click('#tabSaved');
  await p.click('.legacy-bar button');
  await p.waitForFunction(() => document.getElementById('savedCount').textContent === '2');
  log('STEP 1 회귀: 이전 로컬 글 가져오기');
  assert.match(await p.textContent('#savedUsage'), /저장된 글 2 \/ 5개/);

  // ── ⑩ FREE 저장 한도: 불러온 글을 저장(=새 글) 3개 → 5개, 6번째는 PRO 안내 + 서버 거부 ──
  for (let i = 0; i < 3; i++) {
    await importFile(legacyPath);
    await p.waitForSelector('#rb3.on');
    await p.click('#saveBtn');
    await p.waitForFunction((n) => document.getElementById('savedCount').textContent === String(n), 3 + i);
  }
  assert.match(await p.textContent('#savedUsage'), /저장된 글 5 \/ 5개.*PRO 안내/);
  await importFile(legacyPath);
  await p.waitForSelector('#rb3.on');
  await p.click('#saveBtn');
  await p.waitForSelector('#viewPro.on');
  assert.match(await p.textContent('#proReason'), /최대 5개/);
  assert.doesNotMatch(await p.textContent('#proReason'), /\[\d{3}\]/, 'HTTP 상태 코드 노출 없음');
  assert.ok(await p.isDisabled('#proPayBtn'), '결제 버튼 비활성화 (준비 중)');
  await p.screenshot({ path: OUT + '/6-pro-modal-saved-limit.png' });
  await p.click('#viewPro >> text=닫기');
  assert.equal((await db.collection('posts').where('uid', '==', userUid).get()).size, 5);
  // 삭제하면 다시 저장 가능
  await p.click('#tabSaved');
  await p.click('#savedList button:has-text("🗑️") >> nth=1');
  await p.waitForFunction(() => document.getElementById('savedCount').textContent === '4');
  await p.click('#tabResult');
  await p.click('#saveBtn');
  await p.waitForFunction(() => document.getElementById('savedCount').textContent === '5');
  log('FREE 저장 5개 → 6번째 차단(PRO 안내, 결제 버튼 비활성), 삭제 후 다시 저장 가능');

  // ── ⑪ FREE 내보내기 한도: 누적 5회, 6번째 차단 (불러오기는 계속 가능) ──
  for (let i = 2; i <= 5; i++) {
    const [d] = await Promise.all([p.waitForEvent('download'), p.click('#exportBtn')]);
    await d.path();
    await p.waitForFunction((n) => new RegExp('무료 내보내기 ' + n + ' / 5회').test(document.getElementById('exportUsage').textContent), i);
  }
  await p.click('#exportBtn');
  await p.waitForSelector('#viewPro.on');
  assert.match(await p.textContent('#proReason'), /내보내기 5회/);
  await p.click('#viewPro >> text=닫기');
  assert.equal((await db.doc('users/' + userUid).get()).data().exportCount, 5);
  await importFile(jsonPath);
  await p.waitForFunction(() => document.querySelector('.tc-x') && document.querySelector('.tc-x').textContent !== '예전 제목');
  log('FREE 내보내기 누적 5회 → 6번째 차단(PRO 안내), 불러오기는 무제한');

  // ── ⑫ 악성 HTML 이 든 JSON 불러오기 → 태그 제거, 스크립트 실행 없음 ──
  const evilPath = OUT + '/evil.json';
  fs.writeFileSync(evilPath, JSON.stringify({ format: 'jaeinit-blog-studio', version: 3, plan: 'pro', exportCount: 0, credits: 99,
    input: { title: '<img src=x onerror="window.__xss=1">악성', type: '맛집' },
    result: { title_1: '<img src=x onerror="window.__xss=1">제목', body: '<script>window.__xss=1</script>본문<img src=x onerror="window.__xss=1">', hashtags: ['#a'] } }));
  await importFile(evilPath);
  await p.waitForFunction(() => document.querySelector('.tc-x') && document.querySelector('.tc-x').textContent === '제목');
  await p.click('#tabPreview'); await p.click('#tabResult');
  assert.equal(await p.evaluate(() => window.__xss), undefined);
  assert.equal(await p.locator('#rightResult img, #previewArea img[src="x"]').count(), 0);
  assert.equal(await p.inputValue('#ti'), '악성');
  assert.equal((await db.doc('users/' + userUid).get()).data().plan, 'free', 'JSON 의 plan 필드는 무시');
  log('악성 HTML JSON → 태그 제거·실행 없음, plan/credits 필드 무시');

  // ── ⑬ 작성 스타일: FREE 1개, 생성 시 적용 (크레딧은 생성에만) ──
  await p.click('#stx');
  await p.click('#viewAccount >> text=작성 스타일 관리');
  await p.waitForSelector('#viewStyle.on');
  await p.fill('#sfName', '곰 여행 스타일'); await p.fill('#sfBlog', '여행하는 곰'); await p.fill('#sfGreet', '안녕하세요, 여행하는 곰입니다!');
  await p.selectOption('#sfTone', 'emotional');
  await p.click('#sfSave');
  await p.waitForFunction(() => document.getElementById('styleOk').textContent.includes('저장'));
  await p.waitForFunction(() => Array.from(document.querySelectorAll('#styleSel option')).some((o) => o.textContent.includes('곰 여행 스타일')));
  await p.click('#viewStyle >> text=새로 입력');
  await p.fill('#sfName', '둘째 스타일');
  await p.click('#sfSave');
  assert.match(await p.textContent('#styleErr'), /1개까지/);
  assert.equal((await db.collection('styles').where('uid', '==', userUid).get()).size, 1);
  assert.equal(await credits(), '크레딧 1개', '스타일 저장은 크레딧 없음');
  await p.click('#viewStyle >> text=닫기');
  assert.match(await p.$eval('#styleSel', (s) => s.options[s.selectedIndex].textContent), /곰 여행 스타일/);
  await p.click('text=🔄 새로 작성');
  await fill('', 0);
  await p.waitForTimeout(1100);
  await p.click('#gb');
  await p.waitForSelector('#rb3.on', { timeout: 20000 });
  await p.waitForFunction(() => document.getElementById('stxStatus').textContent === '크레딧 0개');
  assert.ok(bodies.some((x) => x.includes('"styleId"')), '생성 요청에 스타일 ID 전달');
  const styled = (await db.collection('generations').where('uid', '==', userUid).get()).docs.map((d) => d.data()).filter((x) => x.style && x.style.preset === 'custom');
  assert.equal(styled.length, 1);
  assert.equal(styled[0].style.greeting, '안녕하세요, 여행하는 곰입니다!');
  assert.equal(styled[0].style.uid, undefined, '스냅샷에 uid 없음');
  log('작성 스타일: FREE 1개(2번째 차단), 선택한 스타일이 생성에 적용, 저장은 크레딧 없음');

  // ── ⑭ PRO (관리자 테스트 설정 — 실제 결제 아님): 한도 해제, 크레딧 0 이어도 PRO 유지 ──
  await adminSetPlan(db, { uid: userUid, plan: 'pro', reason: 'E2E 테스트 계정', actorUid: 'e2e' });
  await p.waitForFunction(() => document.getElementById('planBadge').textContent === 'PRO');
  assert.equal(await credits(), '크레딧 0개');
  assert.match(await p.textContent('#exportUsage'), /무제한/);
  const [d6] = await Promise.all([p.waitForEvent('download'), p.click('#exportBtn')]);
  await d6.path();
  await importFile(legacyPath);
  await p.waitForSelector('#rb3.on');
  await p.click('#saveBtn');
  await p.waitForFunction(() => document.getElementById('savedCount').textContent === '6');
  assert.match(await p.textContent('#savedUsage'), /6개.*제한이 없어요/);
  await p.screenshot({ path: OUT + '/7-pro-unlimited.png' });
  log('PRO(관리자 테스트 설정): 내보내기 6회째·저장 6개째 허용, 크레딧 0개여도 PRO 유지');

  // ── API 키 노출 확인 ──
  const leaked = bodies.filter((x) => /sk-ant-api|x-api-key/i.test(x) && !x.includes('sk-ant-api03-OLD'));
  assert.equal(leaked.length, 0);
  const html = await p.content();
  assert.ok(!/sk-ant-|api\.anthropic\.com|openapi\.naver\.com/.test(html));
  log('브라우저 요청·페이지에 API 키/외부 AI 엔드포인트 없음');

  // ── 사진 미저장: Storage 요청 없음, Firestore 쓰기에 사진 데이터 없음 ──
  assert.ok(!reqs.some((r) => /:9199|firebasestorage\.googleapis\.com/.test(r.url)), 'Cloud Storage 요청 없음');
  const snippet = JPEGS[0].slice(10, 60);
  const fsWrites = reqs.filter((r) => /:8080|firestore\.googleapis\.com/.test(r.url));
  assert.ok(fsWrites.length > 0 && !fsWrites.some((r) => r.body.includes(snippet) || r.body.includes('data:image')), 'Firestore 쓰기에 사진 없음');
  const genDocs = await db.collection('generations').where('uid', '==', userUid).get();
  const postDocs = await db.collection('posts').where('uid', '==', userUid).get();
  const stored = JSON.stringify(genDocs.docs.map((d) => d.data())) + JSON.stringify(postDocs.docs.map((d) => d.data()));
  assert.ok(!stored.includes(snippet) && !stored.includes('data:image') && !/"photos"/.test(stored), '서버 문서에 사진 없음');
  log('사진 미저장: Storage 요청 없음, Firestore 생성 기록·저장 글에 사진·Base64 없음');

  // ── 회원 탈퇴 ──
  await p.click('#stx');
  await p.click('#viewAccount >> text=회원 탈퇴');
  await p.waitForFunction(() => document.getElementById('stxStatus').textContent === '로그인 필요', null, { timeout: 30000 });
  const relogin = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pw123456', returnSecureToken: true }) });
  assert.equal(relogin.status, 400);
  assert.equal((await db.collection('posts').where('uid', '==', userUid).get()).size, 0);
  assert.equal((await db.collection('generations').where('uid', '==', userUid).get()).size, 0);
  assert.equal((await db.collection('styles').where('uid', '==', userUid).get()).size, 0);
  log('회원 탈퇴 → 계정·글·생성 기록·스타일 삭제, 재로그인 불가');

  assert.deepEqual(errs, []);
  assert.equal(limit429.length, 2, '의도된 서버 한도 거부: 6번째 저장 1회 + 6번째 내보내기 1회');
  log('콘솔 오류 없음 (서버 한도 거부 응답 2건만 — 6번째 저장·내보내기)');
  await b.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
