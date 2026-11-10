// 앱 진입점 — 이벤트 연결 및 화면 흐름
import './firebase.js';
import { state, g, esc } from './state.js';
import * as A from './auth.js';
import * as api from './api.js';
import * as acct from './account.js';
import * as P from './posts.js';
import * as G from './generations.js';
import { addImg } from './images.js';
import { show, switchTab as baseSwitchTab, anim, cpId, cpTags, cpAll, cpTxt } from './render.js';

/* ── 보안: 이전 버전이 브라우저에 저장한 API 키 제거 ── */
['jaeinit_claude_key', 'jaeinit_naver_id', 'jaeinit_naver_sec'].forEach((k) => {
  try { if (localStorage.getItem(k) !== null) localStorage.removeItem(k); } catch (e) { /* ignore */ }
});

let unsubs = [];
let ledger = [];
let packagesLoaded = false;

/* ── 모달 ── */
function showView(v) {
  ['viewLogin', 'viewVerify', 'viewAccount'].forEach((id) => g(id).classList.toggle('on', id === v));
  g('modal').className = 'modal';
}
function closeModal() { g('modal').className = 'modal hide'; }
function msg(id, text, isErr) {
  const el = g(id);
  el.textContent = text || '';
  el.className = (isErr ? 'modal-e' : 'auth-ok') + (text ? ' on' : '');
}
function openAccount() {
  const u = state.user;
  if (!u) { msg('me', ''); msg('authOk', ''); return showView('viewLogin'); }
  if (A.needsVerification(u)) { g('verifyEmail').textContent = u.email; msg('verifyErr', ''); msg('verifyOk', ''); return showView('viewVerify'); }
  renderAccount();
  if (!packagesLoaded) loadPackages();
  showView('viewAccount');
}

/* ── 로그인/가입 ── */
async function withBusy(ids, fn) {
  ids.forEach((id) => { g(id).disabled = true; });
  try { return await fn(); } finally { ids.forEach((id) => { g(id).disabled = false; }); }
}
async function loginGoogle() {
  msg('me', '');
  try { await A.loginWithGoogle(); closeModal(); } catch (e) { msg('me', '⚠️ ' + A.authErrorMessage(e), true); }
}
async function loginEmail() {
  msg('me', ''); msg('authOk', '');
  const email = g('authEmail').value.trim(), pw = g('authPw').value;
  await withBusy(['btnLogin', 'btnSignup'], async () => {
    try {
      const u = await A.loginWithEmail(email, pw);
      g('authPw').value = '';
      if (A.needsVerification(u)) openAccount(); else closeModal();
    } catch (e) { msg('me', '⚠️ ' + A.authErrorMessage(e), true); }
  });
}
async function signupEmail() {
  msg('me', ''); msg('authOk', '');
  const email = g('authEmail').value.trim(), pw = g('authPw').value;
  await withBusy(['btnLogin', 'btnSignup'], async () => {
    try {
      await A.signupWithEmail(email, pw);
      g('authPw').value = '';
      openAccount();
    } catch (e) { msg('me', '⚠️ ' + A.authErrorMessage(e), true); }
  });
}
async function resetPw() {
  const email = g('authEmail').value.trim();
  if (!email) return msg('me', '⚠️ 이메일을 먼저 입력해주세요.', true);
  try { await A.resetPassword(email); msg('me', ''); msg('authOk', '📧 비밀번호 재설정 메일을 보냈어요.'); } catch (e) { msg('me', '⚠️ ' + A.authErrorMessage(e), true); }
}
async function resendVerify() {
  try { await A.resendVerification(); msg('verifyErr', ''); msg('verifyOk', '📧 인증 메일을 다시 보냈어요.'); } catch (e) { msg('verifyErr', '⚠️ ' + A.authErrorMessage(e), true); }
}
async function checkVerified() {
  try {
    const u = await A.refreshUser();
    if (!u.emailVerified) return msg('verifyErr', '⚠️ 아직 인증되지 않았어요. 메일의 링크를 눌러주세요.', true);
    await syncProfile(u);
    renderAccount(); showView('viewAccount');
  } catch (e) { msg('verifyErr', '⚠️ ' + A.authErrorMessage(e), true); }
}
async function logout() {
  await A.logoutUser();
  closeModal();
}

