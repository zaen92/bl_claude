'use strict';
/**
 * ⚠️ 실제 Claude API 통합 테스트 — 실제 비용 발생 (전체 1회 실행 약 $0.2~0.4 예상, 정가 기준)
 *
 *   키가 없으면 이 테스트는 "실패"로 끝납니다 (mock 결과를 실제 성공으로 보고하지 않기 위해).
 *
 *   실행 (키를 화면·히스토리에 남기지 않는 방법은 docs/LIVE_VERIFICATION.md 참고):
 *     ANTHROPIC_API_KEY=... npm run test:live
 *   옵션: CLAUDE_MODEL=claude-sonnet-4-6  NAVER_CLIENT_ID / NAVER_CLIENT_SECRET (네이버 검색 포함)
 *
 *   L0 키·모델 확인(Models API, 과금 없음) → L1 텍스트 생성 → L2 사진 분석 → L3 웹 검색 → 각 단계 최종 JSON 검증
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt, mergePlaceInfo } = require('../../src/ai/prompt');
const { buildClaudeRequest, runClaude, webSearchToolType } = require('../../src/ai/claude');
const { parseGeneration } = require('../../src/ai/parse');
const { checkResult } = require('../../src/ai/validateResult');
const { estimateCostUsd } = require('../../src/config/pricing');
const { findPlace } = require('../../src/naver');
const { solid } = require('../fixtures/images');

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const NO_KEY = !KEY && 'ANTHROPIC_API_KEY 없음';
// 결과 형식 필수 조건 (이 중 하나라도 있으면 실패). 분량·인사말 등은 경고로만 출력.
const CRITICAL = /^(field_type|empty|missing_photo_marker|markdown_in_body|hashtag_format)/;
const totals = { usd: 0, calls: 0 };

function client() {
  const Anthropic = require('@anthropic-ai/sdk');
  return new (Anthropic.default || Anthropic)({ apiKey: KEY, maxRetries: 1, timeout: 280_000 });
}

function report(name, out, extra = {}) {
  const cost = estimateCostUsd(out.model, out.usage);
  totals.usd += cost.usd || 0; totals.calls++;
  console.log(`\n[live:${name}] ` + JSON.stringify({ model: out.model, stopReason: out.stopReason, requests: out.requestCount, usage: out.usage, costUsd: cost.usd, breakdown: cost.breakdown, blockTypes: out.blockTypes, ...extra }));
}

/** 블로그 생성 1회 + 최종 JSON 검증 */
async function blog(name, { volume = 'short', images = [], webSearchMaxUses = 0, title, content, memo = '' }) {
  const naver = webSearchMaxUses && process.env.NAVER_CLIENT_ID ? await findPlace(title, content, { clientId: process.env.NAVER_CLIENT_ID, clientSecret: process.env.NAVER_CLIENT_SECRET }) : null;
  const prompt = buildPrompt({ title, type: '맛집', content, memo, info: mergePlaceInfo('', naver), volume, imageCount: images.length });
  const params = buildClaudeRequest({ model: MODEL, maxTokens: 8192, prompt, images, webSearchMaxUses });
  const t0 = Date.now();
  let chunks = 0;
  const out = await runClaude(client(), params, { onText: () => { chunks++; } });
  // 최종 JSON: 우선 엄격한 JSON.parse 로 확인 (recover 폴백에 의존했는지 기록)
  let strictJson = false;
  try { const m = out.text.match(/\{[\s\S]*\}/); JSON.parse(m[0]); strictJson = true; } catch (e) { /* 아래 assert 에서 실패 */ }
  const result = parseGeneration(out.text, title);
  const q = checkResult(result, { volume, imageCount: images.length });
  report(name, out, { ms: Date.now() - t0, streamedChunks: chunks, strictJson, naver: !!naver, bodyChars: q.bodyChars, warnings: q.flags.filter((f) => !CRITICAL.test(f)), title_1: result.title_1, place: [result.place_name, result.place_address] });
  assert.ok(chunks > 1, '스트리밍 수신');
  assert.ok(strictJson, '모델이 유효한 JSON 을 출력');
  assert.deepEqual(q.flags.filter((f) => CRITICAL.test(f)), [], '결과 필수 형식');
  return { out, result, q };
}

