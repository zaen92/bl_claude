// 결과/미리보기/복사 렌더링 — 기존 show(), renderPreview(), cp* 로직 유지
import { state, g, esc, nl } from './state.js';

export function anim() {
  const ss = [{ l: '📊 제목 분석 중...', p: 15 }, { l: '🔍 키워드 추출 중...', p: 30 }, { l: '✍️ 본문 작성 중...', p: 60 }, { l: '🎯 SEO 최적화 중...', p: 88 }, { l: '✅ 완성!', p: 100 }];
  let k = 0;
  (function tk() { if (k >= ss.length) return; g('lst').textContent = ss[k].l; g('lb').style.width = ss[k].p + '%'; k++; setTimeout(tk, 1200); })();
}

export function switchTab(tab) {
  g('tabResult').className = 'tab-btn' + (tab === 'result' ? ' on' : '');
  g('tabPreview').className = 'tab-btn' + (tab === 'preview' ? ' on' : '');
  g('tabSaved').className = 'tab-btn' + (tab === 'saved' ? ' on' : '');
  g('tabHistory').className = 'tab-btn' + (tab === 'history' ? ' on' : '');
  g('rightHistory').style.display = tab === 'history' ? 'flex' : 'none';
  g('rightResult').style.display = tab === 'result' ? 'flex' : 'none';
  g('rightPreview').style.display = tab === 'preview' ? 'flex' : 'none';
  g('rightSaved').style.display = tab === 'saved' ? 'flex' : 'none';
  if (tab === 'preview') renderPreview();
}

