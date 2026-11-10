// Firestore 보안 규칙 테스트 — `npm run test:emu` (Firestore 에뮬레이터 필요)
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where, getDocs, serverTimestamp,
} from 'firebase/firestore';

const PROJECT_ID = 'demo-jaeinit';
let env;

before(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'), host, port: Number(port) },
  });
});
after(async () => { await env?.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  // 서버(Admin)가 만든 것과 같은 초기 데이터
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/alice'), { uid: 'alice', email: 'a@x.com', displayName: 'Alice', credits: 2, role: 'user', signupBonus: { status: 'granted', amount: 2 } });
    await setDoc(doc(db, 'users/bob'), { uid: 'bob', email: 'b@x.com', displayName: 'Bob', credits: 0, role: 'user' });
    await setDoc(doc(db, 'creditLedger/signup_bonus_alice'), { uid: 'alice', type: 'signup_bonus', delta: 2, balanceAfter: 2 });
    await setDoc(doc(db, 'creditLedger/signup_bonus_bob'), { uid: 'bob', type: 'signup_bonus', delta: 2, balanceAfter: 2 });
    await setDoc(doc(db, 'creditPackages/p10'), { name: '10회', credits: 10, price: 4900, currency: 'KRW', active: true, sortOrder: 1 });
    await setDoc(doc(db, 'orders/o1'), { uid: 'alice', status: 'pending', amount: 4900 });
    await setDoc(doc(db, 'generations/g1'), { uid: 'alice', status: 'succeeded' });
    await setDoc(doc(db, 'posts/pa'), { uid: 'alice', title: 'A글', type: '맛집', data: { body: 'x' }, createdAt: new Date(), updatedAt: new Date() });
    await setDoc(doc(db, 'signupGrants/hash1'), { uid: 'alice' });
  });
});

const anon = () => env.unauthenticatedContext().firestore();
const alice = () => env.authenticatedContext('alice', { email: 'a@x.com', email_verified: true }).firestore();
const bob = () => env.authenticatedContext('bob').firestore();
const admin = () => env.authenticatedContext('admin1', { admin: true }).firestore();

