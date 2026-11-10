// 인증 (Google / 이메일) — 서버 프로필 동기화는 api.ensureProfile 에서
import {
  GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, signOut, onAuthStateChanged, reload,
} from 'firebase/auth';
import { auth } from './firebase.js';

export const onUser = (cb) => onAuthStateChanged(auth, cb);
export const currentUser = () => auth.currentUser;

export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return (await signInWithPopup(auth, provider)).user;
}
export async function loginWithEmail(email, pw) {
  return (await signInWithEmailAndPassword(auth, email, pw)).user;
}
export async function signupWithEmail(email, pw) {
  const { user } = await createUserWithEmailAndPassword(auth, email, pw);
  await sendEmailVerification(user);
  return user;
}
export const resendVerification = () => sendEmailVerification(auth.currentUser);
export const resetPassword = (email) => sendPasswordResetEmail(auth, email);
export const logoutUser = () => signOut(auth);
/** 이메일 인증 상태 갱신 (토큰도 새로 받아 email_verified 반영) */
export async function refreshUser() {
  await reload(auth.currentUser);
  await auth.currentUser.getIdToken(true);
  return auth.currentUser;
}
export const needsVerification = (u) => !!u && !u.emailVerified && u.providerData.some((p) => p.providerId === 'password');

const MSG = {
  'auth/invalid-email': '이메일 형식이 올바르지 않아요.',
  'auth/missing-password': '비밀번호를 입력해주세요.',
  'auth/weak-password': '비밀번호는 6자 이상이어야 해요.',
  'auth/email-already-in-use': '이미 가입된 이메일이에요. 로그인해주세요.',
  'auth/invalid-credential': '이메일 또는 비밀번호가 올바르지 않아요.',
  'auth/user-not-found': '이메일 또는 비밀번호가 올바르지 않아요.',
  'auth/wrong-password': '이메일 또는 비밀번호가 올바르지 않아요.',
  'auth/too-many-requests': '시도가 너무 많아요. 잠시 후 다시 시도해주세요.',
  'auth/popup-closed-by-user': '로그인 창이 닫혔어요.',
  'auth/popup-blocked': '팝업이 차단됐어요. 브라우저 팝업 허용 후 다시 시도해주세요.',
  'auth/network-request-failed': '네트워크 오류가 발생했어요.',
  'auth/account-exists-with-different-credential': '같은 이메일로 다른 로그인 방식이 이미 있어요.',
};
export const authErrorMessage = (e) => MSG[e && e.code] || (e && e.message) || '오류가 발생했어요.';
