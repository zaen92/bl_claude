// FREE/PRO 운영 설정(config/policy) 조회·변경 — 변경은 --apply 가 있을 때만 (기본은 미리보기)
//   조회:  node scripts/policy.mjs --project <프로젝트ID>
//   변경:  node scripts/policy.mjs --project <프로젝트ID> --set signupBonusCredits=3,freeExportLimit=5 --apply
//   에뮬레이터: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/policy.mjs --project demo-jaeinit ...
// 가입 크레딧 변경은 "이후 신규 가입자"에게만 적용됩니다. 기존 회원의 잔액·원장은 바뀌지 않습니다.
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fnRequire = createRequire(join(ROOT, 'functions/package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, FieldValue } = fnRequire('firebase-admin/firestore');
const { DEFAULT_POLICY, RANGES, getPolicy } = fnRequire('./src/config/policy');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const projectId = opt('project');
if (!projectId) { console.error('--project <id> 를 지정하세요'); process.exit(2); }
const db = getFirestore(initializeApp({ projectId }));

const raw = (await db.doc('config/policy').get()).data() || null;
console.log(`프로젝트 ${projectId}${process.env.FIRESTORE_EMULATOR_HOST ? ' (에뮬레이터)' : ''}`);
console.log('저장된 값  :', raw ? JSON.stringify(raw) : '(문서 없음 — 기본값 사용)');
console.log('적용되는 값:', JSON.stringify(await getPolicy(db)));
console.log('코드 기본값:', JSON.stringify(DEFAULT_POLICY));

const set = opt('set');
if (!set) process.exit(0);
const patch = {};
for (const kv of set.split(',')) {
  const [k, v] = kv.split('=');
  if (!(k in DEFAULT_POLICY)) { console.error(`알 수 없는 항목: ${k} (허용: ${Object.keys(DEFAULT_POLICY).join(', ')})`); process.exit(2); }
  const n = Number(v);
  const [min, max] = RANGES[k];
  if (!Number.isInteger(n) || n < min || n > max) { console.error(`${k} 는 ${min}~${max} 정수여야 해요`); process.exit(2); }
  patch[k] = n;
}
console.log('\n변경 예정:', JSON.stringify(patch));
if (!args.includes('--apply')) { console.log('미리보기만 했어요. 실제로 바꾸려면 --apply 를 붙이세요.'); process.exit(0); }
await db.doc('config/policy').set({ ...patch, updatedAt: FieldValue.serverTimestamp(), updatedBy: 'scripts/policy.mjs' }, { merge: true });
console.log('✔ 변경 완료:', JSON.stringify(await getPolicy(db)));
