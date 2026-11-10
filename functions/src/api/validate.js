'use strict';
const { POST_TYPES, VOLUMES } = require('../lib/schema');

const MAX_IMAGES = 10;
const MAX_IMAGE_DATAURL_LEN = 2_000_000; // 장당 약 1.5MB (클라이언트가 1400px/JPEG 0.82 로 압축 → 보통 200~500KB)
const MAX_TOTAL_DATAURL_LEN = 12_000_000; // 전체 약 9MB (callable 요청 한도 32MB 이내)

function str(v, { name, min = 0, max }) {
  if (v == null) v = '';
  if (typeof v !== 'string') throw new Error(`${name} 형식이 올바르지 않아요.`);
  const s = v.trim();
  if (s.length < min) throw new Error(`${name}을(를) 입력해주세요.`);
  if (s.length > max) throw new Error(`${name}은(는) ${max}자 이하로 입력해주세요.`);
  return s;
}

/**
 * generatePost 입력 검증. 실패 시 Error(message) 를 던진다 (호출부에서 invalid-argument 로 변환).
 * @returns {import('./contracts').GeneratePostRequest}
 */
function validateGenerateInput(data) {
  if (!data || typeof data !== 'object') throw new Error('요청 형식이 올바르지 않아요.');
  const out = {
    title: str(data.title, { name: '제목', min: 1, max: 200 }),
    type: data.type,
    content: str(data.content, { name: '내용', min: 1, max: 5000 }),
    memo: str(data.memo, { name: '메모', max: 2000 }),
    info: str(data.info, { name: '장소 정보', max: 2000 }),
    volume: data.volume,
    images: [],
    clientRequestId: data.clientRequestId,
  };
  if (!POST_TYPES.includes(out.type)) throw new Error('글 유형을 선택해주세요.');
  if (!VOLUMES.includes(out.volume)) throw new Error('분량을 선택해주세요.');
  if (typeof out.clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(out.clientRequestId)) throw new Error('clientRequestId 가 필요해요.');
  const imgs = data.images == null ? [] : data.images;
  if (!Array.isArray(imgs) || imgs.length > MAX_IMAGES) throw new Error(`사진은 최대 ${MAX_IMAGES}장까지 가능해요.`);
  for (const im of imgs) {
    if (typeof im !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(im) || im.length > MAX_IMAGE_DATAURL_LEN) {
      throw new Error('사진 형식 또는 크기가 올바르지 않아요.');
    }
  }
  if (imgs.reduce((n, im) => n + im.length, 0) > MAX_TOTAL_DATAURL_LEN) throw new Error('사진 전체 용량이 너무 커요. 장수를 줄여주세요.');
  out.images = imgs;
  return out;
}

module.exports = { validateGenerateInput, MAX_IMAGES, MAX_IMAGE_DATAURL_LEN, MAX_TOTAL_DATAURL_LEN };
