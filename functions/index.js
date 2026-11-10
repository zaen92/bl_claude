'use strict';
/**
 * 잰잇 블로그 스튜디오 Cloud Functions (2nd gen, asia-northeast3)
 *
 * STEP 1 구현:
 *   - ensureUserProfile   로그인 직후 프로필 생성/동기화 + 가입 크레딧 2개 원자적 지급
 *   - adminAdjustCredits  관리자 전용 크레딧 수동 조정 (custom claim admin == true)
 *   - generatePost        인터페이스 + 인증/입력 검증. 에뮬레이터에서만 모의 결과 반환 (실제 AI 호출은 STEP 2)
 *   - createOrder / confirmPayment  인터페이스만 (STEP 3, 토스페이먼츠)
 */
const { onCall, HttpsError } = require('firebase-functions/https');
const { setGlobalOptions } = require('firebase-functions');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const { REGION } = require('./src/lib/schema');
const credits = require('./src/lib/credits');
const { validateGenerateInput } = require('./src/api/validate');
const { mockGeneration } = require('./src/ai/mock');

initializeApp();
setGlobalOptions({ region: REGION, maxInstances: 10 });

const IS_EMULATOR = process.env.FUNCTIONS_EMULATOR === 'true';

function requireAuth(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요해요.');
  }
  return request.auth;
}

function requireAdmin(request) {
  const auth = requireAuth(request);
  if (auth.token.admin !== true) throw new HttpsError('permission-denied', '관리자만 사용할 수 있어요.');
  return auth;
}

function toHttpsError(err) {
  if (err instanceof HttpsError) return err;
  if (err instanceof credits.CreditError) return new HttpsError(err.code, err.message);
  logger.error(err);
  return new HttpsError('internal', '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요.');
}

/** @returns {Promise<import('./src/api/contracts').EnsureUserProfileResponse>} */
exports.ensureUserProfile = onCall(async (request) => {
  const { uid } = requireAuth(request);
  try {
    // 토큰의 email_verified 는 오래됐을 수 있으므로 Admin Auth 에서 최신 값을 조회한다.
    const u = await getAuth().getUser(uid);
    return await credits.ensureUserProfile(getFirestore(), {
      uid,
      email: u.email || null,
      emailVerified: !!u.emailVerified,
      displayName: u.displayName || null,
      photoURL: u.photoURL || null,
      providerIds: (u.providerData || []).map((p) => p.providerId),
    });
  } catch (err) {
    throw toHttpsError(err);
  }
});

exports.adminAdjustCredits = onCall(async (request) => {
  const admin = requireAdmin(request);
  const d = request.data || {};
  try {
    return await credits.adminAdjustCredits(getFirestore(), {
      uid: d.uid,
      delta: d.delta,
      reason: d.reason,
      requestId: d.requestId,
      actorUid: admin.uid,
    });
  } catch (err) {
    throw toHttpsError(err);
  }
});

/**
 * @returns {Promise<import('./src/api/contracts').GeneratePostResponse>}
 * STEP 2 구현 계획 (docs/API.md):
 *   1) 검증 → 2) 트랜잭션: credits>=1 확인, -1 차감, creditLedger(generation) + generations(pending) 생성
 *   3) 네이버 지역검색 → 4) Claude 스트리밍 호출 (response.sendChunk) → 5) 성공: generations 완료 기록
 *   6) 실패: refund 원장 +1, generations failed
 */
exports.generatePost = onCall({ timeoutSeconds: 300, memory: '512MiB' }, async (request, response) => {
  requireAuth(request);
  let input;
  try {
    input = validateGenerateInput(request.data);
  } catch (err) {
    throw new HttpsError('invalid-argument', err.message);
  }

  if (!IS_EMULATOR) {
    throw new HttpsError('unimplemented', 'AI 생성은 다음 업데이트(STEP 2)에서 서버로 연결될 예정이에요.');
  }

  // ── 에뮬레이터 전용 모의 응답 (크레딧 차감 없음) ──
  const result = mockGeneration({ ...input, imageCount: input.images.length });
  if (response && request.acceptsStreaming) {
    await response.sendChunk({ type: 'status', message: '🧪 에뮬레이터 모의 생성 중...' });
    const text = JSON.stringify(result);
    for (let i = 0; i < text.length; i += 80) await response.sendChunk({ type: 'text', delta: text.slice(i, i + 80) });
  }
  const snap = await getFirestore().collection('users').doc(request.auth.uid).get();
  return {
    generationId: `mock_${input.clientRequestId}`,
    result,
    naver: null,
    creditsRemaining: snap.exists ? snap.data().credits || 0 : 0,
    mock: true,
  };
});

/** @returns {Promise<import('./src/api/contracts').CreateOrderResponse>} STEP 3 */
exports.createOrder = onCall(async (request) => {
  requireAuth(request);
  throw new HttpsError('unimplemented', '크레딧 충전은 곧 오픈 예정이에요.');
});

/** @returns {Promise<import('./src/api/contracts').ConfirmPaymentResponse>} STEP 3 */
exports.confirmPayment = onCall(async (request) => {
  requireAuth(request);
  throw new HttpsError('unimplemented', '크레딧 충전은 곧 오픈 예정이에요.');
});
