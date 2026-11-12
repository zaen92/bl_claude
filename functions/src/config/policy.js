'use strict';
/**
 * 운영 정책 (FREE / PRO 한도, 가입 무료 크레딧) — 코드 곳곳에 하드코딩하지 않고 여기서만 관리.
 *
 * 실제 값은 Firestore config/policy 문서(관리자만 수정, 누구나 읽기)에서 읽고, 없거나 잘못된 값은 아래 기본값을 사용.
 *   예) 가입 무료 크레딧을 3개로: config/policy { signupBonusCredits: 3 }
 * 변경은 "그 이후" 처리되는 요청부터 적용된다 (가입 보너스는 신규 지급 시점의 값, 기존 회원 잔액·원장은 바꾸지 않음).
 */
const { COL } = require('../lib/schema');

const DEFAULT_POLICY = Object.freeze({
  signupBonusCredits: 5,   // 이메일 인증 후 최초 1회 지급
  freeExportLimit: 5,      // FREE: 가입 후 누적 JSON 내보내기 횟수 (매월 초기화 없음)
  freeSavedPostLimit: 5,   // FREE: 계정 저장 글 최대 개수 (삭제하면 다시 사용 가능)
  freeStyleLimit: 1,       // FREE: 개인화 스타일 저장 개수
  // PRO 는 상품 정책상 무제한. 아래는 서버 안정성을 위한 기술적 상한 (사용자에게 "제한"으로 안내하지 않음)
  proSavedPostLimit: 5000,
  proStyleLimit: 20,
});

// 운영자가 넣을 수 있는 값의 범위 (잘못된 값으로 서비스가 망가지지 않도록)
const RANGES = {
  signupBonusCredits: [0, 100],
  freeExportLimit: [0, 1000],
  freeSavedPostLimit: [0, 1000],
  freeStyleLimit: [0, 50],
  proSavedPostLimit: [1, 100000],
  proStyleLimit: [1, 200],
};

function normalizePolicy(raw) {
  const out = { ...DEFAULT_POLICY };
  for (const [k, [min, max]] of Object.entries(RANGES)) {
    const v = raw && raw[k];
    if (Number.isInteger(v) && v >= min && v <= max) out[k] = v;
  }
  return out;
}

/** 트랜잭션 안에서도 사용 가능 (tx 를 넘기면 tx.get) */
async function getPolicy(db, tx) {
  const ref = db.collection(COL.CONFIG).doc('policy');
  const snap = tx ? await tx.get(ref) : await ref.get();
  return normalizePolicy(snap.exists ? snap.data() : null);
}

const PLAN = Object.freeze({ FREE: 'free', PRO: 'pro' });
const planOf = (user) => (user && user.plan === PLAN.PRO ? PLAN.PRO : PLAN.FREE);

/** 회원 등급별 한도 (null = 상품 정책상 제한 없음) */
function limitsFor(plan, policy) {
  if (plan === PLAN.PRO) {
    return { exports: null, savedPosts: policy.proSavedPostLimit, styles: policy.proStyleLimit, savedPostsTechnical: true };
  }
  return { exports: policy.freeExportLimit, savedPosts: policy.freeSavedPostLimit, styles: policy.freeStyleLimit, savedPostsTechnical: false };
}

module.exports = { DEFAULT_POLICY, RANGES, normalizePolicy, getPolicy, PLAN, planOf, limitsFor };
