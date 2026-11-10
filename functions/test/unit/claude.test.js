'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { webSearchToolType, buildClaudeRequest, runClaude, classifyAiError, AiError } = require('../../src/ai/claude');
const { estimateCostUsd } = require('../../src/config/pricing');
const { planChange, bucketsOf } = require('../../src/lib/credits');
const { createMockClient } = require('../../src/ai/mockClient');
const { buildPrompt } = require('../../src/ai/prompt');

const IMG = 'data:image/jpeg;base64,/9j/AAAA';

test('webSearchToolType: sonnet-4-6 은 web_search_20260209, 구형 모델은 20250305, override 우선', () => {
  assert.equal(webSearchToolType('claude-sonnet-4-6'), 'web_search_20260209');
  assert.equal(webSearchToolType('claude-opus-5-5'), 'web_search_20260209');
  assert.equal(webSearchToolType('claude-haiku-4-5'), 'web_search_20250305');
  assert.equal(webSearchToolType('claude-sonnet-4-6', 'web_search_20250305'), 'web_search_20250305');
  assert.equal(webSearchToolType('claude-sonnet-4-6', 'auto'), 'web_search_20260209');
});

test('buildClaudeRequest: 사진 → 텍스트 순서, 웹검색 도구, 모델/토큰', () => {
  const r = buildClaudeRequest({ model: 'claude-sonnet-4-6', maxTokens: 8192, prompt: 'P', images: [IMG, IMG], webSearchMaxUses: 5 });
  assert.equal(r.model, 'claude-sonnet-4-6');
  assert.equal(r.max_tokens, 8192);
  assert.deepEqual(r.tools.map((t) => [t.type, t.name, t.max_uses]), [['web_search_20260209', 'web_search', 5]]);
  const c = r.messages[0].content;
  assert.deepEqual(c.map((b) => b.type), ['image', 'image', 'text']);
  assert.deepEqual(c[0].source, { type: 'base64', media_type: 'image/jpeg', data: '/9j/AAAA' });
  assert.equal(c[2].text, 'P');
  assert.equal(r.temperature, undefined); // 2026-10-21 API 버전에서 거부되는 샘플링 파라미터 미사용
  assert.equal(buildClaudeRequest({ model: 'm', maxTokens: 1, prompt: 'P', images: [], webSearchMaxUses: 0 }).tools, undefined);
});

test('runClaude: 스트리밍 텍스트 누적 + usage 합산 + pause_turn 이어쓰기', async () => {
  const client = createMockClient();
  const prompt = buildPrompt({ title: '세비야 맛집', type: '맛집', content: 'c', memo: '[[mock:pause]]', info: '', volume: 'normal', imageCount: 1 });
  const params = buildClaudeRequest({ model: 'claude-sonnet-4-6', maxTokens: 100, prompt, images: [IMG], webSearchMaxUses: 3 });
  let streamed = '';
  const out = await runClaude(client, params, { onText: (t) => { streamed += t; } });
  assert.equal(client.calls.length, 2, 'pause_turn 후 1번 더 요청');
  assert.equal(client.calls[1].messages.length, 2);
  assert.equal(client.calls[1].messages[1].role, 'assistant');
  assert.equal(out.requestCount, 2);
  assert.equal(out.text, streamed);
  assert.ok(out.text.includes('"title_1"'));
  assert.ok(out.usage.inputTokens > 0 && out.usage.outputTokens > 0);
  assert.equal(out.usage.webSearchRequests, 4);
});

test('runClaude: refusal 은 AiError(ai_refusal)', async () => {
  const client = createMockClient();
  const prompt = buildPrompt({ title: 't', type: '맛집', content: 'c', memo: '[[mock:refusal]]', info: '', volume: 'short', imageCount: 0 });
  await assert.rejects(runClaude(client, buildClaudeRequest({ model: 'claude-sonnet-4-6', maxTokens: 10, prompt, images: [], webSearchMaxUses: 0 })), (e) => e instanceof AiError && e.reason === 'ai_refusal');
});

test('classifyAiError: 상태코드별 사유', () => {
  const e = (status, name) => Object.assign(new Error('x'), { status, name });
  assert.equal(classifyAiError(e(429)).reason, 'ai_rate_limited');
  assert.equal(classifyAiError(e(529)).reason, 'ai_unavailable');
  assert.equal(classifyAiError(e(500)).reason, 'ai_unavailable');
  assert.equal(classifyAiError(e(401)).reason, 'ai_config');
  assert.equal(classifyAiError(e(400)).reason, 'ai_bad_request');
  assert.equal(classifyAiError(e(undefined, 'AbortError')).reason, 'ai_timeout');
  assert.equal(classifyAiError(e(undefined, 'APIConnectionError')).reason, 'ai_network');
  assert.equal(classifyAiError(new AiError('ai_refusal')).retryable, false);
});

test('estimateCostUsd: sonnet-4-6 정가 기준', () => {
  // 입력 10,000 × $3/M + 출력 2,000 × $15/M + 검색 2 × $0.01 = 0.03 + 0.03 + 0.02
  assert.deepEqual(estimateCostUsd('claude-sonnet-4-6', { inputTokens: 10000, outputTokens: 2000, webSearchRequests: 2 }), { usd: 0.08, known: true });
  assert.deepEqual(estimateCostUsd('unknown-model', { inputTokens: 1 }), { usd: null, known: false });
});

test('planChange: 무료 크레딧 우선 차감, 부족 시 거부', () => {
  assert.deepEqual(planChange({ free: 1, paid: 3 }, -1).bucketDelta, { free: -1, paid: 0 });
  assert.deepEqual(planChange({ free: 0, paid: 3 }, -1).bucketDelta, { free: 0, paid: -1 });
  const p = planChange({ free: 1, paid: 3 }, -2);
  assert.deepEqual([p.free, p.paid, p.credits], [0, 2, 2]);
  assert.throws(() => planChange({ free: 0, paid: 0 }, -1), /부족/);
  assert.deepEqual(planChange({ free: 0, paid: 0 }, 10, 'paid').bucketDelta, { free: 0, paid: 10 });
  assert.deepEqual(bucketsOf({ credits: 2 }), { free: 2, paid: 0, credits: 2 }); // STEP 1 문서 호환
});