/* ── 계정 화면 ── */
function renderAccount() {
  const u = state.user, p = state.profile;
  if (!u) return;
  g('acctEmail').textContent = u.email || '';
  g('acctCredits').textContent = p ? (p.credits || 0) + '개' : '…';
  const bs = p && p.signupBonus ? p.signupBonus.status : '';
  g('acctBonus').textContent = bs === 'granted' ? '🎁 가입 무료 크레딧 지급 완료'
    : bs === 'pending_verification' ? '📧 이메일 인증 후 무료 크레딧 2개가 지급돼요'
      : bs === 'ineligible' ? '이 이메일은 이미 가입 혜택을 받았어요' : '';
  if (document.activeElement !== g('acctName')) g('acctName').value = (p && p.displayName) || '';
  const L = g('acctLedger'); L.innerHTML = '';
  if (!ledger.length) L.innerHTML = '<div class="acct-led-i" style="color:#bbb">내역이 없어요</div>';
  ledger.forEach((x) => {
    const row = document.createElement('div'); row.className = 'acct-led-i';
    const when = x.createdAt && x.createdAt.toDate ? x.createdAt.toDate().toLocaleDateString('ko-KR') : '';
    row.innerHTML = '<span>' + esc(acct.LEDGER_LABEL[x.type] || x.type) + ' <span style="color:#bbb">' + esc(when) + '</span></span>'
      + '<span class="' + (x.delta > 0 ? 'p' : 'm') + '">' + (x.delta > 0 ? '+' : '') + x.delta + ' (잔액 ' + x.balanceAfter + ')</span>';
    L.appendChild(row);
  });
}
async function loadPackages() {
  try {
    const list = await acct.loadPackages();
    packagesLoaded = true;
    const el = g('acctPackages');
    el.innerHTML = list.length ? '' : '<div style="grid-column:1/-1;font-size:11px;color:#bbb;text-align:center">상품 준비 중</div>';
    list.forEach((p) => {
      const d = document.createElement('div'); d.className = 'acct-pk-i';
      d.innerHTML = '<b>' + esc(p.credits) + '회</b>' + esc(Number(p.price).toLocaleString('ko-KR')) + '원';
      el.appendChild(d);
    });
  } catch (e) { console.warn(e); }
}
async function saveName() {
  const name = g('acctName').value.trim();
  if (!name || name.length > 40) return msg('acctOk', '⚠️ 이름은 1~40자로 입력해주세요.', true);
  try { await acct.updateDisplayName(state.user.uid, name); msg('acctOk', '✅ 저장했어요.'); setTimeout(() => msg('acctOk', ''), 2000); } catch (e) { msg('acctOk', '⚠️ 저장 실패: ' + e.message, true); }
}

/* ── 헤더 상태 ── */
function updateStatus() {
  const u = state.user, p = state.profile;
  const dot = g('dot'), stx = g('stxStatus');
  if (!u) { g('stx').textContent = '👤 로그인'; dot.className = 'hd-dot'; stx.textContent = '로그인 필요'; return; }
  g('stx').textContent = '👤 내 계정';
  if (A.needsVerification(u)) { dot.className = 'hd-dot'; stx.textContent = '이메일 인증 필요'; return; }
  const c = p ? p.credits || 0 : null;
  dot.className = 'hd-dot' + (c ? ' on' : '');
  stx.textContent = c === null ? '불러오는 중…' : '크레딧 ' + c + '개';
  updateGenHint();
}
function updateGenHint() {
  const h = g('genHint'), p = state.profile;
  if (!state.user) { h.innerHTML = '💳 로그인 후 이용 · 신규 회원 무료 2크레딧'; return; }
  if (A.needsVerification(state.user)) { h.innerHTML = '📧 이메일 인증 후 무료 2크레딧이 지급돼요'; return; }
  const c = p ? p.credits || 0 : 0;
  h.innerHTML = c > 0
    ? '💳 생성 1회 = <b>1크레딧</b> 차감 · 실패하면 자동 복구 · 남은 크레딧 <b>' + c + '개</b>'
    : '🙏 크레딧을 모두 사용했어요 · 충전 기능은 곧 오픈 예정이에요';
}

