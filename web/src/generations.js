// 생성 이력 조회 + 진행 중 생성 추적 (새로고침/네트워크 끊김 복구)
import { collection, doc, query, where, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { ref, getBlob } from 'firebase/storage';
import { db, storage } from './firebase.js';

export const subscribeGenerations = (uid, cb, n = 20) =>
  onSnapshot(
    query(collection(db, 'generations'), where('uid', '==', uid), orderBy('createdAt', 'desc'), limit(n)),
    (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (e) => { console.warn('generations', e); cb([]); },
  );

/** 문서 변경 감시. 문서가 없으면 cb(null) */
export const watchGeneration = (id, cb) =>
  onSnapshot(doc(db, 'generations', id), (s) => cb(s.exists() ? { id: s.id, ...s.data() } : null), () => cb(null));

/**
 * Storage 사진 경로 → 화면 표시용 blob: URL.
 * 다운로드 토큰 URL(getDownloadURL)을 쓰지 않는다 — 토큰 URL 은 링크만 있으면 누구나 열 수 있기 때문.
 * getBlob 은 로그인 토큰으로 요청하므로 Storage 보안 규칙(본인만 읽기)이 그대로 적용된다.
 * 보관 기간이 지나 삭제된 사진은 null → 미리보기에서 "사진 없음" 표시.
 */
let liveUrls = [];
export async function photoUrls(photos) {
  liveUrls.forEach((u) => URL.revokeObjectURL(u));
  liveUrls = [];
  const list = (photos || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
  const urls = await Promise.all(list.map((p) => getBlob(ref(storage, p.path)).then((b) => URL.createObjectURL(b)).catch(() => null)));
  liveUrls = urls.filter(Boolean);
  return urls;
}

const key = (uid) => 'jaeinit_pending_generation_' + uid;
export function savePending(uid, v) { try { localStorage.setItem(key(uid), JSON.stringify(v)); } catch (e) { /* ignore */ } }
export function loadPending(uid) { try { return JSON.parse(localStorage.getItem(key(uid)) || 'null'); } catch (e) { return null; } }
export function clearPending(uid) { try { localStorage.removeItem(key(uid)); } catch (e) { /* ignore */ } }
