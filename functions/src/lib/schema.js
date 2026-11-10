'use strict';
/**
 * Firestore 컬렉션 이름과 도메인 상수.
 * 스키마 상세 설명은 docs/SCHEMA.md 참고.
 */

const COL = Object.freeze({
  USERS: 'users',
  CREDIT_LEDGER: 'creditLedger',
  CREDIT_PACKAGES: 'creditPackages',
  ORDERS: 'orders',
  GENERATIONS: 'generations',
  POSTS: 'posts',
  // 서버 전용: 이메일 기준 가입 보너스 지급 이력 (재가입 악용 방지)
  SIGNUP_GRANTS: 'signupGrants',
});

/** 크레딧 버킷: 무료(가입 보너스·보상) 우선 사용, 유료(구매)는 그 다음 */
const BUCKET = Object.freeze({ FREE: 'free', PAID: 'paid' });

const GENERATION_STATUS = Object.freeze({
  PROCESSING: 'processing', // 크레딧 예약(차감)됨, AI 호출 중
  SUCCEEDED: 'succeeded',   // 차감 확정
  FAILED: 'failed',         // 실패 → 크레딧 복구됨
});

/** 회원가입 무료 크레딧 */
const SIGNUP_BONUS_CREDITS = 2;
/** AI 생성 1회당 차감 크레딧 (STEP 2에서 사용) */
const GENERATION_COST = 1;

const LEDGER_TYPE = Object.freeze({
  SIGNUP_BONUS: 'signup_bonus',
  PURCHASE: 'purchase',
  GENERATION: 'generation',
  REFUND: 'refund', // 생성 실패 시 환원 / 결제 취소 시 회수(음수)
  ADMIN_ADJUST: 'admin_adjust',
});

const SIGNUP_BONUS_STATUS = Object.freeze({
  GRANTED: 'granted',
  PENDING_VERIFICATION: 'pending_verification', // 이메일 미인증 → 인증 후 지급
  INELIGIBLE: 'ineligible', // 같은 이메일로 이미 지급됨 / 이메일 없음
});

const POST_TYPES = Object.freeze(['맛집', '카페', '여행', '숙소', '캠핑', '미용', '쇼핑', '투어', '전시']);
const VOLUMES = Object.freeze(['short', 'normal', 'long']);

const REGION = 'asia-northeast3'; // 서울

module.exports = {
  COL,
  BUCKET,
  GENERATION_STATUS,
  SIGNUP_BONUS_CREDITS,
  GENERATION_COST,
  LEDGER_TYPE,
  SIGNUP_BONUS_STATUS,
  POST_TYPES,
  VOLUMES,
  REGION,
};
