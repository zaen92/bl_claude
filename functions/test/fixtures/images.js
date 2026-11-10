'use strict';
// 테스트·벤치마크용 PNG 생성 (외부 의존성 없음)
const zlib = require('node:zlib');

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** pixel(x,y) → [r,g,b] */
function png(w, h, pixel) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const buf = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + buf.toString('base64');
}

const solid = (w, h, rgb) => png(w, h, () => rgb);

/** 실제 사진과 같은 해상도(1400x1050, 클라이언트 압축 결과와 동일)의 그라데이션 — 이미지 토큰 수 측정용 */
const photoLike = (seed = 0) => png(1400, 1050, (x, y) => [(x + seed * 40) % 256, (y + seed * 70) % 256, ((x + y) / 2 + seed * 90) % 256]);

module.exports = { png, solid, photoLike };
