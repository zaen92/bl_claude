# Firestore 컬렉션 스키마

쓰기 주체: 🖥️ = Cloud Functions(Admin SDK) 전용 · 👤 = 본인 클라이언트 · 🛡️ = 관리자 클라이언트
모든 시각 필드는 Firestore `Timestamp` (서버 시간).

## users/{uid}
읽기: 본인, 관리자 · 쓰기: 🖥️ (본인은 `displayName`, `updatedAt` 만 수정 가능 — **plan·크레딧·사용량 카운터는 클라이언트가 바꿀 수 없음**)
> `plan`/카운터가 없는 예전 문서는 로그인 시 `plan:'free'` 로 채우고, 카운터는 첫 사용 때 실제 문서 수로 계산합니다 (일괄 마이그레이션 불필요).

| 필드 | 타입 | 설명 |
|---|---|---|
| uid | string | Firebase Auth uid |
| email | string\|null | 로그인 이메일 |
| emailVerified | bool | Admin Auth 기준 인증 여부 |
| displayName | string | 표시 이름 (1~40자, 사용자 수정 가능) |
| photoURL | string\|null | |
| providerIds | string[] | `google.com`, `password` 등 |
| **credits** | int | **현재 총 잔액** — 항상 `freeCredits + paidCredits` == creditLedger.delta 합계 |
| freeCredits | int | 무료 크레딧 (가입 보너스·관리자 보상). **먼저 사용** |
| paidCredits | int | 유료 구매 크레딧 (STEP 3) |
| creditsUpdatedAt | Timestamp | |
| activeGenerations | int | 처리 중인 생성 수 (동시 실행 상한 판단) |
| usage | map | `{minuteStart(ms), minuteCount, day('YYYY-MM-DD' KST), dayCount}` — 분당/일일 한도 |
| lastGenerationAt | Timestamp | |
| signupBonus | map | `{status: 'granted'\|'pending_verification'\|'ineligible', amount, reason?, grantedAt?}` — amount 는 **가입 시점의 운영 설정값**(`config/policy.signupBonusCredits`) |
| **plan** | `'free'`\|`'pro'` | 회원 등급. 신규 가입 = `free`. STEP 3 첫 유료 결제 시 `pro` (크레딧 0 이어도 유지, 구독 아님) |
| planSource | string | `signup` / `purchase`(STEP 3) / `admin_test`(관리자 테스트 설정) |
| upgradedAt | Timestamp\|null | PRO 전환 시각 |
| exportCount | int | 앱 내 JSON 내보내기 **누적** 승인 횟수 (월 초기화 없음) |
| savedPostCount | int | 계정 저장 글 수 (서버가 저장·삭제 트랜잭션에서 증감) |
| styleCount | int | 저장한 작성 스타일 수 |
| role | string | 표시용 `'user'`. **권한 판단은 custom claim `admin` 만 사용** |
| createdAt / updatedAt / lastLoginAt | Timestamp | |

## creditLedger/{entryId}  (불변 원장)
읽기: 본인(uid 일치), 관리자 · 쓰기: 🖥️ (생성만, 수정·삭제 없음)

| 필드 | 타입 | 설명 |
|---|---|---|
| uid | string | |
| type | string | `signup_bonus` `purchase` `generation` `refund` `admin_adjust` |
| delta | int | +지급 / −차감 |
| bucketDelta | map | `{free, paid}` — 어느 버킷에서 증감했는지 (생성 실패 시 같은 버킷으로 복구) |
| balanceBefore / balanceAfter | int | 반영 전/후 잔액 |
| refType / refId | string\|null | `signup`/uid, `order`/orderId, `generation`/generationId, `admin`/requestId |
| reason | string\|null | |
| actor | map | `{type:'system'\|'admin'\|'user', uid}` |
| createdAt | Timestamp | |

**문서 ID 규칙(멱등 키)** — 같은 ID 로 두 번 `create` 하면 트랜잭션이 실패하므로 이중 지급/차감이 불가능합니다.

| 종류 | ID |
|---|---|
| 가입 보너스 | `signup_bonus_{uid}` |
| 결제 지급 (STEP 3) | `purchase_{orderId}` |
| 생성 차감 | `gen_{generationId}` |
| 생성 실패 복구 | `refund_{generationId}` |
| 관리자 조정 | `admin_{requestId}` |

## creditPackages/{packageId}  (공개 상품)
읽기: 누구나 · 쓰기: 🛡️ (규칙에서 필드 타입 검증)

