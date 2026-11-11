'use strict';
/**
 * AI 생성 + 크레딧 차감 서비스 (서버 전용)
 *
 *   ⓪ gate      서비스 일시중지 / 일일 AI 비용 상한 확인 (config/service, opsDaily) — 차감 전
 *   ① reserve   트랜잭션: 잔액·속도·일일·동시실행·용량 확인 → 1크레딧 차감(원장 gen_{id}) + generations(processing)
 *   ② run       사진 Storage 저장 → 네이버 검색 → Claude 호출(스트리밍) → 결과 파싱
 *   ③ finalize  트랜잭션: generations succeeded, 차감 확정, 사진 보관 만료일, 비용 기록(generationMetrics, opsDaily)
 *   ③' refund   실패 시 트랜잭션: 원장 refund_{id} +1, generations failed, 비용 기록 → 사진 삭제(실패 시 삭제 작업 등록)
 *   ④ recover   함수가 죽어 processing 으로 남은 건은 lease 만료 후 refund (조회 시 / 5분 주기 스케줄러)
 *
 * 이중 환급 방지: refund 는 트랜잭션 안에서 status==processing 일 때만 실행하고, 원장 ID refund_{id} 를 create() 로 기록.
 * generationId = `${uid}_${clientRequestId}` → 같은 요청(더블클릭·재전송)은 한 번만 실행·차감된다.
 * 잔액 불변식: users.credits == freeCredits + paidCredits == Σ creditLedger.delta (uid)
 */
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { COL, LEDGER_TYPE, GENERATION_STATUS, GENERATION_COST, BUCKET, PHOTO_STATE, PHOTO_RETENTION_DAYS } = require('../lib/schema');
const { writeLedgerInTx, bucketsOf, CreditError } = require('../lib/credits');
const { buildPrompt, mergePlaceInfo } = require('../ai/prompt');
const { parseGeneration } = require('../ai/parse');
const { checkResult } = require('../ai/validateResult');
const { buildClaudeRequest, runClaude, classifyAiError, AiError } = require('../ai/claude');
const { estimateCostUsd, estimateComputeUsd } = require('../config/pricing');
const { savePhotos, deletePhotos, totalImageBytes } = require('../storage/photos');
const jobs = require('../storage/deletionJobs');

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

const DAY_MS = 24 * 3600 * 1000;
const KST_OFFSET_MS = 9 * 3600 * 1000;
const kstDay = (ms) => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);

function generationIdOf(uid, clientRequestId) {
  return `${uid}_${clientRequestId}`;
}

/** 클라이언트에 돌려줄 공개 형태 (비용·토큰 정보는 포함하지 않음) */
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

// ── ⓪ 서비스 게이트 ────────────────────────────────────────
let gateCache = { at: 0, value: null };
/**
 * config/service: { generationEnabled: bool, pauseMessage?: string, dailyCostLimitUsd?: number }
 * opsDaily/{KST day}.aiCostUsd 가 상한 이상이면 신규 생성 거부 (크레딧 차감 없음)
 */
async function checkServiceGate(db, cfg, nowMs, { cacheMs = 30_000, caller = null } = {}) {
  if (!gateCache.value || nowMs - gateCache.at > cacheMs) {
    const s = await db.collection(COL.CONFIG).doc('service').get();
    gateCache = { at: nowMs, value: s.exists ? s.data() : {} };
  }
  const c = gateCache.value;
  // 스테이징: 허용 목록 모드 (설정이 없으면 관리자만 — fail closed)
  const mode = c.accessMode || cfg.accessMode || 'open';
  if (mode === 'allowlist') {
    const email = caller && caller.email ? String(caller.email).toLowerCase() : null;
    const allowed = (caller && caller.admin === true) || (email && Array.isArray(c.allowedEmails) && c.allowedEmails.map((e) => String(e).toLowerCase()).includes(email));
    if (!allowed) throw new CreditError('permission-denied', '테스트 기간에는 초대된 계정만 이용할 수 있어요.', { reason: 'not_allowlisted' });
  }
  if (c.generationEnabled === false) {
    throw new CreditError('unavailable', c.pauseMessage || '서비스 점검 중이에요. 잠시 후 다시 이용해주세요.', { reason: 'service_paused' });
  }
  const limit = Number.isFinite(c.dailyCostLimitUsd) ? c.dailyCostLimitUsd : cfg.dailyCostLimitUsd;
  if (limit > 0) {
    const ops = await db.collection(COL.OPS_DAILY).doc(kstDay(nowMs)).get();
    const spent = ops.exists ? (ops.data().aiCostUsd || 0) + (ops.data().aiCostUsdFailed || 0) : 0;
    if (spent >= limit) {
      throw new CreditError('unavailable', '오늘은 이용량이 많아 생성이 잠시 중단됐어요. 내일 다시 이용해주세요.', { reason: 'daily_budget_exceeded' });
    }
  }
}
function resetGateCache() { gateCache = { at: 0, value: null }; }

