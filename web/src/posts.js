// 저장된 글 (Firestore posts) + 기존 localStorage 저장 글 이전
// 저장·수정·삭제는 서버 callable(savePost/deletePost)만 — FREE 저장 개수 제한은 서버 트랜잭션에서 적용된다.
// 클라이언트는 본인 글을 읽기만 한다 (firestore.rules).
import { collection, query, where, orderBy, limit as qLimit, onSnapshot } from 'firebase/firestore';
import { db } from './firebase.js';
import { savePostCall, deletePostCall } from './features.js';

const LEGACY_KEY = 'jaeinit_saved_posts';
export const PAGE_SIZE = 30;

/** 최근 글부터 n개 구독 ("더 보기" 시 n 을 늘려 다시 구독) */
export const subscribePosts = (uid, cb, n = PAGE_SIZE) =>
  onSnapshot(
    query(collection(db, 'posts'), where('uid', '==', uid), orderBy('createdAt', 'desc'), qLimit(n)),
    (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() })), s.docs.length >= n),
    (e) => { console.warn('posts', e); cb([], false); },
  );

/** 입력값 중 텍스트만 전송 (사진·Base64 는 보내지 않음 — 서버도 한 번 더 걸러냄) */
function textInput(i) {
  if (!i) return null;
  const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const n = Number(i.imageCount);
  return {
    title: s(i.title, 200), memo: s(i.memo, 2000), content: s(i.content, 5000), info: s(i.info, 2000),
    type: s(i.type, 20), volume: ['short', 'normal', 'long'].includes(i.volume) ? i.volume : 'normal',
    imageCount: Number.isInteger(n) && n >= 0 && n <= 10 ? n : 0,
  };
}

const rid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
export const newClientSaveId = () => `save_${rid()}`;

/**
 * 새 글 저장 또는 기존 글 수정.
 * - postId 가 있으면 수정 (저장 개수 증가 없음)
 * - generationId 가 있으면 같은 생성 결과는 한 문서로 (재전송·중복 클릭에도 1개)
 * - 둘 다 없으면 clientSaveId (호출부가 재시도 시 같은 값을 재사용)
 */
export function savePost({ postId = null, title, type, data, generationId = null, input = null, style = null, clientSaveId = null }) {
  const req = { title: (title || '제목 없음').slice(0, 300), type: type || '', data };
  const ti = textInput(input);
  if (ti) req.input = ti;
  if (style) req.style = style;
  if (postId) req.postId = postId;
  else if (generationId) req.generationId = generationId;
  else req.clientSaveId = clientSaveId || newClientSaveId();
  return savePostCall(req);
}

export const removePost = (postId) => deletePostCall({ postId });

/** 전체 삭제 — 서버에서 한 개씩 삭제(카운터 정확히 감소) */
export async function removeAllPosts(posts) {
  for (const p of posts) await deletePostCall({ postId: p.id });
}

/** 기존 v3 가 localStorage 에 저장한 글 (삭제하지 않고 백업으로 유지) */
export function getLegacyPosts() {
  try {
    const arr = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter((p) => p && p.data) : [];
  } catch (e) { return []; }
}

/**
 * localStorage 글 → 계정으로 이전 (서버 savePost, legacyId 로 중복 방지).
 * FREE 저장 한도에 도달하면 중단하고 나머지는 브라우저에 그대로 남긴다.
 * @returns {Promise<{imported:number, skipped:number, limited:boolean}>}
 */
export async function importLegacyPosts() {
  let imported = 0, skipped = 0, limited = false;
  for (const p of getLegacyPosts()) {
    try {
      const r = await savePostCall({
        legacyId: String(p.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || rid(),
        legacySavedAt: typeof p.date === 'string' ? p.date.slice(0, 40) : '',
        title: String(p.title || (p.data && p.data.title_1) || '제목 없음').slice(0, 300),
        type: typeof p.type === 'string' ? p.type.slice(0, 20) : '',
        data: p.data,
      });
      if (r.created) imported++; else skipped++;
    } catch (e) {
      if (e && e.details && e.details.reason === 'saved_post_limit') { limited = true; break; }
      throw e;
    }
  }
  return { imported, skipped, limited };
}
