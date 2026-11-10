// 생성 이력 조회 + 진행 중 생성 추적 (새로고침/네트워크 끊김 복구)
import { collection, doc, query, where, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { ref, getDownloadURL } from 'firebase/storage';
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

/** Storage 사진 경로 → 표시용 URL (본인만 읽기 가능) */
export async function photoUrls(photos) {
  const list = (photos || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
  return Promise.all(list.map((p) => getDownloadURL(ref(storage, p.path)).catch(() => null)));
}

const key = (uid) => 'jaeinit_pending_generation_' + uid;
export function savePending(uid, v) { try { localStorage.setItem(key(uid), JSON.stringify(v)); } catch (e) { /* ignore */ } }
export function loadPending(uid) { try { return JSON.parse(localStorage.getItem(key(uid)) || 'null'); } catch (e) { return null; } }
export function clearPending(uid) { try { localStorage.removeItem(key(uid)); } catch (e) { /* ignore */ } }