/* ── 로그인 상태 변화 ── */
async function syncProfile(u) {
  try { await api.ensureProfile(); } catch (e) { console.warn('ensureUserProfile', e); }
}
A.onUser(async (u) => {
  unsubs.forEach((f) => f()); unsubs = [];
  state.user = u; state.profile = null; state.posts = []; ledger = [];
  state.generations = [];
  updateStatus(); updateSavedCount(); renderSavedList(); renderHistory();
  if (!u) return;
  await syncProfile(u);
  unsubs.push(acct.subscribeProfile(u.uid, (p) => { state.profile = p; updateStatus(); renderAccount(); }));
  unsubs.push(G.subscribeGenerations(u.uid, (list) => { state.generations = list; renderHistory(); }));
  resumePending(u.uid);
  unsubs.push(acct.subscribeLedger(u.uid, (l) => { ledger = l; renderAccount(); }));
  unsubs.push(P.subscribePosts(u.uid, (posts) => { state.posts = posts; updateSavedCount(); renderSavedList(); }));
});

/* ── 입력 선택 (기존 st/sv) ── */
function st(b, t) { document.querySelectorAll('.tb').forEach((x) => x.classList.remove('on')); b.classList.add('on'); state.sT = t; }
function sv(b, v) { document.querySelectorAll('.vb').forEach((x) => x.classList.remove('on')); b.classList.add('on'); state.sV = v; }
function switchTab(tab) { baseSwitchTab(tab); if (tab === 'saved') renderSavedList(); if (tab === 'history') renderHistory(); }

/* ── 생성 ── */
let watchUnsub = null;
let watchTimer = null;
function stopWatch() { if (watchUnsub) { watchUnsub(); watchUnsub = null; } if (watchTimer) { clearInterval(watchTimer); watchTimer = null; } }

function showError(text, { retry = false, info = false } = {}) {
  const eb = g('eb');
  eb.innerHTML = '';
  const t = document.createElement('div'); t.textContent = text; eb.appendChild(t);
  if (retry) {
    const b = document.createElement('button'); b.className = 'err-retry'; b.textContent = '🔄 다시 시도'; b.onclick = () => { lastFinishedAt = 0; gen(); };
    eb.appendChild(b);
  }
  eb.className = 'err on' + (info ? ' info' : '');
  try { eb.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* ignore */ }
}
function endLoading() {
  g('load').className = 'load'; g('gb').disabled = false; state.inFlight = false; lastFinishedAt = Date.now();
  if (!state.resultData) g('empty').style.display = '';
}
function startLoading(msg) {
  g('gb').disabled = true; g('empty').style.display = 'none'; g('load').className = 'load on';
  ['rb1', 'rb2', 'rb3', 'rb4', 'rb5', 'rb6'].forEach((id) => { g(id).className = 'rb'; });
  g('sb').textContent = msg || ''; g('lb').style.width = '0%'; anim();
  switchTab('result');
}

/** 생성 결과(서버 응답 또는 generations 문서)를 화면에 표시 */
async function showGeneration(gen, { localPhotos } = {}) {
  state.resultData = gen.result;
  state.resultMeta = { generationId: gen.generationId || gen.id, type: (gen.input && gen.input.type) || state.sT, photos: (gen.photos || []).map((p) => ({ path: p.path, index: p.index })) };
  state.previewPhotos = localPhotos || [];
  show(gen.result);
  if (!localPhotos && state.resultMeta.photos.length) {
    const meta = state.resultMeta;
    const urls = await G.photoUrls(meta.photos);
    if (state.resultMeta !== meta) return;
    state.previewPhotos = urls.filter(Boolean);
    if (g('rightPreview').style.display !== 'none') renderPreview();
    g('tabPreview').style.color = '#2d6a4f';
  }
}

function finishWithFailure(gen) {
  endLoading();
  const msg = (gen.error && gen.error.message) || '생성에 실패했어요.';
  showError('❌ ' + msg + (gen.charge && gen.charge.status === 'refunded' || gen.refunded ? ' 차감된 1크레딧은 자동으로 복구됐어요.' : ''), { retry: !gen.error || gen.error.retryable !== false });
}

