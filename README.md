# ✍️ 잰잇 블로그 스튜디오 — SaaS (STEP 1)

`jaeinit_blog_studio_v3.html`(단일 HTML, 브라우저에서 Claude/네이버 API 직접 호출)을
Firebase 기반 유료 SaaS 로 전환하기 위한 1단계 코드입니다.

**STEP 1 범위**: 모듈화 · Firebase 연결 · Google/이메일 로그인 · 가입 무료 크레딧 2개(서버 원자 지급) · 데이터 스키마 · 프로필/잔액/저장 글 조회 · 보안 규칙 · 에뮬레이터 테스트 · 서버 API 인터페이스 설계

> ⚠️ **실제 AI 생성은 STEP 2 에서 서버로 연결됩니다.** 지금은 API 키를 브라우저에서 제거했기 때문에, 운영 배포 시 생성 버튼은 "다음 업데이트에서 연결 예정" 메시지를 보여줍니다. 로컬 에뮬레이터에서는 모의(mock) 결과로 전체 흐름을 확인할 수 있습니다.

## 폴더 구조
```
├── legacy/jaeinit_blog_studio_v3.html   # 원본 (수정하지 않음)
├── web/                                  # 프론트엔드 (Vite, Firebase JS SDK)
│   ├── index.html                        # 기존 마크업 유지, 설정 모달 → 로그인/계정 모달
│   ├── .env.example                      # Firebase 웹 설정 (공개 식별자만)
│   └── src/
│       ├── style.css                     # 기존 스타일 그대로 + 모달 추가 스타일
│       ├── main.js                       # 화면 흐름 (gen, savePost, 저장 목록, 로그인 UI)
│       ├── render.js                     # show / renderPreview / 복사
│       ├── images.js                     # 사진 압축 업로드
│       ├── firebase.js                   # 초기화 + 에뮬레이터 연결
│       ├── auth.js  api.js  account.js  posts.js  state.js
├── functions/                            # Cloud Functions (Node 22, 2nd gen, asia-northeast3)
│   ├── index.js                          # callable: ensureUserProfile, adminAdjustCredits, generatePost, createOrder, confirmPayment
│   ├── src/lib/   credits.js email.js schema.js
│   ├── src/ai/    prompt.js parse.js mock.js   # 기존 buildPrompt / recover 서버 이전
│   ├── src/api/   contracts.js validate.js
│   ├── src/config/secrets.js             # Secret Manager 키 정의
│   └── test/unit, test/integration
├── tests/rules/firestore.rules.test.mjs  # 보안 규칙 테스트
├── tests/e2e/smoke.cjs                   # 브라우저 스모크 테스트 (선택)
├── scripts/seed.mjs  set-admin.mjs       # 상품 시드, 관리자 지정
├── firestore.rules  firestore.indexes.json  firebase.json  .firebaserc
└── docs/  ARCHITECTURE.md SCHEMA.md API.md TESTING.md NEXT_STEPS.md
```

## 로컬 실행 (실제 Firebase 프로젝트 없이)
필요: Node 22, Java 21+ (Firestore 에뮬레이터)

```bash
npm install && npm --prefix functions install && npm --prefix web install
```
```bash
npm run emulators:clean
```
다른 터미널에서:
```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run seed -- --project demo-jaeinit
```
```bash
npm run dev
```
- 앱: http://127.0.0.1:5173 (개발 모드는 자동으로 에뮬레이터에 연결, 프로젝트 ID `demo-jaeinit`)
- 에뮬레이터 UI: http://127.0.0.1:4000 — 이메일 인증 링크는 Auth 탭 / 터미널 로그에 출력됩니다
- 관리자 지정: `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 npm run set-admin -- --project demo-jaeinit you@example.com` (재로그인 필요)
- `npm run emulators` 를 쓰면 종료 시 데이터가 `.emulator-data/` 에 저장됩니다

## 테스트
```bash
npm test
```
자세한 시나리오와 결과: [docs/TESTING.md](docs/TESTING.md)

## Firebase 프로젝트 설정 (운영)
1. [Firebase 콘솔](https://console.firebase.google.com)에서 프로젝트 생성 → **Blaze 요금제** (Functions·Secret Manager 필요)
2. **Authentication** → 로그인 방법: `Google`, `이메일/비밀번호` 사용 설정. 설정 → 승인된 도메인에 배포 도메인 추가
3. **Firestore** 생성 — 위치 `asia-northeast3 (서울)` 권장
4. 웹 앱 등록. Firebase Hosting 으로 배포하면 설정이 자동 주입되므로 `.env` 불필요. 다른 곳에서 호스팅하면 `web/.env.example` → `web/.env.local` 에 값 입력
5. CLI 연결:
   ```bash
   npx firebase login
   ```
   ```bash
   npx firebase use --add
   ```
6. (STEP 2/3 대비) 비밀키 등록 — **이전 버전에서 브라우저에 저장했던 키는 재발급 권장**
   ```bash
   npx firebase functions:secrets:set ANTHROPIC_API_KEY
   ```
   (`NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`, `TOSS_SECRET_KEY` 도 같은 방식)
7. 배포:
   ```bash
   npm run build && npx firebase deploy --only firestore,functions,hosting
   ```
8. 상품 시드: `GOOGLE_APPLICATION_CREDENTIALS=서비스계정.json npm run seed -- --project <프로젝트ID>` (⚠️ 가격은 예시값 — 확정 후 수정)
9. 관리자 지정: `GOOGLE_APPLICATION_CREDENTIALS=서비스계정.json npm run set-admin -- --project <프로젝트ID> <이메일>`

## 서비스 정책 반영
| 정책 | 구현 |
|---|---|
| 가입 시 무료 2크레딧 | `ensureUserProfile` 트랜잭션, 이메일 인증 후 1회, 이메일 해시로 재가입 차단 |
| 생성 1회 = 1크레딧 | 원장 타입·ID 규칙 정의 완료, 차감 구현은 STEP 2 |
| 10/30/70회 일회성 구매, 토스페이먼츠 | `creditPackages`/`orders` 스키마 + `createOrder`/`confirmPayment` 인터페이스, 구현은 STEP 3 |
| 크레딧은 서버만 변경 | 보안 규칙에서 users.credits / creditLedger / orders / generations 클라이언트 쓰기 전면 차단 |
| 비밀키 서버 보관 | 브라우저 키 저장 코드 삭제 + 기존 키 localStorage 에서 제거, Secret Manager 정의 |

문서: [기존 코드 분석](docs/ARCHITECTURE.md) · [스키마](docs/SCHEMA.md) · [API](docs/API.md) · [테스트](docs/TESTING.md) · [다음 단계](docs/NEXT_STEPS.md)
