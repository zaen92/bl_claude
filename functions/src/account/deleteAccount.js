'use strict';
/**
 * 회원 탈퇴 데이터 정리 (멱등 — 탈퇴 callable 과 Auth onDelete 트리거 양쪽에서 호출될 수 있음)
 *
 *  삭제: posts, generations(입력·결과 원문), users 문서 (사진은 서버에 저장하지 않으므로 삭제할 사진 없음)
 *  보관: creditLedger(회계 기록, uid 만 포함), generationMetrics(토큰·비용, 입력 내용 없음),
 *        signupGrants(이메일 해시 — 재가입 보너스 악용 방지). 개인정보처리방침에 명시 필요.
 */
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { COL } = require('../lib/schema');

async function deleteQueryInBatches(db, query) {
  let n = 0;
  for (;;) {
    const snap = await query.limit(300).get();
    if (snap.empty) return n;
    const b = db.batch();
    snap.docs.forEach((d) => b.delete(d.ref));
    await b.commit();
    n += snap.size;
  }
}

async function deleteAccountData(db, uid, { nowMs = Date.now(), source = 'unknown' } = {}) {
  const recRef = db.collection(COL.ACCOUNT_DELETIONS).doc(uid);
  await recRef.set({ uid, source, status: 'running', startedAt: FieldValue.serverTimestamp() }, { merge: true });
  const posts = await deleteQueryInBatches(db, db.collection(COL.POSTS).where('uid', '==', uid));
  const generations = await deleteQueryInBatches(db, db.collection(COL.GENERATIONS).where('uid', '==', uid));
  await db.collection(COL.USERS).doc(uid).delete();
  await recRef.set({
    status: 'done',
    posts, generations,
    completedAt: FieldValue.serverTimestamp(),
    completedAtMs: Timestamp.fromMillis(nowMs),
  }, { merge: true });
  return { posts, generations };
}

module.exports = { deleteAccountData };
