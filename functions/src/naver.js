'use strict';
/**
 * 네이버 지역검색 API (서버 전용) — 기존 v3 searchNaver() 이전.
 * 실패해도 생성은 계속한다 (null 반환). 키·응답 원문은 로그에 남기지 않는다.
 */
async function searchNaver(query, { clientId, clientSecret, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!clientId || !clientSecret || !query) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://openapi.naver.com/v1/search/local.json?query=' + encodeURIComponent(query.slice(0, 100)) + '&display=1', {
      headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.items && data.items.length > 0) {
      const item = data.items[0];
      return {
        name: String(item.title || '').replace(/<[^>]*>/g, ''),
        address: item.roadAddress || item.address || '',
        tel: item.telephone || '',
        category: item.category || '',
        link: item.link || '',
      };
    }
  } catch (e) {
    /* 네트워크 오류·타임아웃은 무시 */
  } finally {
    clearTimeout(t);
  }
  return null;
}

/** 기존 동작: 제목으로 먼저 찾고, 없으면 내용 첫 문장으로 재검색 */
async function findPlace(title, content, opts) {
  return (await searchNaver(title, opts)) || (await searchNaver(String(content || '').split(/[.,!?\n]/)[0], opts));
}

module.exports = { searchNaver, findPlace };
