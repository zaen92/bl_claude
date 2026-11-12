'use strict';
/**
 * 잰잇 블로그 스튜디오 Cloud Functions (2nd gen, asia-northeast3)
 *
 *   ensureUserProfile     로그인 직후 프로필 생성/동기화 + 가입 크레딧 2개 원자적 지급   (STEP 1)
 *   adminAdjustCredits    관리자 전용 크레딧 수동 조정                                  (STEP 1)
 *   generatePost          실제 Claude 생성 + 1크레딧 차감/복구 (스트리밍)              (STEP 2)
 *   getGenerationStatus   생성 상태 조회 (새로고침·네트워크 끊김 후 복구)               (STEP 2)
 *   sweepStaleGenerations 5분마다 멈춘 생성 건 크레딧 복구                             (STEP 2)
 *   deleteAccount / onAuthUserDeleted  회원 탈퇴 시 글·생성 기록 삭제                  (STEP 2.5)
 *   adminCheckAiConfig    관리자 AI 설정 점검                                         (STEP 2.5)
 *   ※ 사진은 Claude 분석용으로 요청에서만 사용하고 서버에 저장하지 않는다 (Cloud Storage 미사용)
 *   createOrder / confirmPayment  인터페이스만 (STEP 3, 토스페이먼츠)
 */
const { onCall, HttpsError } = require('firebase-functions/https');
const { onSchedule } = require('firebase-functions/scheduler');
const { setGlobalOptions } = require('firebase-functions');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const { REGION } = require('./src/lib/schema');
const credits = require('./src/lib/credits');
const { validateGenerateInput } = require('./src/api/validate');
const { runtimeConfig } = require('./src/config/params');
const { ANTHROPIC_API_KEY, NAVER_CLIENT_ID, NAVER_CLIENT_SECRET, secretValue } = require('./src/config/secrets');
const service = require('./src/generation/service');
const { findPlace } = require('./src/naver');
const { deleteAccountData } = require('./src/account/deleteAccount');
const { webSearchToolType } = require('./src/ai/claude');
const functionsV1 = require('firebase-functions/v1');

initializeApp();
setGlobalOptions({ region: REGION, maxInstances: 10 });

const IS_EMULATOR = process.env.FUNCTIONS_EMULATOR === 'true';
// AI_MOCK 은 에뮬레이터에서만 유효 (운영에서는 무시) — functions/.env.demo-jaeinit 참고
const USE_MOCK_AI = IS_EMULATOR && process.env.AI_MOCK === 'true';
// App Check: 운영 배포 시 functions/.env 에 ENFORCE_APP_CHECK=true (docs/APP_CHECK.md)
const ENFORCE_APP_CHECK = process.env.ENFORCE_APP_CHECK === 'true';

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

async function requireVerifiedEmail(auth) {
  if (auth.token.email_verified === true) return;
  // 토큰이 인증 전에 발급됐을 수 있으므로 최신 값 확인
  const u = await getAuth().getUser(auth.uid);
  if (!u.emailVerified) throw new HttpsError('failed-precondition', '이메일 인증 후 이용할 수 있어요.', { reason: 'email_not_verified' });
}

function toHttpsError(err) {
  if (err instanceof HttpsError) return err;
  if (err instanceof credits.CreditError) return new HttpsError(err.code, err.message, err.details);
  logger.error('unhandled', { name: err && err.name, code: err && err.code });
  return new HttpsError('internal', '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요.');
}

let anthropicClient = null;
let mockClient = null;
function aiDeps() {
  if (USE_MOCK_AI) {
    if (!mockClient) mockClient = require('./src/ai/mockClient').createMockClient();
    return { client: mockClient, provider: 'mock' };
  }
  const key = secretValue(ANTHROPIC_API_KEY);
  if (!key) return null;
  if (!anthropicClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropicClient = new (Anthropic.default || Anthropic)({ apiKey: key, maxRetries: 1, timeout: 280_000 });
  }
  return { client: anthropicClient, provider: 'anthropic' };
}

function naverDeps() {
  const clientId = secretValue(NAVER_CLIENT_ID);
  const clientSecret = secretValue(NAVER_CLIENT_SECRET);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, find: (title, content) => findPlace(title, content, { clientId, clientSecret }) };
}

