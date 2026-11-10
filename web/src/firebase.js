// Firebase 초기화 + 로컬 에뮬레이터 연결
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';

export const REGION = 'asia-northeast3';
const env = import.meta.env;
export const USE_EMULATORS = env.VITE_USE_EMULATORS === 'true' || (env.DEV && env.VITE_USE_EMULATORS !== 'false');

async function resolveConfig() {
  if (USE_EMULATORS) {
    // demo- 프로젝트 ID 는 실제 클라우드 리소스에 절대 접근하지 않는다
    return { apiKey: 'demo-key', authDomain: 'demo-jaeinit.firebaseapp.com', projectId: 'demo-jaeinit', appId: 'demo-app' };
  }
  if (env.VITE_FIREBASE_API_KEY) {
    return {
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: env.VITE_FIREBASE_APP_ID,
    };
  }
  // Firebase Hosting 예약 URL — 배포 시 자동 제공
  const res = await fetch('/__/firebase/init.json');
  if (!res.ok) throw new Error('Firebase 설정을 찾을 수 없어요. web/.env.local 을 확인하세요.');
  return res.json();
}

export const app = initializeApp(await resolveConfig());
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, REGION);

if (USE_EMULATORS) {
  const host = location.hostname || '127.0.0.1';
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
  connectFunctionsEmulator(functions, host, 5001);
}