/** 결과를 모르는 생성 건(네트워크 끊김·새로고침)을 서버 기록으로 추적 */
function trackGeneration(uid, generationId, { localPhotos } = {}) {
  stopWatch();
  let seen = false;
  const startedAt = Date.now();
  const check = async () => {
    try {
      const s = await api.getGenerationStatus(generationId); // lease 가 지난 건은 서버가 이 자리에서 복구
      if (s.status !== 'processing') { /* onSnapshot 이 처리 */ }
    } catch (e) {
      // 문서가 없음 = 요청이 서버에 도달하지 않음 → 차감도 없음
      if (e.code === 'functions/not-found' && Date.now() - startedAt > 8000) {
        stopWatch(); G.clearPending(uid); state.currentRequestId = null; endLoading();
        showError('⚠️ 요청이 서버에 전달되지 않았어요. 크레딧은 차감되지 않았어요.', { retry: true });
      }
    }
  };
  watchUnsub = G.watchGeneration(generationId, async (doc) => {
    if (!doc) return;
    seen = true;
    if (doc.status === 'processing') { g('lst').textContent = '⏳ 서버에서 생성 중이에요...'; return; }
    stopWatch(); G.clearPending(uid); state.currentRequestId = null;
    if (doc.status === 'succeeded') {
      g('eb').className = 'err'; endLoading();
      await showGeneration(doc, { localPhotos });
    } else {
      finishWithFailure(doc);
    }
  });
  watchTimer = setInterval(check, 10000);
  setTimeout(check, 2500);
}

async function resumePending(uid) {
  const p = G.loadPending(uid);
  if (!p || !p.generationId) return;
  state.inFlight = true;
  state.currentRequestId = p.clientRequestId;
  startLoading('🔄 이전 생성 요청의 상태를 확인하고 있어요...\n');
  trackGeneration(uid, p.generationId);
}

let lastFinishedAt = 0;
async function gen(ev) {
  // 더블클릭 방지: 진행 중이거나, 더블클릭의 두 번째 클릭이거나, 방금(1초 내) 끝난 직후의 클릭은 무시
  if (state.inFlight || (ev && ev.detail > 1) || Date.now() - lastFinishedAt < 1000) return;
  const eb = g('eb'); eb.className = 'err';
  if (!state.user) { openAccount(); return; }
  if (A.needsVerification(state.user)) { openAccount(); return; }
  const t = g('ti').value.trim(), m = g('mi').value.trim(), c = g('ci').value.trim(), info = g('ii').value.trim();
  if (!t || !state.sT || !c || !state.sV) { showError('⚠️ 제목, 글 유형, 내용, 분량을 모두 입력/선택해주세요!'); return; }
  if (state.profile && (state.profile.credits || 0) < 1) {
    showError('🙏 크레딧을 모두 사용했어요. 크레딧 충전 기능은 곧 오픈 예정이에요. 조금만 기다려주세요!', { info: true });
    return;
  }
  state.inFlight = true;
  const uid = state.user.uid;
  // 결과가 확정되기 전 재시도는 같은 멱등 키 → 서버가 중복 실행·차감하지 않음
  const clientRequestId = state.currentRequestId || api.newRequestId();
  state.currentRequestId = clientRequestId;
  const generationId = uid + '_' + clientRequestId;
  const localPhotos = state.imgs.slice();
  G.savePending(uid, { generationId, clientRequestId, startedAt: Date.now() });
  state.resultData = null;
  startLoading();
  const sb = g('sb');
  try {
    const res = await api.generatePost(
      { title: t, type: state.sT, content: c, memo: m, info, volume: state.sV, images: localPhotos, clientRequestId },
      (ch) => {
        if (ch.type === 'status') sb.textContent += ch.message + '\n';
        else if (ch.type === 'text') sb.textContent += ch.delta;
        sb.scrollTop = sb.scrollHeight;
      },
    );
    if (res.status === 'processing') { trackGeneration(uid, generationId, { localPhotos }); return; }
    G.clearPending(uid); state.currentRequestId = null;
    if (res.status === 'failed') { finishWithFailure(res); return; }
    endLoading();
    await showGeneration(res, { localPhotos });
  } catch (e) {
    if (api.isDefinitiveError(e)) {
      G.clearPending(uid); state.currentRequestId = null; endLoading();
      const d = e.details || {};
      showError('❌ ' + api.apiErrorMessage(e), { retry: d.retryable === true || (d.refunded && d.retryable !== false) });
    } else {
      // 네트워크 끊김 등: 서버에서는 계속 처리 중일 수 있음 → 기록을 추적 (같은 키로만 재시도)
      g('lst').textContent = '📡 연결이 끊겼어요. 생성 상태를 확인하는 중...';
      showError('📡 연결이 불안정해요. 서버의 생성 결과를 확인하고 있어요. (중복 차감되지 않아요)', { info: true });
      trackGeneration(uid, generationId, { localPhotos });
    }
  }
}

