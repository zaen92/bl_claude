// ⚠️ 실제 Claude API 비용 측정 벤치마크 — 사진 장수 × 글 분량 × 모델 조합으로 실제 생성 후 토큰·비용 기록
//
//   무료 사전 측정 (입력 토큰만, 생성·검색 없음 — Token Counting API):
//     ANTHROPIC_API_KEY=... node scripts/live-benchmark.mjs --count-only
//   실제 측정 (비용 발생, --yes 필수):
//     ANTHROPIC_API_KEY=... node scripts/live-benchmark.mjs --yes [--photos 0,3,5,10] [--volumes short,normal,long]
//         [--models claude-sonnet-4-6,claude-sonnet-5-5] [--repeat 1] [--web-search 5] [--photos-dir ./samples]
//
//   --photos-dir: 실제 음식·장소 사진(JPG/PNG)을 넣으면 그 사진을 사용 (권장). 없으면 1400x1050 합성 이미지
//                 (이미지 토큰은 해상도로 결정되므로 비용 측정에는 충분, 사진 이해 품질은 측정 불가)
//   결과: cost-reports/benchmark-<시각>.json / .md
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'functions/package.json'));
const { buildPrompt } = require('./src/ai/prompt');
const { buildClaudeRequest, runClaude } = require('./src/ai/claude');
const { parseGeneration } = require('./src/ai/parse');
const { checkResult } = require('./src/ai/validateResult');
const { estimateCostUsd, PRICING_VERIFIED_AT } = require('./src/config/pricing');
const { summarize } = require('./src/ops/costAnalysis');
const { photoLike } = require('./test/fixtures/images');
const Anthropic = require('@anthropic-ai/sdk');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const flag = (k) => args.includes('--' + k);
const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error('❌ ANTHROPIC_API_KEY 가 없습니다. 실제 측정 불가 (docs/LIVE_VERIFICATION.md)'); process.exit(2); }
const models = list(opt('models', process.env.CLAUDE_MODEL || 'claude-sonnet-4-6'));
const photoCounts = list(opt('photos', '0,3,5,10')).map(Number);
const volumes = list(opt('volumes', 'short,normal,long'));
const repeat = Number(opt('repeat', '1'));
const webSearch = Number(opt('web-search', '5'));
const countOnly = flag('count-only');
const client = new (Anthropic.default || Anthropic)({ apiKey: KEY, maxRetries: 1, timeout: 280_000 });

