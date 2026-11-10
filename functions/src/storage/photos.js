'use strict';
/**
 * 생성 요청 사진을 Cloud Storage 에 보관 (서버 전용 쓰기).
 * 경로: users/{uid}/generations/{generationId}/photo_{n}.{ext}
 * 클라이언트는 Storage 보안 규칙상 자기 경로만 읽을 수 있고 쓰기는 불가.
 * 다운로드 토큰(firebaseStorageDownloadTokens)을 만들지 않는다 → 토큰 URL 로 규칙을 우회한 열람 불가.
 * 브라우저는 getBlob()(인증 + 보안 규칙 적용)으로만 읽는다.
 */
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function decodeDataUrl(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('invalid image data');
  return { contentType: m[1], buffer: Buffer.from(m[2], 'base64') };
}

/** 저장 전 용량 계산용 */
function totalImageBytes(images) {
  return (images || []).reduce((s, d) => s + decodeDataUrl(d).buffer.length, 0);
}

async function savePhotos(bucket, uid, generationId, images) {
  const out = [];
  for (let i = 0; i < images.length; i++) {
    const { contentType, buffer } = decodeDataUrl(images[i]);
    const path = `users/${uid}/generations/${generationId}/photo_${i + 1}.${EXT[contentType]}`;
    await bucket.file(path).save(buffer, {
      resumable: false,
      contentType,
      metadata: { cacheControl: 'private, max-age=31536000' },
    });
    out.push({ path, bytes: buffer.length, contentType, index: i + 1 });
  }
  return out;
}

async function deletePhotos(bucket, photos) {
  await Promise.all((photos || []).map((p) => bucket.file(p.path).delete({ ignoreNotFound: true }).catch(() => {})));
}

module.exports = { savePhotos, deletePhotos, totalImageBytes, decodeDataUrl };