/** generationMetrics + opsDaily 기록 (트랜잭션 안) */
function writeMetricsInTx(tx, db, { generationId, g, status, aiMeta, failureReason, photoBytes, qualityFlags, nowMs }) {
  const model = (aiMeta && aiMeta.model) || g.model;
  const usage = (aiMeta && aiMeta.usage) || null;
  const cost = usage ? estimateCostUsd(model, usage) : { usd: null, known: false, breakdown: null };
  const latencyMs = aiMeta && aiMeta.latencyMs != null ? aiMeta.latencyMs : null;
  const computeUsdEst = latencyMs != null ? estimateComputeUsd(latencyMs) : null;
  let billing = 'none'; // Anthropic 과금 추정
  if (status === GENERATION_STATUS.SUCCEEDED) billing = 'full';
  else if (aiMeta && aiMeta.responseStarted) billing = aiMeta.partialUsage === false ? 'unknown' : 'partial_lower_bound';
  else if (aiMeta && aiMeta.aiCallStarted && aiMeta.reason === 'ai_timeout') billing = 'unknown';
  const day = kstDay(nowMs);
  tx.set(db.collection(COL.GENERATION_METRICS).doc(generationId), {
    uid: g.uid,
    generationId,
    status,
    provider: g.provider,
    model,
    type: g.input.type,
    volume: g.input.volume,
    imageCount: g.input.imageCount,
    photoBytes: photoBytes || 0,
    usage,
    costUsd: cost.usd,
    costKnown: cost.known,
    costBreakdown: cost.breakdown,
    billing,
    aiCallStarted: !!(aiMeta && aiMeta.aiCallStarted),
    apiRequestCount: (aiMeta && aiMeta.requestCount) || 0,
    latencyMs,
    computeUsdEst,
    failureReason: failureReason || null,
    qualityFlags: qualityFlags || [],
    day,
    createdAt: FieldValue.serverTimestamp(),
  });
  const inc = (n) => FieldValue.increment(n || 0);
  const ok = status === GENERATION_STATUS.SUCCEEDED;
  tx.set(db.collection(COL.OPS_DAILY).doc(day), {
    day,
    succeeded: inc(ok ? 1 : 0),
    failed: inc(ok ? 0 : 1),
    aiCostUsd: inc(ok ? cost.usd : 0),
    aiCostUsdFailed: inc(ok ? 0 : cost.usd),
    inputTokens: inc(usage && usage.inputTokens),
    outputTokens: inc(usage && usage.outputTokens),
    webSearchRequests: inc(usage && usage.webSearchRequests),
    computeUsdEst: inc(computeUsdEst),
    photoBytesAdded: inc(ok ? photoBytes : 0),
    byModel: { [model.replace(/\./g, '_')]: { count: inc(1), costUsd: inc(cost.usd) } },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
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
      usage: { minuteStart: inWindow ? usage.minuteStart : nowMs, minuteCount: minuteCount + 1, day, dayCount: dayCount + 1 },
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
      photosState: input.images.length ? PHOTO_STATE.PENDING : PHOTO_STATE.NONE,
      photosExpireAt: null,
      photoBytesReserved: imageBytes,
      result: null,
      naver: null,
      provider,
      model: cfg.model,
      charge: { status: 'reserved', amount: GENERATION_COST, ledgerId, bucketDelta: r.bucketDelta, refundLedgerId: null },
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
    const photoBytes = photos.reduce((n, p) => n + (p.bytes || 0), 0);
    const quality = checkResult(result, { volume: g.input.volume, imageCount: g.input.imageCount });
    tx.update(genRef, {
      status: GENERATION_STATUS.SUCCEEDED,
      result,
      naver: naver || null,
      photos,
      photosState: photos.length ? PHOTO_STATE.STORED : PHOTO_STATE.NONE,
      photosExpireAt: photos.length ? Timestamp.fromMillis(nowMs + PHOTO_RETENTION_DAYS * DAY_MS) : null,
      model: aiMeta.model,
      'charge.status': 'captured',
      leaseExpiresAt: null,
      updatedAt: FieldValue.serverTimestamp(),
      completedAt: FieldValue.serverTimestamp(),
    });
    // 예약했던 용량과 실제 저장 용량의 차이 보정
    const storageFix = photoBytes - (g.photoBytesReserved || 0);
    tx.update(userRef, {
      activeGenerations: Math.max(0, (u.activeGenerations || 0) - 1),
      storageBytes: Math.max(0, (u.storageBytes || 0) + storageFix),
      lastGenerationAt: Timestamp.fromMillis(nowMs),
    });
    writeMetricsInTx(tx, db, { generationId, g, status: GENERATION_STATUS.SUCCEEDED, aiMeta, photoBytes, qualityFlags: quality.flags, nowMs });
    return { finalized: true, credits: u.credits || 0, qualityFlags: quality.flags };
  });
}

