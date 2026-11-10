# Firestore 컬렉션 스키마

쓰기 주체: 🖥️ = Cloud Functions(Admin SDK) 전용 · 👤 = 본인 클라이언트 · 🛡️ = 관리자 클라이언트
모든 시각 필드는 Firestore `Timestamp` (서버 시간).

## users/{uid}
읽기: 본인, 관리자 · 쓰기: 🖥️ (본인은 `displayName`, `updatedAt` 만 수정 가능)

| 필드 | 타입 | 설명 |
|---|---|---|
| uid | string | Firebase Auth uid |
| email | string\|null | 로그인 이메일 |
| emailVerified | bool | Admin Auth 기준 인증 여부 |
| displayName | string | 표시 이름 (1~40자, 사용자 수정 가능) |
| photoURL | string\|null | |
| providerIds | string[] | `google.com`, `password` 등 |
| **credits** | int | **현재 잔액** — 항상 creditLedger 합계와 일치 |
| creditsUpdatedAt | Timestamp | |
| signupBonus | map | `{status: 'granted'\|'pending_verification'\|'ineligible', amount, reason?, grantedAt?}` |
| role | string | 표시용 `'user'`. **권한 판단은 custom claim `admin` 만 사용** |
| createdAt / updatedAt / lastLoginAt | Timestamp | |

## creditLedger/{entryId}  (불변 원장)
읽기: 본인(uid 일치), 관리자 · 쓰기: 🖥️ (생성만, 수정·삭제 없음)

| 필드 | 타입 | 설명 |
|---|---|---|
| uid | string | |
| type | string | `signup_bonus` `purchase` `generation` `refund` `admin_adjust` |
| delta | int | +지급 / −차감 |
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
| 생성 차감 (STEP 2) | `gen_{generationId}` |
| 생성 실패 환원 (STEP 2) | `refund_{generationId}` |
| 관리자 조정 | `admin_{requestId}` |

## creditPackages/{packageId}  (공개 상품)
읽기: 누구나 · 쓰기: 🛡️ (규칙에서 필드 타입 검증)

| 필드 | 타입 | 예시 |
|---|---|---|
| name | string | `크레딧 10회` |
| credits | int > 0 | 10 / 30 / 70 |
| price | int > 0 (원) | ⚠️ 시드값 4,900 / 12,900 / 27,900 은 **예시**, 확정 필요 |
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

## generations/{generationId}  (STEP 2 — AI 생성 기록)
읽기: 본인, 관리자 · 쓰기: 🖥️ · ID: `{uid}_{clientRequestId}` (재시도 시 중복 차감 방지)

| 필드 | 타입 | 설명 |
|---|---|---|
| uid | string | |
| status | string | `pending` → `succeeded` / `failed`(환원됨) |
| input | map | `{title, type, content, memo, info, volume, imageCount}` (사진 원본은 저장하지 않음) |
| result | map\|null | GenerationResult (아래) |
| naver | map\|null | `{name, address, tel, category}` |
| model | string | 사용한 Claude 모델 ID |
| usage | map | `{inputTokens, outputTokens}` |
| creditCharged | int | 1 |
| chargeLedgerId / refundLedgerId | string\|null | |
| error | map\|null | |
| createdAt / completedAt | Timestamp | |

## posts/{postId}  (사용자가 저장한 글)
읽기/삭제: 본인 (관리자 읽기) · 생성/수정: 👤 (규칙에서 스키마 검증)

| 필드 | 타입 | 설명 |
|---|---|---|
| uid | string | 작성자 = `request.auth.uid` 강제 |
| title | string ≤ 300 | |
| type | string ≤ 20 | 글 유형 |
| data | map | **GenerationResult — 기존 localStorage `data` 와 동일 구조** |
| generationId | string\|null | 원본 생성 기록 |
| legacyId / legacySavedAt | int\|string / string | localStorage 에서 가져온 글만 |
| createdAt / updatedAt | Timestamp | `request.time` 강제 |

### GenerationResult (기존 resultData 와 동일)
`title_1, title_2, title_3, keyword_main, keyword_sub, keyword_location, keyword_intent, place_name, place_address, place_hours, place_price, body, hashtags[], reel, thumbnail`

## signupGrants/{sha256(정규화 이메일)}  (비공개)
읽기·쓰기: 🖥️ 전용 (관리자 클라이언트도 불가)
`{uid, amount, grantedAt}` — 계정을 삭제하고 같은 이메일(Gmail 점/`+태그` 변형 포함)로 재가입해도 보너스를 다시 받지 못하게 합니다. 이메일 원문은 저장하지 않습니다.

## 인덱스
`firestore.indexes.json`: posts / creditLedger / orders / generations 의 `uid ASC + createdAt DESC` 복합 인덱스.
