'use strict';
/**
 * 모델별 공개 정가 (USD / 1M tokens) — 2026-11 기준 Anthropic 1st-party API.
 * 실제 청구액은 Anthropic Console 의 Usage/Cost 화면이 기준이며, 여기 값은 "예상 비용" 기록용이다.
 * 가격이 바뀌면 이 표만 수정하면 된다.
 */
const MODEL_PRICING = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
const WEB_SEARCH_USD_PER_REQUEST = 10 / 1000; // $10 / 1,000 searches
const CACHE_WRITE_MULTIPLIER = 1.25; // 5분 캐시 쓰기
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * @param {string} model
 * @param {{inputTokens:number,outputTokens:number,cacheCreationInputTokens?:number,cacheReadInputTokens?:number,webSearchRequests?:number}} u
 * @returns {{usd:number|null, known:boolean}}
 */
function estimateCostUsd(model, u) {
  const p = MODEL_PRICING[model];
  if (!p) return { usd: null, known: false };
  const M = 1e6;
  const usd = (u.inputTokens || 0) * p.input / M
    + (u.outputTokens || 0) * p.output / M
    + (u.cacheCreationInputTokens || 0) * p.input * CACHE_WRITE_MULTIPLIER / M
    + (u.cacheReadInputTokens || 0) * p.input * CACHE_READ_MULTIPLIER / M
    + (u.webSearchRequests || 0) * WEB_SEARCH_USD_PER_REQUEST;
  return { usd: Math.round(usd * 1e6) / 1e6, known: true };
}

module.exports = { MODEL_PRICING, WEB_SEARCH_USD_PER_REQUEST, estimateCostUsd };