/* ── 생성 이력 ── */
function renderHistory() {
  const list = g('historyList'), empty = g('historyEmpty');
  list.innerHTML = '';
  if (!state.user) { g('historyEmptyT').textContent = '로그인하면 생성 이력을 볼 수 있어요'; empty.style.display = 'block'; return; }
  g('historyEmptyT').textContent = '생성 이력이 없어요';
  const items = state.generations;
  if (!items.length) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  items.forEach((it) => {
    const inp = it.input || {};
    const card = document.createElement('div'); card.style.cssText = 'background:#fff;border:1px solid #e4e1dc;border-radius:12px;padding:16px;margin-bottom:10px;';
    const h = document.createElement('div'); h.style.cssText = 'font-size:14px;font-weight:700;color:#1a1a1a;line-height:1.5;margin-bottom:4px';
    h.textContent = (it.result && it.result.title_1) || inp.title || '제목 없음';
    const meta = document.createElement('div'); meta.style.cssText = 'font-size:11px;color:#888;margin-bottom:10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap';
    const st = document.createElement('span');
    if (it.status === 'succeeded') { st.className = 'hst ok'; st.textContent = '✅ 완료 · 1크레딧 사용'; }
    else if (it.status === 'processing') { st.className = 'hst run'; st.textContent = '⏳ 생성 중'; }
    else { st.className = 'hst fail'; st.textContent = '❌ 실패 · 크레딧 복구됨'; }
    const when = it.createdAt && it.createdAt.toDate ? it.createdAt.toDate().toLocaleString('ko-KR') : '';
    const tx = document.createElement('span'); tx.textContent = when + (inp.type ? ' · ' + inp.type : '') + (inp.imageCount ? ' · 사진 ' + inp.imageCount + '장' : '');
    meta.appendChild(st); meta.appendChild(tx);
    card.appendChild(h); card.appendChild(meta);
    if (it.status === 'failed' && it.error) {
      const em = document.createElement('div'); em.style.cssText = 'font-size:12px;color:#dc3545;margin-bottom:10px'; em.textContent = it.error.message; card.appendChild(em);
    }
    const btns = document.createElement('div'); btns.style.cssText = 'display:flex;gap:6px';
    if (it.status === 'succeeded') {
      const lb = document.createElement('button');
      lb.style.cssText = 'flex:1;padding:9px;background:#2d6a4f;color:#fff;border:none;border-radius:8px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer';
      lb.textContent = '📄 불러오기';
      lb.onclick = () => { switchTab('result'); showGeneration(it); };
      btns.appendChild(lb);
    }
    const rb = document.createElement('button');
    rb.style.cssText = 'flex:1;padding:9px;background:#fff;color:#2d6a4f;border:1.5px solid #2d6a4f;border-radius:8px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer';
    rb.textContent = '✏️ 입력 다시 쓰기';
    rb.onclick = () => refillForm(inp);
    btns.appendChild(rb);
    card.appendChild(btns);
    list.appendChild(card);
  });
}

/** 이력의 입력값으로 왼쪽 폼 채우기 (사진은 다시 선택) */
function refillForm(inp) {
  g('ti').value = inp.title || ''; g('mi').value = inp.memo || ''; g('ci').value = inp.content || ''; g('ii').value = inp.info || '';
  document.querySelectorAll('.tb').forEach((b) => { if (b.textContent.trim().endsWith(inp.type)) st(b, inp.type); });
  const vi = { short: 0, normal: 1, long: 2 }[inp.volume];
  if (vi != null) sv(document.querySelectorAll('.vb')[vi], inp.volume);
  state.currentRequestId = null;
  g('ti').focus();
}

function reset() {
  ['ti', 'mi', 'ci', 'ii'].forEach((id) => { g(id).value = ''; });
  g('pg').innerHTML = ''; g('pcnt').textContent = ''; g('cnote').className = 'cn';
  document.querySelectorAll('.tb').forEach((b) => b.classList.remove('on'));
  document.querySelectorAll('.vb').forEach((b) => b.classList.remove('on'));
  if (state.inFlight) return; // 생성 중에는 초기화하지 않음
  state.sT = ''; state.sV = ''; state.imgs = []; state.resultData = null; state.resultMeta = null; state.previewPhotos = null; state.currentRequestId = null;
  ['rb1', 'rb2', 'rb3', 'rb4', 'rb5', 'rb6'].forEach((id) => { g(id).className = 'rb'; });
  g('load').className = 'load'; g('eb').className = 'err'; g('gb').disabled = false; g('empty').style.display = '';
  g('rightResult').scrollTop = 0; switchTab('result');
}

