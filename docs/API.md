# 서버 API (Cloud Functions callable)

- 리전 `asia-northeast3`, 2nd gen, Node 22 · 클라이언트: [`web/src/api.js`](../web/src/api.js)
- 모든 함수는 **Firebase Auth ID 토큰 필수** → 미로그인 시 `unauthenticated`
- App Check: `functions/.env` 의 `ENFORCE_APP_CHECK=true` 로 전체 callable 에 강제 ([APP_CHECK.md](APP_CHECK.md))
- 타입 정의: [`functions/src/api/contracts.js`](../functions/src/api/contracts.js)

| 함수 | 상태 | 권한 |
|---|---|---|
| `ensureUserProfile` | ✅ STEP 1 | 로그인 |
| `adminAdjustCredits` | ✅ STEP 1 (+버킷 지정) | custom claim `admin == true` |
| `generatePost` | ✅ **STEP 2 — 실제 Claude 호출 + 크레딧 차감/복구** | 로그인 + 이메일 인증 |
| `getGenerationStatus` | ✅ STEP 2 | 로그인 (본인 기록만) |
| `sweepStaleGenerations` | ✅ STEP 2 (5분 주기 스케줄) | 시스템 |
| `photoRetentionDaily` · `processPhotoDeletionJobs` | ✅ STEP 2.5 (매일 04:10 / 10분 주기) | 시스템 |
| `deleteAccount` | ✅ STEP 2.5 회원 탈퇴 | 로그인 + 최근 10분 내 로그인 |
| `onAuthUserDeleted` | ✅ STEP 2.5 (Auth 삭제 트리거, 데이터 정리) | 시스템 |
| `adminCheckAiConfig` | ✅ STEP 2.5 키·모델·웹검색 점검 (생성 비용 없음, 키 값 미반환) | admin |
| `adminRetryDeletionJob` | ✅ STEP 2.5 실패한 사진 삭제 작업 재시도 | admin |
| `createOrder` / `confirmPayment` / `tossWebhook` | ⬜ STEP 3 (인터페이스만) | |

---

## generatePost
요청
```json
{ "title": "...", "type": "맛집", "content": "...", "memo": "", "info": "", "volume": "normal",
  "images": ["data:image/jpeg;base64,..."], "clientRequestId": "req_9f2c..." }
```
| 검증 | 한도 |
|---|---|
| 제목 / 내용 / 메모·장소 | 1~200자 / 1~5,000자 / ≤2,000자 |
| 유형 · 분량 | 9종 · short/normal/long |
| 사진 | 최대 10장, JPEG/PNG/WebP dataURL, 장당 ≤약 1.5MB, 합계 ≤약 9MB (클라이언트가 1400px·JPEG 82%로 압축) |
| clientRequestId | `[A-Za-z0-9_-]{8,64}` — 멱등 키 |

### 처리 순서 (`functions/src/generation/service.js`)
1. 인증 + 이메일 인증 확인 (토큰 → 필요 시 Admin Auth 재확인), 입력 검증, API 키 설정 확인(없으면 **차감 전** 거부), 서비스 게이트(일시중지·일일 비용 상한, 차감 전)
2. **예약 트랜잭션**: `generations/{uid}_{clientRequestId}` 가 있으면 그 상태를 반환(중복 실행·차감 없음). 없으면
   잔액 ≥1 · 동시 실행 < 상한 · 분당/일일 한도 · 저장 용량 확인 → `credits −1`(무료 우선), `creditLedger/gen_{id}`, `generations`(processing, lease 6분) 생성
3. 사진 → Storage 저장 · 네이버 지역검색(키 설정 시) · Claude 호출(스트리밍, 웹 검색 도구, `pause_turn` 이어쓰기, 240초 제한)
4. 결과 파싱(기존 JSON 추출 + recover) → 본문이 비면 실패 처리
5. **확정 트랜잭션**: `succeeded`, `charge.status=captured`, 사진 보관 만료일(90일), `generationMetrics`·`opsDaily` 에 토큰·비용·품질 기록
6. **실패 시 복구 트랜잭션** (status==processing 일 때만 → 이중 환급 불가): `creditLedger/refund_{id}` +1 (차감했던 버킷으로), `failed`, 부분 사용량 기록 → 사진 삭제(실패 시 삭제 작업 등록)·용량 반환
7. 함수가 3~6 전에 죽으면: lease 만료 후 `getGenerationStatus` 조회 시 또는 5분 주기 스케줄러가 6 을 실행

스트리밍 청크: `{type:'status', message}` | `{type:'text', delta}` → 기존 "실시간 작성 중" 박스

응답 (`GeneratePostResponse`)
```json
{ "generationId": "uid_req_...", "status": "succeeded", "result": { /* GenerationResult */ },
  "naver": null, "photos": [{"path": "users/.../photo_1.jpg", "index": 1}], "error": null, "refunded": false,
  "mock": false, "creditsRemaining": 1, "usage": {"inputTokens": 12000, "outputTokens": 3500} }
```