export function show(d) {
  g('load').className = 'load';
  g('empty').style.display = 'none';
  const tcs = g('tcs'); tcs.innerHTML = '';
  [d.title_1, d.title_2, d.title_3].forEach((ti, ix) => {
    if (!ti) return;
    const c = document.createElement('div'); c.className = 'tc';
    const n = document.createElement('div'); n.className = 'tc-n'; n.textContent = ix + 1;
    const x = document.createElement('div'); x.className = 'tc-x'; x.textContent = ti;
    const b = document.createElement('button'); b.className = 'tc-c'; b.textContent = '복사';
    b.onclick = () => { cpTxt(ti); b.textContent = '✅'; b.classList.add('ok'); setTimeout(() => { b.textContent = '복사'; b.classList.remove('ok'); }, 2000); };
    c.appendChild(n); c.appendChild(x); c.appendChild(b); tcs.appendChild(c);
  });
  g('rb1').className = 'rb on';
  const kg = g('kg'); kg.innerHTML = '';
  [['메인 키워드', d.keyword_main], ['서브 키워드', d.keyword_sub], ['지역 키워드', d.keyword_location], ['검색 의도', d.keyword_intent]].forEach((p) => {
    const c = document.createElement('div'); c.className = 'kc';
    const l = document.createElement('div'); l.className = 'kl'; l.textContent = p[0];
    const v = document.createElement('div'); v.className = 'kv'; v.textContent = p[1] || '-';
    c.appendChild(l); c.appendChild(v); kg.appendChild(c);
  });
  g('rb2').className = 'rb on';

  /* 위치 정보 + 네이버 지도 (AI 결과는 HTML 이스케이프 후 삽입) */
  const pn = d.place_name || '', pa = d.place_address || '', ph = d.place_hours || '', pp = d.place_price || '';
  g('rb6').className = 'rb';
  if (pn || pa) {
    let h = '<div style="display:flex;flex-direction:column;gap:8px">';
    if (pn) h += '<div class="kc"><div class="kl">업체명</div><div class="kv" style="font-size:14px">' + esc(pn) + '</div></div>';
    if (pa) h += '<div class="kc"><div class="kl">주소</div><div class="kv">' + esc(pa) + '</div></div>';
    if (ph) h += '<div class="kc"><div class="kl">영업시간</div><div class="kv">' + esc(ph) + '</div></div>';
    if (pp) h += '<div class="kc"><div class="kl">가격대</div><div class="kv">' + esc(pp) + '</div></div>';
    h += '</div>';
    g('placeInfo').innerHTML = h;
    const mapLink = g('naverMapLink');
    mapLink.href = 'https://map.naver.com/v5/search/' + encodeURIComponent(pn + (pa ? ' ' + pa : ''));
    mapLink.style.display = 'block';
    g('rb6').className = 'rb on';
  }

  const bs = nl(d.body || '');
  g('btxt').textContent = bs;
  g('cc').textContent = bs.replace(/\s/g, '').length.toLocaleString() + '자';
  g('rb3').className = 'rb on';
  const tw = g('tw'); tw.innerHTML = '';
  let ht = d.hashtags || [];
  if (!ht.length) { const mm = (d.body || '').match(/#[가-힣a-zA-Z0-9_]+/g); if (mm) ht = mm.slice(0, 15); }
  ht.forEach((t) => { const s = document.createElement('span'); s.className = 'tag'; s.textContent = t; s.onclick = () => cpTxt(t); tw.appendChild(s); });
  g('rb4').className = 'rb on';
  g('rt').textContent = nl(d.reel || ''); g('th').textContent = nl(d.thumbnail || ''); g('rb5').className = 'rb on';
  g('gb').disabled = false;
  g('rightResult').scrollTop = 0;
  if ((state.previewPhotos || state.imgs).length > 0) g('tabPreview').style.color = '#2d6a4f';
}

export function renderPreview() {
  const area = g('previewArea');
  if (!state.resultData) {
    area.innerHTML = '<div class="preview-no"><div class="preview-no-ico">👀</div><div class="preview-no-txt">포스팅을 먼저 생성하면<br>사진이 합쳐진 미리보기를 볼 수 있어요</div></div>';
    return;
  }
  const d = state.resultData, imgs = state.previewPhotos || state.imgs;
  const title = d.title_1 || g('ti').value || '제목 없음';
  const bodyRaw = nl(d.body || '');
  const tags = (d.hashtags || []).join(' ');
  const parts = bodyRaw.split(/(\[사진\d*\])/g);
  let imgIdx = 0, bodyHtml = '';
  parts.forEach((part) => {
    const m = part.match(/\[사진(\d*)\]/);
    if (m) {
      const idx = m[1] ? parseInt(m[1], 10) - 1 : imgIdx;
      if (imgs[idx]) bodyHtml += '<div class="pp-img"><img src="' + esc(imgs[idx]) + '" alt="사진' + (idx + 1) + '"></div>';
      else bodyHtml += '<div class="pp-img-empty"><div class="pp-img-empty-ico">📸</div><div class="pp-img-empty-txt">사진' + (idx + 1) + ' — 왼쪽에서 사진을 업로드하세요</div></div>';
      imgIdx++;
    } else {
      bodyHtml += '<p>' + esc(part) + '</p>';
    }
  });
  if (imgIdx === 0 && imgs.length > 0) {
    bodyHtml += '<div style="margin-top:20px">';
    imgs.forEach((src, i) => { bodyHtml += '<div class="pp-img"><img src="' + esc(src) + '" alt="사진' + (i + 1) + '"></div>'; });
    bodyHtml += '</div>';
  }
  let tagsHtml = '';
  if (tags) {
    tagsHtml = '<div class="preview-post-tags">';
    tags.split(/\s+/).forEach((t) => { if (t.startsWith('#')) tagsHtml += '<span>' + esc(t) + '</span> '; });
    tagsHtml += '</div>';
  }
  area.innerHTML = '<div class="preview-wrap"><div class="preview-post">'
    + '<div class="preview-post-title">' + esc(title) + '</div>'
    + '<div class="preview-post-body">' + bodyHtml + '</div>'
    + tagsHtml + '</div></div>';
}

/* ── 복사 ── */
export function cpTxt(t) { if (navigator.clipboard) navigator.clipboard.writeText(t).catch(() => fb(t)); else fb(t); }
function fb(t) { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); document.execCommand('copy'); document.body.removeChild(a); }
export function cpId(id, b) { const o = b.textContent; cpTxt(g(id).textContent); b.textContent = '✅ 복사됨!'; b.classList.add('ok'); setTimeout(() => { b.textContent = o; b.classList.remove('ok'); }, 2000); }
export function cpTags(b) { const t = Array.from(document.querySelectorAll('.tag')).map((x) => x.textContent).join(' '); const o = b.textContent; cpTxt(t); b.textContent = '✅ 복사됨!'; b.classList.add('ok'); setTimeout(() => { b.textContent = o; b.classList.remove('ok'); }, 2000); }
export function cpAll() {
  const ti = Array.from(document.querySelectorAll('.tc-x')).map((e, i) => (i + 1) + '. ' + e.textContent).join('\n');
  cpTxt('[제목]\n' + ti + '\n\n[본문]\n' + g('btxt').textContent + '\n\n[해시태그]\n' + Array.from(document.querySelectorAll('.tag')).map((x) => x.textContent).join(' ') + '\n\n[릴스]\n' + g('rt').textContent + '\n\n[썸네일]\n' + g('th').textContent);
  alert('전체 복사 완료! ✅');
}
