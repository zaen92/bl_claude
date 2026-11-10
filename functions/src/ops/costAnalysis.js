'use strict';
/**
 * 비용 분석·손익 계산 (순수 함수) — scripts/cost-report.mjs, scripts/live-benchmark.mjs 에서 사용.
 * 가격은 확정하지 않는다: 가격을 넣으면 손익을, 안 넣으면 손익분기·목표 마진 가격을 계산한다.
 */

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}
const r6 = (n) => (n == null ? null : Math.round(n * 1e6) / 1e6);

function stats(rows) {
  const costs = rows.map((r) => r.costUsd).filter((c) => typeof c === 'number').sort((a, b) => a - b);
  const avg = (f) => (rows.length ? rows.reduce((s, r) => s + (f(r) || 0), 0) / rows.length : null);
  return {
    count: rows.length,
    avgUsd: r6(costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null),
    p50Usd: r6(percentile(costs, 0.5)),
    p95Usd: r6(percentile(costs, 0.95)),
    maxUsd: r6(costs.length ? costs[costs.length - 1] : null),
    avgInputTokens: Math.round(avg((r) => r.usage && r.usage.inputTokens) || 0),
    avgOutputTokens: Math.round(avg((r) => r.usage && r.usage.outputTokens) || 0),
    avgWebSearches: r6(avg((r) => r.usage && r.usage.webSearchRequests)),
    avgLatencyMs: Math.round(avg((r) => r.latencyMs) || 0),
  };
}

const photoBucket = (n) => (!n ? '0장' : n <= 3 ? '1~3장' : n <= 5 ? '4~5장' : '6~10장');

function groupBy(rows, keyFn) {
  const m = {};
  for (const r of rows) (m[keyFn(r)] = m[keyFn(r)] || []).push(r);
  return Object.fromEntries(Object.entries(m).sort().map(([k, v]) => [k, stats(v)]));
}

/** rows: generationMetrics 문서 배열 */
function summarize(rows) {
  const ok = rows.filter((r) => r.status === 'succeeded');
  const failed = rows.filter((r) => r.status === 'failed');
  const failedCost = failed.reduce((s, r) => s + (r.costUsd || 0), 0);
  const okCost = ok.reduce((s, r) => s + (r.costUsd || 0), 0);
  const billing = {};
  for (const r of failed) billing[r.billing || 'none'] = (billing[r.billing || 'none'] || 0) + 1;
  return {
    total: rows.length,
    succeeded: stats(ok),
    byModel: groupBy(ok, (r) => r.model),
    byPhotos: groupBy(ok, (r) => photoBucket(r.imageCount)),
    byVolume: groupBy(ok, (r) => r.volume),
    failed: { count: failed.length, costUsd: r6(failedCost), billing },
    // 실패 호출 비용을 성공 1건당으로 환산 (크레딧은 복구되므로 회사 부담)
    failureOverheadPerSuccessUsd: r6(ok.length ? failedCost / ok.length : 0),
    computeUsdPerSuccess: r6(ok.length ? rows.reduce((s, r) => s + (r.computeUsdEst || 0), 0) / ok.length : 0),
    avgPhotoBytesPerSuccess: Math.round(ok.length ? ok.reduce((s, r) => s + (r.photoBytes || 0), 0) / ok.length : 0),
    aiCostUsd: r6(okCost),
  };
}

/**
 * 크레딧 상품 손익.
 * @param {object} o
 * @param {number} o.costPerGenUsd   생성 1회 원가 (AI 평균 + 실패 부담 + 서버 + 저장)
 * @param {number} [o.costPerGenWorstUsd]  최악(p95 등) 원가
 * @param {{credits:number, priceKrw?:number}[]} o.packages
 * @param {number} o.usdKrw          환율
 * @param {number} [o.pgFeeRate]     PG 수수료율 (계약 조건 확인 필요, 미입력 시 0 으로 계산하고 경고)
 * @param {number} [o.vatRate=0.1]   가격에 부가세 포함 가정
 * @param {number} [o.targetMargin=0.5]
 */
function pnl(o) {
  const vat = o.vatRate == null ? 0.1 : o.vatRate;
  const fee = o.pgFeeRate || 0;
  const netFactor = 1 / (1 + vat) - fee; // 소비자가 1원당 남는 금액
  const target = o.targetMargin == null ? 0.5 : o.targetMargin;
  const rows = o.packages.map((p) => {
    const costKrw = p.credits * o.costPerGenUsd * o.usdKrw;
    const worstKrw = o.costPerGenWorstUsd ? p.credits * o.costPerGenWorstUsd * o.usdKrw : null;
    const row = {
      credits: p.credits,
      costKrw: Math.round(costKrw),
      worstCostKrw: worstKrw == null ? null : Math.round(worstKrw),
      breakEvenPriceKrw: Math.ceil(costKrw / netFactor),
      targetPriceKrw: Math.ceil(costKrw / ((1 - target) * netFactor)),
      targetMargin: target,
      priceKrw: p.priceKrw || null,
    };
    if (p.priceKrw) {
      const net = p.priceKrw * netFactor;
      row.netRevenueKrw = Math.round(net);
      row.marginKrw = Math.round(net - costKrw);
      row.marginRate = Math.round(((net - costKrw) / net) * 1000) / 1000;
      if (worstKrw != null) row.worstMarginKrw = Math.round(net - worstKrw);
      row.perCreditPriceKrw = Math.round(p.priceKrw / p.credits);
    }
    return row;
  });
  return {
    rows,
    signupFreeCreditCostKrw: Math.round(2 * o.costPerGenUsd * o.usdKrw), // 가입자 1명당 무료 2회 원가
    assumptions: { usdKrw: o.usdKrw, pgFeeRate: fee, pgFeeMissing: !o.pgFeeRate, vatRate: vat, costPerGenUsd: o.costPerGenUsd, costPerGenWorstUsd: o.costPerGenWorstUsd || null },
  };
}

module.exports = { summarize, pnl, stats, photoBucket, percentile };
