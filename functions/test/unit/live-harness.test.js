'use strict';
/**
 * test/live/claude.live.test.js 자체가 올바르게 동작하는지 가짜 Anthropic 서버로 점검한다.
 * (실제 키로 비용을 쓰기 전에 테스트 코드 버그를 잡기 위함 — ⚠️ 실제 API 검증이 아님)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** 상위 테스트 러너의 NODE_TEST_CONTEXT 를 물려받으면 자식 출력 형식이 바뀌므로 제거 */
function cleanEnv() {
  const e = { ...process.env };
  delete e.NODE_TEST_CONTEXT;
  return e;
}

function blogJson(imageCount) {
  const marks = Array.from({ length: imageCount }, (_, i) => `[사진${i + 1}]\\n사진 캡션 ${i + 1}`).join('\\n');
  return JSON.stringify({
    title_1: '제목1', title_2: '제목2', title_3: '제목3', keyword_main: '세비야 맛집', keyword_sub: '타파스', keyword_location: '세비야', keyword_intent: '정보',
    place_name: '바 알팔파', place_address: '서울 중구 명동10길 29', place_hours: '10:30~21:00', place_price: '1만원대',
    body: `안녕하세요! 여행블로거 잰잇입니다 ^ㅎ^\\n${marks}\\n${'본문'.repeat(300)}\\n💡잰잇의 팁\\n오늘 포스팅이 도움 되셨다면 공감이랑 서이추 꾸욱 눌러주세요!`,
    hashtags: ['#세비야', '#타파스', '#맛집'], reel: '릴스', thumbnail: '메인: 썸네일\\n서브: 서브',
  }).replace(/\\\\n/g, '\\n');
}

function sse(text, usage) {
  const ev = [
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.in, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...text.match(/[\s\S]{1,50}/g).map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.out, server_tool_use: { web_search_requests: usage.ws } } },
    { type: 'message_stop' },
  ];
  return ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

test('live 테스트 하네스: 가짜 서버로 L0~L3 전체 흐름이 통과하는지 (실제 API 아님)', async () => {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url.startsWith('/v1/models/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'claude-sonnet-4-6', type: 'model', display_name: 'Claude Sonnet 4.6', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { server_tools: { supported: true, web_search: { supported: true } } } }));
      }
      const b = JSON.parse(body);
      const content = b.messages[0].content;
      const images = content.filter((c) => c.type === 'image').length;
      const prompt = content.find((c) => c.type === 'text').text;
      const text = prompt.includes('두 사진의 주된 색') ? '{"photo1":"빨강","photo2":"파랑"}' : blogJson(images);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(text, { in: 2000 + images * 1568, out: 1500, ws: b.tools ? 2 : 0 }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await new Promise((resolve) => {
      const { spawn } = require('node:child_process');
      const p = spawn(process.execPath, ['--test', path.join(__dirname, '../live/claude.live.test.js')], {
        env: { ...cleanEnv(), ANTHROPIC_API_KEY: 'sk-ant-harness-not-real', ANTHROPIC_BASE_URL: `http://127.0.0.1:${srv.address().port}`, CLAUDE_MODEL: 'claude-sonnet-4-6' },
      });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { out += d; });
      p.on('close', (code) => resolve({ code, out }));
    });
    assert.equal(r.code, 0, r.out.slice(-2000));
    assert.match(r.out, /# pass 5/);
    assert.match(r.out, /\[live:total\] 호출 4회/);
  } finally {
    srv.close();
  }
});

test('live 테스트: 키가 없으면 실패로 종료 (성공으로 보고하지 않음)', () => {
  const env = cleanEnv();
  delete env.ANTHROPIC_API_KEY;
  const r = spawnSync(process.execPath, ['--test', path.join(__dirname, '../live/claude.live.test.js')], { env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /# fail 1/);
  assert.match(r.stdout, /# skipped 4/);
});
