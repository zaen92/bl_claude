// 사진 저장 기능 제거에 따른 기존 데이터 정리 (사진 미저장 정책 전환용)
//
//   기본: 조회만 (아무것도 바꾸지 않음) — 남아 있는 사진 관련 데이터 개수를 보고
//     node scripts/migrate-remove-photos.mjs --project <프로젝트ID>
//     (에뮬레이터: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 ... --project demo-jaeinit)
//
//   --apply-firestore : Firestore 문서에서 사진 관련 필드만 제거 (글 본문·생성 결과·[사진N] 배치는 유지)
//                       generations.{photos,photosState,photosExpireAt,photoBytesReserved,photosKeptBy,photosCheckedAt,photosDeletedAt},
//                       posts.photos, users.storageBytes, photoDeletionJobs 문서
//   --delete-storage  : Cloud Storage 의 users/ 아래 사진 파일 삭제 (복구 불가 — 먼저 백업 권장)
//                       --bucket <버킷 이름> 필요 (Firebase 콘솔 → Storage 상단 gs://...)
//
// ⚠️ 삭제·수정 옵션은 되돌릴 수 없습니다. 반드시 조회 결과를 확인한 뒤 실행하세요.
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'functions/package.json'));
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const flag = (k) => args.includes('--' + k);
const projectId = opt('project');
if (!projectId) { console.error('--project <프로젝트ID> 필요'); process.exit(2); }
const APPLY_FS = flag('apply-firestore');
const DELETE_ST = flag('delete-storage');

const app = initializeApp({ projectId, ...(opt('bucket') ? { storageBucket: opt('bucket') } : {}) });
const db = getFirestore(app);
const GEN_FIELDS = ['photos', 'photosState', 'photosExpireAt', 'photoBytesReserved', 'photosKeptBy', 'photosCheckedAt', 'photosDeletedAt'];

async function scan(col, pred) {
  const snap = await db.collection(col).get();
  return snap.docs.filter((d) => pred(d.data()));
}

console.log(`\n사진 데이터 점검: ${projectId} ${APPLY_FS || DELETE_ST ? '(⚠️ 변경 모드)' : '(조회만)'}\n`);
const gens = await scan('generations', (d) => GEN_FIELDS.some((k) => k in d));
const posts = await scan('posts', (d) => 'photos' in d);
const users = await scan('users', (d) => 'storageBytes' in d);
const jobs = (await db.collection('photoDeletionJobs').get()).docs;
console.log(`- 사진 필드가 있는 생성 기록: ${gens.length}건`);
console.log(`- 사진 경로가 있는 저장 글: ${posts.length}건 (글 내용·[사진N] 배치는 유지됨)`);
console.log(`- storageBytes 가 있는 사용자: ${users.length}명`);
console.log(`- 사진 삭제 작업 문서: ${jobs.length}건`);

let files = [];
if (opt('bucket')) {
  const { getStorage } = require('firebase-admin/storage');
  [files] = await getStorage(app).bucket().getFiles({ prefix: 'users/' });
  const bytes = files.reduce((n, f) => n + Number(f.metadata.size || 0), 0);
  console.log(`- Cloud Storage users/ 아래 파일: ${files.length}개 (${(bytes / 1e6).toFixed(2)}MB)`);
} else {
  console.log('- Cloud Storage: --bucket 미지정으로 확인 안 함');
}

if (APPLY_FS) {
  const del = Object.fromEntries(GEN_FIELDS.map((k) => [k, FieldValue.delete()]));
  for (const d of gens) await d.ref.update(del);
  for (const d of posts) await d.ref.update({ photos: FieldValue.delete() });
  for (const d of users) await d.ref.update({ storageBytes: FieldValue.delete() });
  for (const d of jobs) await d.ref.delete();
  console.log(`\n✅ Firestore 사진 필드 정리 완료 (생성 ${gens.length}, 글 ${posts.length}, 사용자 ${users.length}, 작업 ${jobs.length})`);
}
if (DELETE_ST) {
  if (!opt('bucket')) { console.error('--delete-storage 에는 --bucket 이 필요합니다'); process.exit(2); }
  for (const f of files) await f.delete({ ignoreNotFound: true });
  console.log(`✅ Storage 사진 ${files.length}개 삭제 완료`);
}
if (!APPLY_FS && !DELETE_ST) console.log('\n변경하지 않았습니다. 정리하려면 --apply-firestore / --delete-storage --bucket <버킷> (되돌릴 수 없음)');
