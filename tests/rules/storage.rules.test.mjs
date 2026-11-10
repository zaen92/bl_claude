// Cloud Storage 보안 규칙 테스트 — `npm run test:emu`
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { ref, uploadString, getBytes, deleteObject, listAll } from 'firebase/storage';

let env;
const PATH = 'users/alice/generations/alice_req1/photo_1.jpg';

before(async () => {
  const [host, port] = (process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199').split(':');
  env = await initializeTestEnvironment({
    projectId: 'demo-jaeinit',
    storage: { rules: readFileSync(new URL('../../storage.rules', import.meta.url), 'utf8'), host, port: Number(port) },
  });
});
after(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadString(ref(ctx.storage(), PATH), 'jpegbytes', 'raw', { contentType: 'image/jpeg' });
  });
});

const st = (uid, claims) => (uid ? env.authenticatedContext(uid, claims) : env.unauthenticatedContext()).storage();

test('Storage: 본인 사진만 읽기, 타인/비로그인 읽기 불가, 관리자 읽기 가능', async () => {
  await assertSucceeds(getBytes(ref(st('alice'), PATH)));
  await assertFails(getBytes(ref(st('bob'), PATH)));
  await assertFails(getBytes(ref(st(null), PATH)));
  await assertSucceeds(getBytes(ref(st('admin1', { admin: true }), PATH)));
  await assertFails(listAll(ref(st('bob'), 'users/alice')));
});

test('Storage: 클라이언트 업로드·삭제 불가 (본인 경로 포함, 서버만 저장 → 용량 집계 보장)', async () => {
  await assertFails(uploadString(ref(st('alice'), 'users/alice/generations/x/photo_9.jpg'), 'x', 'raw', { contentType: 'image/jpeg' }));
  await assertFails(deleteObject(ref(st('alice'), PATH)));
  await assertFails(uploadString(ref(st('bob'), 'users/alice/hack.jpg'), 'x', 'raw', { contentType: 'image/jpeg' }));
  await assertFails(uploadString(ref(st('alice'), 'public/x.jpg'), 'x', 'raw'));
});
