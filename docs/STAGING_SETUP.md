# 스테이징 구축 · API 키 등록 가이드 (운영자용)

## 구조 (사용자는 API 키를 입력하지 않습니다)
```
사용자 ── 로그인 ──▶ 웹앱 ── callable(로그인 토큰) ──▶ Cloud Functions ──▶ Claude API
                                                         │  ▲
                                         Secret Manager ─┘  └─ 운영자가 등록한 Anthropic 키 (서버 메모리에서만 사용)
```
- 일반 사용자는 회원가입 → 무료 2회 또는 유료 크레딧으로 생성. **API 키 입력 화면은 없습니다.**
- 운영자(사장님)가 발급한 Anthropic 키는 **Firebase 프로젝트별 Secret Manager** 에만 저장됩니다.
  - 스테이징 프로젝트 ← **개발용 키** (Anthropic `jaeinit-staging` 워크스페이스)
  - 운영 프로젝트 ← **운영용 키** (Anthropic `jaeinit-prod` 워크스페이스)
- 키는 브라우저 번들·GitHub·Firestore·로그·관리자 점검 화면 어디에도 나오지 않습니다 (자동 테스트로 확인).
- **키는 Claude(이 대화)나 다른 사람에게 보내지 마세요.** 아래 명령의 입력 프롬프트에만 붙여넣습니다.

---

## 1. 직접 정해야 하는 값 (임의로 만들지 않았습니다)
| # | 항목 | 어디에 쓰이나 | 비고 |
|---|---|---|---|
| 1 | **스테이징 Firebase 프로젝트 ID** | `firebase use --add` 별칭 `staging` | 전 세계 고유. 생성 후 변경 불가 |
| 2 | **운영 Firebase 프로젝트 ID** | 별칭 `prod` (STEP 3 이후) | 스테이징과 **다른 프로젝트** |
| 3 | Google Cloud 결제 계정 · 월 예산 금액 | Blaze 요금제, 예산 알림 | 스테이징 예산 예: 월 $10~20 |
| 4 | 리전 | Firestore·Storage 위치 | 코드 기준 `asia-northeast3`(서울) 권장 — **생성 후 변경 불가** |
| 5 | Anthropic 워크스페이스 2개 이름 | 키·지출 한도 분리 | 예: `jaeinit-staging`, `jaeinit-prod` |
| 6 | 워크스페이스별 **월 지출 한도** | Anthropic Console | 스테이징 예: $20, 운영은 실측 후 |
| 7 | **Anthropic API 키 2개** (개발용·운영용) | Secret Manager `ANTHROPIC_API_KEY` | 각 워크스페이스에서 발급 |
| 8 | 네이버 검색 API 사용 여부 / Client ID·Secret | Secret `NAVER_CLIENT_ID/SECRET` | 미사용 시 `-` |
| 9 | 관리자 이메일 | `set-admin` | 본인 계정 |
| 10 | 스테이징 테스트 허용 이메일 목록 | Firestore `config/service.allowedEmails` | 지인 테스터 등 |
| 11 | reCAPTCHA Enterprise 사이트 키 (스테이징·운영 각각) | App Check | 3단계 이후 |
| 12 | 커스텀 도메인 사용 여부 | Auth 승인 도메인, `storage.cors.json` | 없으면 `<ID>.web.app` 사용 |
| 13 | 일일 AI 비용 상한 (USD) | `functions/.env.staging` `DAILY_COST_LIMIT_USD` | 스테이징 기본 10 |

---

