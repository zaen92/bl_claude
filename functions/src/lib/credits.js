'use strict';
/**
 * 크레딧 관련 서버 전용 로직.
 * 모든 잔액 변경은 Firestore 트랜잭션 안에서 users 잔액 갱신 + creditLedger 기록을 함께 수행한다.
 * 브라우저는 보안 규칙상 users.credits / creditLedger 에 쓸 수 없다.
 *
 * 잔액 필드 (항상 credits == freeCredits + paidCredits == creditLedger.delta 합계)
 *   credits      총 잔액
 *   freeCredits  무료(가입 보너스, 관리자 보상) — 먼저 사용
 *   paidCredits  유료 구매분 (STEP 3)
 */
const { FieldValue } = require('firebase-admin/firestore');
const {
  COL,
  BUCKET,
  SIGNUP_BONUS_CREDITS,
  LEDGER_TYPE,
  SIGNUP_BONUS_STATUS,
} = require('./schema');
const { emailKey } = require('./email');

class CreditError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code; // HttpsError 코드로 그대로 매핑
    this.details = details;
  }
}

/**
 * 사용자 문서에서 버킷 잔액을 읽는다.
 * STEP 1 에서 만들어진 문서는 freeCredits/paidCredits 가 없으므로 전액 무료로 간주 (STEP 1 에는 구매가 없었음).
 */
function bucketsOf(userData) {
  const credits = (userData && userData.credits) || 0;
  if (userData && Number.isInteger(userData.freeCredits) && Number.isInteger(userData.paidCredits)) {
    return { free: userData.freeCredits, paid: userData.paidCredits, credits };
  }
  return { free: credits, paid: 0, credits };
}

/**
 * 잔액 변경 계획. delta<0 이면 무료 → 유료 순으로 차감, delta>0 이면 지정 버킷에 적립.
 * @returns {{free:number, paid:number, credits:number, bucketDelta:{free:number,paid:number}}}
 */
function planChange(buckets, delta, bucket) {
  let { free, paid } = buckets;
  const bucketDelta = { free: 0, paid: 0 };
  if (delta > 0) {
    if (bucket === BUCKET.PAID) paid += delta; else free += delta;
    bucketDelta[bucket === BUCKET.PAID ? 'paid' : 'free'] = delta;
  } else {
    let need = -delta;
    if (bucket === BUCKET.PAID || bucket === BUCKET.FREE) {
      // 특정 버킷에서만 차감 (관리자 회수, 결제 취소 등)
      const have = bucket === BUCKET.PAID ? paid : free;
      if (have < need) throw new CreditError('failed-precondition', '크레딧이 부족합니다.', { reason: 'insufficient_credits' });
      if (bucket === BUCKET.PAID) paid -= need; else free -= need;
      bucketDelta[bucket] = delta;
    } else {
      const fromFree = Math.min(free, need);
      free -= fromFree; need -= fromFree;
      const fromPaid = Math.min(paid, need);
      paid -= fromPaid; need -= fromPaid;
      if (need > 0) throw new CreditError('failed-precondition', '크레딧이 부족합니다.', { reason: 'insufficient_credits' });
      bucketDelta.free = fromFree ? -fromFree : 0;
      bucketDelta.paid = fromPaid ? -fromPaid : 0;
    }
  }
  return { free, paid, credits: free + paid, bucketDelta };
}

/**
 * 트랜잭션 안에서 원장을 기록하고, users 문서에 써야 할 잔액 필드를 돌려준다. (모든 tx.get 이후에 호출)
 * @param {object} p
 * @param {{free:number,paid:number,credits:number}} p.buckets 현재 잔액
 * @param {'free'|'paid'|undefined} p.bucket 적립 버킷 / 차감 시 지정 버킷(없으면 무료 우선)
 * @returns {{userFields:object, balanceAfter:number, bucketDelta:object}}
 */
