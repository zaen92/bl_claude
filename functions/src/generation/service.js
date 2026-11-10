'use strict';
/**
 * AI 생성 + 크레딧 차감 서비스 (서버 전용)
 *
 *   ① reserve   트랜잭션: 잔액·속도·일일·동시실행·용량 확인 → 1크레딧 차감(원장 gen_{id}) + generations(processing)
 *   ② run       사진 Storage 저장 → 네이버 검색 → Claude 호출(스트리밍) → 결과 파싱
 *   ③ finalize  트랜잭션: generations succeeded, 차감 확정(charge.status=captured)
 *   ③' refund   실패 시 트랜잭션: 원장 refund_{id} +1, generations failed, 사진 삭제
 *   ④ recover   함수가 죽어 processing 으로 남은 건은 lease 만료 후 refund (조회 시 / 5분 주기 스케줄러)
 *
 * generationId = `${uid}_${clientRequestId}` → 같은 요청(더블클릭·재전송)은 한 번만 실행·차감된다.
 * 잔액 불변식: users.credits == freeCredits + paidCredits == Σ creditLedger.delta (uid)
 */
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { COL, LEDGER_TYPE, GENERATION_STATUS, GENERATION_COST, BUCKET } = require('../lib/schema');
const { writeLedgerInTx, bucketsOf, CreditError } = require('../lib/credits');
const { buildPrompt, mergePlaceInfo } = require('../ai/prompt');
const { parseGeneration } = require('../ai/parse');
const { buildClaudeRequest, runClaude, classifyAiError, AiError } = require('../ai/claude');
const { estimateCostUsd } = require('../config/pricing');
const { savePhotos, deletePhotos, totalImageBytes } = require('../storage/photos');

/** 사용자에게 보여줄 실패 메시지 (내부 정보·원문 오류는 노출하지 않음) */
const USER_MESSAGE = {
  ai_timeout: 'AI 응답 시간이 초과됐어요.',
  ai_network: 'AI 서버 연결에 실패했어요.',
  ai_rate_limited: 'AI 요청이 많아 잠시 처리할 수 없어요.',
  ai_unavailable: 'AI 서버가 일시적으로 불안정해요.',
  ai_config: '서비스 설정 문제로 생성할 수 없어요. 관리자에게 문의해주세요.',
  ai_billing: '서비스 설정 문제로 생성할 수 없어요. 관리자에게 문의해주세요.',
  ai_bad_request: '입력(사진 등)을 처리할 수 없었어요. 사진을 줄여 다시 시도해주세요.',
  ai_refusal: '이 내용으로는 글을 생성할 수 없어요. 내용을 수정해주세요.',
  ai_empty_result: 'AI가 올바른 결과를 만들지 못했어요.',
  ai_incomplete: 'AI 응답이 완료되지 않았어요.',
  storage_failed: '사진 저장에 실패했어요.',
  timeout_recovered: '생성이 제시간에 끝나지 않았어요.',
  internal: '알 수 없는 오류가 발생했어요.',
};

const KST_OFFSET_MS = 9 * 3600 * 1000;
const kstDay = (ms) => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);

function generationIdOf(uid, clientRequestId) {
  return `${uid}_${clientRequestId}`;
}

/** 클라이언트에 돌려줄 공개 형태 */
function publicView(id, g) {
  return {
    generationId: id,
    status: g.status,
    result: g.result || null,
    naver: g.naver || null,
    photos: (g.photos || []).map((p) => ({ path: p.path, index: p.index })),
    error: g.error ? { reason: g.error.reason, message: g.error.message, retryable: !!g.error.retryable } : null,
    refunded: !!(g.charge && g.charge.status === 'refunded'),
    mock: g.provider === 'mock',
  };
}

/**
 * ① 예약: 1크레딧 차감 + generations 생성 (원자적)
 * @returns {Promise<{reserved:boolean, existing?:object}>}
 */
