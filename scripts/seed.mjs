// 크레딧 상품(creditPackages) 시드. 가격은 반드시 직접 지정 (실측 원가 확인 전 확정 금지 — docs/AI_COST.md)
//   에뮬레이터:  FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed.mjs --project demo-jaeinit --prices 10:4900,30:12900,70:27900
//   운영:        GOOGLE_APPLICATION_CREDENTIALS=키.json node scripts/seed.mjs --project <실제프로젝트ID> --prices 10:<원>,30:<원>,70:<원>
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const i = process.argv.indexOf('--project');
const projectId = i > 0 ? process.argv[i + 1] : null;
if (!projectId) { console.error('--project <id> 를 지정하세요'); process.exit(1); }

const pi = process.argv.indexOf('--prices');
const prices = pi > 0 ? Object.fromEntries(process.argv[pi + 1].split(',').map((x) => x.split(':').map(Number))) : null;
if (!prices || ![10, 30, 70].every((c) => Number.isInteger(prices[c]) && prices[c] > 0)) {
  console.error('가격이 확정되지 않았습니다. --prices 10:<원>,30:<원>,70:<원> 로 지정하세요 (실측 후 결정: npm run cost-report)');
  process.exit(1);
}
const PACKAGES = [10, 30, 70].map((c, i) => ({ id: `credits_${c}`, name: `크레딧 ${c}회`, credits: c, price: prices[c], sortOrder: i + 1 }));

const db = getFirestore(initializeApp({ projectId }));
for (const p of PACKAGES) {
  const { id, ...rest } = p;
  await db.doc(`creditPackages/${id}`).set({ ...rest, currency: 'KRW', active: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  console.log('✔', id, rest.credits + '회', rest.price + '원');
}
console.log(process.env.FIRESTORE_EMULATOR_HOST ? '(에뮬레이터)' : `(프로젝트 ${projectId})`);