/**
 * ③' 실패 → 크레딧 복구 (멱등: processing 상태일 때만 실행 — 이중 환급 불가)
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
    const userSnap = await tx.get(userRef);
    const u = userSnap.data() || {};
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
    if (userSnap.exists) {
      tx.update(userRef, {
        ...r.userFields,
        activeGenerations: Math.max(0, (u.activeGenerations || 0) - 1),
        storageBytes: Math.max(0, (u.storageBytes || 0) - (g.photoBytesReserved || 0)),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(genRef, {
      status: GENERATION_STATUS.FAILED,
      error: { reason, message: USER_MESSAGE[reason] || USER_MESSAGE.internal, retryable: retryable !== false },
      'charge.status': 'refunded',
      'charge.refundLedgerId': refundLedgerId,
      photos: [],
      photosState: (g.photos || []).length ? PHOTO_STATE.DELETED : g.photosState === PHOTO_STATE.PENDING ? PHOTO_STATE.DELETED : PHOTO_STATE.NONE,
      leaseExpiresAt: null,
      updatedAt: FieldValue.serverTimestamp(),
      completedAt: Timestamp.fromMillis(nowMs),
    });
    writeMetricsInTx(tx, db, { generationId, g, status: GENERATION_STATUS.FAILED, aiMeta: aiMeta ? { ...aiMeta, reason } : null, failureReason: reason, photoBytes: 0, nowMs });
    return { refunded: true, photos: g.photos || [], uid: g.uid, credits: r.balanceAfter };
  });
}

/** 실패한 생성의 사진 삭제: 즉시 시도, 실패하면 삭제 작업 등록 (용량은 refund 에서 이미 반환) */
async function cleanupFailedPhotos(db, bucket, generationId, uid, photos, nowMs) {
  const paths = (photos || []).map((p) => p.path);
  // 업로드 중 실패했을 수 있으므로 경로 대신 생성 폴더 전체를 대상으로
  const prefix = `users/${uid}/generations/${generationId}/`;
  try {
    await bucket.deleteFiles({ prefix, force: true });
  } catch (e) {
    await jobs.enqueue(db, `failed_${generationId}`, { type: 'prefix', uid: null, prefix, paths, bytesToRelease: 0, reason: 'generation_failed' }, nowMs);
  }
}

