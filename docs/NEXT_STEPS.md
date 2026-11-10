# 다음 단계

## 직접 설정해야 하는 항목
### Anthropic
1. Console 에서 운영용·개발용 API 키 분리 발급, 이전 v3 브라우저 키 폐기 ([LIVE_VERIFICATION.md](LIVE_VERIFICATION.md) 1절)
2. 월 지출 한도 설정, 웹 검색이 조직 설정에서 꺼져 있지 않은지 확인
3. `claude-sonnet-4-6` 은 2027-02-17 이후 은퇴 예정 → 출시 후 `claude-sonnet-5-5` 등과 품질·비용 비교 계획

### Firebase / Google Cloud
1. Blaze 요금제, Firestore·Storage(서울) 생성, Auth(Google·이메일) 사용 설정, 승인된 도메인
2. Secret 3종 등록: `ANTHROPIC_API_KEY`, `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` (미사용 시 `-`)
3. 배포: `npm run build && npx firebase deploy --only firestore,storage,functions,hosting` (Cloud Scheduler·Secret Manager API 사용 설정 요청이 나오면 승인)
4. 운영 버킷 CORS: `storage.cors.json` 수정 후 `gcloud storage buckets update gs://<버킷> --cors-file=storage.cors.json` ([STORAGE.md](STORAGE.md))
5. 관리자 지정: `npm run set-admin -- --project <id> <이메일>`
6. App Check: reCAPTCHA Enterprise 키 → 모니터링 → `ENFORCE_APP_CHECK=true` ([APP_CHECK.md](APP_CHECK.md))
7. Google Cloud 예산 알림, Cloud Logging 알림(`photo deletion jobs failed`, `stale generations refunded`, `generation failed` 급증)
8. (선택) `config/service` 문서 생성 — 일일 비용 상한·일시중지 스위치

## 실제 서비스 배포 전 남은 작업
1. **실제 API 검증**: `test:live:check` → `test:live` → 결과 확인 ([LIVE_VERIFICATION.md](LIVE_VERIFICATION.md))
2. **스테이징 배포 후 수동 시나리오**: 관리자 AI 점검 → 가입 → 사진 0/3장 2회 생성 → 3회째 차단 → 저장·새로고침 후 사진 확인 → 탈퇴
3. **비용 실측**: `benchmark --count-only` → `benchmark --yes --photos-dir 실제사진` → `cost-report` 로 원가·손익분기 확인. 일부러 타임아웃을 낸 호출의 Console 과금 확인
4. **상품 가격 결정** (실측 후) → STEP 3
5. 개인정보처리방침·이용약관: 입력·사진이 Anthropic 으로 전송됨, 사진 보관 90일·저장 글은 유지, 탈퇴 시 삭제 범위와 보관 항목(원장·비용 지표·이메일 해시)
6. CSP 헤더 Report-Only 시험 ([SECURITY_REVIEW.md](SECURITY_REVIEW.md))
7. 실제 환경에서 Auth 삭제 트리거 확인 (콘솔에서 테스트 계정 삭제 → `accountDeletions` 기록 확인)

## STEP 3 — 토스페이먼츠 일회성 결제 (아직 시작하지 않음)
- 실측 원가 기반 10/30/70회 가격 확정 → `createOrder` / 결제위젯 / `confirmPayment`(서버 금액 검증, `paidCredits` 적립, `purchase_{orderId}` 원장) / `tossWebhook`(재조회 검증) / 환불 정책
- 전자상거래법 고지(환불 규정·사업자 정보)
