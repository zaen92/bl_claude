'use strict';
/**
 * 서버 API 인터페이스 정의 (JSDoc 타입).
 * STEP 1: ensureUserProfile, adminAdjustCredits
 * STEP 2: generatePost(실제 Claude + 네이버 + 크레딧 차감/복구), getGenerationStatus, sweepStaleGenerations
 * STEP 3: createOrder, confirmPayment, tossWebhook (현재 인터페이스만)
 * 자세한 흐름은 docs/API.md 참고.
 *
 * ── 공통 ──────────────────────────────────────────────
 * 모든 callable 은 Firebase Auth ID 토큰 필수 (미로그인 → 'unauthenticated').
 * 리전: asia-northeast3. 에러는 HttpsError(code, message, details) 형태.
 *
 * @typedef {Object} EnsureUserProfileResponse
 * @property {boolean} created          이번 호출에서 users 문서가 새로 생성됐는지
 * @property {boolean} granted          이번 호출에서 가입 보너스가 지급됐는지
 * @property {number}  credits          현재 잔액
 * @property {'granted'|'pending_verification'|'ineligible'} signupBonusStatus
 * @property {string|null} signupBonusReason
 *
 * @typedef {Object} GeneratePostRequest
 * @property {string} title
 * @property {'맛집'|'카페'|'여행'|'숙소'|'캠핑'|'미용'|'쇼핑'|'투어'|'전시'} type
 * @property {string} content
 * @property {string} [memo]
 * @property {string} [info]
 * @property {'short'|'normal'|'long'} volume
 * @property {string[]} [images]        data:image/jpeg;base64,... (최대 10장)
 * @property {string} clientRequestId   멱등 키 → generations/{uid}_{clientRequestId}
 *
 * @typedef {Object} PlaceInfo
 * @property {string} name
 * @property {string} address
 * @property {string} tel
 * @property {string} category
 *
 * @typedef {Object} GenerationResult  (기존 resultData 와 동일한 필드)
 * @property {string} title_1 @property {string} title_2 @property {string} title_3
 * @property {string} keyword_main @property {string} keyword_sub @property {string} keyword_location @property {string} keyword_intent
 * @property {string} place_name @property {string} place_address @property {string} place_hours @property {string} place_price
 * @property {string} body @property {string[]} hashtags @property {string} reel @property {string} thumbnail
 *
 * @typedef {Object} GenerationView  (generatePost / getGenerationStatus 공통)
 * @property {string} generationId       `${uid}_${clientRequestId}`
 * @property {'processing'|'succeeded'|'failed'} status
 * @property {GenerationResult|null} result
 * @property {PlaceInfo|null} naver
 * @property {number} imageCount        첨부했던 사진 장수 (사진 자체는 저장·반환하지 않음, 본문 [사진N] 배치만)
 * @property {{reason:string,message:string,retryable:boolean}|null} error
 * @property {boolean} refunded           실패 시 크레딧 복구 여부
 * @property {boolean} mock               에뮬레이터 mock AI 결과 여부
 *
 * @typedef {GenerationView & {creditsRemaining:number, usage:{inputTokens:number,outputTokens:number}, duplicate?:boolean}} GeneratePostResponse
 *   duplicate=true: 같은 clientRequestId 의 기존 결과(추가 차감 없음)
 *
 * 실패 시 HttpsError.details: { reason, generationId?, refunded?, retryable?, creditsRemaining?, retryAfterSec? }
 *   reason: insufficient_credits | rate_limited | daily_limit | too_many_concurrent | email_not_verified | service_paused | daily_budget_exceeded | not_allowlisted
 *         | ai_not_configured | ai_timeout | ai_network | ai_rate_limited | ai_unavailable | ai_config | ai_billing
 *         | ai_bad_request | ai_refusal | ai_empty_result | ai_incomplete | internal
 *
 * 스트리밍 청크(StreamChunk): { type:'status', message:string, generationId?:string } | { type:'text', delta:string }
 *
 * @typedef {Object} GetGenerationStatusRequest
 * @property {string} generationId
 *
 * @typedef {Object} CreateOrderRequest
 * @property {string} packageId          creditPackages/{packageId}
 * @typedef {Object} CreateOrderResponse
 * @property {string} orderId            토스 orderId 로 그대로 사용 (6~64자 영숫자/-/_)
 * @property {number} amount             서버가 creditPackages 에서 읽은 금액 (클라이언트 값 신뢰 X)
 * @property {string} orderName          예: "잰잇 크레딧 10회"
 * @property {string} customerKey        토스 위젯용 (uid 해시)
 *
 * @typedef {Object} ConfirmPaymentRequest
 * @property {string} paymentKey @property {string} orderId @property {number} amount
 * @typedef {Object} ConfirmPaymentResponse
 * @property {'paid'} status @property {number} creditsAdded @property {number} creditsRemaining
 *
 * @typedef {Object} AdminAdjustCreditsRequest
 * @property {string} uid @property {number} delta @property {string} reason @property {string} requestId
 */
module.exports = {};
