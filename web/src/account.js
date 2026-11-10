// 회원 프로필 / 크레딧 잔액 / 원장 / 상품 조회 (읽기 전용 — 쓰기는 서버만)
import {
  doc, onSnapshot, collection, query, where, orderBy, limit, getDocs, updateDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase.js';

export const subscribeProfile = (uid, cb) =>
  onSnapshot(doc(db, 'users', uid), (s) => cb(s.exists() ? s.data() : null), () => cb(null));

export const subscribeLedger = (uid, cb, n = 5) =>
  onSnapshot(
    query(collection(db, 'creditLedger'), where('uid', '==', uid), orderBy('createdAt', 'desc'), limit(n)),
    (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (e) => { console.warn('ledger', e); cb([]); },
  );

export async function loadPackages() {
  const s = await getDocs(query(collection(db, 'creditPackages'), where('active', '==', true)));
  return s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.sortOrder - b.sortOrder);
}

/** 보안 규칙상 displayName/updatedAt 만 수정 가능 */
export const updateDisplayName = (uid, name) =>
  updateDoc(doc(db, 'users', uid), { displayName: name, updatedAt: serverTimestamp() });

export const LEDGER_LABEL = {
  signup_bonus: '🎁 가입 축하',
  purchase: '💳 충전',
  generation: '✨ AI 생성',
  refund: '↩️ 환원',
  admin_adjust: '🛠️ 관리자 조정',
};