async function reserve(db, { uid, generationId, input, imageBytes, cfg, provider, nowMs }) {
  const userRef = db.collection(COL.USERS).doc(uid);
  const genRef = db.collection(COL.GENERATIONS).doc(generationId);
  return db.runTransaction(async (tx) => {
    const [userSnap, genSnap] = await Promise.all([tx.get(userRef), tx.get(genRef)]);
    if (genSnap.exists) return { reserved: false, existing: genSnap.data() };
    if (!userSnap.exists) throw new CreditError('failed-precondition', '프로필이 아직 준비되지 않았어요. 새로고침 후 다시 시도해주세요.', { reason: 'profile_missing' });
    const u = userSnap.data();
    const buckets = bucketsOf(u);
    if (buckets.credits < GENERATION_COST) {
      throw new CreditError('failed-precondition', '크레딧이 모두 소진됐어요. 충전 기능은 곧 오픈 예정이에요.', { reason: 'insufficient_credits', credits: buckets.credits });
    }
    if ((u.activeGenerations || 0) >= cfg.maxConcurrent) {
      throw new CreditError('resource-exhausted', '이미 생성 중인 글이 있어요. 완료 후 다시 시도해주세요.', { reason: 'too_many_concurrent' });
    }
    const usage = u.usage || {};
    const inWindow = usage.minuteStart && nowMs - usage.minuteStart < 60_000;
    const minuteCount = inWindow ? usage.minuteCount || 0 : 0;
    if (minuteCount >= cfg.rateLimitPerMinute) {
      const retryAfterSec = Math.ceil((60_000 - (nowMs - usage.minuteStart)) / 1000);
      throw new CreditError('resource-exhausted', `요청이 너무 잦아요. ${retryAfterSec}초 후 다시 시도해주세요.`, { reason: 'rate_limited', retryAfterSec });
    }
    const day = kstDay(nowMs);
    const dayCount = usage.day === day ? usage.dayCount || 0 : 0;
    if (dayCount >= cfg.dailyLimit) {
      throw new CreditError('resource-exhausted', `오늘 생성 한도(${cfg.dailyLimit}회)를 모두 사용했어요. 내일 다시 이용해주세요.`, { reason: 'daily_limit' });
    }
    if ((u.storageBytes || 0) + imageBytes > cfg.storageQuotaBytes) {
      throw new CreditError('resource-exhausted', '사진 저장 공간이 부족해요. 사진 수를 줄여주세요.', { reason: 'storage_quota' });
    }

    const ledgerId = `gen_${generationId}`;
    const r = writeLedgerInTx(tx, db, {
      uid,
      buckets,
      delta: -GENERATION_COST, // 무료 → 유료 순 차감
      type: LEDGER_TYPE.GENERATION,
      ledgerId,
      refType: 'generation',
      refId: generationId,
      reason: 'AI 포스팅 생성',
      actor: { type: 'user', uid },
    });
    tx.update(userRef, {
      ...r.userFields,
      activeGenerations: FieldValue.increment(1),
      storageBytes: FieldValue.increment(imageBytes),
      usage: {
        minuteStart: inWindow ? usage.minuteStart : nowMs,
        minuteCount: minuteCount + 1,
        day,
        dayCount: dayCount + 1,
      },
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(genRef, {
      uid,
      clientRequestId: input.clientRequestId,
      status: GENERATION_STATUS.PROCESSING,
      input: {
        title: input.title, type: input.type, content: input.content, memo: input.memo, info: input.info,
        volume: input.volume, imageCount: input.images.length,
      },
      photos: [],
      photoBytesReserved: imageBytes,
      result: null,
      naver: null,
      provider,
      model: cfg.model,
      charge: { status: 'reserved', amount: GENERATION_COST, ledgerId, bucketDelta: r.bucketDelta, refundLedgerId: null },
      usage: null,
      costUsd: null,
      error: null,
      leaseExpiresAt: Timestamp.fromMillis(nowMs + cfg.leaseSeconds * 1000),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      completedAt: null,
    });
    return { reserved: true, creditsAfter: r.balanceAfter };
  });
}

/** ③ 성공 확정 */
async function finalize(db, { uid, generationId, result, naver, aiMeta, photos, nowMs }) {
  const userRef = db.collection(COL.USERS).doc(uid);
  const genRef = db.collection(COL.GENERATIONS).doc(generationId);
  return db.runTransaction(async (tx) => {
    const [userSnap, genSnap] = await Promise.all([tx.get(userRef), tx.get(genRef)]);
    const g = genSnap.data();
    if (!g || g.status !== GENERATION_STATUS.PROCESSING) return { finalized: false, status: g && g.status };
    const u = userSnap.data() || {};
    tx.update(genRef, {
      status: GENERATION_STATUS.SUCCEEDED,
      result,
      naver: naver || null,
      photos,
      usage: aiMeta.usage,
      costUsd: aiMeta.costUsd,
      model: aiMeta.model,
      stopReason: aiMeta.stopReason,
      apiRequestCount: aiMeta.requestCount,
      latencyMs: aiMeta.latencyMs,
      'charge.status': 'captured',
      leaseExpiresAt: null,
      updatedAt: FieldValue.serverTimestamp(),
      completedAt: FieldValue.serverTimestamp(),
    });
    tx.update(userRef, { activeGenerations: Math.max(0, (u.activeGenerations || 0) - 1), lastGenerationAt: Timestamp.fromMillis(nowMs) });
    return { finalized: true, credits: u.credits || 0 };
  });
}

/**
 * ③' 실패 → 크레딧 복구 (멱등: processing 상태일 때만 실행)
 * @param {{onlyIfLeaseExpiredBefore?:number}} opts 스테일 복구 시 lease 만료 확인
 */
async function refund(db, { generationId, reason, retryable, aiMeta, nowMs, onlyIfLeaseExpiredBefore }) {
  const genRef = db.collection(COL.GENERATIONS).doc(generationId);
  return db.runTransaction(async (tx) => {
    const genSnap = await tx.get(genRef);
    const g = genSnap.data();
    if (!g || g.status !== GENERATION_STATUS.PROCESSING) return { refunded: false, status: g && g.status, photos: [] };
    if (onlyIfLeaseExpiredBefore != null && g.leaseExpiresAt && g.leaseExpiresAt.toMillis() > onlyIfLeaseExpiredBefore) {
      return { refunded: false, status: g.status, photos: [] };
    }
    const userRef = db.collection(COL.USERS).doc(g.uid);
    const u = (await tx.get(userRef)).data() || {};
    const refundLedgerId = `refund_${generationId}`;
    const charged = g.charge.bucketDelta || { free: -GENERATION_COST, paid: 0 };
    // 차감했던 버킷으로 정확히 되돌린다 (1크레딧이므로 한 버킷)
    const bucket = charged.paid < 0 ? BUCKET.PAID : BUCKET.FREE;
    const r = writeLedgerInTx(tx, db, {
      uid: g.uid,
      buckets: bucketsOf(u),
      delta: g.charge.amount,
      bucket,
      type: LEDGER_TYPE.REFUND,
      ledgerId: refundLedgerId,
      refType: 'generation',
      refId: generationId,
      reason: `생성 실패 자동 복구 (${reason})`,
      actor: { type: 'system', uid: null },
    });
    tx.update(userRef, {
      ...r.userFields,
      activeGenerations: Math.max(0, (u.activeGenerations || 0) - 1),
      storageBytes: Math.max(0, (u.storageBytes || 0) - (g.photoBytesReserved || 0)),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(genRef, {
      status: GENERATION_STATUS.FAILED,
      error: { reason, message: USER_MESSAGE[reason] || USER_MESSAGE.internal, retryable: retryable !== false },
      'charge.status': 'refunded',
      'charge.refundLedgerId': refundLedgerId,
      usage: aiMeta && aiMeta.usage ? aiMeta.usage : g.usage || null,
      costUsd: aiMeta && aiMeta.costUsd != null ? aiMeta.costUsd : g.costUsd || null,
      leaseExpiresAt: null,
      updatedAt: FieldValue.serverTimestamp(),
      completedAt: Timestamp.fromMillis(nowMs),
    });
    return { refunded: true, photos: g.photos || [], credits: r.balanceAfter };
  });
}

/** ④ lease 가 지난 processing 건 복구 */
async function recoverIfStale(db, bucket, generationId, nowMs) {
  const r = await refund(db, { generationId, reason: 'timeout_recovered', retryable: true, nowMs, onlyIfLeaseExpiredBefore: nowMs });
  if (r.refunded && bucket) await deletePhotos(bucket, r.photos);
  return r.refunded;
}

async function sweepStale(db, bucket, nowMs, limit = 50) {
  const snap = await db.collection(COL.GENERATIONS)
    .where('status', '==', GENERATION_STATUS.PROCESSING)
    .where('leaseExpiresAt', '<', Timestamp.fromMillis(nowMs))
    .limit(limit).get();
  let n = 0;
  for (const d of snap.docs) if (await recoverIfStale(db, bucket, d.id, nowMs)) n++;
  return n;
}

/** 조회 (본인 것만). processing 인데 lease 가 지났으면 이 자리에서 복구 */
async function getStatus(db, bucket, { uid, generationId, nowMs }) {
  const ref = db.collection(COL.GENERATIONS).doc(generationId);
  let snap = await ref.get();
  if (!snap.exists || snap.data().uid !== uid) throw new CreditError('not-found', '생성 기록을 찾을 수 없어요.');
  const g = snap.data();
  if (g.status === GENERATION_STATUS.PROCESSING && g.leaseExpiresAt && g.leaseExpiresAt.toMillis() < nowMs) {
    await recoverIfStale(db, bucket, generationId, nowMs);
    snap = await ref.get();
  }
  return publicView(generationId, snap.data());
}

/**
 * 전체 생성 흐름.
 * @param {object} deps { db, bucket, ai:{client, provider}, naver:{clientId, clientSecret}|null, logger, now:()=>number }
 * @param {object} cfg  runtimeConfig()
 * @param {{uid:string, input:object, onChunk?:Function, signal?:AbortSignal}} req
 */
async function generate(deps, cfg, { uid, input, onChunk }) {
  const { db, bucket, ai, logger } = deps;
  const now = deps.now || Date.now;
  const generationId = generationIdOf(uid, input.clientRequestId);
  const imageBytes = totalImageBytes(input.images);
  const send = (c) => { try { if (onChunk) onChunk(c); } catch (e) { /* 스트림 끊김 무시 */ } };

  const res = await reserve(db, { uid, generationId, input, imageBytes, cfg, provider: ai.provider, nowMs: now() });
  if (!res.reserved) {
    // 같은 요청이 이미 있음 (더블클릭/재전송) → 추가 차감 없이 현재 상태 반환
    return { ...(await getStatus(db, bucket, { uid, generationId, nowMs: now() })), duplicate: true };
  }
  send({ type: 'status', message: '💳 1크레딧 예약 완료 (실패 시 자동 복구)', generationId });

  const started = now();
  let aiMeta = null;
  let photos = [];
  try {
    if (input.images.length) {
      send({ type: 'status', message: `📸 사진 ${input.images.length}장 저장 중...` });
      try {
        photos = await savePhotos(bucket, uid, generationId, input.images);
      } catch (e) {
        throw new AiError('storage_failed', 'storage failed');
      }
      await db.collection(COL.GENERATIONS).doc(generationId).update({ photos });
    }

    let naver = null;
    if (deps.naver && deps.naver.clientId) {
      send({ type: 'status', message: '🔍 네이버 지도에서 업장 정보 검색 중...' });
      naver = await deps.naver.find(input.title, input.content);
      send({ type: 'status', message: naver ? `✅ ${naver.name} 정보 찾음!` : 'ℹ️ 네이버 검색 결과 없음 — Claude가 웹 검색으로 대체합니다' });
    }

    const prompt = buildPrompt({ ...input, info: mergePlaceInfo(input.info, naver), imageCount: input.images.length });
    const params = buildClaudeRequest({
      model: cfg.model,
      maxTokens: cfg.maxTokens,
      prompt,
      images: input.images,
      webSearchMaxUses: cfg.webSearchMaxUses,
      webSearchToolTypeOverride: cfg.webSearchToolType,
    });
    send({ type: 'status', message: '✍️ Claude가 글을 작성하고 있어요...' });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.claudeTimeoutMs);
    let out;
    try {
      out = await runClaude(ai.client, params, { signal: ctrl.signal, onText: (t) => send({ type: 'text', delta: t }) });
    } finally {
      clearTimeout(timer);
    }
    const cost = estimateCostUsd(out.model, out.usage);
    aiMeta = { usage: out.usage, costUsd: cost.usd, model: out.model, stopReason: out.stopReason, requestCount: out.requestCount, latencyMs: now() - started };

    const result = parseGeneration(out.text, input.title);
    if (!out.text.trim() || !result.body || !result.body.trim()) throw new AiError('ai_empty_result', 'empty result');

    const fin = await finalize(db, { uid, generationId, result, naver, aiMeta, photos, nowMs: now() });
    if (!fin.finalized) {
      // 이미 스테일 복구로 환원된 경우 (정상 흐름에서는 발생하지 않음)
      throw new AiError('timeout_recovered', 'already refunded');
    }
    logger && logger.info('generation succeeded', { generationId, model: aiMeta.model, usage: aiMeta.usage, costUsd: aiMeta.costUsd, latencyMs: aiMeta.latencyMs, photos: photos.length });
    const userSnap = await db.collection(COL.USERS).doc(uid).get();
    return {
      ...publicView(generationId, (await db.collection(COL.GENERATIONS).doc(generationId).get()).data()),
      creditsRemaining: (userSnap.data() || {}).credits || 0,
      usage: { inputTokens: aiMeta.usage.inputTokens, outputTokens: aiMeta.usage.outputTokens },
    };
  } catch (err) {
    const c = classifyAiError(err);
    if (err && err.meta && err.meta.usage && !aiMeta) {
      const cost = estimateCostUsd(cfg.model, err.meta.usage);
      aiMeta = { usage: err.meta.usage, costUsd: cost.usd };
    }
    // 로그에는 사유 코드·상태만 (입력 내용·이메일·키·오류 원문 제외)
    logger && logger.warn('generation failed', { generationId, reason: c.reason, status: c.status || null, requestId: (err && err.requestID) || null });
    const r = await refund(db, { generationId, reason: c.reason, retryable: c.retryable, aiMeta, nowMs: now() });
    if (r.refunded) await deletePhotos(bucket, r.photos.length ? r.photos : photos);
    const userSnap = await db.collection(COL.USERS).doc(uid).get();
    throw new CreditError(
      c.retryable ? 'unavailable' : 'failed-precondition',
      `${USER_MESSAGE[c.reason] || USER_MESSAGE.internal} 차감된 1크레딧은 자동으로 복구됐어요.`,
      { reason: c.reason, generationId, refunded: true, retryable: c.retryable, creditsRemaining: (userSnap.data() || {}).credits || 0 },
    );
  }
}

module.exports = { generate, reserve, finalize, refund, recoverIfStale, sweepStale, getStatus, generationIdOf, publicView, kstDay, USER_MESSAGE };
