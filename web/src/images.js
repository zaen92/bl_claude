// 이미지 업로드/압축/삭제/순서 변경 — 사진은 브라우저 메모리에만 (서버·JSON·계정에 저장하지 않음)
import { state, g } from './state.js';

export const MAX_PHOTOS = 10;                 // 서버 검증과 같은 값 (functions/src/api/validate.js)
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 원본 파일 크기 상한 (압축 전)

export function compress(file, cb, onError) {
  const r = new FileReader();
  r.onload = (ev) => {
    const im = new Image();
    im.onload = () => {
      let w = im.width, h = im.height;
      const ra = Math.min(1400 / w, 1400 / h, 1);
      w = Math.round(w * ra); h = Math.round(h * ra);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(im, 0, 0, w, h);
      cb(cv.toDataURL('image/jpeg', 0.82));
    };
    im.onerror = () => onError && onError();
    im.src = ev.target.result;
  };
  r.onerror = () => onError && onError();
  r.readAsDataURL(file);
}

function note(text) { g('cnote').textContent = text; g('cnote').className = 'cn' + (text ? ' on' : ''); }

export function addImg(e) {
  const all = Array.from(e.target.files || []);
  e.target.value = ''; // 같은 파일 재선택 허용
  const room = MAX_PHOTOS - state.imgs.length;
  const notes = [];
  const fs = all.filter((f) => /^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(f.type) || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f.name));
  if (fs.length < all.length) notes.push('⚠️ 사진 파일만 올릴 수 있어요 (' + (all.length - fs.length) + '개 제외)');
  const sized = fs.filter((f) => f.size <= MAX_FILE_BYTES);
  if (sized.length < fs.length) notes.push('⚠️ 20MB 가 넘는 사진은 제외했어요');
  const take = sized.slice(0, Math.max(0, room));
  if (sized.length > take.length) notes.push('⚠️ 사진은 최대 ' + MAX_PHOTOS + '장까지예요');
  if (!take.length) { note(notes.join(' · ')); return; }
  let dn = 0, cp2 = 0;
  const results = new Array(take.length);
  const done = () => {
    dn++;
    if (dn < take.length) return;
    results.forEach((src) => { if (src && state.imgs.length < MAX_PHOTOS) state.imgs.push(src); }); // 선택한 순서 유지
    renderPhotos();
    if (cp2 > 0) notes.unshift('✅ ' + cp2 + '장 자동 압축 완료');
    note(notes.join(' · '));
  };
  take.forEach((f, i) => {
    compress(f, (src) => {
      results[i] = src;
      if (Math.round(src.length * 0.75) < f.size) cp2++;
      done();
    }, () => { notes.push('⚠️ 읽을 수 없는 사진이 있어요'); done(); });
  });
}

/** 순서 변경 — 번호([사진N])는 현재 순서대로 다시 매겨진다 */
export function movePhoto(i, d) {
  const j = i + d;
  if (j < 0 || j >= state.imgs.length) return;
  const a = state.imgs.slice();
  [a[i], a[j]] = [a[j], a[i]];
  state.imgs = a;
  renderPhotos();
}
export function removePhoto(i) {
  state.imgs = state.imgs.filter((_, k) => k !== i);
  renderPhotos();
}

export function renderPhotos() {
  const pg = g('pg');
  pg.innerHTML = '';
  state.imgs.forEach((src, i) => {
    const w = document.createElement('div'); w.className = 'pi';
    const im = document.createElement('img'); im.src = src; im.alt = '사진' + (i + 1);
    const num = document.createElement('div'); num.className = 'pi-n'; num.textContent = i + 1;
    const db = document.createElement('button'); db.className = 'db'; db.textContent = '✕'; db.title = '삭제';
    db.onclick = () => removePhoto(i);
    w.appendChild(im); w.appendChild(num); w.appendChild(db);
    if (state.imgs.length > 1) {
      const mv = document.createElement('div'); mv.className = 'pi-mv';
      const l = document.createElement('button'); l.textContent = '◀'; l.title = '앞으로'; l.disabled = i === 0; l.onclick = () => movePhoto(i, -1);
      const r = document.createElement('button'); r.textContent = '▶'; r.title = '뒤로'; r.disabled = i === state.imgs.length - 1; r.onclick = () => movePhoto(i, 1);
      mv.appendChild(l); mv.appendChild(r); w.appendChild(mv);
    }
    pg.appendChild(w);
  });
  reNumber();
}

export function reNumber() {
  g('pg').querySelectorAll('.pi').forEach((el, i) => { el.querySelector('.pi-n').textContent = i + 1; });
  g('pcnt').textContent = state.imgs.length > 0 ? '총 ' + state.imgs.length + '장 업로드됨 (AI가 사진 분석 후 적절한 위치에 배치 · ◀▶ 로 순서 변경)' : '';
}
