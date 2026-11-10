'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, pnl, photoBucket } = require('../../src/ops/costAnalysis');

const row = (o) => ({ status: 'succeeded', model: 'claude-sonnet-4-6', imageCount: 0, volume: 'normal', costUsd: 0.1, usage: { inputTokens: 10000, outputTokens: 3000, webSearchRequests: 2 }, computeUsdEst: 0.001, photoBytes: 0, latencyMs: 30000, ...o });

test('summarize: 평균·p95·최대, 사진/분량/모델별, 실패 비용 부담', () => {
  const rows = [
    row({ costUsd: 0.08 }), row({ costUsd: 0.10, imageCount: 3 }), row({ costUsd: 0.12, imageCount: 5, volume: 'long' }), row({ costUsd: 0.30, imageCount: 10, volume: 'long' }),
    row({ status: 'failed', costUsd: 0.02, billing: 'partial_lower_bound' }), row({ status: 'failed', costUsd: null, billing: 'none' }),
  ];
  const s = summarize(rows);
  assert.equal(s.succeeded.count, 4);
  assert.equal(s.succeeded.avgUsd, 0.15);
  assert.equal(s.succeeded.p95Usd, 0.3);
  assert.equal(s.succeeded.maxUsd, 0.3);
  assert.deepEqual(Object.keys(s.byPhotos), ['0장', '1~3장', '4~5장', '6~10장']);
  assert.equal(s.byVolume.long.count, 2);
  assert.deepEqual(s.failed, { count: 2, costUsd: 0.02, billing: { partial_lower_bound: 1, none: 1 } });
  assert.equal(s.failureOverheadPerSuccessUsd, 0.005);
  assert.equal(photoBucket(0), '0장');
});

test('pnl: 가격 미정이면 손익분기/목표 가격, 가격 입력 시 마진 (부가세·PG 수수료 반영)', () => {
  const r = pnl({ costPerGenUsd: 0.1, costPerGenWorstUsd: 0.3, usdKrw: 1400, pgFeeRate: 0.03, packages: [{ credits: 10 }, { credits: 30, priceKrw: 9900 }] });
  const a = r.rows[0];
  assert.equal(a.costKrw, 1400);
  // netFactor = 1/1.1 - 0.03 = 0.879090...
  assert.equal(a.breakEvenPriceKrw, Math.ceil(1400 / (1 / 1.1 - 0.03)));
  assert.equal(a.targetPriceKrw, Math.ceil(1400 / (0.5 * (1 / 1.1 - 0.03))));
  const b = r.rows[1];
  assert.equal(b.costKrw, 4200);
  assert.equal(b.netRevenueKrw, Math.round(9900 * (1 / 1.1 - 0.03)));
  assert.equal(b.marginKrw, b.netRevenueKrw - 4200);
  assert.equal(b.worstMarginKrw, b.netRevenueKrw - 12600);
  assert.equal(r.signupFreeCreditCostKrw, 280);
  assert.equal(pnl({ costPerGenUsd: 0.1, usdKrw: 1400, packages: [{ credits: 10 }] }).assumptions.pgFeeMissing, true);
});
