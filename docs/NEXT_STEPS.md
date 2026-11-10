# 다음 개발 단계 권장 사항

## STEP 2 — 서버 AI 생성 + 크레딧 차감
1. `functions` 에 `@anthropic-ai/sdk` 추가, `generatePost` 를 docs/API.md 순서대로 구현
   - `secrets: [ANTHROPIC_API_KEY, NAVER_CLIENT_ID, NAVER_CLIENT_SECRET]` 바인딩
   - 모델 ID 는 `defineString('CLAUDE_MODEL')` 같은 파라미터로 분리. 기존 v3 는 `claude-sonnet-4-6` 을 사용했으므로 그대로 시작하고, 품질/비용 비교 후 최신 모델(예: `claude-sonnet-5-5`, `claude-opus-5-5`) 전환을 검토
   - 웹 검색 서버 도구는 4.6 이후 모델에서 `web_search_20260209` 사용 가능 (기존 `web_search_20250305` 대체), `max_uses` 로 비용 제한
   - 스트리밍 + `response.sendChunk` 로 기존 "실시간 작성 중" UX 유지
2. 차감/환원 트랜잭션 + 멱등 키(`clientRequestId`) + `pending` 정리 스케줄 함수
3. 사용자별 레이트 리밋 (예: 분당 3회) — `users/{uid}` 의 lastGenerationAt 또는 별도 카운터
4. **App Check**(reCAPTCHA Enterprise) 적용 → callable `enforceAppCheck: true`
5. 클라이언트: 생성 전 잔액 0 이면 충전 안내, 결과 하단에 남은 크레딧 표시

## STEP 3 — 토스페이먼츠 일회성 결제
1. 결제위젯 SDK, `createOrder` → 결제창 → successUrl 에서 `confirmPayment`
2. `tossWebhook` (onRequest) + 결제 조회 API 재검증, 취소/환불 정책 확정 (사용한 크레딧이 있는 경우 등)
3. 상품 가격 확정 (현재 시드값은 예시), 전자상거래법 고지(환불 규정·사업자 정보) 페이지
4. 테스트 키로 결제 E2E → 라이브 키는 Secret Manager 에만

## 그 외
- 사진 영구 보관: Cloud Storage `users/{uid}/posts/{postId}/...` + Storage 보안 규칙, posts 에 경로 저장
- 관리자 화면: 사용자 검색, 원장 조회, `adminAdjustCredits` 호출 UI
- 회원 탈퇴: `beforeUserDeleted`/`onDelete` 로 개인정보 삭제(원장·주문은 법정 보관기간 고려해 익명화)
- 이메일 열거 보호(Email enumeration protection) 활성화, 비밀번호 정책 설정
- 모니터링: Cloud Logging 알림 (생성 실패율, 환원 건수, 결제 실패)
- CI: GitHub Actions 에서 `npm test` (Java 21 + firebase-tools)