/* ── 저장된 글 (Firestore) ── */
function updateSavedCount() { const n = state.posts.length; g('savedCount').textContent = n > 0 ? n : ''; }

async function savePost() {
  if (!state.resultData) { alert('저장할 글이 없어요!'); return; }
  if (!state.user) { openAccount(); return; }
  const btn = g('saveBtn');
  try {
    btn.disabled = true;
    await P.createPost(state.user.uid, {
      title: state.resultData.title_1 || g('ti').value || '제목 없음',
      type: (state.resultMeta && state.resultMeta.type) || state.sT,
      data: state.resultData,
      generationId: state.resultMeta && state.resultMeta.generationId,
      photos: (state.resultMeta && state.resultMeta.photos) || [],
    });
    btn.textContent = '✅ 저장됨!'; btn.style.background = '#388e3c'; btn.style.color = '#fff'; btn.style.borderColor = '#388e3c';
    setTimeout(() => { btn.textContent = '💾 저장'; btn.style.background = ''; btn.style.color = ''; btn.style.borderColor = ''; }, 2000);
  } catch (e) {
    alert('저장에 실패했어요: ' + e.message);
  } finally { btn.disabled = false; }
}

function renderLegacyBar() {
  const bar = g('legacyBar'); bar.innerHTML = '';
  const legacy = P.getLegacyPosts();
  if (!state.user || !legacy.length) return;
  const imported = new Set(state.posts.filter((p) => p.legacyId != null).map((p) => String(p.legacyId)));
  const left = legacy.filter((p) => !imported.has(String(p.id))).length;
  if (!left) return;
  const d = document.createElement('div'); d.className = 'legacy-bar';
  const t = document.createElement('span'); t.textContent = '📦 이 브라우저에 저장된 이전 글 ' + left + '개가 있어요. 계정으로 옮기면 어디서든 볼 수 있어요.';
  const b = document.createElement('button'); b.textContent = '계정으로 가져오기';
  b.onclick = async () => {
    b.disabled = true; b.textContent = '가져오는 중…';
    try { const r = await P.importLegacyPosts(state.user.uid); alert('✅ ' + r.imported + '개 가져왔어요.' + (r.skipped ? ' (이미 있는 글 ' + r.skipped + '개 제외)' : '') + '\n원본은 이 브라우저에도 그대로 남아 있어요.'); } catch (e) { alert('가져오기 실패: ' + e.message); b.disabled = false; b.textContent = '계정으로 가져오기'; }
  };
  d.appendChild(t); d.appendChild(b); bar.appendChild(d);
}

