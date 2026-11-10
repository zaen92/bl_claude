// 운영 비용 리포트 + 크레딧 상품(10/30/70회) 손익 분석 — 가격은 확정하지 않고 계산만 한다.
//
//   운영 데이터(generationMetrics) 기준:
//     GOOGLE_APPLICATION_CREDENTIALS=서비스계정.json node scripts/cost-report.mjs --project <id> --from 2026-11-01 --to 2026-11-30 --usd-krw 1400 --pg-fee 0.03
//     (에뮬레이터: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 ... --project demo-jaeinit)
//   벤치마크 결과 기준:
//     node scripts/cost-report.mjs --benchmark cost-reports/benchmark-....json --usd-krw 1400 --pg-fee 0.03
//   가격 후보 비교 (선택): --prices 10:5900,30:14900,70:29900   목표 마진: --margin 0.5
//   사진 보관 원가 반영: --storage-months 3 (사진 1회분을 N개월 보관한다고 가정, 기본 3)
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'functions/package.json'));
const { summarize, pnl } = require('./src/ops/costAnalysis');
const { STORAGE_USD_PER_GB_MONTH, PRICING_VERIFIED_AT } = require('./src/config/pricing');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

let rows;
let source;
if (opt('benchmark')) {
  rows = JSON.parse(readFileSync(opt('benchmark'), 'utf8')).results.filter((r) => r.status !== 'counted');
  source = `벤치마크 ${opt('benchmark')}`;
} else {
  const projectId = opt('project');
  if (!projectId) { console.error('--project <id> 또는 --benchmark <file> 필요'); process.exit(2); }
  const { initializeApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const db = getFirestore(initializeApp({ projectId }));
  let q = db.collection('generationMetrics');
  if (opt('from')) q = q.where('day', '>=', opt('from'));
  if (opt('to')) q = q.where('day', '<=', opt('to'));
  rows = (await q.get()).docs.map((d) => d.data());
  source = `generationMetrics (${projectId}, ${opt('from', '처음')} ~ ${opt('to', '현재')})`;
}
if (!rows.length) { console.error('데이터가 없습니다'); process.exit(1); }

const s = summarize(rows);
const usdKrw = Number(opt('usd-krw', '0'));
const pgFee = opt('pg-fee') ? Number(opt('pg-fee')) : undefined;
const months = Number(opt('storage-months', '3'));
const storageUsd = (s.avgPhotoBytesPerSuccess / 1e9) * STORAGE_USD_PER_GB_MONTH * months;
const perGen = (s.succeeded.avgUsd || 0) + s.failureOverheadPerSuccessUsd + s.computeUsdPerSuccess + storageUsd;
const perGenWorst = (s.succeeded.p95Usd || 0) + s.failureOverheadPerSuccessUsd + s.computeUsdPerSuccess + storageUsd;

const fmt = (o) => `${o.count}건 · 평균 $${o.avgUsd} · p50 $${o.p50Usd} · p95 $${o.p95Usd} · 최대 $${o.maxUsd} · 입력 ${o.avgInputTokens} / 출력 ${o.avgOutputTokens} 토큰 · 검색 ${o.avgWebSearches}회`;
let md = `# 비용 리포트\n\n- 데이터: ${source}\n- 단가 기준: Anthropic 정가 (확인일 ${PRICING_VERIFIED_AT}), 실제 청구액은 Anthropic Console 과 대조 필요\n\n`;
md += `## AI 비용 (성공 건)\n- 전체: ${fmt(s.succeeded)}\n`;
for (const [title, g] of [['모델별', s.byModel], ['사진 장수별', s.byPhotos], ['분량별', s.byVolume]]) {
  md += `\n### ${title}\n| 구분 | 건수 | 평균 | p95 | 최대 | 입력 토큰 | 출력 토큰 |\n|---|---|---|---|---|---|---|\n`;
  for (const [k, o] of Object.entries(g)) md += `| ${k} | ${o.count} | ${o.avgUsd} | ${o.p95Usd} | ${o.maxUsd} | ${o.avgInputTokens} | ${o.avgOutputTokens} |\n`;
}
md += `\n## 실패 호출\n- ${s.failed.count}건, 비용 $${s.failed.costUsd} (과금 추정 구분: ${JSON.stringify(s.failed.billing)})\n- 성공 1건당 실패 부담: $${s.failureOverheadPerSuccessUsd} (크레딧은 복구되므로 회사 부담)\n`;
md += `\n## 서버·저장 비용 (추정)\n- Functions 실행: 성공 1건당 $${s.computeUsdPerSuccess}\n- 사진 저장: 1건 평균 ${(s.avgPhotoBytesPerSuccess / 1e6).toFixed(2)}MB × ${months}개월 × $${STORAGE_USD_PER_GB_MONTH}/GB-월 = $${storageUsd.toFixed(6)}\n`;
md += `\n## 생성 1회 원가\n- 평균: **$${perGen.toFixed(4)}** (AI 평균 + 실패 부담 + 서버 + 저장)\n- 보수적(p95): **$${perGenWorst.toFixed(4)}**\n`;

if (usdKrw > 0) {
  const prices = Object.fromEntries((opt('prices', '') || '').split(',').filter(Boolean).map((x) => x.split(':').map(Number)));
  const r = pnl({ costPerGenUsd: perGen, costPerGenWorstUsd: perGenWorst, usdKrw, pgFeeRate: pgFee, targetMargin: Number(opt('margin', '0.5')), packages: [10, 30, 70].map((c) => ({ credits: c, priceKrw: prices[c] })) });
  md += `\n## 크레딧 상품 손익 (가격 미확정 — 참고용)\n- 환율 ${usdKrw}원/USD · PG 수수료 ${r.assumptions.pgFeeMissing ? '⚠️ 미입력(0%로 계산)' : (pgFee * 100).toFixed(2) + '%'} · 가격은 부가세 10% 포함 가정\n- 가입자 1명당 무료 2회 원가: ${r.signupFreeCreditCostKrw}원\n\n`;
  md += `| 상품 | 원가(평균) | 원가(p95) | 손익분기 가격 | 목표 마진 ${Math.round(r.rows[0].targetMargin * 100)}% 가격 | 입력 가격 | 순매출 | 마진(평균) | 마진율 | 마진(p95) |\n|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const x of r.rows) md += `| ${x.credits}회 | ${x.costKrw}원 | ${x.worstCostKrw ?? '-'}원 | ${x.breakEvenPriceKrw}원 | ${x.targetPriceKrw}원 | ${x.priceKrw ?? '-'} | ${x.netRevenueKrw ?? '-'} | ${x.marginKrw ?? '-'} | ${x.marginRate ?? '-'} | ${x.worstMarginKrw ?? '-'} |\n`;
} else {
  md += `\n(손익 분석: --usd-krw <환율> --pg-fee <수수료율> 를 지정하세요)\n`;
}

mkdirSync(join(ROOT, 'cost-reports'), { recursive: true });
const out = join(ROOT, 'cost-reports', `report-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
writeFileSync(out, md);
console.log(md);
console.log(`저장: ${out}`);
