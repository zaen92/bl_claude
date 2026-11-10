'use strict';
/**
 * 회원 탈퇴 데이터 정리 (멱등 — 탈퇴 callable 과 Auth onDelete 트리거 양쪽에서 호출될 수 있음)
 *
 *  삭제: Storage users/{uid}/ 전체(사진·다운로드 토큰), posts, generations(입력·결과 원문), users 문서
 *  보관: creditLedger(회계 기록, uid 만 포함), generationMetrics(토큰·비용, 입력 내용 없음),
 *        signupGrants(이메일 해시 — 재가입 보너스 악용 방지). 개인정보처리방침에 명시 필요.
 *  Storage 삭제 실패 시 photoDeletionJobs(prefix) 로 재시도.
 */
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { COL } = require('../lib/schema');
const jobs = require('../storage/deletionJobs');

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

async function deleteAccountData(db, bucket, uid, { nowMs = Date.now(), source = 'unknown' } = {}) {
  const recRef = db.collection(COL.ACCOUNT_DELETIONS).doc(uid);
  await recRef.set({ uid, source, status: 'running', startedAt: FieldValue.serverTimestamp() }, { merge: true });

  let storage = 'deleted';
  const prefix = `users/${uid}/`;
  try {
    await bucket.deleteFiles({ prefix, force: true });
    const [left] = await bucket.getFiles({ prefix, maxResults: 1 });
    if (left.length) throw new Error('files remain');
  } catch (e) {
    storage = 'queued';
    await jobs.enqueue(db, `user_${uid}`, { type: 'prefix', uid: null, prefix, bytesToRelease: 0, reason: 'account_deleted' }, nowMs);
  }

  const posts = await deleteQueryInBatches(db, db.collection(COL.POSTS).where('uid', '==', uid));
  const generations = await deleteQueryInBatches(db, db.collection(COL.GENERATIONS).where('uid', '==', uid));
  await db.collection(COL.USERS).doc(uid).delete();

  await recRef.set({
    status: storage === 'deleted' ? 'done' : 'storage_pending',
    storage, posts, generations,
    completedAt: FieldValue.serverTimestamp(),
    completedAtMs: Timestamp.fromMillis(nowMs),
  }, { merge: true });
  return { storage, posts, generations };
}

module.exports = { deleteAccountData };
