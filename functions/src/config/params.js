'use strict';
/**
 * 환경 설정 (비밀이 아닌 값). 값은 functions/.env (배포/에뮬레이터 공통) 에서 읽는다.
 * 프로젝트별로 다르게 하려면 functions/.env.<projectId> 를 추가한다.
 */
const { defineString, defineInt } = require('firebase-functions/params');

const P = {
  CLAUDE_MODEL: defineString('CLAUDE_MODEL', { default: 'claude-sonnet-4-6', description: 'Claude 모델 ID' }),
  CLAUDE_MAX_TOKENS: defineInt('CLAUDE_MAX_TOKENS', { default: 8192 }),
  CLAUDE_TIMEOUT_SECONDS: defineInt('CLAUDE_TIMEOUT_SECONDS', { default: 240 }),
  WEB_SEARCH_MAX_USES: defineInt('WEB_SEARCH_MAX_USES', { default: 5 }),
  WEB_SEARCH_TOOL_TYPE: defineString('WEB_SEARCH_TOOL_TYPE', { default: 'auto' }),
  RATE_LIMIT_PER_MINUTE: defineInt('RATE_LIMIT_PER_MINUTE', { default: 3 }),
  DAILY_GENERATION_LIMIT: defineInt('DAILY_GENERATION_LIMIT', { default: 20 }),
  MAX_CONCURRENT_GENERATIONS: defineInt('MAX_CONCURRENT_GENERATIONS', { default: 2 }),
  STORAGE_QUOTA_MB: defineInt('STORAGE_QUOTA_MB', { default: 200 }),
};

/** 함수 실행 시점에 호출 (배포 분석 단계에서는 .value() 를 부르지 않는다) */
function runtimeConfig() {
  return {
    model: P.CLAUDE_MODEL.value(),
    maxTokens: P.CLAUDE_MAX_TOKENS.value(),
    claudeTimeoutMs: P.CLAUDE_TIMEOUT_SECONDS.value() * 1000,
    webSearchMaxUses: P.WEB_SEARCH_MAX_USES.value(),
    webSearchToolType: P.WEB_SEARCH_TOOL_TYPE.value(),
    rateLimitPerMinute: P.RATE_LIMIT_PER_MINUTE.value(),
    dailyLimit: P.DAILY_GENERATION_LIMIT.value(),
    maxConcurrent: P.MAX_CONCURRENT_GENERATIONS.value(),
    storageQuotaBytes: P.STORAGE_QUOTA_MB.value() * 1024 * 1024,
    leaseSeconds: 360, // generatePost timeoutSeconds(300) 보다 길어야 한다
  };
}

module.exports = { P, runtimeConfig };