## 2. Anthropic 설정 (Claude Console)
1. [platform.claude.com](https://platform.claude.com) 로그인 → **Settings → Workspaces** (`/settings/workspaces`) → **Create workspace**
   - `jaeinit-staging`, `jaeinit-prod` 두 개 생성 (Default 워크스페이스에는 지출 한도를 걸 수 없어서 별도 생성)
2. 각 워크스페이스 선택 → **Spend limits** → 월 한도와 알림 금액 설정
3. (선택) **Rate limits** (`/usage/limits`) → 워크스페이스 선택 → 모델별 분당 요청·토큰 제한
4. **Settings → Capabilities** (`/settings/capabilities`) → 웹 검색이 꺼져 있지 않은지 확인 (꺼져 있으면 생성 요청이 400 오류)
5. **Settings → API Keys** → **Create Key** → 워크스페이스 `jaeinit-staging` 선택 → 이름 `jaeinit-staging-functions`
   - 키는 생성 직후 한 번만 보입니다. 다음 4절 등록 명령의 입력 프롬프트에 바로 붙여넣고, 메모장 등에 저장하지 마세요.
   - 운영 키(`jaeinit-prod`)는 운영 프로젝트를 만들 때(STEP 3 이후) 발급하세요.
6. 이전 v3 에서 브라우저에 넣었던 키가 있으면 **API Keys 에서 삭제(Disable/Delete)**

---

## 3. Firebase 스테이징 프로젝트 (Firebase 콘솔)
1. [console.firebase.google.com](https://console.firebase.google.com) → **프로젝트 추가** → 이름·ID 입력(1번 값) → Google 애널리틱스는 꺼도 됨
2. 좌측 하단 **요금제 업그레이드 → Blaze** → 결제 계정 연결 → **예산 알림** 설정 (예: 월 $20, 50/90/100% 알림)
3. **프로젝트 설정 → 일반 → 내 앱 → 웹 앱 추가** (Hosting 설정 체크) — 웹 설정 값은 Hosting 이 자동 제공하므로 복사 불필요
4. **Authentication → 시작하기 → 로그인 방법**: `이메일/비밀번호` 사용, `Google` 사용(지원 이메일 지정)
   - **설정 → 승인된 도메인**: `<ID>.web.app`, `<ID>.firebaseapp.com` 기본 포함 확인 (커스텀 도메인이 있으면 추가)
   - (권장) **설정 → 사용자 작업 → 이메일 열거 보호** 사용
5. **Firestore Database → 데이터베이스 만들기**: 위치 `asia-northeast3 (Seoul)`, **프로덕션 모드** (규칙은 배포 시 덮어씀)
6. **Storage → 시작하기**: 위치 `asia-northeast3`, 프로덕션 모드
7. Secret Manager·Cloud Scheduler·Cloud Functions·Cloud Build·Artifact Registry API 는 **첫 배포 시 CLI 가 사용 설정을 요청**합니다 (승인하면 됨)
8. App Check 는 첫 배포·점검이 끝난 뒤 (6절)

---

## 4. 터미널 설정 (본인 PC)
필요: Node 22, Java 21+, [Google Cloud CLI](https://cloud.google.com/sdk/docs/install)
```bash
git clone https://github.com/zaen92/bl_claude.git && cd bl_claude && git checkout claude/relaxed-johnson-n6wyp9
```
```bash
npm install && npm --prefix functions install && npm --prefix web install
```
로그인 (브라우저가 열림):
```bash
npx firebase login
```
```bash
gcloud auth login
```
```bash
gcloud auth application-default login
```
스테이징 프로젝트 연결 — 목록에서 1번 프로젝트를 고르고, 별칭을 물으면 **`staging`** 입력:
```bash
npx firebase use --add
```
**Anthropic 키 등록** — 입력 프롬프트에 개발용 키를 붙여넣고 Enter (화면에 표시되지 않음):
```bash
npx firebase functions:secrets:set ANTHROPIC_API_KEY --project staging
```
네이버 검색 (미사용 시 각 프롬프트에 `-` 입력):
```bash
npx firebase functions:secrets:set NAVER_CLIENT_ID --project staging
```
```bash
npx firebase functions:secrets:set NAVER_CLIENT_SECRET --project staging
```
등록 확인 (값은 출력되지 않고 버전만 표시):
```bash
npx firebase functions:secrets:get ANTHROPIC_API_KEY --project staging
```
> 키를 셸 명령 인자나 `.env` 파일에 직접 쓰지 마세요 (셸 기록·GitHub 노출 위험). `functions/.secret.local` 은 로컬 에뮬레이터 전용이며 gitignore 되어 있습니다.

### 4-1. Storage CORS (사진 표시에 필요)
`storage.cors.json` 의 `YOUR_PROJECT_ID` 를 스테이징 프로젝트 ID 로 바꾼 뒤 (운영 프로젝트를 만들면 그 도메인도 추가):
```bash
gcloud storage buckets update gs://<스테이징 버킷 이름> --cors-file=storage.cors.json
```
버킷 이름은 Firebase 콘솔 → Storage 상단 `gs://…` (보통 `<프로젝트ID>.firebasestorage.app`).

### 4-2. 사전 점검 → 스테이징 배포
```bash
npm run preflight:staging
```
모든 항목이 ✅ 일 때만 배포 (사전 점검을 다시 거친 뒤 배포합니다):
```bash
npm run deploy:staging
```
- 스테이징 빌드는 화면 제목 옆에 **STAGING** 표시, 접근 모드는 **허용 목록**(초대된 이메일·관리자만 AI 생성)
- 운영 배포 스크립트는 일부러 만들지 않았습니다 (STEP 3 이후)

### 4-3. 관리자·테스터 지정
```bash
npm run set-admin -- --project <스테이징 ID> <관리자 이메일>
```
(해당 계정으로 앱에 한 번 가입해 둔 뒤 실행 — `gcloud auth application-default login` 계정 권한 사용, 이후 앱에서 재로그인)
Firestore 콘솔 → `config` 컬렉션 → 문서 ID `service` →
`allowedEmails` (배열): 테스터 이메일들, (선택) `dailyCostLimitUsd` (숫자)

---

## 5. 실제 API 검증 (키 등록 후)
1. 앱 → 👤 내 계정 → **🛠 AI 설정 점검 (관리자)** → 키 ✅ · 형식 ✅ · 모델 ✅ · 웹검색 ✅ (생성 비용 없음)
2. 로컬에서 Claude API 직접 검증 (키를 Secret Manager 에서 바로 읽음 — 셸 기록에 키가 남지 않음):
   ```bash
   ANTHROPIC_API_KEY="$(gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY --project=<스테이징 ID>)" npm run test:live:check
   ```
   ```bash
   ANTHROPIC_API_KEY="$(gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY --project=<스테이징 ID>)" npm run test:live
   ```
   텍스트 생성·사진 분석·웹 검색·JSON 형식·토큰·비용 (약 $0.2~0.4)
3. **배포된 스테이징 종합 점검** — 실제 Claude + Firestore + Cloud Storage 로 아래를 자동 확인 (약 $0.2~0.5, 테스트 계정 자동 생성·삭제):
   ```bash
   npm run staging-check -- --project <스테이징 ID> --yes
   ```
   가입 2크레딧 → 1회(텍스트·웹검색·짧은 글) → 2회(사진 3장·보통 글, Storage 저장) → 사진 본인만 다운로드 → 3회째 차단 → 재전송 무차감 → 손상 이미지로 실제 API 오류 → 복구 → 동시 3건 중 1건(긴 글) → 원장=잔액 → 이력 복구 → 저장 글 사진 유지·삭제 후 실제 Storage 삭제 → 생성별 토큰·비용 → 회원 탈퇴 후 Storage 비움
   - App Check 를 강제하기 **전에** 실행하세요 (스크립트는 App Check 토큰이 없음)
4. 비용 측정: [LIVE_VERIFICATION.md](LIVE_VERIFICATION.md) 6절 (`benchmark` → `cost-report`)

## 6. App Check (스테이징 점검 후)
[APP_CHECK.md](APP_CHECK.md) 순서: reCAPTCHA Enterprise 사이트 키 → 콘솔 App Check 등록 → `web/.env.staging.local` 에 `VITE_APPCHECK_SITE_KEY=…` → `npm run deploy:staging` → 지표 확인 → `functions/.env.staging` 의 `ENFORCE_APP_CHECK=true` → 다시 배포

---

## 7. 서비스별 설정과 예상 과금
> ⚠️ Google Cloud/Firebase 단가는 이번 작업 환경에서 공식 페이지(firebase.google.com, cloud.google.com 가격표)를 열 수 없어 **확인하지 못했습니다.** 아래는 구조와 대략적 규모이며, 금액은 링크에서 반드시 확인하세요.

| 서비스 | 필요한 설정 | 과금 항목 | 스테이징 예상 |
|---|---|---|---|
| Authentication | 이메일/비밀번호, Google, 승인 도메인 | 월간 활성 사용자(MAU) — 소규모는 무료 범위 | 0 |
| Firestore | 서울, 프로덕션 모드, 규칙·인덱스는 배포 | 문서 읽기·쓰기·삭제, 저장 용량 (일일 무료 할당량 있음) | 0 ~ 수 센트 |
| Cloud Functions (2세대) | 첫 배포 시 API 사용 설정, Secret 바인딩 | 요청 수, vCPU·메모리 사용 시간, 배포 시 Cloud Build·이미지 저장(Artifact Registry) | 수 센트 ~ $1 |
| Cloud Storage | 서울 버킷, 규칙 배포, CORS | 저장 GB-월, 다운로드, 작업 수 (미국 외 리전 버킷은 무료 사용량이 적용되지 않을 수 있음 — 확인 필요) | 수 센트 |
| Secret Manager | 키 3개 | 활성 비밀 버전 수/월, 접근 횟수 (소량 무료 범위 있음) | 0 ~ $0.2 |
| Cloud Scheduler | 배포 시 자동 생성 (3개: 멈춘 생성 복구·사진 보관·삭제 작업) | 작업 수/월 (결제 계정당 소량 무료) | 0 ~ $0.3 |
| App Check | reCAPTCHA Enterprise | 평가(assessment) 수 — 월 무료 범위 초과 시 과금 | 0 |
| Hosting | 배포 시 자동 | 저장·전송량 (무료 범위 있음) | 0 |
| **Anthropic** | 워크스페이스·키·지출 한도 | 토큰 + 웹 검색($10/1천회) | **생성 1회 약 $0.1~0.15 추정** — 실측 필요 |

공식 가격표: [Firebase](https://firebase.google.com/pricing) · [Cloud Run/Functions](https://cloud.google.com/run/pricing) · [Secret Manager](https://cloud.google.com/secret-manager/pricing) · [Cloud Scheduler](https://cloud.google.com/scheduler/pricing) · [Cloud Storage](https://cloud.google.com/storage/pricing) · [reCAPTCHA](https://cloud.google.com/recaptcha/pricing) · [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing)

→ 스테이징의 Google 쪽 비용은 대부분 무료 범위 ~ 월 몇 달러 수준이고, **실제 비용의 대부분은 Anthropic 사용량**입니다. Anthropic 워크스페이스 지출 한도 + 서버 일일 비용 상한(`DAILY_COST_LIMIT_USD`) + 허용 목록 모드로 이중·삼중으로 막혀 있습니다.

## 8. 문제 해결
| 증상 | 확인 |
|---|---|
| AI 점검에서 키 ❌ | `functions:secrets:get` 로 버전 존재 확인 → 키 등록 후 **다시 배포** (`npm run deploy:staging`) |
| 모델 ❌ (401) | 키가 비활성/삭제됨, 워크스페이스 확인 |
| 생성 시 "테스트 기간에는 초대된 계정만" | `config/service.allowedEmails` 에 이메일 추가 |
| 생성 시 400 web search not enabled | Console → Settings → Capabilities 에서 웹 검색 사용 |
| 저장 글 사진이 안 보임 | 버킷 CORS 적용 여부 (4-1) |
| 배포가 사전 점검에서 멈춤 | `npm run preflight:staging` 출력의 → 안내대로 |
