'use strict';
/**
 * 모델별 공개 정가 (USD / 1M tokens) — Anthropic 1st-party Claude API.
 * 출처: https://platform.claude.com/docs/en/about-claude/pricing  (확인일 PRICING_VERIFIED_AT)
 *  - 캐시 쓰기(5분) = 입력가 × 1.25, 캐시 읽기 = 입력가 × 0.1 (Opus 5.5 / Sonnet 5.5 는 × 0.05)
 *  - 웹 검색 $10 / 1,000회 (오류 난 검색은 과금 안 됨), 검색 결과는 입력 토큰으로 별도 과금
 *  - Haiku 5.5 는 프롬프트 100K 토큰 초과 시 장문 단가
 *  - inference_geo:"us" 사용 시 1.1배 (이 서비스는 사용하지 않음)
 * 실제 청구액은 Anthropic Console > Usage/Cost 가 기준이며, 여기 값은 "예상 비용" 기록용이다.
 */
const PRICING_VERIFIED_AT = '2026-11-10';

const MODEL_PRICING = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.30 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.10 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.20 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.20 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.50 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.50 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.50 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.50 },
  'claude-haiku-5-5': { input: 0.10, output: 0.50, cacheRead: 0.01, longContext: { thresholdTokens: 100_000, input: 0.50, output: 2.50, cacheRead: 0.05 } },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.10 },
};
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const WEB_SEARCH_USD_PER_REQUEST = 10 / 1000;

/**
 * Cloud Functions(2nd gen, Cloud Run) 실행 비용 추정 상수 — 리전·약정·무료 사용량에 따라 다르므로 콘솔 청구서와 대조 필요.
 * 기본값: vCPU-초 $0.000024, GiB-초 $0.0000025, 요청 100만 건당 $0.40 (Tier 1 기준, 서울은 Tier 2 로 더 높을 수 있음)
 */
const COMPUTE_PRICING = { vcpuSecond: 0.000024, gibSecond: 0.0000025, perInvocation: 0.4 / 1e6, tierMultiplier: 1.0 };
const GENERATE_FN_RESOURCES = { vcpu: 1, gib: 1 }; // generatePost: memory 1GiB (기본 vCPU 1)

/** Cloud Storage 표준 저장 추정 단가 (USD / GB-월) — 리전별 상이, 콘솔 확인 필요 */
const STORAGE_USD_PER_GB_MONTH = 0.026;

const round6 = (n) => Math.round(n * 1e6) / 1e6;

function priceOf(model) {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  // 날짜가 붙은 ID (예: claude-haiku-4-5-20251001) 대응
  const k = Object.keys(MODEL_PRICING).find((m) => model && model.startsWith(m + '-'));
  return k ? MODEL_PRICING[k] : null;
}

/**
 * @param {string} model
 * @param {{inputTokens:number,outputTokens:number,cacheCreationInputTokens?:number,cacheReadInputTokens?:number,webSearchRequests?:number}} u
 * @returns {{usd:number|null, known:boolean, breakdown:object|null}}
 */
function estimateCostUsd(model, u) {
  const base = priceOf(model);
  if (!base) return { usd: null, known: false, breakdown: null };
  const promptTokens = (u.inputTokens || 0) + (u.cacheCreationInputTokens || 0) + (u.cacheReadInputTokens || 0);
  const p = base.longContext && promptTokens > base.longContext.thresholdTokens ? { ...base, ...base.longContext } : base;
  const M = 1e6;
  const breakdown = {
    input: round6((u.inputTokens || 0) * p.input / M),
    output: round6((u.outputTokens || 0) * p.output / M),
    cacheWrite: round6((u.cacheCreationInputTokens || 0) * p.input * CACHE_WRITE_5M_MULTIPLIER / M),
    cacheRead: round6((u.cacheReadInputTokens || 0) * p.cacheRead / M),
    webSearch: round6((u.webSearchRequests || 0) * WEB_SEARCH_USD_PER_REQUEST),
  };
  const usd = round6(Object.values(breakdown).reduce((a, b) => a + b, 0));
  return { usd, known: true, breakdown };
}

/** 함수 실행 시간 기반 서버 비용 추정 */
function estimateComputeUsd(latencyMs, res = GENERATE_FN_RESOURCES) {
  const s = Math.max(0, latencyMs || 0) / 1000;
  const c = COMPUTE_PRICING;
  return round6((s * (res.vcpu * c.vcpuSecond + res.gib * c.gibSecond) + c.perInvocation) * c.tierMultiplier);
}

module.exports = {
  PRICING_VERIFIED_AT, MODEL_PRICING, WEB_SEARCH_USD_PER_REQUEST, CACHE_WRITE_5M_MULTIPLIER,
  COMPUTE_PRICING, STORAGE_USD_PER_GB_MONTH, estimateCostUsd, estimateComputeUsd, priceOf,
};