| 필드 | 타입 | 예시 |
|---|---|---|
| name | string | `크레딧 10회` |
| credits | int > 0 | 10 / 30 / 70 |
| price | int > 0 (원) | ⚠️ 미확정 — 실측 원가 확인 후 `seed --prices` 로 지정 (로컬 예시값만 존재) |
| currency | `'KRW'` | |
| active | bool | 판매 여부 |
| sortOrder | int | |

## orders/{orderId}  (STEP 3 — 토스페이먼츠 일회성 결제)
읽기: 본인, 관리자 · 쓰기: 🖥️

| 필드 | 타입 | 설명 |
|---|---|---|
| uid | string | |
| packageId / packageName | string | |
| credits | int | 주문 시점 상품 크레딧 (스냅샷) |
| amount | int | 주문 시점 가격 (스냅샷, 서버가 결정) |
| currency | `'KRW'` | |
| status | string | `pending` → `paid` / `failed` / `canceled` / `refunded` |
| pg | `'tosspayments'` | |
| paymentKey | string\|null | 토스 paymentKey |
| method | string\|null | 카드, 간편결제 등 |
| creditGranted | bool | 크레딧 지급 완료 여부 |
| failure | map\|null | `{code, message}` |
| createdAt / paidAt / updatedAt | Timestamp | |

## generations/{generationId}  (AI 생성 기록 — STEP 2 구현)
읽기: 본인, 관리자 · 쓰기: 🖥️ · ID: `{uid}_{clientRequestId}` (같은 요청 재전송·더블클릭 시 중복 실행/차감 방지)

| 필드 | 타입 | 설명 |
|---|---|---|
| uid / clientRequestId | string | |
| status | string | `processing`(1크레딧 예약됨) → `succeeded`(차감 확정) / `failed`(크레딧 복구됨) |
| input | map | `{title, type, content, memo, info, volume, imageCount}` — **텍스트만, 사진은 저장하지 않음** |
| style | map | 생성에 쓴 작성 스타일 스냅샷 `{preset:'jaeinit'\|'basic'\|'custom', name, blogName, greeting, closing, tone, useEmoji, extra}` (스타일 문서 ID·uid 없음) |
| result | map\|null | GenerationResult |
| naver | map\|null | `{name, address, tel, category, link}` |
| provider | string | `anthropic` / `mock`(에뮬레이터) |
| model | string | 실제 응답한 Claude 모델 ID |
| charge | map | `{status:'reserved'\|'captured'\|'refunded', amount:1, ledgerId:'gen_{id}', bucketDelta, refundLedgerId}` |

> 토큰·비용은 STEP 2.5 부터 사용자가 읽을 수 없는 `generationMetrics` 로 분리했습니다.
| error | map\|null | `{reason, message(사용자용), retryable}` — 오류 원문·개인정보 미기록 |
| leaseExpiresAt | Timestamp\|null | 처리 중 건의 만료 시각 (지나면 자동 복구) |
| createdAt / updatedAt / completedAt | Timestamp | |

## posts/{postId}  (사용자가 저장한 글)
읽기: 본인 (관리자 읽기) · 쓰기: 🖥️ **서버 callable `savePost`/`deletePost` 전용** — FREE 저장 개수 제한을 서버 트랜잭션으로 적용하기 위해 클라이언트 직접 쓰기는 규칙이 모두 거부

문서 ID: 생성 결과 저장 = `generationId`(같은 결과를 다시 저장하면 수정) · 예전 로컬 글 = `legacy_{uid}_{id}` · 그 밖(JSON 불러오기 등) = `{uid}_save_{clientSaveId}` (재전송해도 1개)

| 필드 | 타입 | 설명 |
|---|---|---|
| uid | string | 작성자 (서버가 로그인 uid 로 기록) |
| title | string ≤ 300 | |
| type | string | 글 유형 (9종 중 하나 또는 빈 값) |
| data | map | **GenerationResult — 기존 localStorage `data` 와 동일 구조** (서버가 사진 데이터·HTML 태그 제거) |
| input | map | `{title, memo, content, info, type, volume, imageCount}` 입력값 (텍스트만) |
| style | map\|null | 작성 스타일 스냅샷 (generations.style 과 같은 형식) |
| generationId | string\|null | 원본 생성 기록 |
| legacyId / legacySavedAt | string / string | localStorage 에서 가져온 글만 |
| createdAt / updatedAt | Timestamp | 서버 시간 |