function writeLedgerInTx(tx, db, { uid, buckets, delta, bucket, type, ledgerId, refType = null, refId = null, reason = null, actor }) {
  if (!Number.isInteger(delta) || delta === 0) throw new CreditError('invalid-argument', 'delta must be a non-zero integer');
  const plan = planChange(buckets, delta, bucket);
  const ledgerRef = db.collection(COL.CREDIT_LEDGER).doc(ledgerId);
  // create(): 같은 ID가 이미 있으면 트랜잭션 전체가 실패 → 이중 지급/차감 방지
  tx.create(ledgerRef, {
    uid,
    type,
    delta,
    bucketDelta: plan.bucketDelta,
    balanceBefore: buckets.credits,
    balanceAfter: plan.credits,
    refType,
    refId,
    reason,
    actor,
    createdAt: FieldValue.serverTimestamp(),
  });
  return {
    balanceAfter: plan.credits,
    bucketDelta: plan.bucketDelta,
    userFields: {
      credits: plan.credits,
      freeCredits: plan.free,
      paidCredits: plan.paid,
      creditsUpdatedAt: FieldValue.serverTimestamp(),
    },
  };
}

/**
 * 로그인 직후 호출. 사용자 프로필을 만들거나 갱신하고, 조건을 만족하면 가입 보너스를 정확히 1번 지급한다.
 *
 * 안전성:
 *  - 중복 로그인/동시 요청: 단일 트랜잭션에서 users/{uid}.signupBonus.status 를 확인 후 갱신.
 *    원장 문서 ID가 `signup_bonus_{uid}` 로 고정되어 있어 create() 충돌 시 트랜잭션이 실패한다.
 *  - 재가입(계정 삭제 후 같은 이메일로 가입 → 새 uid): signupGrants/{sha256(정규화 이메일)} 로 차단.
 *  - 이메일 미인증 가입자에게는 지급 보류 (남의 이메일로 가입해 보너스를 소진시키는 공격 방지).
 */
async function ensureUserProfile(db, authUser) {
  const { uid } = authUser;
  if (!uid) throw new CreditError('invalid-argument', 'uid required');
  const email = authUser.email || null;
  const emailVerified = !!authUser.emailVerified;
  const key = emailKey(email);
  const userRef = db.collection(COL.USERS).doc(uid);
  const grantRef = key ? db.collection(COL.SIGNUP_GRANTS).doc(key) : null;

  return db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    const grantSnap = grantRef ? await tx.get(grantRef) : null;
    const now = FieldValue.serverTimestamp();
    const existing = userSnap.exists ? userSnap.data() : null;

    const profile = {
      uid,
      email,
      emailVerified,
      photoURL: authUser.photoURL || null,
      providerIds: Array.isArray(authUser.providerIds) ? authUser.providerIds : [],
      lastLoginAt: now,
      updatedAt: now,
    };

    let buckets = bucketsOf(existing);
    let balanceFields = null;
    let bonus = existing && existing.signupBonus ? { ...existing.signupBonus } : { status: SIGNUP_BONUS_STATUS.PENDING_VERIFICATION, amount: 0 };
    let granted = false;

    const settled = bonus.status === SIGNUP_BONUS_STATUS.GRANTED || bonus.status === SIGNUP_BONUS_STATUS.INELIGIBLE;
    if (!settled) {
      if (!key) {
        bonus = { status: SIGNUP_BONUS_STATUS.INELIGIBLE, amount: 0, reason: 'no_email' };
      } else if (grantSnap && grantSnap.exists && grantSnap.data().uid !== uid) {
        bonus = { status: SIGNUP_BONUS_STATUS.INELIGIBLE, amount: 0, reason: 'email_already_used' };
      } else if (grantSnap && grantSnap.exists) {
        bonus = { status: SIGNUP_BONUS_STATUS.GRANTED, amount: SIGNUP_BONUS_CREDITS, reason: 'reconciled' };
      } else if (!emailVerified) {
        bonus = { status: SIGNUP_BONUS_STATUS.PENDING_VERIFICATION, amount: 0 };
      } else {
        const r = writeLedgerInTx(tx, db, {
          uid,
          buckets,
          delta: SIGNUP_BONUS_CREDITS,
          bucket: BUCKET.FREE,
          type: LEDGER_TYPE.SIGNUP_BONUS,
          ledgerId: `signup_bonus_${uid}`,
          refType: 'signup',
          refId: uid,
          reason: '회원가입 무료 크레딧',
          actor: { type: 'system', uid: null },
        });
        balanceFields = r.userFields;
        buckets = { free: r.userFields.freeCredits, paid: r.userFields.paidCredits, credits: r.balanceAfter };
        tx.create(grantRef, { uid, grantedAt: now, amount: SIGNUP_BONUS_CREDITS });
        bonus = { status: SIGNUP_BONUS_STATUS.GRANTED, amount: SIGNUP_BONUS_CREDITS, grantedAt: now };
        granted = true;
      }
    }

    if (existing) {
      const upd = { ...profile, signupBonus: bonus, ...(balanceFields || {}) };
      // STEP 1 문서 보정: 버킷 필드가 없으면 채운다 (잔액 자체는 변하지 않음)
      if (!balanceFields && !(Number.isInteger(existing.freeCredits) && Number.isInteger(existing.paidCredits))) {
        upd.freeCredits = buckets.free;
        upd.paidCredits = buckets.paid;
      }
      if (!existing.displayName && authUser.displayName) upd.displayName = authUser.displayName;
      tx.update(userRef, upd);
    } else {
      tx.create(userRef, {
        ...profile,
        displayName: authUser.displayName || (email ? email.split('@')[0] : '사용자'),
        credits: buckets.credits,
        freeCredits: buckets.free,
        paidCredits: buckets.paid,
        creditsUpdatedAt: now,
        signupBonus: bonus,
        role: 'user', // 표시용. 실제 권한은 custom claim(admin)으로만 판단
        activeGenerations: 0,
        storageBytes: 0,
        createdAt: now,
      });
    }

    return { created: !existing, granted, credits: buckets.credits, signupBonusStatus: bonus.status, signupBonusReason: bonus.reason || null };
  });
}