exports.ensureUserProfile = onCall({ enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const { uid } = requireAuth(request);
  try {
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

exports.adminAdjustCredits = onCall({ enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const admin = requireAdmin(request);
  const d = request.data || {};
  try {
    return await credits.adminAdjustCredits(getFirestore(), {
      uid: d.uid, delta: d.delta, reason: d.reason, requestId: d.requestId, bucket: d.bucket, actorUid: admin.uid,
    });
  } catch (err) {
    throw toHttpsError(err);
  }
});

/** @returns {Promise<import('./src/api/contracts').GeneratePostResponse>} */
exports.generatePost = onCall({
  timeoutSeconds: 300,
  memory: '1GiB',
  concurrency: 20,
  enforceAppCheck: ENFORCE_APP_CHECK,
  secrets: [ANTHROPIC_API_KEY, NAVER_CLIENT_ID, NAVER_CLIENT_SECRET],
}, async (request, response) => {
  const auth = requireAuth(request);
  await requireVerifiedEmail(auth);
  let input;
  try {
    input = validateGenerateInput(request.data);
  } catch (err) {
    throw new HttpsError('invalid-argument', err.message);
  }
  const ai = aiDeps();
  if (!ai) {
    logger.error('ANTHROPIC_API_KEY not configured');
    throw new HttpsError('failed-precondition', 'AI 생성이 아직 설정되지 않았어요. 관리자에게 문의해주세요. (크레딧은 차감되지 않았어요)', { reason: 'ai_not_configured' });
  }
  const streaming = !!(response && request.acceptsStreaming);
  try {
    return await service.generate(
      { db: getFirestore(), ai, naver: naverDeps(), logger },
      runtimeConfig(),
      { uid: auth.uid, input, caller: { email: auth.token.email || null, admin: auth.token.admin === true }, onChunk: streaming ? (c) => { response.sendChunk(c).catch(() => {}); } : null },
    );
  } catch (err) {
    throw toHttpsError(err);
  }
});

exports.getGenerationStatus = onCall({ enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const { uid } = requireAuth(request);
  const id = request.data && request.data.generationId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(id)) throw new HttpsError('invalid-argument', 'generationId 가 필요해요.');
  try {
    return await service.getStatus(getFirestore(), { uid, generationId: id, nowMs: Date.now() });
  } catch (err) {
    throw toHttpsError(err);
  }
});

exports.sweepStaleGenerations = onSchedule({ schedule: 'every 5 minutes', timeZone: 'Asia/Seoul' }, async () => {
  const n = await service.sweepStale(getFirestore(), Date.now());
  if (n) logger.warn('stale generations refunded', { count: n });
});

/**
 * 회원 탈퇴: 최근 로그인(10분 이내) 확인 → 데이터 정리 → Auth 계정 삭제.
 * 요청 { confirm: '탈퇴' }
 */
exports.deleteAccount = onCall({ enforceAppCheck: ENFORCE_APP_CHECK, timeoutSeconds: 300 }, async (request) => {
  const auth = requireAuth(request);
  if (!request.data || request.data.confirm !== '탈퇴') throw new HttpsError('invalid-argument', '확인 문구가 일치하지 않아요.');
  const authTime = Number(auth.token.auth_time || 0) * 1000;
  if (!authTime || Date.now() - authTime > 10 * 60 * 1000) {
    throw new HttpsError('failed-precondition', '보안을 위해 다시 로그인한 뒤 탈퇴를 진행해주세요.', { reason: 'requires_recent_login' });
  }
  try {
    const r = await deleteAccountData(getFirestore(), auth.uid, { source: 'user_request' });
    await getAuth().deleteUser(auth.uid);
    logger.info('account deleted', { posts: r.posts, generations: r.generations });
    return { deleted: true };
  } catch (err) {
    throw toHttpsError(err);
  }
});

/** 관리자가 콘솔에서 계정을 지운 경우 등에도 데이터 정리 (멱등) */
exports.onAuthUserDeleted = functionsV1.region(REGION).auth.user().onDelete(async (user) => {
  const r = await deleteAccountData(getFirestore(), user.uid, { source: 'auth_trigger' });
  logger.info('account data cleaned by trigger', { posts: r.posts, generations: r.generations });
});

/** 관리자: AI 설정 점검 (키 존재·형식, 모델 사용 가능 여부, 웹 검색 지원) — 키 값은 반환하지 않음, 생성 비용 없음 */
exports.adminCheckAiConfig = onCall({ enforceAppCheck: ENFORCE_APP_CHECK, secrets: [ANTHROPIC_API_KEY, NAVER_CLIENT_ID, NAVER_CLIENT_SECRET] }, async (request) => {
  requireAdmin(request);
  const cfg = runtimeConfig();
  const key = secretValue(ANTHROPIC_API_KEY);
  const out = {
    provider: USE_MOCK_AI ? 'mock' : 'anthropic',
    keyConfigured: USE_MOCK_AI ? null : !!key,
    keyFormatOk: USE_MOCK_AI ? null : !!(key && key.startsWith('sk-ant-')),
    model: cfg.model,
    webSearchToolType: webSearchToolType(cfg.model, cfg.webSearchToolType),
    webSearchMaxUses: cfg.webSearchMaxUses,
    naverConfigured: !!naverDeps(),
    appCheckEnforced: ENFORCE_APP_CHECK,
    accessMode: cfg.accessMode,
    projectId: process.env.GCLOUD_PROJECT || null,
    modelAvailable: null,
    webSearchSupported: null,
    error: null,
  };
  const ai = aiDeps();
  if (ai) {
    try {
      const m = await ai.client.models.retrieve(cfg.model);
      out.modelAvailable = m.id === cfg.model || !!m.id;
      out.maxInputTokens = m.max_input_tokens || null;
      out.maxOutputTokens = m.max_tokens || null;
      const st = m.capabilities && m.capabilities.server_tools;
      out.webSearchSupported = st && st.web_search ? !!st.web_search.supported : null;
    } catch (err) {
      out.modelAvailable = false;
      out.error = { status: err.status || null, type: err.type || (err.error && err.error.type) || err.name || 'error' };
    }
  }
  return out;
});

/** @returns {Promise<import('./src/api/contracts').CreateOrderResponse>} STEP 3 */
exports.createOrder = onCall({ enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  requireAuth(request);
  throw new HttpsError('unimplemented', '크레딧 충전은 곧 오픈 예정이에요.');
});

/** @returns {Promise<import('./src/api/contracts').ConfirmPaymentResponse>} STEP 3 */
exports.confirmPayment = onCall({ enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  requireAuth(request);
  throw new HttpsError('unimplemented', '크레딧 충전은 곧 오픈 예정이에요.');
});
