// 테스트 회원 조정 (스테이징·에뮬레이터용) — 운영 설정(config/policy)·다른 회원은 건드리지 않음
//   조회:           node scripts/test-member.mjs --project <ID> --email tester@example.com
//   크레딧 조정:     ... --credits +10 --reason "테스트 충전" --apply      (creditLedger 에 admin_adjust 로 기록, 원장=잔액 유지)
//   등급(PRO 테스트): ... --plan pro --reason "PRO 화면 테스트" --apply    (planSource='admin_test', 결제 아님)
//   에뮬레이터: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node scripts/test-member.mjs --project demo-jaeinit ...
// --apply 가 없으면 미리보기만 합니다. 잔액·사용량 카운터를 문서에서 직접 고치지 마세요 (원장과 어긋남).
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fnRequire = createRequire(join(ROOT, 'functions/package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const { adminAdjustCredits } = fnRequire('./src/lib/credits');
const { adminSetPlan } = fnRequire('./src/account/features');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const projectId = opt('project');
const email = opt('email');
if (!projectId || !email) { console.error('--project <id> --email <테스트 계정 이메일> 를 지정하세요'); process.exit(2); }
const app = initializeApp({ projectId });
const db = getFirestore(app);
const uid = (await getAuth(app).getUserByEmail(email)).uid;
const show = async () => {
  const u = (await db.doc(`users/${uid}`).get()).data() || {};
  console.log(JSON.stringify({ email, plan: u.plan || 'free', credits: u.credits, freeCredits: u.freeCredits, paidCredits: u.paidCredits,
    exportCount: u.exportCount, savedPostCount: u.savedPostCount, styleCount: u.styleCount, planSource: u.planSource || null }));
};
await show();
const credits = opt('credits'); const plan = opt('plan'); const reason = opt('reason');
if (!credits && !plan) process.exit(0);
if (!reason) { console.error('--reason "<사유>" 가 필요해요 (원장·등급 기록에 남음)'); process.exit(2); }
const delta = credits ? Number(credits) : 0;
if (credits && (!Number.isInteger(delta) || delta === 0)) { console.error('--credits 는 0 이 아닌 정수 (예: +10, -3)'); process.exit(2); }
if (plan && !['free', 'pro'].includes(plan)) { console.error('--plan 은 free 또는 pro'); process.exit(2); }
console.log('변경 예정:', JSON.stringify({ ...(credits ? { credits: delta } : {}), ...(plan ? { plan } : {}), reason }));
if (!args.includes('--apply')) { console.log('미리보기만 했어요. 실제로 바꾸려면 --apply 를 붙이세요.'); process.exit(0); }
if (credits) {
  const r = await adminAdjustCredits(db, { uid, delta, reason, requestId: `script_${randomUUID()}`, actorUid: 'scripts/test-member' });
  console.log('✔ 크레딧 조정:', JSON.stringify(r));
}
if (plan) console.log('✔ 등급:', JSON.stringify(await adminSetPlan(db, { uid, plan, reason, actorUid: 'scripts/test-member' })));
await show();