/**
 * 관리자 수동 조정 (CS 보상, 오류 정정 등).
 * requestId 로 멱등성 보장 → 같은 요청이 재전송돼도 1번만 반영.
 * 적립은 기본 무료 버킷, 회수는 bucket 미지정 시 무료→유료 순.
 */
async function adminAdjustCredits(db, { uid, delta, reason, requestId, actorUid, bucket }) {
  if (!uid || typeof uid !== 'string') throw new CreditError('invalid-argument', 'uid required');
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10000) throw new CreditError('invalid-argument', 'delta must be a non-zero integer (|delta| <= 10000)');
  if (!reason || typeof reason !== 'string' || reason.length > 200) throw new CreditError('invalid-argument', 'reason required (<=200 chars)');
  if (!requestId || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) throw new CreditError('invalid-argument', 'requestId must match [A-Za-z0-9_-]{8,64}');
  if (bucket != null && bucket !== BUCKET.FREE && bucket !== BUCKET.PAID) throw new CreditError('invalid-argument', "bucket must be 'free' or 'paid'");

  const userRef = db.collection(COL.USERS).doc(uid);
  const ledgerId = `admin_${requestId}`;
  const ledgerRef = db.collection(COL.CREDIT_LEDGER).doc(ledgerId);

  return db.runTransaction(async (tx) => {
    const [userSnap, ledgerSnap] = await Promise.all([tx.get(userRef), tx.get(ledgerRef)]);
    if (ledgerSnap.exists) {
      const l = ledgerSnap.data();
      return { applied: false, duplicate: true, balanceAfter: l.balanceAfter, ledgerId };
    }
    if (!userSnap.exists) throw new CreditError('not-found', '사용자를 찾을 수 없습니다.');
    const r = writeLedgerInTx(tx, db, {
      uid,
      buckets: bucketsOf(userSnap.data()),
      delta,
      bucket: bucket || (delta > 0 ? BUCKET.FREE : undefined),
      type: LEDGER_TYPE.ADMIN_ADJUST,
      ledgerId,
      refType: 'admin',
      refId: requestId,
      reason,
      actor: { type: 'admin', uid: actorUid },
    });
    tx.update(userRef, { ...r.userFields, updatedAt: FieldValue.serverTimestamp() });
    return { applied: true, duplicate: false, balanceAfter: r.balanceAfter, ledgerId };
  });
}

module.exports = { ensureUserProfile, adminAdjustCredits, writeLedgerInTx, bucketsOf, planChange, CreditError };