// 사진 준비
let pool = [];
const dir = opt('photos-dir');
if (dir) {
  pool = readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).map((f) => {
    const ext = extname(f).slice(1).toLowerCase();
    const mt = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mt};base64,${readFileSync(join(dir, f)).toString('base64')}`;
  });
  if (!pool.length) { console.error('사진 폴더에 이미지가 없습니다'); process.exit(2); }
} else {
  pool = Array.from({ length: 10 }, (_, i) => photoLike(i));
}
const photosFor = (n) => Array.from({ length: n }, (_, i) => pool[i % pool.length]);

const SAMPLE = { title: '세비야 타파스 맛집 바 알팔파 | 살모레호 솔직 후기', type: '맛집', content: '남편이랑 방문. 살모레호 맛있음(4.5유로), 소꼬리찜은 아쉬움. 웨이팅 20분. 테라스 자리 추천.', memo: '', info: '' };
const runs = [];
for (const model of models) for (const n of photoCounts) for (const volume of volumes) for (let r = 0; r < repeat; r++) runs.push({ model, n, volume });

if (!countOnly && !flag('yes')) {
  console.log(`실제 생성 ${runs.length}회가 실행됩니다 (예상 최대 약 $${(runs.length * 0.35).toFixed(2)}, 정가 기준 추정).`);
  console.log('진행하려면 --yes 를 붙여 다시 실행하세요. 무료 입력 토큰 측정은 --count-only');
  process.exit(1);
}

const results = [];
for (const [i, r] of runs.entries()) {
  const images = photosFor(r.n);
  const prompt = buildPrompt({ ...SAMPLE, volume: r.volume, imageCount: images.length });
  const params = buildClaudeRequest({ model: r.model, maxTokens: 8192, prompt, images, webSearchMaxUses: webSearch });
  const label = `[${i + 1}/${runs.length}] ${r.model} 사진${r.n} ${r.volume}`;
  try {
    if (countOnly) {
      const { model, messages, tools } = params;
      let ct;
      try { ct = await client.messages.countTokens({ model, messages, tools }); } catch (e) { ct = await client.messages.countTokens({ model, messages }); }
      const usage = { inputTokens: ct.input_tokens, outputTokens: 0, webSearchRequests: 0 };
      results.push({ ...r, imageCount: r.n, status: 'counted', usage, costUsd: estimateCostUsd(r.model, usage).usd });
      console.log(label, `입력 ${ct.input_tokens} 토큰 (프롬프트+사진, 검색 결과 제외)`);
      continue;
    }
    const t0 = Date.now();
    const out = await runClaude(client, params);
    const result = parseGeneration(out.text, SAMPLE.title);
    const q = checkResult(result, { volume: r.volume, imageCount: r.n });
    const cost = estimateCostUsd(out.model, out.usage);
    results.push({ ...r, imageCount: r.n, status: 'succeeded', model: out.model, usage: out.usage, costUsd: cost.usd, costBreakdown: cost.breakdown, latencyMs: Date.now() - t0, bodyChars: q.bodyChars, qualityFlags: q.flags });
    console.log(label, `$${cost.usd} in ${out.usage.inputTokens} out ${out.usage.outputTokens} 검색 ${out.usage.webSearchRequests} ${Math.round((Date.now() - t0) / 1000)}s 본문 ${q.bodyChars}자 ${q.flags.length ? '⚠️ ' + q.flags.join(',') : ''}`);
  } catch (e) {
    const m = e.aiMeta || {};
    const cost = m.usage ? estimateCostUsd(r.model, m.usage) : { usd: null };
    results.push({ ...r, imageCount: r.n, status: 'failed', error: e.status || e.name, usage: m.usage || null, costUsd: cost.usd, billing: m.responseStarted ? 'partial_lower_bound' : 'none' });
    console.log(label, '❌', e.status || e.name);
  }
}

mkdirSync(join(ROOT, 'cost-reports'), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const base = join(ROOT, 'cost-reports', `benchmark-${countOnly ? 'count-' : ''}${stamp}`);
writeFileSync(base + '.json', JSON.stringify({ countOnly, models, photoCounts, volumes, repeat, webSearch, pricingVerifiedAt: PRICING_VERIFIED_AT, photos: dir ? 'real' : 'synthetic', results }, null, 2));

const s = countOnly ? null : summarize(results);
let md = `# 비용 벤치마크 ${countOnly ? '(입력 토큰만 — 무료 측정)' : '(실제 생성)'}\n\n- 시각: ${new Date().toISOString()}\n- 모델: ${models.join(', ')} · 웹검색 max_uses ${webSearch} · 사진: ${dir ? '실제 사진' : '합성 1400x1050'}\n- 단가 확인일: ${PRICING_VERIFIED_AT} (정가 기준 예상 비용)\n\n| 모델 | 사진 | 분량 | 입력 토큰 | 출력 토큰 | 검색 | 예상 비용(USD) | 시간(s) | 본문 글자 | 경고 |\n|---|---|---|---|---|---|---|---|---|---|\n`;
for (const x of results) md += `| ${x.model} | ${x.imageCount} | ${x.volume} | ${x.usage ? x.usage.inputTokens : '-'} | ${x.usage ? x.usage.outputTokens : '-'} | ${x.usage ? x.usage.webSearchRequests : '-'} | ${x.costUsd ?? '-'} | ${x.latencyMs ? Math.round(x.latencyMs / 1000) : '-'} | ${x.bodyChars ?? '-'} | ${(x.qualityFlags || []).join(' ') || (x.status === 'failed' ? '실패 ' + x.error : '')} |\n`;
if (s) {
  md += `\n## 요약 (성공 ${s.succeeded.count}건)\n- 평균 $${s.succeeded.avgUsd} · p95 $${s.succeeded.p95Usd} · 최대 $${s.succeeded.maxUsd}\n- 실패 ${s.failed.count}건, 실패 호출 비용 $${s.failed.costUsd}\n\n| 구분 | 건수 | 평균 | 최대 |\n|---|---|---|---|\n`;
  for (const [g, o] of Object.entries({ ...s.byPhotos, ...s.byVolume })) md += `| ${g} | ${o.count} | ${o.avgUsd} | ${o.maxUsd} |\n`;
  md += `\n손익 분석: \`node scripts/cost-report.mjs --benchmark ${base}.json --usd-krw <환율> --pg-fee <수수료율>\`\n`;
}
writeFileSync(base + '.md', md);
console.log(`\n저장: ${base}.json / .md`);
