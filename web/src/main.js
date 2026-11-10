// 앱 진입점 — 이벤트 연결 및 화면 흐름
import './firebase.js';
import { state, g, esc } from './state.js';
import * as A from './auth.js';
import * as api from './api.js';
import * as acct from './account.js';
import * as P from './posts.js';
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
}

/* ── 로그인 상태 변화 ── */
async function syncProfile(u) {
  try { await api.ensureProfile(); } catch (e) { console.warn('ensureUserProfile', e); }
}
A.onUser(async (u) => {
  unsubs.forEach((f) => f()); unsubs = [];
  state.user = u; state.profile = null; state.posts = []; ledger = [];
  updateStatus(); updateSavedCount(); renderSavedList();
  if (!u) return;
  await syncProfile(u);
  unsubs.push(acct.subscribeProfile(u.uid, (p) => { state.profile = p; updateStatus(); renderAccount(); }));
  unsubs.push(acct.subscribeLedger(u.uid, (l) => { ledger = l; renderAccount(); }));
  unsubs.push(P.subscribePosts(u.uid, (posts) => { state.posts = posts; updateSavedCount(); renderSavedList(); }));
});

/* ── 입력 선택 (기존 st/sv) ── */
function st(b, t) { document.querySelectorAll('.tb').forEach((x) => x.classList.remove('on')); b.classList.add('on'); state.sT = t; }
function sv(b, v) { document.querySelectorAll('.vb').forEach((x) => x.classList.remove('on')); b.classList.add('on'); state.sV = v; }
function switchTab(tab) { baseSwitchTab(tab); if (tab === 'saved') renderSavedList(); }

/* ── 생성 ── */
async function gen() {
  const eb = g('eb'); eb.className = 'err';
  if (!state.user) { openAccount(); return; }
  if (A.needsVerification(state.user)) { openAccount(); return; }
  const t = g('ti').value.trim(), m = g('mi').value.trim(), c = g('ci').value.trim(), info = g('ii').value.trim();
  if (!t || !state.sT || !c || !state.sV) { eb.textContent = '⚠️ 제목, 글 유형, 내용, 분량을 모두 입력/선택해주세요!'; eb.className = 'err on'; return; }
  g('gb').disabled = true; g('empty').style.display = 'none'; g('load').className = 'load on';
  ['rb1', 'rb2', 'rb3', 'rb4', 'rb5', 'rb6'].forEach((id) => { g(id).className = 'rb'; });
  const sb = g('sb'); sb.textContent = ''; g('lb').style.width = '0%'; anim();
  switchTab('result');
  try {
    const res = await api.generatePost(
      { title: t, type: state.sT, content: c, memo: m, info, volume: state.sV, images: state.imgs.slice(), clientRequestId: api.newRequestId() },
      (ch) => {
        if (ch.type === 'status') sb.textContent += ch.message + '\n';
        else if (ch.type === 'text') sb.textContent += ch.delta;
        sb.scrollTop = sb.scrollHeight;
      },
    );
    state.resultData = res.result;
    state.resultMeta = { generationId: res.mock ? null : res.generationId, type: state.sT };
    show(res.result);
  } catch (e) {
    g('load').className = 'load'; eb.textContent = '❌ ' + api.apiErrorMessage(e); eb.className = 'err on'; g('gb').disabled = false; g('empty').style.display = '';
  }
}

function reset() {
  ['ti', 'mi', 'ci', 'ii'].forEach((id) => { g(id).value = ''; });
  g('pg').innerHTML = ''; g('pcnt').textContent = ''; g('cnote').className = 'cn';
  document.querySelectorAll('.tb').forEach((b) => b.classList.remove('on'));
  document.querySelectorAll('.vb').forEach((b) => b.classList.remove('on'));
  state.sT = ''; state.sV = ''; state.imgs = []; state.resultData = null; state.resultMeta = null;
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
    meta.textContent = date + (post.type ? ' · ' + post.type : '');
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
    loadBtn.onclick = () => { state.resultData = data; state.resultMeta = { generationId: post.generationId || null, type: post.type }; show(data); switchTab('result'); };
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
