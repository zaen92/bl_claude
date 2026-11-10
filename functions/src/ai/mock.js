'use strict';
/**
 * 에뮬레이터 전용 모의 생성 결과.
 * 실제 Claude 호출은 STEP 2 에서 연결한다. 프로덕션에서는 절대 사용되지 않는다 (index.js 에서 FUNCTIONS_EMULATOR 확인).
 */
function mockGeneration(input) {
  const photos = [];
  for (let i = 1; i <= Math.min(input.imageCount || 0, 10); i++) photos.push(`[사진${i}]\n(모의 캡션 ${i})`);
  const body = [
    '안녕하세요! 여행블로거 잰잇입니다 ^ㅎ^',
    '',
    `📍 ${input.title}`,
    '',
    '✔ 이 글은 로컬 에뮬레이터의 모의(mock) 결과예요.',
    '✔ 실제 AI 생성은 STEP 2 에서 연결됩니다.',
    '',
    ...photos,
    '',
    `👉 입력한 내용: ${input.content.slice(0, 200)}`,
    '',
    '💡잰잇의 팁',
    '구체적인 가격·메뉴명을 적을수록 결과가 좋아져요.',
    '',
    '오늘 포스팅이 도움 되셨다면 공감이랑 서이추 꾸욱 눌러주세요!',
    '다음에 더 알찬 여행 정보로 돌아올게요 💖',
  ].join('\\n'); // 원본과 동일하게 \\n 이스케이프 형태 (클라이언트 nl() 이 변환)
  return {
    title_1: `${input.title} (모의 제목 1)`,
    title_2: `${input.title} 솔직 후기 (모의 2)`,
    title_3: `${input.type} 추천 | ${input.title} (모의 3)`,
    keyword_main: input.title.split(/\s+/)[0] || '-',
    keyword_sub: input.type,
    keyword_location: '-',
    keyword_intent: '정보 탐색',
    place_name: '',
    place_address: '',
    place_hours: '',
    place_price: '',
    body,
    hashtags: ['#잰잇', '#블로그', `#${input.type}`],
    reel: '모의 릴스 자막 1\\n모의 릴스 자막 2',
    thumbnail: '메인: 모의 썸네일\\n서브: STEP 2 에서 실제 생성',
  };
}

module.exports = { mockGeneration };
