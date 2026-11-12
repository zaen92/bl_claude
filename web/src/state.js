// 화면 상태 (기존 전역변수 sT, sV, imgs, resultData 를 한 곳에 모음)
export const state = {
  sT: '',          // 글 유형
  sV: '',          // 분량
  imgs: [],        // 압축된 이미지 dataURL (메모리에만 유지 — 기존과 동일)
  resultData: null, // 현재 표시 중인 생성 결과
  resultMeta: null, // { generationId, type, input:{title,memo,content,info,type,volume,imageCount}, createdAt }
  previewPhotos: null, // 생성 직후 미리보기용 사진 (브라우저 메모리에만, 서버·JSON 저장 안 함). null 이면 현재 첨부 사진 사용
  inFlight: false,     // 생성 요청 진행 중 (더블클릭 방지)
  currentRequestId: null, // 결과가 확정되기 전까지 같은 멱등 키 재사용
  generations: [],     // 생성 이력
  user: null,      // Firebase Auth 사용자
  profile: null,   // users/{uid}
  posts: [],       // 저장된 글
};
export const g = (id) => document.getElementById(id);
export const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** 모델 결과의 \\n 이스케이프를 실제 줄바꿈으로 (기존 nl) */
export const nl = (s) => (s || '').replace(/\\n/g, '\n');
