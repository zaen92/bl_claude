'use strict';
/**
 * 크레딧 관련 서버 전용 로직.
 * 모든 잔액 변경은 Firestore 트랜잭션 안에서 users.credits 갱신 + creditLedger 기록을 함께 수행한다.
 * 브라우저는 보안 규칙상 users.credits / creditLedger 에 쓸 수 없다.
 */
const { FieldValue } = require('firebase-admin/firestore');
const {
  COL,
  SIGNUP_BONUS_CREDITS,
  LEDGER_TYPE,
  SIGNUP_BONUS_STATUS,
} = require('./schema');
const { emailKey } = require('./email');

class CreditError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // HttpsError 코드로 그대로 매핑
  }
}

/**
 * 트랜잭션 안에서 잔액을 변경하고 원장을 기록한다. (모든 tx.get 이후에 호출할 것)
 * @returns {{balanceBefore:number, balanceAfter:number}}
 */
function writeLedgerInTx(tx, db, { uid, currentBalance, delta, type, ledgerId, refType = null, refId = null, reason = null, actor }) {
  if (!Number.isInteger(delta) || delta === 0) throw new CreditError('invalid-argument', 'delta must be a non-zero integer');
  const balanceBefore = currentBalance;
  const balanceAfter = balanceBefore + delta;
  if (balanceAfter < 0) throw new CreditError('failed-precondition', '크레딧이 부족합니다.');
  const ledgerRef = db.collection(COL.CREDIT_LEDGER).doc(ledgerId);
  // create(): 같은 ID가 이미 있으면 트랜잭션 전체가 실패 → 이중 지급/차감 방지
  tx.create(ledgerRef, {
    uid,
    type,
    delta,
    balanceBefore,
    balanceAfter,
    refType,
    refId,
    reason,
    actor,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { balanceBefore, balanceAfter };
}

/**
 * 로그인 직후 호출. 사용자 프로필을 만들거나 갱신하고, 조건을 만족하면 가입 보너스를 정확히 1번 지급한다.
 *
 * 안전성:
 *  - 중복 로그인/동시 요청: 단일 트랜잭션에서 users/{uid}.signupBonus.status 를 확인 후 갱신.
 *    원장 문서 ID가 `signup_bonus_{uid}` 로 고정되어 있어 create() 충돌 시 트랜잭션이 실패한다.
 *  - 재가입(계정 삭제 후 같은 이메일로 가입 → 새 uid): signupGrants/{sha256(정규화 이메일)} 로 차단.
 *  - 이메일 미인증 가입자에게는 지급 보류 (남의 이메일로 가입해 보너스를 소진시키는 공격 방지).
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {{uid:string,email?:string|null,emailVerified?:boolean,displayName?:string|null,photoURL?:string|null,providerIds?:string[]}} authUser
 *        서버가 Admin Auth(getUser)로 조회한 신뢰 가능한 값이어야 한다.
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

    let credits = existing ? existing.credits || 0 : 0;
    let bonus = existing && existing.signupBonus ? { ...existing.signupBonus } : { status: SIGNUP_BONUS_STATUS.PENDING_VERIFICATION, amount: 0 };
    let granted = false;

    const settled = bonus.status === SIGNUP_BONUS_STATUS.GRANTED || bonus.status === SIGNUP_BONUS_STATUS.INELIGIBLE;
    if (!settled) {
      if (!key) {
        bonus = { status: SIGNUP_BONUS_STATUS.INELIGIBLE, amount: 0, reason: 'no_email' };
      } else if (grantSnap && grantSnap.exists && grantSnap.data().uid !== uid) {
        bonus = { status: SIGNUP_BONUS_STATUS.INELIGIBLE, amount: 0, reason: 'email_already_used' };
      } else if (grantSnap && grantSnap.exists) {
        // 같은 uid로 이미 지급 기록이 있음 (정상 흐름에서는 발생하지 않음) → 재지급 금지
        bonus = { status: SIGNUP_BONUS_STATUS.GRANTED, amount: SIGNUP_BONUS_CREDITS, reason: 'reconciled' };
      } else if (!emailVerified) {
        bonus = { status: SIGNUP_BONUS_STATUS.PENDING_VERIFICATION, amount: 0 };
      } else {
        const r = writeLedgerInTx(tx, db, {
          uid,
          currentBalance: credits,
          delta: SIGNUP_BONUS_CREDITS,
          type: LEDGER_TYPE.SIGNUP_BONUS,
          ledgerId: `signup_bonus_${uid}`,
          refType: 'signup',
          refId: uid,
          reason: '회원가입 무료 크레딧',
          actor: { type: 'system', uid: null },
        });
        credits = r.balanceAfter;
        tx.create(grantRef, { uid, grantedAt: now, amount: SIGNUP_BONUS_CREDITS });
        bonus = { status: SIGNUP_BONUS_STATUS.GRANTED, amount: SIGNUP_BONUS_CREDITS, grantedAt: now };
        granted = true;
      }
    }

    if (existing) {
      const upd = { ...profile, signupBonus: bonus };
      if (granted) {
        upd.credits = credits;
        upd.creditsUpdatedAt = now;
      }
      // displayName 은 사용자가 직접 수정할 수 있으므로 비어 있을 때만 채운다
      if (!existing.displayName && authUser.displayName) upd.displayName = authUser.displayName;
      tx.update(userRef, upd);
    } else {
      tx.create(userRef, {
        ...profile,
        displayName: authUser.displayName || (email ? email.split('@')[0] : '사용자'),
        credits,
        creditsUpdatedAt: now,
        signupBonus: bonus,
        role: 'user', // 표시용. 실제 권한은 custom claim(admin)으로만 판단
        createdAt: now,
      });
    }

    return { created: !existing, granted, credits, signupBonusStatus: bonus.status, signupBonusReason: bonus.reason || null };
  });
}

/**
 * 관리자 수동 조정 (CS 보상, 오류 정정 등).
 * requestId 로 멱등성 보장 → 같은 요청이 재전송돼도 1번만 반영.
 */
async function adminAdjustCredits(db, { uid, delta, reason, requestId, actorUid }) {
  if (!uid || typeof uid !== 'string') throw new CreditError('invalid-argument', 'uid required');
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10000) throw new CreditError('invalid-argument', 'delta must be a non-zero integer (|delta| <= 10000)');
  if (!reason || typeof reason !== 'string' || reason.length > 200) throw new CreditError('invalid-argument', 'reason required (<=200 chars)');
  if (!requestId || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) throw new CreditError('invalid-argument', 'requestId must match [A-Za-z0-9_-]{8,64}');

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
      currentBalance: userSnap.data().credits || 0,
      delta,
      type: LEDGER_TYPE.ADMIN_ADJUST,
      ledgerId,
      refType: 'admin',
      refId: requestId,
      reason,
      actor: { type: 'admin', uid: actorUid },
    });
    tx.update(userRef, { credits: r.balanceAfter, creditsUpdatedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return { applied: true, duplicate: false, balanceAfter: r.balanceAfter, ledgerId };
  });
}

module.exports = { ensureUserProfile, adminAdjustCredits, writeLedgerInTx, CreditError };