test('L0 키 확인 (없으면 실패 — 실제 API 미검증)', () => {
  assert.ok(KEY, 'ANTHROPIC_API_KEY 가 없어 실제 Claude API 를 검증하지 못했습니다. docs/LIVE_VERIFICATION.md 참고');
  assert.ok(KEY.startsWith('sk-ant-'), '키 형식(sk-ant-...) 확인');
});

test('L0 모델 확인 (Models API, 과금 없음): ID·웹 검색 지원', { skip: NO_KEY }, async () => {
  const m = await client().models.retrieve(MODEL);
  const ws = m.capabilities && m.capabilities.server_tools && m.capabilities.server_tools.web_search;
  console.log(`\n[live:model] ${JSON.stringify({ id: m.id, display_name: m.display_name, max_input_tokens: m.max_input_tokens, max_tokens: m.max_tokens, web_search: ws, tool: webSearchToolType(MODEL) })}`);
  assert.equal(m.id, MODEL);
  if (ws) assert.equal(ws.supported, true);
});

test('L1 텍스트 생성 (사진·웹검색 없음) → 최종 JSON 검증', { skip: NO_KEY, timeout: 300_000 }, async () => {
  const { out } = await blog('text', {
    title: '세비야 타파스 맛집 바 알팔파 | 살모레호 솔직 후기',
    content: '남편이랑 방문. 살모레호 맛있음(4.5유로), 소꼬리찜은 아쉬움. 웨이팅 20분. 테라스 자리 추천.',
  });
  assert.equal(out.usage.webSearchRequests, 0);
});

test('L2 사진 분석: 색상 인식 확인 + 블로그 본문에 [사진1~3] 배치', { skip: NO_KEY, timeout: 300_000 }, async () => {
  // (a) 이미지가 실제로 모델에 전달·인식되는지: 단색 사진 2장의 색을 맞히는지
  const probe = await runClaude(client(), {
    model: MODEL,
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: solid(256, 256, [220, 30, 30]).split(',')[1] } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: solid(256, 256, [30, 60, 220]).split(',')[1] } },
        { type: 'text', text: '두 사진의 주된 색을 순서대로 한 단어(한국어)로만 답하세요. 형식: {"photo1":"","photo2":""}' },
      ],
    }],
  });
  report('vision-probe', probe, { answer: probe.text.trim() });
  assert.match(probe.text, /빨|레드|red/i);
  assert.match(probe.text, /파|블루|blue|남/i);
  // (b) 블로그 프롬프트로 사진 3장 배치
  await blog('photos', {
    title: '제주 애월 카페 | 오션뷰 디저트 후기',
    content: '바다가 보이는 통창, 딸기 케이크와 라떼 주문. 주차 가능.',
    images: [solid(800, 600, [200, 60, 50]), solid(800, 600, [40, 90, 200]), solid(800, 600, [60, 160, 80])],
  });
});

test('L3 웹 검색: 실제 업장 정보 검색 → usage.web_search_requests ≥ 1', { skip: NO_KEY, timeout: 300_000 }, async () => {
  const { out, result } = await blog('web-search', {
    title: '서울 명동교자 본점 칼국수 후기',
    content: '칼국수와 만두를 먹었다. 마늘 김치가 강렬했다.',
    webSearchMaxUses: 3,
  });
  assert.ok(out.usage.webSearchRequests >= 1, '웹 검색이 실제로 실행됨');
  if (!result.place_address) console.log('[live:web-search] ⚠️ place_address 비어 있음 — 결과 확인 필요');
});

test.after(() => {
  if (totals.calls) console.log(`\n[live:total] 호출 ${totals.calls}회, 예상 비용 $${totals.usd.toFixed(4)} (정가 기준, 실제 청구는 Console 확인)`);
});
