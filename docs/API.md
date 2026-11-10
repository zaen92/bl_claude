# 서버 API 인터페이스 (Cloud Functions callable)

- 리전 `asia-northeast3`, 2nd gen, Node 22
- 클라이언트: `httpsCallable(functions, name)` (web/src/api.js)
- 모든 함수는 **Firebase Auth ID 토큰 필수** → 미로그인 시 `unauthenticated`
- 타입 정의: [`functions/src/api/contracts.js`](../functions/src/api/contracts.js)

| 함수 | 상태 | 권한 |
|---|---|---|
| `ensureUserProfile` | ✅ STEP 1 구현 | 로그인 |
| `adminAdjustCredits` | ✅ STEP 1 구현 | custom claim `admin == true` |
| `generatePost` | 🟡 인증·입력검증만. 에뮬레이터에서 모의 결과, 운영에서는 `unimplemented` | 로그인 + 이메일 인증 |
| `createOrder` | ⬜ 인터페이스만 (`unimplemented`) | 로그인 |
| `confirmPayment` | ⬜ 인터페이스만 (`unimplemented`) | 로그인 |
| `tossWebhook` (HTTP) | ⬜ 설계만 | 토스 서명/재조회 검증 |

---

## ensureUserProfile ✅
로그인 직후(그리고 이메일 인증 직후) 클라이언트가 호출.

요청 `{}` → 응답
```json
{ "created": true, "granted": true, "credits": 2, "signupBonusStatus": "granted", "signupBonusReason": null }
```
동작 (단일 트랜잭션):
1. `getAuth().getUser(uid)` 로 **최신** `emailVerified` 조회 (토큰 값은 오래됐을 수 있음)
2. `users/{uid}` 없으면 생성, 있으면 로그인 정보 갱신 (사용자가 바꾼 displayName 은 보존)
3. 보너스 미확정 상태이고, 이메일 인증됨 + `signupGrants/{emailHash}` 없음 → `credits += 2`, `creditLedger/signup_bonus_{uid}` **create**, `signupGrants` **create**
4. 이메일 미인증 → `pending_verification` (인증 후 다시 호출하면 지급)
5. 같은 이메일로 이미 지급 → `ineligible / email_already_used`

## adminAdjustCredits ✅
요청 `{ uid, delta(정수, ≠0, |delta|≤10000), reason(≤200자), requestId([A-Za-z0-9_-]{8,64}) }`
응답 `{ applied, duplicate, balanceAfter, ledgerId }` — 같은 requestId 재요청은 `duplicate: true` 로 무시. 잔액이 음수가 되면 `failed-precondition`.

## generatePost 🟡 (STEP 2 에서 완성)
요청 `GeneratePostRequest`
```json
{ "title": "...", "type": "맛집", "content": "...", "memo": "", "info": "", "volume": "normal",
  "images": ["data:image/jpeg;base64,..."], "clientRequestId": "req_9f2c..." }
```
검증: 제목 1~200자, 내용 1~5000자, 메모/장소 ≤2000자, 유형 9종, 분량 3종, 사진 ≤10장(dataURL, 각 ≤2MB), clientRequestId 필수.

스트리밍 청크: `{type:'status', message}` | `{type:'text', delta}` (기존 "실시간 작성 중" 박스에 표시)

응답 `GeneratePostResponse`
```json
{ "generationId": "...", "result": { /* GenerationResult */ }, "naver": null, "creditsRemaining": 1, "mock": false }
```

**STEP 2 처리 순서 (권장 설계)**
1. 검증 + `email_verified` 확인
2. 트랜잭션 ①: `generations/{uid}_{clientRequestId}` 가 이미 있으면 그 결과 반환(멱등). 없으면 `credits ≥ 1` 확인 → `credits -1`, `creditLedger/gen_{generationId}`(−1), `generations`(pending) 생성. 부족하면 `resource-exhausted`
3. 네이버 지역검색 (Secret: `NAVER_CLIENT_ID/SECRET`) → `mergePlaceInfo`
4. Claude 호출 (Secret: `ANTHROPIC_API_KEY`, `@anthropic-ai/sdk` 스트리밍) → `response.sendChunk({type:'text'})`
5. `parseGeneration` → 트랜잭션 ②: generations `succeeded` + result 저장
6. 실패(오류/타임아웃/빈 결과) → 트랜잭션 ③: `credits +1`, `creditLedger/refund_{generationId}`(+1), generations `failed`
7. 5~6 이 실행되지 못한 채 함수가 죽는 경우 대비: `pending` 이 10분 넘은 generations 를 환원하는 스케줄 함수

## createOrder ⬜ (STEP 3)
요청 `{ packageId }` → 응답 `{ orderId, amount, orderName, customerKey }`
- 가격은 **서버가 `creditPackages` 에서 읽음** (클라이언트 금액 불신)
- `orders/{orderId}` 를 `pending` 으로 생성 (금액·크레딧 스냅샷)

## confirmPayment ⬜ (STEP 3)
요청 `{ paymentKey, orderId, amount }` (토스 결제창 successUrl 쿼리) → 응답 `{ status:'paid', creditsAdded, creditsRemaining }`
1. 주문 소유자 = 호출자, `status == pending`, `amount == order.amount` 확인
2. 토스 `POST /v1/payments/confirm` (Basic 인증: `TOSS_SECRET_KEY`, `Idempotency-Key: orderId`)
3. 트랜잭션: order `paid`, `credits += order.credits`, `creditLedger/purchase_{orderId}` create (멱등)
4. 토스 승인 성공 후 3 이 실패하면 → 재시도 가능 상태로 남기고 webhook/재조회로 보정

## tossWebhook ⬜ (STEP 3, onRequest)
- 결제 상태 변경(취소/환불/가상계좌 입금) 수신 → **토스 결제 조회 API 로 재확인** 후 반영
- 환불 시 `creditLedger/refund_{orderId}` (−credits, 잔액 부족 시 정책 결정 필요)

## Secret Manager
```bash
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:secrets:set NAVER_CLIENT_ID
firebase functions:secrets:set NAVER_CLIENT_SECRET
firebase functions:secrets:set TOSS_SECRET_KEY
```
정의: `functions/src/config/secrets.js` (STEP 1 에서는 어떤 함수에도 바인딩하지 않음).
로컬 에뮬레이터에서는 `functions/.secret.local` (gitignore 됨) 에 `KEY=value` 로 둘 수 있습니다.
