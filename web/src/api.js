// 서버 API (Cloud Functions callable) 클라이언트.
// API 키는 서버(Secret Manager)에만 있고, 브라우저는 로그인 토큰으로만 호출한다.
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase.js';

const fn = (name, timeout) => httpsCallable(functions, name, timeout ? { timeout } : undefined);

/** 로그인 직후 호출 — 프로필 생성/동기화 + 가입 크레딧 지급 (서버 트랜잭션) */
export async function ensureProfile() {
  return (await fn('ensureUserProfile')()).data;
}

/**
 * AI 포스팅 생성 (서버에서 1크레딧 예약 → Claude 호출 → 확정/복구).
 * onChunk({type:'status'|'text', ...}) 로 진행상황 스트리밍.
 */
export async function generatePost(input, onChunk) {
  const callable = fn('generatePost', 310_000);
  if (typeof callable.stream === 'function') {
    const { stream, data } = await callable.stream(input);
    try {
      for await (const chunk of stream) onChunk && onChunk(chunk);
    } catch (e) {
      // 스트림 오류는 아래 data 에서 같은 오류로 다시 던져진다
    }
    return await data;
  }
  return (await callable(input)).data;
}

/** 생성 상태 조회 (서버가 멈춘 건을 이 자리에서 복구) */
export async function getGenerationStatus(generationId) {
  return (await fn('getGenerationStatus')({ generationId })).data;
}

/** 관리자: AI 설정 점검 (키 값은 반환되지 않음, 생성 비용 없음) */
export async function adminCheckAiConfig() {
  return (await fn('adminCheckAiConfig')()).data;
}

/** 회원 탈퇴 (서버가 사진·글·생성 기록 삭제 후 계정 삭제) */
export async function deleteAccount() {
  return (await fn('deleteAccount', 300_000)({ confirm: '탈퇴' })).data;
}

const FN_ERR = {
  'functions/unauthenticated': '로그인이 필요해요.',
  'functions/permission-denied': '권한이 없어요.',
  'functions/deadline-exceeded': '응답이 지연되고 있어요.',
};
/** Firebase SDK 가 서버 메시지 끝에 붙이는 HTTP 상태 "[429]" 제거 */
export const serverMessage = (e) => String((e && e.message) || '').replace(/\s*\[\d{3}\]$/, '');
export function apiErrorMessage(e) {
  if (!e) return '오류가 발생했어요.';
  if (e.details && e.details.reason) return serverMessage(e); // 서버가 만든 사용자용 메시지
  if (['functions/invalid-argument', 'functions/unimplemented', 'functions/failed-precondition', 'functions/resource-exhausted'].includes(e.code)) return serverMessage(e);
  return FN_ERR[e.code] || '서버와 연결이 원활하지 않아요.';
}
/** 서버가 결과를 확정해 돌려준 오류인지 (아니면 네트워크 문제로 결과를 모르는 상태) */
export const isDefinitiveError = (e) => !!(e && e.details && e.details.reason) || ['functions/invalid-argument', 'functions/unauthenticated', 'functions/permission-denied', 'functions/unimplemented'].includes(e && e.code);

export function newRequestId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return 'req_' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
