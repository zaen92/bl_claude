// 배포 전 사전 점검 — 하나라도 실패하면 exit 1 (deploy:* 스크립트가 배포를 진행하지 않음)
//   node scripts/preflight.mjs staging      (또는 prod)
// 이 스크립트는 아무것도 배포·수정하지 않습니다. 비밀값을 출력하지 않습니다.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const alias = process.argv[2];
if (!['staging', 'prod'].includes(alias)) { console.error('사용법: node scripts/preflight.mjs <staging|prod>'); process.exit(2); }

const results = [];
const check = (ok, label, hint) => { results.push({ ok, label, hint }); };
const readEnv = (p) => (existsSync(p) ? Object.fromEntries(readFileSync(p, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1).trim()])) : null);
const firebase = (args) => spawnSync('npx', ['firebase', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });

// 1. 프로젝트 별칭
const rc = JSON.parse(readFileSync(join(ROOT, '.firebaserc'), 'utf8'));
const projectId = rc.projects && rc.projects[alias];
check(!!projectId && !projectId.startsWith('demo-'), `.firebaserc 에 "${alias}" 별칭 → 실제 프로젝트 ID`, `npx firebase use --add  (프로젝트 선택 후 별칭 "${alias}" 입력)`);
if (alias === 'prod' && rc.projects.staging) check(rc.projects.staging !== projectId, '스테이징과 운영이 서로 다른 프로젝트', '운영·스테이징은 반드시 별도 Firebase 프로젝트로');

// 2. Firebase CLI 로그인
const login = firebase(['login:list']);
check(login.status === 0 && /Logged in as/i.test(login.stdout + login.stderr), 'Firebase CLI 로그인', 'npx firebase login');

// 3. Functions 설정 파일
const fenv = readEnv(join(ROOT, `functions/.env.${alias}`));
check(!!fenv, `functions/.env.${alias} 존재`, '저장소에 포함된 파일 — 삭제됐다면 git 에서 복구');
if (projectId && existsSync(join(ROOT, `functions/.env.${projectId}`))) check(false, `functions/.env.${projectId} 와 .env.${alias} 를 동시에 둘 수 없음`, '둘 중 하나 삭제');

// 4. Secret Manager (값은 출력하지 않음 — 버전 존재만 확인)
if (projectId && login.status === 0) {
  for (const name of ['ANTHROPIC_API_KEY', 'NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET']) {
    const r = firebase(['functions:secrets:get', name, '--project', alias]);
    check(r.status === 0, `Secret ${name} 등록`, `npx firebase functions:secrets:set ${name} --project ${alias}`);
  }
} else {
  check(false, 'Secret 등록 확인', '프로젝트 별칭·로그인 후 다시 실행');
}

// 5. Cloud Storage 미사용 확인 (사진은 서버에 저장하지 않음)
const fbcfg = JSON.parse(readFileSync(join(ROOT, 'firebase.json'), 'utf8'));
check(!fbcfg.storage, 'Cloud Storage 배포 대상 없음 (사진 미저장 정책)', 'firebase.json 에서 storage 항목 제거');

// 6. App Check
const wenvLocal = readEnv(join(ROOT, `web/.env.${alias}.local`)) || {};
const enforce = fenv && fenv.ENFORCE_APP_CHECK === 'true';
if (enforce) check(!!wenvLocal.VITE_APPCHECK_SITE_KEY, 'App Check 강제(ENFORCE_APP_CHECK=true) → 웹 사이트 키 설정', `web/.env.${alias}.local 에 VITE_APPCHECK_SITE_KEY=... (docs/APP_CHECK.md)`);
check(!wenvLocal.VITE_APPCHECK_DEBUG_TOKEN || alias === 'staging', '운영 빌드에 App Check 디버그 토큰 없음', `web/.env.${alias}.local 에서 VITE_APPCHECK_DEBUG_TOKEN 제거`);
if (alias === 'prod') check(enforce, '운영은 App Check 강제', 'functions/.env.prod ENFORCE_APP_CHECK=true');

// 7. 스테이징 접근 제한
if (alias === 'staging') check(fenv && fenv.ACCESS_MODE === 'allowlist', '스테이징은 허용 목록 모드 (초대된 계정만 AI 생성)', 'functions/.env.staging ACCESS_MODE=allowlist');

// 8. 로컬 비밀 파일이 배포 대상에 섞이지 않음
check(fbcfg.functions[0].ignore.includes('*.local'), 'functions 배포에서 *.local(.secret.local) 제외', 'firebase.json functions.ignore 에 "*.local"');

console.log(`\n배포 사전 점검: ${alias} (${projectId || '프로젝트 미설정'})\n`);
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.label}${r.ok ? '' : `\n     → ${r.hint}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n❌ ${failed}개 항목 미준비 — 배포하지 않습니다.` : '\n✅ 사전 점검 통과 (배포는 별도 명령으로 직접 실행)');
process.exit(failed ? 1 : 0);