/** ④ lease 가 지난 processing 건 복구 */
async function recoverIfStale(db, bucket, generationId, nowMs) {
  const r = await refund(db, { generationId, reason: 'timeout_recovered', retryable: true, aiMeta: { aiCallStarted: true, reason: 'ai_timeout' }, nowMs, onlyIfLeaseExpiredBefore: nowMs });
  if (r.refunded && bucket) await cleanupFailedPhotos(db, bucket, generationId, r.uid, r.photos, nowMs);
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
 * @param {object} deps { db, bucket, ai:{client, provider}, naver:{clientId, clientSecret, find}|null, logger, now:()=>number, gateCacheMs? }
 * @param {object} cfg  runtimeConfig()
 * @param {{uid:string, input:object, onChunk?:Function}} req
 */
async function generate(deps, cfg, { uid, input, onChunk, caller }) {
  const { db, bucket, ai, logger } = deps;
  const now = deps.now || Date.now;
  const generationId = generationIdOf(uid, input.clientRequestId);
  const imageBytes = totalImageBytes(input.images);
  const send = (c) => { try { if (onChunk) onChunk(c); } catch (e) { /* 스트림 끊김 무시 */ } };

  // 같은 요청의 재전송이면 게이트와 무관하게 기존 결과를 돌려준다
  const prev = await db.collection(COL.GENERATIONS).doc(generationId).get();
  if (!prev.exists) await checkServiceGate(db, cfg, now(), { cacheMs: deps.gateCacheMs, caller });

  const res = await reserve(db, { uid, generationId, input, imageBytes, cfg, provider: ai.provider, nowMs: now() });
  if (!res.reserved) {
    // 같은 요청이 이미 있음 (더블클릭/재전송) → 추가 차감 없이 현재 상태 반환
    return { ...(await getStatus(db, bucket, { uid, generationId, nowMs: now() })), duplicate: true };
  }
  send({ type: 'status', message: '💳 1크레딧 예약 완료 (실패 시 자동 복구)', generationId });

  const started = now();
  let aiMeta = { aiCallStarted: false };
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
    aiMeta = { aiCallStarted: true, model: cfg.model };
    try {
      out = await runClaude(ai.client, params, { signal: ctrl.signal, onText: (t) => send({ type: 'text', delta: t }) });
    } finally {
      clearTimeout(timer);
    }
    aiMeta = { aiCallStarted: true, responseStarted: true, usage: out.usage, model: out.model, stopReason: out.stopReason, requestCount: out.requestCount, latencyMs: now() - started };

    const result = parseGeneration(out.text, input.title);
    if (!out.text.trim() || !result.body || !result.body.trim()) throw new AiError('ai_empty_result', 'empty result', { usage: out.usage, responseStarted: true });

    const fin = await finalize(db, { uid, generationId, result, naver, aiMeta, photos, nowMs: now() });
    if (!fin.finalized) {
      // lease 만료로 이미 복구된 경우 (함수 제한 300초 < lease 360초 라 정상 흐름에서는 발생하지 않음)
      throw new AiError('timeout_recovered', 'already refunded');
    }
    logger && logger.info('generation succeeded', { generationId, model: aiMeta.model, usage: aiMeta.usage, latencyMs: aiMeta.latencyMs, photos: photos.length, qualityFlags: fin.qualityFlags });
    const userSnap = await db.collection(COL.USERS).doc(uid).get();
    return {
      ...publicView(generationId, (await db.collection(COL.GENERATIONS).doc(generationId).get()).data()),
      creditsRemaining: (userSnap.data() || {}).credits || 0,
    };
  } catch (err) {
    const c = classifyAiError(err);
    // 실패한 호출의 비용 추정: 응답이 시작됐다면 그때까지의 사용량(하한)을 기록
    const m = err.aiMeta || err.meta || {};
    if (!aiMeta.usage && m.usage) aiMeta = { ...aiMeta, usage: m.usage, requestCount: m.requestCount, partialUsage: m.partialUsage };
    if (m.responseStarted) aiMeta.responseStarted = true;
    aiMeta.latencyMs = now() - started;
    // 로그에는 사유 코드·상태만 (입력 내용·이메일·키·오류 원문 제외)
    logger && logger.warn('generation failed', { generationId, reason: c.reason, status: c.status || null, requestId: (err && err.requestID) || null, responseStarted: !!aiMeta.responseStarted });
    const r = await refund(db, { generationId, reason: c.reason, retryable: c.retryable, aiMeta, nowMs: now() });
    if (r.refunded) await cleanupFailedPhotos(db, bucket, generationId, uid, r.photos.length ? r.photos : photos, now());
    const userSnap = await db.collection(COL.USERS).doc(uid).get();
    throw new CreditError(
      c.retryable ? 'unavailable' : 'failed-precondition',
      `${USER_MESSAGE[c.reason] || USER_MESSAGE.internal} 차감된 1크레딧은 자동으로 복구됐어요.`,
      { reason: c.reason, generationId, refunded: true, retryable: c.retryable, creditsRemaining: (userSnap.data() || {}).credits || 0 },
    );
  }
}

module.exports = {
  generate, reserve, finalize, refund, recoverIfStale, sweepStale, getStatus, generationIdOf, publicView, kstDay,
  checkServiceGate, resetGateCache, cleanupFailedPhotos, USER_MESSAGE,
};