// ── 비로그인 ──
test('비로그인: users/ledger/posts/orders/generations 읽기 불가, 상품 목록은 공개', async () => {
  const db = anon();
  for (const p of ['users/alice', 'creditLedger/signup_bonus_alice', 'posts/pa', 'orders/o1', 'generations/g1']) {
    await assertFails(getDoc(doc(db, p)));
  }
  await assertSucceeds(getDoc(doc(db, 'creditPackages/p10')));
  await assertFails(addDoc(collection(db, 'posts'), { uid: 'x', title: 't', data: {}, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
});

// ── users ──
test('users: 본인만 읽기, 타인 읽기 불가', async () => {
  await assertSucceeds(getDoc(doc(alice(), 'users/alice')));
  await assertFails(getDoc(doc(alice(), 'users/bob')));
});
test('users: 클라이언트가 문서 생성/삭제 불가 (가입 크레딧 자가 지급 차단)', async () => {
  await assertFails(setDoc(doc(env.authenticatedContext('carol').firestore(), 'users/carol'), { uid: 'carol', credits: 999 }));
  await assertFails(deleteDoc(doc(alice(), 'users/alice')));
});
test('users: credits/role/signupBonus 수정 불가, displayName 만 수정 가능', async () => {
  const db = alice();
  await assertFails(updateDoc(doc(db, 'users/alice'), { credits: 100 }));
  await assertFails(updateDoc(doc(db, 'users/alice'), { credits: 100, displayName: 'A', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'users/alice'), { role: 'admin' }));
  await assertFails(updateDoc(doc(db, 'users/alice'), { signupBonus: { status: 'pending_verification' } }));
  await assertFails(updateDoc(doc(db, 'users/alice'), { displayName: '', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'users/alice'), { displayName: 'x'.repeat(41), updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db, 'users/alice'), { displayName: '잰잇', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(bob(), 'users/alice'), { displayName: 'hack', updatedAt: serverTimestamp() }));
});

// ── creditLedger ──
test('creditLedger: 본인 항목만 조회, 쿼리는 uid 필터 필수, 쓰기 불가', async () => {
  const db = alice();
  await assertSucceeds(getDoc(doc(db, 'creditLedger/signup_bonus_alice')));
  await assertFails(getDoc(doc(db, 'creditLedger/signup_bonus_bob')));
  await assertSucceeds(getDocs(query(collection(db, 'creditLedger'), where('uid', '==', 'alice'))));
  await assertFails(getDocs(collection(db, 'creditLedger')));
  await assertFails(setDoc(doc(db, 'creditLedger/fake'), { uid: 'alice', type: 'admin_adjust', delta: 100, balanceAfter: 102 }));
  await assertFails(updateDoc(doc(db, 'creditLedger/signup_bonus_alice'), { delta: 200 }));
  await assertFails(deleteDoc(doc(db, 'creditLedger/signup_bonus_alice')));
});

// ── orders / generations / signupGrants ──
test('orders·generations: 본인 읽기만, 쓰기 불가', async () => {
  const db = alice();
  await assertSucceeds(getDoc(doc(db, 'orders/o1')));
  await assertSucceeds(getDoc(doc(db, 'generations/g1')));
  await assertFails(getDoc(doc(bob(), 'orders/o1')));
  await assertFails(getDoc(doc(bob(), 'generations/g1')));
  await assertFails(updateDoc(doc(db, 'orders/o1'), { status: 'paid' }));
  await assertFails(setDoc(doc(db, 'orders/o2'), { uid: 'alice', status: 'paid', amount: 1 }));
  await assertFails(setDoc(doc(db, 'generations/g2'), { uid: 'alice', status: 'succeeded' }));
});
test('signupGrants: 누구도(관리자 포함) 클라이언트 접근 불가', async () => {
  await assertFails(getDoc(doc(alice(), 'signupGrants/hash1')));
  await assertFails(getDoc(doc(admin(), 'signupGrants/hash1')));
  await assertFails(deleteDoc(doc(alice(), 'signupGrants/hash1')));
});

// ── creditPackages (관리자 전용 쓰기) ──
test('creditPackages: 일반 사용자 쓰기 불가, 관리자만 유효한 상품 쓰기 가능', async () => {
  const pkg = { name: '30회', credits: 30, price: 12900, currency: 'KRW', active: true, sortOrder: 2 };
  await assertFails(setDoc(doc(alice(), 'creditPackages/p30'), pkg));
  await assertFails(updateDoc(doc(alice(), 'creditPackages/p10'), { price: 1 }));
  await assertSucceeds(setDoc(doc(admin(), 'creditPackages/p30'), pkg));
  await assertFails(setDoc(doc(admin(), 'creditPackages/bad'), { ...pkg, price: -1 }));
  await assertFails(setDoc(doc(admin(), 'creditPackages/bad2'), { ...pkg, currency: 'USD' }));
  await assertSucceeds(deleteDoc(doc(admin(), 'creditPackages/p30')));
});

// ── 관리자 읽기 / 쓰기 분리 ──
test('관리자: 모든 사용자 데이터 읽기 가능, 잔액·원장·주문 직접 쓰기는 불가', async () => {
  const db = admin();
  await assertSucceeds(getDoc(doc(db, 'users/alice')));
  await assertSucceeds(getDocs(collection(db, 'creditLedger')));
  await assertSucceeds(getDoc(doc(db, 'orders/o1')));
  await assertSucceeds(getDoc(doc(db, 'posts/pa')));
  await assertFails(updateDoc(doc(db, 'users/alice'), { credits: 50 }));
  await assertFails(setDoc(doc(db, 'creditLedger/x'), { uid: 'alice', delta: 50 }));
  await assertFails(updateDoc(doc(db, 'orders/o1'), { status: 'paid' }));
});

// ── posts ──
test('posts: 본인 글 CRUD, 타인 글 접근 불가', async () => {
  const db = alice();
  const ref = doc(db, 'posts/new1');
  const post = { uid: 'alice', title: '새 글', type: '카페', data: { body: '본문', hashtags: ['#a'] }, generationId: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  await assertSucceeds(setDoc(ref, post));
  await assertSucceeds(getDoc(ref));
  await assertSucceeds(getDocs(query(collection(db, 'posts'), where('uid', '==', 'alice'))));
  await assertFails(getDocs(collection(db, 'posts')));
  await assertSucceeds(updateDoc(ref, { title: '수정', updatedAt: serverTimestamp() }));
  await assertFails(getDoc(doc(bob(), 'posts/new1')));
  await assertFails(updateDoc(doc(bob(), 'posts/new1'), { title: 'x', updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(bob(), 'posts/new1')));
  await assertSucceeds(deleteDoc(ref));
});
test('posts: 스키마 위반 거부 (타인 uid, uid 변경, 임의 필드, createdAt 위조)', async () => {
  const db = alice();
  const base = { uid: 'alice', title: 't', data: {}, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  await assertFails(setDoc(doc(db, 'posts/x1'), { ...base, uid: 'bob' }));
  await assertFails(setDoc(doc(db, 'posts/x2'), { ...base, credits: 100 }));
  await assertFails(setDoc(doc(db, 'posts/x3'), { ...base, createdAt: new Date(2000, 1, 1) }));
  await assertFails(setDoc(doc(db, 'posts/x4'), { ...base, title: 'x'.repeat(301) }));
  await assertFails(setDoc(doc(db, 'posts/x5'), { ...base, data: 'not-a-map' }));
  await assertFails(updateDoc(doc(db, 'posts/pa'), { uid: 'bob', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'posts/pa'), { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  // 로컬 저장 글 이전(legacy): 존재하지 않는 자기 legacy ID 만 조회 가능
  await assertSucceeds(getDoc(doc(db, 'posts/legacy_alice_1700000000000')));
  await assertFails(getDoc(doc(db, 'posts/legacy_bob_1700000000000')));
  await assertFails(getDoc(doc(db, 'posts/random_missing')));
  await assertFails(getDoc(doc(db, 'posts/legacy_alice_x')).then(() => getDoc(doc(bob(), 'posts/pa'))));
  // 사진 경로 목록 (최대 10개)
  await assertSucceeds(setDoc(doc(db, 'posts/p_photos'), { ...base, photos: [{ path: 'users/alice/generations/g/photo_1.jpg', index: 1 }] }));
  await assertFails(setDoc(doc(db, 'posts/p_photos2'), { ...base, photos: new Array(11).fill({ path: 'x' }) }));
  await assertFails(setDoc(doc(db, 'posts/p_photos3'), { ...base, photos: 'not-a-list' }));
  // 로컬 저장 글 이전(legacy) 형식 허용
  await assertSucceeds(setDoc(doc(db, 'posts/legacy_alice_1700000000000'), { ...base, legacyId: 1700000000000, legacySavedAt: '2024. 1. 1. 오후 3:00:00' }));
});
