'use strict';
/**
 * 사진 보관 정책
 *  - 저장하지 않은 생성 결과의 사진: 생성 후 90일이 지나면 삭제
 *  - 저장 글(posts.generationId 로 연결)이 남아 있는 동안은 유지 → 7일마다 다시 확인
 *    (글을 삭제하면 다음 확인 때 삭제 대상이 됨)
 * 실제 삭제는 photoDeletionJobs 가 수행 (실패 시 재시도, 관리자 확인 가능).
 */
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { COL, PHOTO_STATE, PHOTO_RECHECK_DAYS } = require('../lib/schema');
const jobs = require('./deletionJobs');

const DAY = 24 * 3600 * 1000;

/** 생성 1건 검사: 저장 글 참조가 있으면 연장, 없으면 삭제 작업 등록. 반환: 'kept' | 'queued' | 'skipped' */
async function checkGeneration(db, generationId, nowMs) {
  const genRef = db.collection(COL.GENERATIONS).doc(generationId);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(genRef);
    if (!s.exists) return 'skipped';
    const g = s.data();
    if (g.photosState !== PHOTO_STATE.STORED || !g.photosExpireAt || g.photosExpireAt.toMillis() > nowMs) return 'skipped';
    // 같은 트랜잭션에서 참조 확인 → 확인 직후 생긴 글과의 경합을 최소화
    const refs = await tx.get(db.collection(COL.POSTS).where('uid', '==', g.uid).where('generationId', '==', generationId).limit(1));
    if (!refs.empty) {
      tx.update(genRef, { photosExpireAt: Timestamp.fromMillis(nowMs + PHOTO_RECHECK_DAYS * DAY), photosKeptBy: 'post', photosCheckedAt: FieldValue.serverTimestamp() });
      return 'kept';
    }
    const photos = g.photos || [];
    tx.update(genRef, { photosState: PHOTO_STATE.DELETING, photosCheckedAt: FieldValue.serverTimestamp() });
    jobs.enqueueInTx(tx, db, `gen_${generationId}`, {
      type: 'generation',
      uid: g.uid,
      generationId,
      paths: photos.map((p) => p.path),
      bytesToRelease: photos.reduce((n, p) => n + (p.bytes || 0), 0),
      reason: 'retention_expired',
    }, nowMs);
    return 'queued';
  });
}

async function scanExpired(db, nowMs, limit = 200) {
  const snap = await db.collection(COL.GENERATIONS)
    .where('photosState', '==', PHOTO_STATE.STORED)
    .where('photosExpireAt', '<=', Timestamp.fromMillis(nowMs))
    .limit(limit).get();
  const out = { kept: 0, queued: 0, skipped: 0 };
  for (const d of snap.docs) out[await checkGeneration(db, d.id, nowMs)]++;
  return out;
}

module.exports = { scanExpired, checkGeneration };
