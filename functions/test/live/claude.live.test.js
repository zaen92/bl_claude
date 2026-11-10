'use strict';
/**
 * ⚠️ 실제 Claude API 통합 테스트 — 실제 비용이 발생합니다 (1회 약 $0.03~0.10, 2026-11 정가 기준 예상).
 * ANTHROPIC_API_KEY 가 있을 때만 실행되고, 없으면 skip 됩니다. (mock 테스트와 별개)
 *
 *   ANTHROPIC_API_KEY=sk-ant-... npm --prefix functions run test:live
 *   (모델 변경: CLAUDE_MODEL=claude-sonnet-4-6, 네이버 검색 포함: NAVER_CLIENT_ID / NAVER_CLIENT_SECRET)
 *
 * 출력: 생성 결과 요약, 입력/출력 토큰, 웹 검색 횟수, 예상 비용(USD), 소요 시간 → AI 생성 1회당 비용 측정용
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt, mergePlaceInfo } = require('../../src/ai/prompt');
const { buildClaudeRequest, runClaude } = require('../../src/ai/claude');
const { parseGeneration } = require('../../src/ai/parse');
const { estimateCostUsd } = require('../../src/config/pricing');
const { findPlace } = require('../../src/naver');

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
// 64x64 단색 PNG 생성 (사진 분석·배치 경로 확인용)
function solidPng(w, h, [r, g, b]) {
  const zlib = require('node:zlib');
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}
const PNG = solidPng(64, 64, [200, 60, 40]);

test('실제 Claude API: 포스팅 생성 + 사용량/비용 측정', { skip: !KEY && 'ANTHROPIC_API_KEY 없음 → 실제 API 테스트 미실행', timeout: 300_000 }, async () => {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new (Anthropic.default || Anthropic)({ apiKey: KEY, maxRetries: 1, timeout: 280_000 });
  const input = { title: '세비야 타파스 맛집 바 알팔파 | 살모레호 솔직 후기', type: '맛집', content: '남편이랑 방문. 살모레호 맛있음, 소꼬리찜은 아쉬움. 웨이팅 20분.', memo: '', info: '', volume: 'short', images: [PNG] };
  const naver = process.env.NAVER_CLIENT_ID ? await findPlace(input.title, input.content, { clientId: process.env.NAVER_CLIENT_ID, clientSecret: process.env.NAVER_CLIENT_SECRET }) : null;
  const prompt = buildPrompt({ ...input, info: mergePlaceInfo(input.info, naver), imageCount: 1 });
  const params = buildClaudeRequest({ model: MODEL, maxTokens: 8192, prompt, images: input.images, webSearchMaxUses: 5 });
  const t0 = Date.now();
  let chunks = 0;
  const out = await runClaude(client, params, { onText: () => { chunks++; } });
  const result = parseGeneration(out.text, input.title);
  const cost = estimateCostUsd(out.model, out.usage);
  console.log(JSON.stringify({
    model: out.model, stopReason: out.stopReason, requests: out.requestCount, streamedChunks: chunks, ms: Date.now() - t0,
    usage: out.usage, estimatedCostUsd: cost.usd, naver: !!naver,
    title_1: result.title_1, bodyChars: result.body.replace(/\s/g, '').length, hasPhotoMarker: result.body.includes('[사진1]'), hashtags: result.hashtags.length,
  }, null, 2));
  assert.ok(result.title_1 && result.body.length > 200);
  assert.ok(out.usage.inputTokens > 0 && out.usage.outputTokens > 0);
});
