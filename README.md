# ✍️ 잰잇 블로그 스튜디오 — SaaS (STEP 2.5)

`jaeinit_blog_studio_v3.html`(단일 HTML, 브라우저에서 Claude/네이버 API 직접 호출)을
Firebase 기반 유료 SaaS 로 전환하는 코드입니다.

- **STEP 1**: 모듈화 · Google/이메일 로그인 · 가입 무료 크레딧 2개(서버 원자 지급) · 스키마 · 보안 규칙
- **STEP 2**: Cloud Functions 에서 **실제 Claude 생성**(기존 프롬프트·웹 검색·사진 분석/배치·네이버 검색) · **1회 1크레딧 차감/실패 시 자동 복구** · 멱등 키·동시성·속도/일일 한도 · 생성 상태 복구 · 생성 이력 · 사진 Cloud Storage 보관 · App Check 준비 · 토큰/비용 기록
- **STEP 2.5 (안정화)**: 실제 API 검증 도구(`test:live`, 관리자 AI 점검), 공식 단가 재확인, 실패 호출 비용·일일 비용 상한·긴급 중지, 이중 환급 방지 검증, **사진 보관 정책(미저장 90일·저장 글 유지·탈퇴 시 삭제·삭제 재시도)**, 다운로드 토큰 제거(getBlob), 비용 벤치마크·손익 리포트, 보안 검토
- STEP 3 (예정): 토스페이먼츠 일회성 결제

> ⚠️ 이 작업 환경에는 Anthropic API 키가 없어 **실제 Claude 호출은 아직 검증되지 않았습니다.** 키가 없으면 `npm run test:live` 는 실패로 끝납니다. 키 등록·검증 절차: [docs/LIVE_VERIFICATION.md](docs/LIVE_VERIFICATION.md)

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
│       └── generations.js                # 생성 이력, 진행 중 생성 추적(새로고침 복구), 사진(getBlob)
├── functions/                            # Cloud Functions (Node 22, 2nd gen, asia-northeast3)
│   ├── index.js                          # callable: ensureUserProfile, adminAdjustCredits, generatePost, getGenerationStatus + 스케줄러
│   ├── .env / .env.demo-jaeinit          # 모델·한도 설정 / 에뮬레이터 전용(AI_MOCK)
│   ├── .secret.local.example             # 로컬 비밀값 예시 (복사해서 .secret.local)
│   ├── src/generation/service.js         # 예약 → Claude → 확정 / 실패 복구 / 스테일 복구
│   ├── src/ai/    prompt.js parse.js claude.js mockClient.js mock.js
│   ├── src/lib/   credits.js(무료 우선 버킷) email.js schema.js
│   ├── src/storage/ photos.js retention.js(90일 보관) deletionJobs.js(삭제 재시도)
│   ├── src/account/deleteAccount.js      # 회원 탈퇴 데이터 정리
│   ├── src/ops/costAnalysis.js           # 비용 요약·손익 계산
│   ├── src/naver.js
│   ├── src/config/ params.js pricing.js secrets.js
│   └── test/unit, test/integration, test/live(실제 API), test/fixtures
├── tests/rules/                          # Firestore·Storage 보안 규칙 테스트
├── tests/security/no-secrets.test.mjs    # 번들/저장소 비밀값 노출 검사
├── tests/e2e/smoke.cjs                   # 브라우저 E2E (선택)
├── scripts/seed.mjs  set-admin.mjs       # 상품 시드, 관리자 지정
├── scripts/live-benchmark.mjs            # 실제 API 비용 측정 (사진 장수 × 분량 × 모델)
├── scripts/cost-report.mjs               # 운영/벤치마크 비용 리포트 + 10/30/70회 손익
├── storage.rules  storage.cors.json      # Storage 규칙, 운영 버킷 CORS
├── firestore.rules  storage.rules  firestore.indexes.json  firebase.json  .firebaserc
└── docs/  ARCHITECTURE SCHEMA API TESTING NEXT_STEPS APP_CHECK STORAGE AI_COST LIVE_VERIFICATION SECURITY_REVIEW
```

## 로컬 실행 (실제 Firebase 프로젝트 없이)
필요: Node 22, Java 21+ (Firestore 에뮬레이터)

```bash
npm install && npm --prefix functions install && npm --prefix web install
```
```bash
cp functions/.secret.local.example functions/.secret.local
```
```bash
npm run emulators:clean
```
다른 터미널에서:
```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run seed -- --project demo-jaeinit --prices 10:4900,30:12900,70:27900
```
```bash
npm run dev
```
- 앱: http://127.0.0.1:5173 (개발 모드는 자동으로 에뮬레이터에 연결, 프로젝트 ID `demo-jaeinit`)
- 생성은 **mock Claude** (`functions/.env.demo-jaeinit` 의 `AI_MOCK=true`). 크레딧 차감·복구·사진 저장은 실제 로직 그대로.
  메모에 `[[mock:error]]`, `[[mock:slow:5000]]` 등을 넣으면 실패·지연을 재현할 수 있습니다 (`functions/src/ai/mockClient.js`)
- 로컬에서 실제 Claude 로 시험: `functions/.secret.local` 에 `ANTHROPIC_API_KEY=...` + `functions/.env.local` 에 `AI_MOCK=false` (비용 발생, [LIVE_VERIFICATION.md](docs/LIVE_VERIFICATION.md) 4절)
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
6. **Storage** 시작하기 (콘솔 → Storage, 위치 서울 권장). 보안 규칙은 배포 시 `storage.rules` 로 덮어씀
7. **Claude API 키 등록** (Secret Manager) — 자세한 절차·검증: [docs/LIVE_VERIFICATION.md](docs/LIVE_VERIFICATION.md). [Claude Console](https://platform.claude.com) → Settings → API Keys 에서 발급. **이전 버전에서 브라우저에 저장했던 키는 폐기하고 새로 발급**하세요. Console 의 Limits 에서 월 지출 한도도 설정 권장.
   ```bash
   npx firebase functions:secrets:set ANTHROPIC_API_KEY
   ```
   네이버 지역검색 ([developers.naver.com](https://developers.naver.com) 검색 API) — 사용하지 않으면 값으로 `-` 입력:
   ```bash
   npx firebase functions:secrets:set NAVER_CLIENT_ID
   ```
   ```bash
   npx firebase functions:secrets:set NAVER_CLIENT_SECRET
   ```
8. 모델·한도 확인: `functions/.env` (`CLAUDE_MODEL=claude-sonnet-4-6` 등, [docs/API.md](docs/API.md#환경-설정-functionsenv-비밀-아님)). Anthropic Console 조직 설정에서 **웹 검색 허용** 여부 확인
9. 배포 (첫 배포 시 Cloud Scheduler·Secret Manager API 사용 설정을 묻습니다):
   ```bash
   npm run build && npx firebase deploy --only firestore,storage,functions,hosting
   ```
10. App Check: [docs/APP_CHECK.md](docs/APP_CHECK.md) 순서대로 (모니터링 → `ENFORCE_APP_CHECK=true`)
11. 운영 버킷 CORS (사진 표시에 필요): `storage.cors.json` 수정 후 `gcloud storage buckets update gs://<버킷> --cors-file=storage.cors.json`
12. 상품 시드 (**가격 확정 후에만**, STEP 3): `GOOGLE_APPLICATION_CREDENTIALS=서비스계정.json npm run seed -- --project <프로젝트ID> --prices 10:<원>,30:<원>,70:<원>`
13. 관리자 지정: `GOOGLE_APPLICATION_CREDENTIALS=서비스계정.json npm run set-admin -- --project <프로젝트ID> <이메일>`

