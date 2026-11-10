// 브라우저 스모크 테스트 (선택). 사전 조건: 에뮬레이터 + `npm run dev` 실행 중, playwright 설치 필요.
//   npm i --no-save playwright && npx playwright install chromium && node tests/e2e/smoke.cjs
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs'); const OUT = path.join(__dirname, 'screenshots'); fs.mkdirSync(OUT, { recursive: true });
const AUTH = 'http://127.0.0.1:9099';
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console ' + m.text()); });
  p.on('dialog', async (d) => { console.log('DIALOG:', d.message().replace(/\n/g, ' ')); await d.accept(); });

  // 이전 버전 데이터 심기: API 키 + 저장 글
  await p.goto('http://127.0.0.1:5173/');
  await p.evaluate(() => {
    localStorage.setItem('jaeinit_claude_key', 'sk-ant-api03-OLD');
    localStorage.setItem('jaeinit_naver_id', 'nid'); localStorage.setItem('jaeinit_naver_sec', 'nsec');
    localStorage.setItem('jaeinit_saved_posts', JSON.stringify([
      { id: 1700000000000, title: '예전 글 1', type: '맛집', date: '2024. 1. 1. 오후 3:00:00', data: { title_1: '예전 글 1', body: '안녕하세요\\n예전 본문', hashtags: ['#예전'] } },
      { id: 1700000000001, title: '예전 글 2', type: '카페', date: '2024. 1. 2.', data: { title_1: '예전 글 2', body: '두번째', hashtags: [] } },
    ]));
  });
  await p.reload(); await p.waitForTimeout(1500);
  const keys = await p.evaluate(() => ['jaeinit_claude_key', 'jaeinit_naver_id', 'jaeinit_naver_sec', 'jaeinit_saved_posts'].map((k) => localStorage.getItem(k) !== null));
  console.log('localStorage [claude,naverId,naverSec,savedPosts] 존재:', keys);
  console.log('헤더:', await p.textContent('#stx'), '|', await p.textContent('#stxStatus'));
  await p.screenshot({ path: OUT + '/1-logged-out.png' });

  // 비로그인 생성 → 로그인 모달
  await p.click('#gb');
  console.log('비로그인 생성 클릭 → 로그인 모달 표시:', await p.isVisible('#viewLogin'));
  await p.screenshot({ path: OUT + '/2-login-modal.png' });

  // 이메일 가입
  const email = 'e2e' + Date.now() + '@example.com';
  await p.fill('#authEmail', email); await p.fill('#authPw', 'pw123456');
  await p.click('#btnSignup');
  await p.waitForSelector('#viewVerify.on', { timeout: 10000 });
  await p.waitForTimeout(1500);
  console.log('가입 후 인증 화면, 헤더:', await p.textContent('#stxStatus'));
  // 미인증 상태 생성 시도 → 인증 모달
  await p.click('#viewVerify .auth-link');
  await p.click('#gb');
  console.log('미인증 상태 생성 클릭 → 인증 모달:', await p.isVisible('#viewVerify'));
  // 이메일 인증 (에뮬레이터 OOB 링크 사용)
  const oob = await (await fetch(`${AUTH}/emulator/v1/projects/demo-jaeinit/oobCodes`)).json();
  const code = oob.oobCodes.filter((c) => c.email === email && c.requestType === 'VERIFY_EMAIL').pop();
  await fetch(code.oobLink);
  await p.click('#viewVerify .modal-b >> nth=0'); // 인증 완료
  await p.waitForSelector('#viewAccount.on', { timeout: 10000 });
  await p.waitForFunction(() => document.getElementById('acctCredits').textContent === '2개', null, { timeout: 10000 });
  await p.waitForTimeout(800);
  console.log('계정: 크레딧', await p.textContent('#acctCredits'), '|', await p.textContent('#acctBonus'), '| 원장:', (await p.textContent('#acctLedger')).trim(), '| 헤더:', await p.textContent('#stxStatus'));
  await p.screenshot({ path: OUT + '/3-account.png' });
  await p.click('#viewAccount .modal-b >> nth=-1'); // 닫기

  // 생성
  await p.fill('#ti', '세비야 타파스 맛집 바 알팔파');
  await p.fill('#ci', '살모레호 맛있음, 웨이팅 20분');
  await p.click('.tb >> text=맛집');
  await p.click('.vb >> nth=1');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await p.setInputFiles('#fi', { name: 'a.png', mimeType: 'image/png', buffer: png });
  await p.waitForSelector('.pi');
  await p.click('#gb');
  await p.waitForSelector('#rb3.on', { timeout: 20000 });
  console.log('생성 결과 제목1:', await p.textContent('.tc-x >> nth=0'), '| 글자수:', await p.textContent('#cc'), '| 스트림 박스 길이:', (await p.textContent('#sb')).length);
  await p.screenshot({ path: OUT + '/4-result.png', fullPage: false });
  await p.click('#tabPreview');
  console.log('미리보기 이미지 수:', await p.locator('.pp-img img').count());
  await p.screenshot({ path: OUT + '/5-preview.png' });
  await p.click('#tabResult');

  // 저장
  await p.click('#saveBtn');
  await p.waitForFunction(() => document.getElementById('savedCount').textContent === '1', null, { timeout: 10000 });
  await p.click('#tabSaved');
  console.log('저장 탭 카운트:', await p.textContent('#savedCount'), '| 레거시 배너:', (await p.textContent('#legacyBar')).trim().slice(0, 40));
  await p.click('.legacy-bar button');
  await p.waitForFunction(() => document.getElementById('savedCount').textContent === '3', null, { timeout: 10000 });
  console.log('가져오기 후 카운트:', await p.textContent('#savedCount'), '| 배너 남음:', (await p.textContent('#legacyBar')).trim().length > 0);
  await p.screenshot({ path: OUT + '/6-saved.png' });
  // 다시 로드해도 중복 없음 & 레거시 원본 유지
  await p.reload(); await p.waitForFunction(() => document.getElementById('savedCount').textContent === '3', null, { timeout: 10000 });
  console.log('새로고침 후 카운트 3 유지, 레거시 원본 보존:', await p.evaluate(() => JSON.parse(localStorage.getItem('jaeinit_saved_posts')).length));
  // 불러오기
  await p.click('#tabSaved');
  await p.click('text=📄 불러오기 >> nth=-1');
  console.log('불러온 본문:', (await p.textContent('#btxt')).replace(/\n/g, '⏎').slice(0, 30));
  // 로그아웃
  await p.click('#stx'); await p.click('#viewAccount .modal-b.sub');
  await p.waitForTimeout(800);
  console.log('로그아웃 후 헤더:', await p.textContent('#stxStatus'), '| 저장 카운트:', JSON.stringify(await p.textContent('#savedCount')));
  console.log('ERRORS:', errs.length ? errs : 'none');
  await b.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
