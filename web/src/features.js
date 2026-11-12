// FREE / PRO 정책·사용량·개인화 스타일 (클라이언트) — 한도 판단은 모두 서버가 하고, 여기는 표시·호출만
import { doc, getDoc, collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './firebase.js';

// 서버(functions/src/config/policy.js)와 같은 기본값 — 실제 값은 config/policy 문서 (운영자 변경 가능)
export const DEFAULT_POLICY = { signupBonusCredits: 5, freeExportLimit: 5, freeSavedPostLimit: 5, freeStyleLimit: 1 };

export async function loadPolicy() {
  try {
    const s = await getDoc(doc(db, 'config', 'policy'));
    const d = s.exists() ? s.data() : {};
    const out = { ...DEFAULT_POLICY };
    for (const k of Object.keys(DEFAULT_POLICY)) if (Number.isInteger(d[k]) && d[k] >= 0) out[k] = d[k];
    return out;
  } catch (e) {
    return { ...DEFAULT_POLICY };
  }
}

export const planOf = (profile) => (profile && profile.plan === 'pro' ? 'pro' : 'free');

const call = (name) => (data) => httpsCallable(functions, name)(data).then((r) => r.data);
export const savePostCall = call('savePost');
export const deletePostCall = call('deletePost');
export const authorizeExport = call('authorizeExport');
export const saveStyle = call('saveStyle');
export const deleteStyle = call('deleteStyle');

export const subscribeStyles = (uid, cb) =>
  onSnapshot(
    query(collection(db, 'styles'), where('uid', '==', uid), orderBy('createdAt', 'asc')),
    (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (e) => { console.warn('styles', e); cb([]); },
  );

export const TONE_LABEL = { friendly: '친근한 후기형', informative: '정보 전달형', emotional: '감성형' };
export const PRESET_OPTIONS = [
  { value: 'preset:basic', label: '기본 스타일 (블로그 이름·인사말 없음)' },
  { value: 'preset:jaeinit', label: '잰잇 스타일 (기존 프롬프트)' },
];

// 선택한 스타일 기억 (기기별 편의 기능 — 실패해도 동작에 지장 없음)
const KEY = 'jaeinit_style_choice';
export function loadStyleChoice() { try { return localStorage.getItem(KEY) || 'preset:basic'; } catch (e) { return 'preset:basic'; } }
export function saveStyleChoice(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* ignore */ } }

/** 선택값 → 생성 요청의 style 필드 */
export function styleRequest(choice) {
  if (choice && choice.startsWith('style:')) return { styleId: choice.slice(6) };
  return { preset: choice === 'preset:jaeinit' ? 'jaeinit' : 'basic' };
}
