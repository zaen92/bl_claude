# 다음 개발 단계 권장 사항

## 배포 전 남은 작업 (STEP 2 마무리)
1. **실제 API 검증**: Anthropic 키 발급 → `npm run test:live` 로 품질·토큰·비용 측정 ([AI_COST.md](AI_COST.md)), Console 에서 월 지출 한도 설정
2. Firebase 실제 프로젝트(스테이징 권장)에 배포: Blaze 요금제, Storage 버킷, Secret 3종, 인덱스(`firestore:indexes`), Cloud Scheduler(스케줄 함수가 자동 생성)
3. 스테이징에서 실제 키로 수동 시나리오: 가입 → 2회 생성(사진 여러 장) → 3회째 차단 → 저장/다시 열기 → 생성 중 새로고침
4. App Check 단계 적용 (모니터링 → 강제) — [APP_CHECK.md](APP_CHECK.md)
5. 프롬프트/모델 결정: 기본 `claude-sonnet-4-6` 유지 또는 품질·비용 비교 후 `CLAUDE_MODEL` 변경 (5.x 모델은 thinking 기본값·거절 처리 차이 확인)
6. 사진 보관 기간 정책 결정 (미저장 생성 사진 90일 삭제 등) — [STORAGE.md](STORAGE.md)
7. 개인정보처리방침에 "입력 내용·사진이 AI 생성 처리를 위해 Anthropic 에 전송·서버에 보관됨" 명시

## STEP 3 — 토스페이먼츠 일회성 결제 (아직 시작하지 않음)
1. 실측 비용 기반으로 10/30/70회 가격 확정
2. `createOrder` → 결제위젯 → `confirmPayment` (서버 금액 검증, 토스 승인, `paidCredits` 적립, `purchase_{orderId}` 원장)
3. `tossWebhook` + 결제 조회 재검증, 취소/환불 정책 (사용한 크레딧 처리)
4. 전자상거래법 고지(환불 규정·사업자 정보)

## 그 외
- 관리자 화면: 사용자 검색, 원장/생성 기록·비용 조회, `adminAdjustCredits` UI
- 회원 탈퇴: 개인정보·사진 삭제 (원장·주문은 보관 기간 고려해 익명화)
- 모니터링: 생성 실패율, 복구 건수(`stale generations refunded` 로그), 일일 비용 합계 알림
- CI: GitHub Actions 에서 `npm test` (Java 21 + firebase-tools)
