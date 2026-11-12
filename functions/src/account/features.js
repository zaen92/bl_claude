'use strict';
/**
 * FREE / PRO 기능 사용량 (서버 전용, 모두 Firestore 트랜잭션)
 *
 *   savePost / deletePost   계정 저장 글 — FREE 최대 freeSavedPostLimit(기본 5)개, 수정 저장은 개수 증가 없음
 *   authorizeExport         앱 내 공식 JSON 내보내기 승인 — FREE 누적 freeExportLimit(기본 5)회, 재전송은 1회로
 *   saveStyle / deleteStyle 개인화 작성 스타일 — FREE freeStyleLimit(기본 1)개
 *   resolveStyle            AI 생성에 쓸 스타일 (본인 스타일만)
 *   adminSetPlan            관리자 테스트용 등급 변경 (실제 결제와 무관, planSource='admin_test')
 *
 * 사용자 문서의 카운터(savedPostCount, exportCount, styleCount)와 plan 은 보안 규칙상 클라이언트가 바꿀 수 없다.
 * 카운터가 없는 예전 문서는 첫 사용 시 실제 문서 수로 계산한다.
 * 한도 판단은 사용자 문서를 읽는 트랜잭션 안에서 하므로 여러 기기 동시 요청에도 초과되지 않는다.
 */
const { FieldValue } = require('firebase-admin/firestore');
const { COL } = require('../lib/schema');
const { CreditError } = require('../lib/credits');
const { getPolicy, planOf, limitsFor, PLAN } = require('../config/policy');
const { PRESETS, validateStyleInput, snapshotOf, cleanText } = require('../ai/styles');

const TYPES = ['맛집', '카페', '여행', '숙소', '캠핑', '미용', '쇼핑', '투어', '전시'];
const VOLUMES = ['short', 'normal', 'long'];
const RESULT_FIELDS = { title_1: 300, title_2: 300, title_3: 300, keyword_main: 300, keyword_sub: 300, keyword_location: 300, keyword_intent: 300,
  place_name: 300, place_address: 500, place_hours: 500, place_price: 500, body: 20000, reel: 5000, thumbnail: 1000 };
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** 생성 결과(텍스트) 정리 — 사진·Base64·HTML 태그 제거 */
function cleanResult(r) {
  if (!r || typeof r !== 'object') throw new CreditError('invalid-argument', '저장할 글이 없어요.');
  const out = {};
  for (const [k, max] of Object.entries(RESULT_FIELDS)) out[k] = cleanText(r[k], max);
  out.hashtags = Array.isArray(r.hashtags) ? r.hashtags.filter((t) => typeof t === 'string').map((t) => cleanText(t, 100)).filter(Boolean).slice(0, 30) : [];
  if (!out.body && !out.title_1) throw new CreditError('invalid-argument', '저장할 본문이 없어요.');
  return out;
}

/** 입력값(텍스트만) 정리 */
function cleanInput(i) {
  const x = i && typeof i === 'object' ? i : {};
  const n = Number(x.imageCount);
  return {
    title: cleanText(x.title, 200), memo: cleanText(x.memo, 2000), content: cleanText(x.content, 5000), info: cleanText(x.info, 2000),
    type: TYPES.includes(x.type) ? x.type : '',
    volume: VOLUMES.includes(x.volume) ? x.volume : 'normal',
    imageCount: Number.isInteger(n) && n >= 0 && n <= 10 ? n : 0,
  };
}

async function countOf(tx, db, col, uid) {
  return (await tx.get(db.collection(col).where('uid', '==', uid))).size;
}

function limitError(reason, message, extra) {
  return new CreditError('resource-exhausted', message, { reason, ...extra });
}

// ── 저장 글 ───────────────────────────────────────────
/**
 * @param {{postId?:string, generationId?:string, clientSaveId?:string, legacyId?:number|string, legacySavedAt?:string,
 *          title?:string, data:object, input?:object, style?:object}} req
 */
