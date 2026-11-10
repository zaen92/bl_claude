'use strict';
/**
 * 사진 삭제 작업 큐 (photoDeletionJobs) — 서버 전용, 관리자만 읽기.
 *
 *   type 'generation' : 보관 기간이 지난 생성 사진 삭제 → generations.photos 비우고 users.storageBytes 반환
 *   type 'paths'      : 지정 경로 삭제 (생성 실패 시 즉시 삭제가 실패한 경우 등, 용량은 이미 반환됨)
 *   type 'prefix'     : users/{uid}/ 전체 삭제 (회원 탈퇴)
 *
 * 상태: pending → running(10분 lease) → done | (실패) pending(지수 백오프) → 5회 실패 시 failed (관리자 확인)
 * 파일 삭제 시 객체 메타데이터(다운로드 토큰 포함)도 함께 사라진다.
 */
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { COL, PHOTO_STATE } = require('../lib/schema');

const MAX_ATTEMPTS = 5;
const LEASE_MS = 10 * 60 * 1000;
const backoffMs = (attempts) => Math.min(6 * 3600 * 1000, 60 * 1000 * 2 ** attempts); // 2,4,8,16분 … 최대 6시간

function jobRef(db, id) { return db.collection(COL.PHOTO_DELETION_JOBS).doc(id); }

/** 트랜잭션 밖에서 작업 등록 (같은 id 면 덮어쓰지 않음) */
async function enqueue(db, id, job, nowMs) {
  try {
    await jobRef(db, id).create({
      ...job,
      status: 'pending',
      attempts: 0,
      lastError: null,
      nextAttemptAt: Timestamp.fromMillis(nowMs),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  } catch (e) {
    if (e.code === 6 /* ALREADY_EXISTS */) return false;
    throw e;
  }
}

/** 트랜잭션 안에서 작업 등록 */
function enqueueInTx(tx, db, id, job, nowMs) {
  tx.set(jobRef(db, id), {
    ...job,
    status: 'pending',
    attempts: 0,
    lastError: null,
    nextAttemptAt: Timestamp.fromMillis(nowMs),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function deleteFiles(bucket, job) {
  if (job.type === 'prefix') {
    await bucket.deleteFiles({ prefix: job.prefix, force: true });
    const [left] = await bucket.getFiles({ prefix: job.prefix, maxResults: 1 });
    if (left.length) throw new Error('files remain after prefix delete');
    return;
  }
  for (const path of job.paths || []) {
    await bucket.file(path).delete({ ignoreNotFound: true });
  }
}

/** 작업 1건 처리 (claim → 삭제 → 결과 반영). 반환: 'done' | 'retry' | 'failed' | 'skipped' */
async function runJob(db, bucket, id, nowMs) {
  const ref = jobRef(db, id);
  // claim: 동시에 여러 워커가 같은 작업을 잡지 않도록
  const job = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return null;
    const j = s.data();
    if (!['pending', 'running'].includes(j.status) || j.nextAttemptAt.toMillis() > nowMs) return null;
    tx.update(ref, { status: 'running', nextAttemptAt: Timestamp.fromMillis(nowMs + LEASE_MS), updatedAt: FieldValue.serverTimestamp() });
    return j;
  });
  if (!job) return 'skipped';

  try {
    await deleteFiles(bucket, job);
  } catch (err) {
    const attempts = (job.attempts || 0) + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    await ref.update({
      status: failed ? 'failed' : 'pending',
      attempts,
      lastError: { code: (err && (err.code || err.name)) || 'error', message: String((err && err.message) || err).slice(0, 200) },
      nextAttemptAt: Timestamp.fromMillis(nowMs + backoffMs(attempts)),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return failed ? 'failed' : 'retry';
  }

  await db.runTransaction(async (tx) => {
    const genRef = job.generationId ? db.collection(COL.GENERATIONS).doc(job.generationId) : null;
    const userRef = job.uid ? db.collection(COL.USERS).doc(job.uid) : null;
    const genSnap = genRef ? await tx.get(genRef) : null;
    const userSnap = userRef && job.bytesToRelease ? await tx.get(userRef) : null;
    if (job.type === 'generation' && genSnap && genSnap.exists) {
      tx.update(genRef, { photos: [], photosState: PHOTO_STATE.DELETED, photosDeletedAt: FieldValue.serverTimestamp(), photosExpireAt: null });
    }
    if (userSnap && userSnap.exists) {
      tx.update(userRef, { storageBytes: Math.max(0, (userSnap.data().storageBytes || 0) - job.bytesToRelease) });
    }
    tx.update(ref, { status: 'done', doneAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  });
  return 'done';
}

/** 처리할 작업 실행 (스케줄러) */
async function processJobs(db, bucket, nowMs, limit = 50) {
  const snap = await db.collection(COL.PHOTO_DELETION_JOBS)
    .where('status', 'in', ['pending', 'running'])
    .where('nextAttemptAt', '<=', Timestamp.fromMillis(nowMs))
    .limit(limit).get();
  const out = { done: 0, retry: 0, failed: 0, skipped: 0 };
  for (const d of snap.docs) out[await runJob(db, bucket, d.id, nowMs)]++;
  return out;
}

/** 관리자: 실패 작업 재시도 */
async function resetJob(db, id, nowMs) {
  const ref = jobRef(db, id);
  const s = await ref.get();
  if (!s.exists) return false;
  await ref.update({ status: 'pending', attempts: 0, nextAttemptAt: Timestamp.fromMillis(nowMs), updatedAt: FieldValue.serverTimestamp() });
  return true;
}

module.exports = { enqueue, enqueueInTx, runJob, processJobs, resetJob, MAX_ATTEMPTS, backoffMs };
