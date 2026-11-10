// 크레딧 상품(creditPackages) 시드.
//   에뮬레이터:  FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed.mjs --project demo-jaeinit
//   운영:        GOOGLE_APPLICATION_CREDENTIALS=키.json node scripts/seed.mjs --project <실제프로젝트ID>
// ⚠️ 가격(price)은 예시값입니다. 판매 전 반드시 확정하세요.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const i = process.argv.indexOf('--project');
const projectId = i > 0 ? process.argv[i + 1] : null;
if (!projectId) { console.error('--project <id> 를 지정하세요'); process.exit(1); }

const PACKAGES = [
  { id: 'credits_10', name: '크레딧 10회', credits: 10, price: 4900, sortOrder: 1 },
  { id: 'credits_30', name: '크레딧 30회', credits: 30, price: 12900, sortOrder: 2 },
  { id: 'credits_70', name: '크레딧 70회', credits: 70, price: 27900, sortOrder: 3 },
];

const db = getFirestore(initializeApp({ projectId }));
for (const p of PACKAGES) {
  const { id, ...rest } = p;
  await db.doc(`creditPackages/${id}`).set({ ...rest, currency: 'KRW', active: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  console.log('✔', id, rest.credits + '회', rest.price + '원');
}
console.log(process.env.FIRESTORE_EMULATOR_HOST ? '(에뮬레이터)' : `(프로젝트 ${projectId})`);
