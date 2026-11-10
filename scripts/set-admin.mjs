// 관리자 권한 부여/해제 (custom claim admin)
//   node scripts/set-admin.mjs --project <id> <email> [--revoke]
//   에뮬레이터: FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 를 함께 지정
// 대상 사용자는 다시 로그인(또는 토큰 갱신)해야 권한이 반영됩니다.
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const args = process.argv.slice(2);
const pi = args.indexOf('--project');
const projectId = pi >= 0 ? args[pi + 1] : null;
const revoke = args.includes('--revoke');
const email = args.find((a, idx) => !a.startsWith('--') && idx !== pi + 1);
if (!projectId || !email) { console.error('사용법: node scripts/set-admin.mjs --project <id> <email> [--revoke]'); process.exit(1); }

const auth = getAuth(initializeApp({ projectId }));
const user = await auth.getUserByEmail(email);
const claims = { ...(user.customClaims || {}) };
if (revoke) delete claims.admin; else claims.admin = true;
await auth.setCustomUserClaims(user.uid, claims);
console.log(`${revoke ? '해제' : '부여'} 완료: ${email} (${user.uid})`, claims);
