'use strict';
/**
 * 요청에 포함된 사진(dataURL) 처리 도우미.
 * 사진은 Claude 분석용으로 요청 본문에서만 사용하고 서버(Storage·Firestore·로그)에 저장하지 않는다.
 */
function decodeDataUrl(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('invalid image data');
  return { contentType: m[1], buffer: Buffer.from(m[2], 'base64') };
}

/** 비용 분석용 요청 크기 (저장하지 않음) */
function totalImageBytes(images) {
  return (images || []).reduce((s, d) => s + decodeDataUrl(d).buffer.length, 0);
}

module.exports = { decodeDataUrl, totalImageBytes };