## 서비스 정책 반영
| 정책 | 구현 |
|---|---|
| 가입 시 무료 2크레딧 | `ensureUserProfile` 트랜잭션, 이메일 인증 후 1회, 이메일 해시로 재가입 차단 |
| 생성 1회 = 1크레딧, 무료 우선 | 예약 트랜잭션에서 무료→유료 순 차감, 성공 시 확정, 실패·중단 시 같은 버킷으로 자동 복구 |
| 0크레딧 생성 불가 | 클라이언트 안내 + 서버 트랜잭션에서 거부 (AI 미호출) |
| 중복·동시 요청 | 멱등 키 `generations/{uid}_{clientRequestId}`, 트랜잭션 잔액 검사, 동시 실행 상한 |
| 10/30/70회 일회성 구매, 토스페이먼츠 | `creditPackages`/`orders` 스키마 + `createOrder`/`confirmPayment` 인터페이스, 구현은 STEP 3 |
| 크레딧은 서버만 변경 | 보안 규칙에서 users.credits / creditLedger / orders / generations 클라이언트 쓰기 전면 차단 |
| 비밀키 서버 보관 | 브라우저 키 저장 코드 삭제 + 기존 키 localStorage 에서 제거, Secret Manager 정의 |

문서: [실제 API 검증](docs/LIVE_VERIFICATION.md) · [보안 검토](docs/SECURITY_REVIEW.md) · [기존 코드 분석](docs/ARCHITECTURE.md) · [스키마](docs/SCHEMA.md) · [API](docs/API.md) · [테스트](docs/TESTING.md) · [App Check](docs/APP_CHECK.md) · [사진 보관](docs/STORAGE.md) · [AI 비용](docs/AI_COST.md) · [다음 단계](docs/NEXT_STEPS.md)