function renderSavedList() {
  const list = g('savedList'), empty = g('savedEmpty');
  list.innerHTML = '';
  renderLegacyBar();
  if (!state.user) {
    g('savedEmptyT').textContent = '로그인하면 저장된 글을 볼 수 있어요';
    const n = P.getLegacyPosts().length;
    g('savedEmptyD').textContent = n ? '이 브라우저에 이전 글 ' + n + '개가 보관되어 있어요. 로그인 후 계정으로 가져올 수 있어요.' : '상단의 👤 로그인 버튼을 눌러주세요';
    empty.style.display = 'block'; return;
  }
  g('savedEmptyT').textContent = '저장된 글이 없어요';
  g('savedEmptyD').textContent = '포스팅 생성 후 💾 저장 버튼을 누르세요';
  const posts = state.posts;
  if (posts.length === 0) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  const clearAll = document.createElement('div'); clearAll.style.cssText = 'text-align:right;margin-bottom:12px';
  const clearBtn = document.createElement('button');
  clearBtn.style.cssText = 'background:none;border:1px solid #ffcdd2;color:#dc3545;border-radius:7px;padding:6px 12px;font-family:inherit;font-size:11px;cursor:pointer';
  clearBtn.textContent = '🗑️ 전체 삭제';
  clearBtn.onclick = async () => { if (!confirm('저장된 글 ' + posts.length + '개를 모두 삭제할까요?')) return; await P.removeAllPosts(state.user.uid); };
  clearAll.appendChild(clearBtn); list.appendChild(clearAll);

  posts.forEach((post) => {
    const data = post.data || {};
    const card = document.createElement('div'); card.style.cssText = 'background:#fff;border:1px solid #e4e1dc;border-radius:12px;padding:16px;margin-bottom:10px;';
    const header = document.createElement('div'); header.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px';
    const titleDiv = document.createElement('div'); titleDiv.style.cssText = 'flex:1';
    const h = document.createElement('div'); h.style.cssText = 'font-size:14px;font-weight:700;color:#1a1a1a;line-height:1.5;margin-bottom:4px'; h.textContent = post.title;
    const meta = document.createElement('div'); meta.style.cssText = 'font-size:11px;color:#888';
    const date = post.legacySavedAt || (post.createdAt && post.createdAt.toDate ? post.createdAt.toDate().toLocaleString('ko-KR') : '');
    meta.textContent = date + (post.type ? ' · ' + post.type : '') + (post.photos && post.photos.length ? ' · 📸 ' + post.photos.length + '장' : '');
    titleDiv.appendChild(h); titleDiv.appendChild(meta); header.appendChild(titleDiv); card.appendChild(header);

    const bodyPrev = document.createElement('div');
    bodyPrev.style.cssText = 'font-size:12px;line-height:1.7;color:#555;max-height:60px;overflow:hidden;margin-bottom:12px;white-space:pre-line';
    bodyPrev.textContent = (data.body || '').replace(/\\n/g, '\n').substring(0, 150) + '...';
    card.appendChild(bodyPrev);

    if (data.hashtags && data.hashtags.length > 0) {
      const tagRow = document.createElement('div'); tagRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px';
      data.hashtags.slice(0, 5).forEach((t) => { const tag = document.createElement('span'); tag.style.cssText = 'background:#e8f5ee;color:#1b4332;border-radius:99px;padding:2px 8px;font-size:10px'; tag.textContent = t; tagRow.appendChild(tag); });
      if (data.hashtags.length > 5) { const more = document.createElement('span'); more.style.cssText = 'font-size:10px;color:#888;padding:2px 4px'; more.textContent = '+' + (data.hashtags.length - 5) + '개'; tagRow.appendChild(more); }
      card.appendChild(tagRow);
    }

    const btns = document.createElement('div'); btns.style.cssText = 'display:flex;gap:6px';
    const loadBtn = document.createElement('button');
    loadBtn.style.cssText = 'flex:1;padding:9px;background:#2d6a4f;color:#fff;border:none;border-radius:8px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer';
    loadBtn.textContent = '📄 불러오기';
    loadBtn.onclick = () => {
      switchTab('result');
      showGeneration({ id: post.generationId || null, result: data, input: { type: post.type }, photos: post.photos || [] });
    };
    const cpBtn = document.createElement('button');
    cpBtn.style.cssText = 'flex:1;padding:9px;background:#fff;color:#2d6a4f;border:1.5px solid #2d6a4f;border-radius:8px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer';
    cpBtn.textContent = '📋 복사';
    cpBtn.onclick = () => {
      cpTxt('[제목]\n' + post.title + '\n\n[본문]\n' + (data.body || '').replace(/\\n/g, '\n') + '\n\n[해시태그]\n' + (data.hashtags || []).join(' '));
      cpBtn.textContent = '✅ 복사됨'; setTimeout(() => { cpBtn.textContent = '📋 복사'; }, 2000);
    };
    const delBtn = document.createElement('button');
    delBtn.style.cssText = 'padding:9px 12px;background:#fff;color:#dc3545;border:1.5px solid #ffcdd2;border-radius:8px;font-family:inherit;font-size:12px;cursor:pointer';
    delBtn.textContent = '🗑️';
    delBtn.onclick = async () => { if (!confirm('이 글을 삭제할까요?')) return; await P.removePost(post.id); };
    btns.appendChild(loadBtn); btns.appendChild(cpBtn); btns.appendChild(delBtn);
    card.appendChild(btns); list.appendChild(card);
  });
}

/* ── HTML onclick 에서 쓰는 함수 노출 (기존 마크업 유지) ── */
Object.assign(window, {
  st, sv, gen, reset, savePost, switchTab, addImg, cpId, cpTags, cpAll,
  openAccount, closeModal, loginGoogle, loginEmail, signupEmail, resetPw, resendVerify, checkVerified, logout, saveName,
});

renderSavedList();