## styles/{styleId}  (개인화 작성 스타일)
읽기: 본인, 관리자 · 쓰기: 🖥️ `saveStyle`/`deleteStyle` 전용 (FREE 1개, PRO 여러 개)
`uid, name(≤30), blogName(≤30), greeting(≤100), closing(≤200), tone('friendly'|'informative'|'emotional'), useEmoji(bool), extra(≤500, 추가 작성 지침), createdAt, updatedAt`
— 프리셋 `jaeinit`(기존 v3 프롬프트 그대로)·`basic`(블로그 이름·인사말 없음, 기본값)은 문서가 아니라 코드(`functions/src/ai/styles.js`)에 있습니다.

## exportGrants/{uid}_{requestId}  (JSON 내보내기 승인 기록)
읽기·쓰기: 🖥️ 전용. `uid, plan, createdAt` — 같은 requestId 재전송은 이 문서로 판별해 1회만 집계

### GenerationResult (기존 resultData 와 동일)
`title_1, title_2, title_3, keyword_main, keyword_sub, keyword_location, keyword_intent, place_name, place_address, place_hours, place_price, body, hashtags[], reel, thumbnail`

## 운영 컬렉션 (서버 전용 쓰기 · 관리자만 읽기, STEP 2.5)
### generationMetrics/{generationId}
생성 1건의 비용·품질 (입력 내용·이메일 없음, 회원 탈퇴 후에도 회계용으로 보관):
`uid, generationId, status, provider, model, type, volume, imageCount, imageBytesSent, usage{inputTokens,outputTokens,cacheCreationInputTokens,cacheReadInputTokens,webSearchRequests}, costUsd, costKnown, costBreakdown{input,output,cacheWrite,cacheRead,webSearch}, billing('full'|'none'|'partial_lower_bound'|'unknown'), aiCallStarted, apiRequestCount, latencyMs, computeUsdEst, failureReason, qualityFlags[], day('YYYY-MM-DD' KST), createdAt`

### opsDaily/{YYYY-MM-DD}  (KST)
`succeeded, failed, aiCostUsd, aiCostUsdFailed, inputTokens, outputTokens, webSearchRequests, computeUsdEst, imageBytesSentAdded, byModel{<model>:{count,costUsd}}` — 일일 비용 상한 판단

### accountDeletions/{uid}
`source('user_request'|'auth_trigger'), status('running'|'done'), posts, generations, styles, startedAt, completedAt` (탈퇴 시 posts·generations·styles·exportGrants·users 삭제)

### config/policy  (누구나 읽기 · 관리자만 쓰기 — FREE/PRO 운영 설정)
`signupBonusCredits(0~100, 기본 5), freeExportLimit(기본 5), freeSavedPostLimit(기본 5), freeStyleLimit(기본 1), proSavedPostLimit(기본 5000, 기술적 상한), proStyleLimit(기본 20), updatedAt, updatedBy`
— 문서가 없거나 값이 잘못되면 코드 기본값(`functions/src/config/policy.js`). **가입 크레딧 변경은 이후 신규 가입자에게만 적용**되고 기존 잔액·원장은 바뀌지 않습니다. 운영 방법: [PLANS_AND_LIMITS.md](PLANS_AND_LIMITS.md)

### config/service  (관리자 읽기·쓰기)
`generationEnabled(bool), pauseMessage(string ≤200), dailyCostLimitUsd(number), accessMode('open'|'allowlist'), allowedEmails(string[] ≤200)` — 재배포 없이 생성 일시중지·비용 상한·스테이징 테스터 관리

## signupGrants/{sha256(정규화 이메일)}  (비공개)
읽기·쓰기: 🖥️ 전용 (관리자 클라이언트도 불가)
`{uid, amount, grantedAt}` — 계정을 삭제하고 같은 이메일(Gmail 점/`+태그` 변형 포함)로 재가입해도 보너스를 다시 받지 못하게 합니다. 이메일 원문은 저장하지 않습니다.

## 사진
사진은 **어디에도 저장하지 않습니다** (Cloud Storage 미사용, Firestore 에는 `imageCount` 와 본문 `[사진N]` 배치만). 자세한 내용: [PHOTOS_AND_BACKUP.md](PHOTOS_AND_BACKUP.md)

## 인덱스
`firestore.indexes.json`: posts / creditLedger / orders / generations 의 `uid ASC + createdAt DESC`, styles `uid ASC + createdAt ASC`, generations `status + leaseExpiresAt`(스테일 복구).
