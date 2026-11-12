# 다음 단계 (운영자 작업 순서)

자세한 화면·명령: **[STAGING_SETUP.md](STAGING_SETUP.md)**

## A. 스테이징 + 실제 API 검증 (지금 할 일)
1. 값 결정 — STAGING_SETUP 1절 표 (프로젝트 ID, 결제 계정·예산, 리전, 워크스페이스 이름·지출 한도, 관리자·테스터 이메일)
2. Anthropic: 워크스페이스 `jaeinit-staging` 생성 → 지출 한도 → 웹 검색 사용 확인 → 워크스페이스 전용 키 발급 (2절)
3. Firebase 콘솔: 스테이징 프로젝트 생성 → Blaze·예산 알림 → 웹 앱 → Auth(이메일·Google) → Firestore(서울) (3절, Storage 불필요)
4. 터미널: `firebase login` → `gcloud auth login` / `application-default login` → `firebase use --add`(별칭 `staging`) → `functions:secrets:set` 3개 (4절)
5. `npm run preflight:staging` 모두 ✅ → (승인 후) `npm run deploy:staging` (4-1)
6. 관리자 지정, `config/service.allowedEmails` 에 테스터 (4-2), 운영 설정 확인 `node scripts/policy.mjs --project jaeinit-staging` (기본: 가입 5크레딧·저장 5·내보내기 5·스타일 1)
7. 앱의 **🛠 AI 설정 점검** → `test:live:check` → `test:live` → `staging-check --yes` (5절)
8. 비용 실측: `benchmark --count-only` → 실제 사진으로 `benchmark --yes` (사진 0/3/5/10 × 분량) → `cost-report` (평균·p95·최대·실패 비용)
9. App Check 단계 적용 → `ENFORCE_APP_CHECK=true` (6절)
10. 검증 결과(콘솔 출력·`cost-reports/` 파일)를 공유해 주시면 문제 수정·가격 검토를 이어서 진행합니다 (키 값은 공유하지 마세요)

## B. STEP 3 착수 조건
- [ ] `test:live` 통과 (텍스트·사진·웹검색·JSON)
- [ ] `staging-check` 통과 (실제 Claude 로 크레딧·사진·FREE/PRO 한도·탈퇴 시나리오)
- [ ] 사용자 지정 스타일이 실제 Claude 결과에 반영되는지 확인 (기본·잰잇·내 스타일 각 1회)
- [ ] 벤치마크로 1회당 평균·p95·최대 비용 확정, Console 청구액과 대조
- [ ] 실측 원가로 10/30/70회 가격 결정 (`cost-report --prices` 로 마진 확인) — 가입 무료 5회 원가 포함
- [ ] 개인정보처리방침·이용약관 초안 (입력·사진이 AI 분석을 위해 Anthropic 으로 전송되지만 서버에는 사진을 저장하지 않음, 탈퇴 시 삭제·보관 항목)

## C. STEP 3 — 토스페이먼츠 일회성 결제 (조건 충족 후)
- `createOrder` / 결제위젯 / `confirmPayment`(서버 금액 검증, `paidCredits` 적립, `purchase_{orderId}` 원장, **같은 트랜잭션에서 `plan:'pro'`, `planSource:'purchase'`, `upgradedAt`**) / `tossWebhook` / 환불 정책 (환불 시 PRO 유지 여부 결정 필요)
- PRO 안내 창 결제 버튼 활성화 ([PLANS_AND_LIMITS.md](PLANS_AND_LIMITS.md) 6절)
- 운영 프로젝트(별칭 `prod`) 구축 — 운영 키는 `jaeinit-prod` 워크스페이스, `functions/.env.prod`(App Check 강제)

## D. 그 외 권장
- `claude-sonnet-4-6` 은퇴(2027-02-17 이후 예정) 대비 `claude-sonnet-5-5` 비교 (`benchmark --models`)
- CSP 헤더 Report-Only 시험, Cloud Logging 알림(삭제 작업 failed, 생성 실패 급증), 관리자 화면
