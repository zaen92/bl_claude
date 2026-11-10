'use strict';
/**
 * Claude Messages API 호출 (서버 전용). 기존 v3 의 브라우저 fetch 호출을 대체한다.
 *  - 사진(base64) + 프롬프트 텍스트를 한 user 메시지로 전송 (기존과 동일한 순서: 사진 → 텍스트)
 *  - 웹 검색 서버 도구로 업장 정보 검색 (기존 web_search 기능 유지)
 *  - 스트리밍: 텍스트 조각을 onText 로 전달 → callable 스트림으로 브라우저에 중계
 *  - pause_turn(서버 도구 반복 한도) 시 이어서 요청
 */

// web_search_20260209 (동적 필터링) 지원 모델. 그 외 모델은 기본 버전 사용.
const WEB_SEARCH_2026_MODELS = /^claude-(fable|mythos|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)/;

function webSearchToolType(model, override) {
  if (override && override !== 'auto') return override;
  return WEB_SEARCH_2026_MODELS.test(model) ? 'web_search_20260209' : 'web_search_20250305';
}

/** dataURL → Claude image 블록 */
function imageBlock(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('invalid image data');
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}

function buildClaudeRequest({ model, maxTokens, prompt, images, webSearchMaxUses, webSearchToolTypeOverride }) {
  const tools = webSearchMaxUses > 0
    ? [{
      type: webSearchToolType(model, webSearchToolTypeOverride),
      name: 'web_search',
      max_uses: webSearchMaxUses,
      user_location: { type: 'approximate', country: 'KR', timezone: 'Asia/Seoul' },
    }]
    : undefined;
  return {
    model,
    max_tokens: maxTokens,
    ...(tools ? { tools } : {}),
    messages: [{ role: 'user', content: [...(images || []).map(imageBlock), { type: 'text', text: prompt }] }],
  };
}

class AiError extends Error {
  constructor(reason, message, meta) {
    super(message || reason);
    this.reason = reason;
    this.meta = meta || {};
  }
}

function addUsage(acc, u) {
  if (!u) return acc;
  acc.inputTokens += u.input_tokens || 0;
  acc.outputTokens += u.output_tokens || 0;
  acc.cacheCreationInputTokens += u.cache_creation_input_tokens || 0;
  acc.cacheReadInputTokens += u.cache_read_input_tokens || 0;
  acc.webSearchRequests += (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
  return acc;
}

/**
 * @param {{messages:{stream:Function}}} client Anthropic SDK 클라이언트 (또는 테스트용 mock)
 * @returns {Promise<{text:string, usage:object, stopReason:string, model:string, requestCount:number}>}
 */
async function runClaude(client, params, { onText, signal, maxContinuations = 3 } = {}) {
  const usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, webSearchRequests: 0 };
  let text = '';
  let messages = params.messages;
  const assistantSoFar = [];
  let last = null;
  let requestCount = 0;
  for (let i = 0; i <= maxContinuations; i++) {
    requestCount++;
    const stream = client.messages.stream({ ...params, messages }, { signal });
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
        text += ev.delta.text;
        if (onText) onText(ev.delta.text);
      }
    }
    last = await stream.finalMessage();
    addUsage(usage, last.usage);
    if (last.stop_reason !== 'pause_turn') break;
    // 서버 도구 반복 한도 → 지금까지의 assistant 내용을 붙여 그대로 재요청 (추가 user 메시지 없이)
    assistantSoFar.push(...last.content);
    messages = [params.messages[0], { role: 'assistant', content: assistantSoFar.slice() }];
  }
  const stopReason = last ? last.stop_reason : 'unknown';
  if (stopReason === 'refusal') throw new AiError('ai_refusal', 'model refused', { usage });
  if (stopReason === 'pause_turn') throw new AiError('ai_incomplete', 'too many continuations', { usage });
  return { text, usage, stopReason, model: (last && last.model) || params.model, requestCount };
}

/**
 * SDK/네트워크 오류 → 내부 사유 코드 (사용자 메시지·로그용). 메시지 본문은 기록하지 않는다.
 */
function classifyAiError(err) {
  if (err instanceof AiError) return { reason: err.reason, retryable: err.reason !== 'ai_refusal' };
  const status = err && typeof err.status === 'number' ? err.status : null;
  const name = (err && err.name) || '';
  if (name === 'AbortError' || name === 'APIUserAbortError' || /timeout/i.test(name)) return { reason: 'ai_timeout', retryable: true, status };
  if (name === 'APIConnectionError') return { reason: 'ai_network', retryable: true, status };
  if (status === 429) return { reason: 'ai_rate_limited', retryable: true, status };
  if (status === 529 || (status && status >= 500)) return { reason: 'ai_unavailable', retryable: true, status };
  if (status === 401 || status === 403) return { reason: 'ai_config', retryable: false, status };
  if (status === 400 || status === 413 || status === 422) return { reason: 'ai_bad_request', retryable: false, status };
  if (status === 402) return { reason: 'ai_billing', retryable: false, status };
  return { reason: 'internal', retryable: true, status };
}

module.exports = { webSearchToolType, buildClaudeRequest, runClaude, classifyAiError, AiError, imageBlock };
