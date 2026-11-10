'use strict';
/**
 * 실제 @anthropic-ai/sdk 를 로컬 가짜 HTTP 서버(SSE)에 연결해 runClaude 의 스트림 처리·오류 분류를 검증한다.
 * ⚠️ Anthropic 실서버 호출이 아니다 (실제 API 검증은 test/live).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Anthropic = require('@anthropic-ai/sdk');
const { runClaude, buildClaudeRequest, classifyAiError } = require('../../src/ai/claude');
const { parseGeneration } = require('../../src/ai/parse');

const RESULT = { title_1: '세비야 맛집', body: '안녕하세요! 여행블로거 잰잇입니다 ^ㅎ^\\n[사진1]\\n캡션', hashtags: ['#세비야'], reel: 'r', thumbnail: '메인: a\\n서브: b' };

function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function startServer(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { seen.push({ headers: req.headers, body: JSON.parse(body || '{}') }); handler(req, res, seen.length); });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

const textStream = (text, stop, usage) => sse([
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.in, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ...text.match(/[\s\S]{1,40}/g).map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.out, server_tool_use: { web_search_requests: usage.ws } } },
  { type: 'message_stop' },
]);

test('SDK 스트리밍: 텍스트 조각 수신 → 결과 파싱, usage(입력/출력/웹검색) 집계, 요청 형식', async () => {
  const text = '검색해봤어요.\n' + JSON.stringify(RESULT);
  const { srv, seen, url } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(textStream(text, 'end_turn', { in: 1234, out: 567, ws: 2 }));
  });
  try {
    const client = new Anthropic({ apiKey: 'test-key-not-real', baseURL: url, maxRetries: 0 });
    const params = buildClaudeRequest({ model: 'claude-sonnet-4-6', maxTokens: 8192, prompt: 'P', images: ['data:image/jpeg;base64,/9j/AAAA'], webSearchMaxUses: 5 });
    let n = 0;
    const out = await runClaude(client, params, { onText: () => { n++; } });
    assert.ok(n > 1, '여러 조각으로 스트리밍');
    assert.equal(out.text, text);
    assert.deepEqual(out.usage, { inputTokens: 1234, outputTokens: 567, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, webSearchRequests: 2 });
    assert.equal(parseGeneration(out.text, 'f').title_1, '세비야 맛집');
    const req = seen[0];
    // SDK 1.x 는 키를 Authorization: Bearer 로 전송 (구버전은 x-api-key)
    assert.ok(req.headers.authorization === 'Bearer test-key-not-real' || req.headers['x-api-key'] === 'test-key-not-real');
    assert.ok(req.headers['anthropic-version'], 'anthropic-version 헤더');
    assert.equal(req.body.stream, true);
    assert.equal(req.body.model, 'claude-sonnet-4-6');
    assert.equal(req.body.tools[0].type, 'web_search_20260209');
    assert.equal(req.body.messages[0].content[0].type, 'image');
  } finally { srv.close(); }
});

test('SDK 오류: 529 과부하 → ai_unavailable, 401 → ai_config', async () => {
  for (const [status, type, reason] of [[529, 'overloaded_error', 'ai_unavailable'], [401, 'authentication_error', 'ai_config'], [400, 'invalid_request_error', 'ai_bad_request']]) {
    const { srv, url } = await startServer((req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_test' });
      res.end(JSON.stringify({ type: 'error', error: { type, message: 'x' } }));
    });
    try {
      const client = new Anthropic({ apiKey: 'k', baseURL: url, maxRetries: 0 });
      await assert.rejects(runClaude(client, buildClaudeRequest({ model: 'claude-sonnet-4-6', maxTokens: 10, prompt: 'P', images: [], webSearchMaxUses: 0 })), (e) => {
        assert.equal(classifyAiError(e).reason, reason, `${status}`);
        return true;
      });
    } finally { srv.close(); }
  }
});

test('SDK 타임아웃(AbortSignal) → ai_timeout', async () => {
  const { srv, url } = await startServer(() => { /* 응답하지 않음 */ });
  try {
    const client = new Anthropic({ apiKey: 'k', baseURL: url, maxRetries: 0 });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 300);
    await assert.rejects(runClaude(client, buildClaudeRequest({ model: 'claude-sonnet-4-6', maxTokens: 10, prompt: 'P', images: [], webSearchMaxUses: 0 }), { signal: ctrl.signal }), (e) => {
      assert.equal(classifyAiError(e).reason, 'ai_timeout', e.name);
      return true;
    });
  } finally { srv.closeAllConnections(); srv.close(); }
});
