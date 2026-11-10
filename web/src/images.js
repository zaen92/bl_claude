// 이미지 업로드/압축 (기존 compress/addImg/reNumber 그대로)
import { state, g } from './state.js';

export function compress(file, cb) {
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
    im.src = ev.target.result;
  };
  r.readAsDataURL(file);
}

export function addImg(e) {
  const fs = Array.from(e.target.files);
  let dn = 0, cp2 = 0;
  fs.forEach((f) => {
    const os = f.size;
    compress(f, (src) => {
      state.imgs.push(src);
      if (Math.round(src.length * 0.75) < os) cp2++;
      const w = document.createElement('div'); w.className = 'pi';
      const im = document.createElement('img'); im.src = src;
      const num = document.createElement('div'); num.className = 'pi-n'; num.textContent = state.imgs.length;
      const db = document.createElement('button'); db.className = 'db'; db.textContent = '✕';
      db.onclick = () => { w.remove(); state.imgs = state.imgs.filter((x) => x !== src); reNumber(); };
      w.appendChild(im); w.appendChild(num); w.appendChild(db); g('pg').appendChild(w); dn++;
      if (dn === fs.length) {
        reNumber();
        if (cp2 > 0) { g('cnote').textContent = '✅ ' + cp2 + '장 자동 압축 완료'; g('cnote').className = 'cn on'; }
      }
    });
  });
  e.target.value = ''; // 같은 파일 재선택 허용
}

export function reNumber() {
  g('pg').querySelectorAll('.pi').forEach((el, i) => { el.querySelector('.pi-n').textContent = i + 1; });
  g('pcnt').textContent = state.imgs.length > 0 ? '총 ' + state.imgs.length + '장 업로드됨 (AI가 사진 분석 후 적절한 위치에 배치)' : '';
}
