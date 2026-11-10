// 저장된 글 (Firestore posts) + 기존 localStorage 저장 글 이전
import {
  collection, doc, query, where, orderBy, onSnapshot, addDoc, deleteDoc, getDoc, setDoc, writeBatch, getDocs, serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase.js';

const LEGACY_KEY = 'jaeinit_saved_posts';

export const subscribePosts = (uid, cb) =>
  onSnapshot(
    query(collection(db, 'posts'), where('uid', '==', uid), orderBy('createdAt', 'desc')),
    (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (e) => { console.warn('posts', e); cb([]); },
  );

export function createPost(uid, { title, type, data, generationId = null }) {
  return addDoc(collection(db, 'posts'), {
    uid, title: (title || '제목 없음').slice(0, 300), type: type || '', data, generationId,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
}

export const removePost = (id) => deleteDoc(doc(db, 'posts', id));

export async function removeAllPosts(uid) {
  const s = await getDocs(query(collection(db, 'posts'), where('uid', '==', uid)));
  for (let i = 0; i < s.docs.length; i += 400) {
    const b = writeBatch(db);
    s.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
    await b.commit();
  }
}

/** 기존 v3 가 localStorage 에 저장한 글 (삭제하지 않고 백업으로 유지) */
export function getLegacyPosts() {
  try {
    const arr = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter((p) => p && p.data) : [];
  } catch (e) { return []; }
}

/**
 * localStorage 글 → 계정으로 이전. 문서 ID 를 legacy_{uid}_{기존id} 로 고정해 여러 번 눌러도 중복되지 않는다.
 * @returns {Promise<{imported:number, skipped:number}>}
 */
export async function importLegacyPosts(uid) {
  let imported = 0, skipped = 0;
  for (const p of getLegacyPosts()) {
    const id = `legacy_${uid}_${String(p.id).replace(/[^A-Za-z0-9_-]/g, '')}`;
    const ref = doc(db, 'posts', id);
    if ((await getDoc(ref)).exists()) { skipped++; continue; }
    await setDoc(ref, {
      uid,
      title: String(p.title || (p.data && p.data.title_1) || '제목 없음').slice(0, 300),
      type: typeof p.type === 'string' ? p.type.slice(0, 20) : '',
      data: p.data,
      generationId: null,
      legacyId: typeof p.id === 'number' ? p.id : String(p.id),
      legacySavedAt: typeof p.date === 'string' ? p.date : '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    imported++;
  }
  return { imported, skipped };
}
