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
 * AI 포스팅 생성. onChunk({type:'status'|'text', ...}) 로 스트리밍 진행상황 전달.
 * @returns {Promise<{generationId:string,result:object,naver:object|null,creditsRemaining:number,mock:boolean}>}
 */
export async function generatePost(input, onChunk) {
  const callable = fn('generatePost', 300_000);
  if (typeof callable.stream === 'function') {
    const { stream, data } = await callable.stream(input);
    for await (const chunk of stream) onChunk && onChunk(chunk);
    return await data;
  }
  return (await callable(input)).data;
}

const FN_ERR = {
  'functions/unauthenticated': '로그인이 필요해요.',
  'functions/permission-denied': '권한이 없어요.',
  'functions/resource-exhausted': '크레딧이 부족해요. 충전 후 이용해주세요.',
  'functions/failed-precondition': '크레딧이 부족해요. 충전 후 이용해주세요.',
  'functions/deadline-exceeded': '응답이 지연되고 있어요. 잠시 후 다시 시도해주세요.',
  'functions/unavailable': '서버에 연결할 수 없어요. 잠시 후 다시 시도해주세요.',
};
export function apiErrorMessage(e) {
  if (!e) return '오류가 발생했어요.';
  if (e.code === 'functions/invalid-argument' || e.code === 'functions/unimplemented') return e.message;
  return FN_ERR[e.code] || e.message || '오류가 발생했어요.';
}

export function newRequestId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return 'req_' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