### 오류 (HttpsError, `details.reason`)
| reason | 코드 | 크레딧 | 사용자 메시지 요지 |
|---|---|---|---|
| email_not_verified | failed-precondition | 차감 안 함 | 이메일 인증 필요 |
| insufficient_credits | failed-precondition | 차감 안 함 | 크레딧 소진, 충전 곧 오픈 |
| rate_limited (`retryAfterSec`) | resource-exhausted | 차감 안 함 | N초 후 다시 |
| daily_limit | resource-exhausted | 차감 안 함 | 오늘 한도 소진 |
| too_many_concurrent | resource-exhausted | 차감 안 함 | 생성 중인 글 있음 |
| storage_quota | resource-exhausted | 차감 안 함 | 사진 저장 공간 부족 |
| ai_not_configured | failed-precondition | 차감 안 함 | 관리자 문의 |
| service_paused | unavailable | 차감 안 함 | `config/service.pauseMessage` |
| not_allowlisted | permission-denied | 차감 안 함 | 테스트 기간 초대 계정만 |
| daily_budget_exceeded | unavailable | 차감 안 함 | 오늘 이용량 많음 |
| ai_timeout · ai_network · ai_rate_limited · ai_unavailable · internal | unavailable | **복구됨** | 재시도 가능 |
| ai_config · ai_billing · ai_bad_request · ai_refusal | failed-precondition | **복구됨** | 재시도 불가/입력 수정 |
| ai_empty_result · ai_incomplete · storage_failed | unavailable | **복구됨** | 재시도 가능 |

실패 details: `{ reason, generationId, refunded: true, retryable, creditsRemaining }`

## getGenerationStatus
요청 `{ generationId }` → `GenerationView` (generatePost 응답과 같은 형태, credits 제외). 본인 것이 아니면 `not-found`.
`processing` 이고 lease 가 지났으면 이 자리에서 복구 후 `failed/refunded` 로 반환.
클라이언트는 새로고침·네트워크 끊김 후 이 함수 + Firestore `generations/{id}` 실시간 구독으로 결과를 이어받는다.

## ensureUserProfile ✅ (STEP 1)
요청 `{}` → `{ created, granted, credits, signupBonusStatus, signupBonusReason }`. 가입 보너스는 `freeCredits` 로 적립.

## adminAdjustCredits ✅
요청 `{ uid, delta, reason, requestId, bucket? }` — `bucket`: `free`(적립 기본) / `paid`. 회수 시 미지정이면 무료→유료 순.
응답 `{ applied, duplicate, balanceAfter, ledgerId }`.

## 환경 설정 (`functions/.env`, 비밀 아님)
| 키 | 기본값 | 설명 |
|---|---|---|
| CLAUDE_MODEL | `claude-sonnet-4-6` | 기존 v3 와 동일. 다른 모델 ID 로 교체 가능 (가격표: `src/config/pricing.js`) |
| CLAUDE_MAX_TOKENS | 8192 | 기존과 동일 |
| CLAUDE_TIMEOUT_SECONDS | 240 | Claude 호출 제한 (함수 제한 300초, lease 360초) |
| WEB_SEARCH_MAX_USES | 5 | 요청당 웹 검색 최대 횟수 (0 이면 웹 검색 끔) |
| WEB_SEARCH_TOOL_TYPE | auto | auto: 4.6 이후 모델 `web_search_20260209`, 그 외 `web_search_20250305` |
| RATE_LIMIT_PER_MINUTE | 3 | 사용자별 분당 생성 요청 |
| DAILY_GENERATION_LIMIT | 20 | 사용자별 일일(KST) 생성 요청 (실패 포함) |
| MAX_CONCURRENT_GENERATIONS | 2 | 사용자별 동시 생성 |
| STORAGE_QUOTA_MB | 200 | 사용자별 사진 보관 용량 |
| ACCESS_MODE | open | `allowlist` 면 `config/service.allowedEmails` 와 관리자만 생성 (스테이징 기본값). 설정이 없으면 관리자만 |
| DAILY_COST_LIMIT_USD | 30 | 서비스 전체 하루 AI 예상 비용 상한 (0=끔). `config/service.dailyCostLimitUsd` 가 있으면 우선 |
| ENFORCE_APP_CHECK | false | 운영 배포 전 true |

환경별 파일 (firebase-tools 가 프로젝트 별칭으로 자동 선택): `functions/.env.staging`(허용 목록·비용 상한 $10·App Check 단계 적용), `functions/.env.prod`(App Check 강제).
`functions/.env.demo-jaeinit` (에뮬레이터 전용): `AI_MOCK=true` → 실제 API 대신 mock. 운영에서는 무시됨(`FUNCTIONS_EMULATOR` 확인). `functions/.env.local`(gitignore)에 `AI_MOCK=false` 를 두면 에뮬레이터에서 실제 API 사용 (확인됨).

## 런타임 운영 스위치 — `config/service` (관리자, Firestore 콘솔에서 수정)
```json
{ "generationEnabled": false, "pauseMessage": "서비스 점검 중이에요 (14시 재개)", "dailyCostLimitUsd": 50,
  "accessMode": "allowlist", "allowedEmails": ["tester@example.com"] }
```
30초 이내 반영(인스턴스 캐시). 재배포 불필요.

## 비밀값 (Secret Manager)
```bash
npx firebase functions:secrets:set ANTHROPIC_API_KEY
```
```bash
npx firebase functions:secrets:set NAVER_CLIENT_ID
```
```bash
npx firebase functions:secrets:set NAVER_CLIENT_SECRET
```
네이버 검색을 쓰지 않으면 두 네이버 값에 `-` 를 입력 (웹 검색만 사용). `generatePost` 에만 바인딩되며 로그·응답·Firestore 에 남지 않는다.
로컬: `cp functions/.secret.local.example functions/.secret.local` 후 값 입력 (gitignore).

## createOrder / confirmPayment / tossWebhook ⬜ (STEP 3)
STEP 1 설계 유지: 서버가 `creditPackages` 금액으로 주문 생성 → 토스 승인 API(`TOSS_SECRET_KEY`, `Idempotency-Key: orderId`) → 트랜잭션으로 `paidCredits += credits`, `creditLedger/purchase_{orderId}` (bucket `paid`).
