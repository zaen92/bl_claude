# App Check 설정

App Check 는 "우리 웹앱에서 온 요청인지"를 확인해, 탈취된 ID 토큰이나 스크립트로 Functions(=Claude 비용)를 직접 호출하는 것을 막습니다.

## 현재 구현
- 서버: 모든 callable 에 `enforceAppCheck: ENFORCE_APP_CHECK` (`functions/.env`, 기본 `false`)
- 클라이언트: `VITE_APPCHECK_SITE_KEY` 가 있으면 `ReCaptchaEnterpriseProvider` 로 초기화, `VITE_APPCHECK_DEBUG_TOKEN` 이 있으면 디버그 공급자 사용 (`web/src/firebase.js`)
- 로컬 에뮬레이터: 사이트 키가 없으면 App Check 를 쓰지 않고, 서버도 `false` 이므로 그대로 동작

## 운영 적용 순서
1. Google Cloud 콘솔 → **reCAPTCHA Enterprise** API 사용 설정 → 웹 사이트 키 생성 (도메인: 배포 도메인, `localhost` 는 개발용 키에만)
2. Firebase 콘솔 → **App Check** → 웹 앱 → 공급자 *reCAPTCHA Enterprise* 등록 (위 사이트 키)
3. `web/.env.production` (또는 빌드 환경 변수):
   ```
   VITE_APPCHECK_SITE_KEY=<사이트 키>
   ```
4. 배포 후 Firebase 콘솔 App Check → **Cloud Functions** 지표에서 "확인된 요청" 비율이 충분히 높은지 1~2일 관찰 (이 단계에서는 아직 강제 안 함)
5. `functions/.env` 에서 `ENFORCE_APP_CHECK=true` → `npx firebase deploy --only functions`
6. (선택) Firestore 도 App Check 탭에서 "적용" — 웹 SDK 가 토큰을 자동 첨부

## 개발 환경에서 App Check 켜고 테스트
1. Firebase 콘솔 → App Check → 앱 메뉴 → **디버그 토큰 관리** → 토큰 추가 (UUID)
2. `web/.env.local`:
   ```
   VITE_USE_EMULATORS=false
   VITE_APPCHECK_SITE_KEY=<사이트 키>
   VITE_APPCHECK_DEBUG_TOKEN=<등록한 디버그 토큰>
   ```
3. 실제 프로젝트의 Functions 에 `ENFORCE_APP_CHECK=true` 로 배포된 상태에서 `npm run dev` → 생성 성공 확인, 디버그 토큰을 지우면 `unauthenticated`/`permission-denied` 로 거부되는지 확인

> 에뮬레이터는 App Check 토큰을 검증하지 않으므로, 강제 동작 확인은 실제 프로젝트에서 해야 합니다. (이번 단계에서 미실행)

## 출시 전 점검표
- [ ] reCAPTCHA Enterprise 사이트 키: 운영 도메인만 등록 (localhost 는 개발용 키로 분리)
- [ ] Firebase 콘솔 App Check 에 웹 앱 등록, 토큰 TTL 기본값(1시간) 확인
- [ ] `VITE_APPCHECK_SITE_KEY` 로 빌드 → 배포 → App Check 지표에서 Functions "확인된 요청" 비율 확인
- [ ] 디버그 토큰은 개발 기기에만, 운영 빌드에 `VITE_APPCHECK_DEBUG_TOKEN` 이 없는지 확인
- [ ] `functions/.env` `ENFORCE_APP_CHECK=true` → `npx firebase deploy --only functions`
- [ ] 강제 후: 디버그 토큰 없는 스크립트에서 callable 호출 시 거부되는지 확인
- [ ] (선택) Firestore 도 App Check 적용
- [ ] 관리자 계정으로 앱 → 내 계정 → "🛠 AI 설정 점검" 에서 `App Check 강제 ✅` 표시 확인

## 주의
- reCAPTCHA Enterprise 는 월 무료 평가 한도를 넘으면 과금됩니다.
- App Check 는 비용 방어의 한 겹일 뿐이며, 서버의 크레딧·분당/일일 한도가 최종 방어선입니다.