async function savePost(db, uid, req) {
  if (!req || typeof req !== 'object') throw new CreditError('invalid-argument', '요청 형식이 올바르지 않아요.');
  let postId;
  let mustExist = false;
  if (req.postId != null) {
    if (typeof req.postId !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(req.postId)) throw new CreditError('invalid-argument', '글 ID가 올바르지 않아요.');
    postId = req.postId; mustExist = true;
  } else if (req.generationId != null) {
    if (typeof req.generationId !== 'string' || !req.generationId.startsWith(uid + '_') || req.generationId.length > 200) throw new CreditError('invalid-argument', '생성 기록 ID가 올바르지 않아요.');
    postId = req.generationId; // 같은 생성 결과를 다시 저장하면 수정으로 처리 (개수 증가 없음)
  } else if (req.legacyId != null) {
    postId = `legacy_${uid}_${String(req.legacyId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}`;
  } else if (typeof req.clientSaveId === 'string' && ID_RE.test(req.clientSaveId)) {
    postId = `${uid}_save_${req.clientSaveId}`; // 재전송해도 같은 문서
  } else {
    throw new CreditError('invalid-argument', 'clientSaveId 가 필요해요.');
  }
  const data = cleanResult(req.data);
  const input = cleanInput(req.input);
  const style = req.style ? snapshotOf(req.style) : null;
  const title = cleanText(req.title || data.title_1 || input.title || '제목 없음', 300) || '제목 없음';
  const type = TYPES.includes(req.type) ? req.type : input.type;

  const userRef = db.collection(COL.USERS).doc(uid);
  const postRef = db.collection(COL.POSTS).doc(postId);
  return db.runTransaction(async (tx) => {
    const [userSnap, postSnap] = await Promise.all([tx.get(userRef), tx.get(postRef)]);
    if (!userSnap.exists) throw new CreditError('failed-precondition', '프로필이 아직 준비되지 않았어요.', { reason: 'profile_missing' });
    const u = userSnap.data();
    const policy = await getPolicy(db, tx);
    const plan = planOf(u);
    const lim = limitsFor(plan, policy);
    const count = Number.isInteger(u.savedPostCount) ? u.savedPostCount : await countOf(tx, db, COL.POSTS, uid);
    const fields = { uid, title, type, data, input, style, updatedAt: FieldValue.serverTimestamp() };

    if (postSnap.exists) {
      if (postSnap.data().uid !== uid) throw new CreditError('not-found', '글을 찾을 수 없어요.');
      // 수정 저장: 개수 변화 없음. 요청에 없는 항목(입력값·스타일·유형·제목)은 기존 값 유지
      const upd = { data, updatedAt: fields.updatedAt };
      if (req.input) upd.input = input;
      if (req.style) upd.style = style;
      if (req.type || req.input) upd.type = type;
      if (req.title || data.title_1) upd.title = title;
      tx.update(postRef, upd);
      if (!Number.isInteger(u.savedPostCount)) tx.update(userRef, { savedPostCount: count });
      return { postId, created: false, savedPostCount: count, limit: plan === PLAN.FREE ? lim.savedPosts : null, plan };
    }
    if (mustExist) throw new CreditError('not-found', '글을 찾을 수 없어요.');
    if (count >= lim.savedPosts) {
      throw limitError('saved_post_limit', plan === PLAN.FREE
        ? `무료 회원은 글을 최대 ${lim.savedPosts}개까지 저장할 수 있어요. 기존 글을 삭제하거나 PRO 로 이용해주세요.`
        : '저장할 수 있는 글이 너무 많아요. 오래된 글을 정리해주세요.', { plan, limit: lim.savedPosts, count });
    }
    tx.create(postRef, {
      ...fields,
      generationId: req.generationId || null,
      ...(req.legacyId != null ? { legacyId: req.legacyId, legacySavedAt: cleanText(req.legacySavedAt, 50) } : {}),
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(userRef, { savedPostCount: count + 1 });
    return { postId, created: true, savedPostCount: count + 1, limit: plan === PLAN.FREE ? lim.savedPosts : null, plan };
  });
}

async function deletePost(db, uid, postId) {
  if (typeof postId !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(postId)) throw new CreditError('invalid-argument', '글 ID가 올바르지 않아요.');
  const userRef = db.collection(COL.USERS).doc(uid);
  const postRef = db.collection(COL.POSTS).doc(postId);
  return db.runTransaction(async (tx) => {
    const [userSnap, postSnap] = await Promise.all([tx.get(userRef), tx.get(postRef)]);
    if (!postSnap.exists || postSnap.data().uid !== uid) return { deleted: false };
    const u = userSnap.data() || {};
    const count = Number.isInteger(u.savedPostCount) ? u.savedPostCount : await countOf(tx, db, COL.POSTS, uid);
    tx.delete(postRef);
    if (userSnap.exists) tx.update(userRef, { savedPostCount: Math.max(0, count - 1) });
    return { deleted: true, savedPostCount: Math.max(0, count - 1) };
  });
}

// ── JSON 내보내기 승인 ─────────────────────────────────
async function authorizeExport(db, uid, { requestId } = {}) {
  if (typeof requestId !== 'string' || !ID_RE.test(requestId)) throw new CreditError('invalid-argument', 'requestId 가 필요해요.');
  const userRef = db.collection(COL.USERS).doc(uid);
  const grantRef = db.collection(COL.EXPORT_GRANTS).doc(`${uid}_${requestId}`);
  return db.runTransaction(async (tx) => {
    const [userSnap, grantSnap] = await Promise.all([tx.get(userRef), tx.get(grantRef)]);
    if (!userSnap.exists) throw new CreditError('failed-precondition', '프로필이 아직 준비되지 않았어요.', { reason: 'profile_missing' });
    const u = userSnap.data();
    const policy = await getPolicy(db, tx);
    const plan = planOf(u);
    const limit = limitsFor(plan, policy).exports;
    const count = Number.isInteger(u.exportCount) ? u.exportCount : 0;
    const view = (c) => ({ allowed: true, plan, exportCount: c, limit, remaining: limit == null ? null : Math.max(0, limit - c) });
    if (grantSnap.exists) return { ...view(count), duplicate: true }; // 같은 승인 요청 재전송 → 추가 집계 없음
    if (limit != null && count >= limit) {
      throw limitError('export_limit', `무료 회원의 JSON 내보내기 ${limit}회를 모두 사용했어요. PRO 는 횟수 제한이 없어요.`, { plan, limit, count });
    }
    tx.create(grantRef, { uid, plan, createdAt: FieldValue.serverTimestamp() });
    tx.update(userRef, { exportCount: count + 1 });
    return { ...view(count + 1), duplicate: false };
  });
}

// ── 개인화 스타일 ──────────────────────────────────────
async function saveStyle(db, uid, req) {
  let fields;
  try { fields = validateStyleInput(req); } catch (e) { throw new CreditError('invalid-argument', e.message); }
  const userRef = db.collection(COL.USERS).doc(uid);
  const styleRef = req.styleId ? db.collection(COL.STYLES).doc(String(req.styleId).slice(0, 100)) : db.collection(COL.STYLES).doc();
  return db.runTransaction(async (tx) => {
    const [userSnap, styleSnap] = await Promise.all([tx.get(userRef), tx.get(styleRef)]);
    if (!userSnap.exists) throw new CreditError('failed-precondition', '프로필이 아직 준비되지 않았어요.', { reason: 'profile_missing' });
    const u = userSnap.data();
    const policy = await getPolicy(db, tx);
    const plan = planOf(u);
    const lim = limitsFor(plan, policy);
    const count = Number.isInteger(u.styleCount) ? u.styleCount : await countOf(tx, db, COL.STYLES, uid);
    if (req.styleId) {
      if (!styleSnap.exists || styleSnap.data().uid !== uid) throw new CreditError('not-found', '스타일을 찾을 수 없어요.');
      tx.update(styleRef, { ...fields, updatedAt: FieldValue.serverTimestamp() }); // 수정은 개수 변화 없음
      return { styleId: styleRef.id, created: false, styleCount: count, limit: lim.styles, plan };
    }
    if (count >= lim.styles) {
      throw limitError('style_limit', plan === PLAN.FREE
        ? `무료 회원은 개인화 스타일을 ${lim.styles}개까지 저장할 수 있어요. 기존 스타일을 수정하거나 PRO 로 이용해주세요.`
        : '저장할 수 있는 스타일 개수를 넘었어요.', { plan, limit: lim.styles, count });
    }
    tx.create(styleRef, { uid, ...fields, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.update(userRef, { styleCount: count + 1 });
    return { styleId: styleRef.id, created: true, styleCount: count + 1, limit: lim.styles, plan };
  });
}

async function deleteStyle(db, uid, styleId) {
  if (typeof styleId !== 'string' || !styleId || styleId.length > 100) throw new CreditError('invalid-argument', '스타일 ID가 올바르지 않아요.');
  const userRef = db.collection(COL.USERS).doc(uid);
  const styleRef = db.collection(COL.STYLES).doc(styleId);
  return db.runTransaction(async (tx) => {
    const [userSnap, styleSnap] = await Promise.all([tx.get(userRef), tx.get(styleRef)]);
    if (!styleSnap.exists || styleSnap.data().uid !== uid) return { deleted: false };
    const u = userSnap.data() || {};
    const count = Number.isInteger(u.styleCount) ? u.styleCount : await countOf(tx, db, COL.STYLES, uid);
    tx.delete(styleRef);
    if (userSnap.exists) tx.update(userRef, { styleCount: Math.max(0, count - 1) });
    return { deleted: true, styleCount: Math.max(0, count - 1) };
  });
}

/**
 * 생성 요청의 스타일 지정 → 스냅샷. { preset:'jaeinit'|'basic' } 또는 { styleId } (본인 스타일만)
 * 지정이 없으면 기본 스타일(특정 블로그 이름·인사말을 강제하지 않음).
 */
async function resolveStyle(db, uid, ref) {
  if (!ref || typeof ref !== 'object') return snapshotOf(PRESETS.basic);
  if (ref.styleId) {
    const s = await db.collection(COL.STYLES).doc(String(ref.styleId).slice(0, 100)).get();
    if (!s.exists || s.data().uid !== uid) throw new CreditError('not-found', '선택한 작성 스타일을 찾을 수 없어요.', { reason: 'style_not_found' });
    return { ...snapshotOf({ ...s.data(), preset: 'custom' }), styleId: s.id };
  }
  if (ref.preset === 'jaeinit') return snapshotOf(PRESETS.jaeinit);
  return snapshotOf(PRESETS.basic);
}

// ── 관리자 테스트용 등급 변경 (결제 아님) ───────────────────
async function adminSetPlan(db, { uid, plan, reason, actorUid }) {
  if (![PLAN.FREE, PLAN.PRO].includes(plan)) throw new CreditError('invalid-argument', "plan 은 'free' 또는 'pro'");
  if (!reason || typeof reason !== 'string' || reason.length > 200) throw new CreditError('invalid-argument', 'reason 필요');
  const ref = db.collection(COL.USERS).doc(uid);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new CreditError('not-found', '사용자를 찾을 수 없어요.');
    const u = s.data();
    tx.update(ref, {
      plan,
      planSource: 'admin_test', // STEP 3 의 결제 기반 전환('payment')과 구분
      planReason: reason,
      planChangedBy: actorUid,
      upgradedAt: plan === PLAN.PRO ? (u.upgradedAt || FieldValue.serverTimestamp()) : u.upgradedAt || null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { uid, plan };
  });
}

module.exports = { savePost, deletePost, authorizeExport, saveStyle, deleteStyle, resolveStyle, adminSetPlan, cleanResult, cleanInput };
