'use strict';
/**
 * 기존 jaeinit_blog_studio_v3.html 의 buildPrompt() 를 서버로 이전한 것.
 * 프롬프트 문구는 원본과 동일하게 유지한다 (전역변수 sT/sV/imgs → 인자로 변경).
 */
const VOLUME_TEXT = { short: '800~1000자', normal: '1500~1800자', long: '1800~2100자' };

/**
 * @param {{title:string, type:string, content:string, memo?:string, info?:string, volume:string, imageCount:number}} p
 */
function buildPrompt(p) {
  const t = p.title;
  const m = p.memo;
  const c = p.content;
  const info = p.info;
  const n = p.imageCount || 0;
  return '당신은 네이버 블로그 SEO 전문 작성자입니다. 반드시 아래 JSON만 출력하세요.\n\n'
    + '제목:' + t + '\n유형:' + p.type + '\n내용:' + c + '\n메모:' + (m || '없음') + '\n사용자가 입력한 정보:' + (info || '없음') + '\n분량:' + (VOLUME_TEXT[p.volume] || '1500~1800자') + '\n사진:' + n + '장\n\n'
    + '[업장 정보 자동 수집]\n'
    + '- 제목이나 내용에서 업체명/장소명이 파악되면, 웹 검색을 통해 정확한 주소, 영업시간, 가격대, 전화번호를 찾아주세요\n'
    + '- 찾은 정보를 JSON의 place_name, place_address, place_hours, place_price 필드에 넣어주세요\n'
    + '- 정보를 못 찾으면 빈 문자열로 두세요\n\n'
    + '[스타일]\n1.인사말:"안녕하세요! 여행블로거 잰잇입니다 ^ㅎ^"로 시작\n2.소제목 이모지 포함\n3.정보나열✔ 중요포인트👉\n4.구어체\n5.마무리:"오늘 포스팅이 도움 되셨다면 공감이랑 서이추 꾸욱 눌러주세요!\\n다음에 더 알찬 여행 정보로 돌아올게요 💖"\n6.💡잰잇의 팁 섹션 포함\n'
    + (n > 0 ? '7.[사진 배치 규칙] 사진 ' + n + '장이 첨부되어 있습니다. 각 사진의 내용을 분석하여 본문에서 가장 어울리는 위치에 [사진1] [사진2] ... 을 배치하세요. 예: 음식 사진→메뉴 후기 섹션, 외관 사진→기본정보 섹션, 내부 사진→분위기 섹션. 각 [사진N] 바로 아래에 사진 내용에 맞는 캡션도 한 줄 추가.\n' : '')
    + '\n[SEO] 지역명+업체명+키워드 반복, 방문정보(검색해서 찾은 정보 포함) 포함\n[body규칙] 줄바꿈\\n, 순수텍스트, 마크다운금지\n\n'
    + '{"title_1":"","title_2":"","title_3":"","keyword_main":"","keyword_sub":"","keyword_location":"","keyword_intent":"",'
    + '"place_name":"업체명","place_address":"정확한 주소","place_hours":"영업시간","place_price":"가격대",'
    + '"body":"","hashtags":["#태그1"],"reel":"","thumbnail":"메인: ...\\n서브: ..."}';
}

/** 기존 gen() 에서 네이버 검색 결과를 info 에 합치던 로직 */
function mergePlaceInfo(info, naver) {
  let full = info || '';
  if (naver) {
    full += '\n\n[네이버 지도 검색 결과]\n';
    full += '업체명: ' + naver.name + '\n';
    if (naver.address) full += '주소: ' + naver.address + '\n';
    if (naver.tel) full += '전화: ' + naver.tel + '\n';
    if (naver.category) full += '카테고리: ' + naver.category + '\n';
  }
  return full;
}

module.exports = { buildPrompt, mergePlaceInfo, VOLUME_TEXT };
