# 출시 전 보안 검토 (2026-11-10, STEP 2.5)

판정: ✅ 확인·조치 완료 · ⚠️ 조치했으나 실제 환경 확인 필요 · ❌ 미해결

## 1. App Check — ⚠️
- 코드: 모든 callable 에 `enforceAppCheck: ENFORCE_APP_CHECK` (기본 false), 웹은 사이트 키가 있을 때 reCAPTCHA Enterprise 로 초기화
- 에뮬레이터는 App Check 토큰을 검증하지 않아 **강제 동작은 미검증**
- 적용 순서·체크리스트: [APP_CHECK.md](APP_CHECK.md). 공개 전 반드시 `ENFORCE_APP_CHECK=true`

## 2. Storage 다운로드 URL·토큰 노출 — ✅ (이번에 수정)
- **발견**: STEP 2 는 서버가 사진마다 다운로드 토큰을 만들고 화면에서 `getDownloadURL` 로 토큰 URL 을 사용. 토큰 URL 은 **보안 규칙을 우회**해 링크만 있으면 누구나 열람 가능 (브라우저 기록·복사·공유로 유출 위험)
- **조치**: 토큰 생성 제거, 화면은 `getBlob()`(로그인 토큰 + 규칙 적용)으로 받아 `blob:` URL 로만 표시
- 운영 버킷에는 CORS 설정 필요 (`storage.cors.json` — [STORAGE.md](STORAGE.md))
- 검증: 보안 정적 테스트(토큰 생성·getDownloadURL 사용 금지), E2E(사진 src 가 `blob:`, `token=` 요청 없음)

## 3. 회원별 데이터 접근 권한 — ✅
| 데이터 | 본인 | 타인 | 관리자 | 검증 |
|---|---|---|---|---|
| users | 읽기 + 표시이름 수정 | ✗ | 읽기 | rules 테스트 |
| creditLedger / orders / generations | 읽기 | ✗ | 읽기 | rules 테스트 |
| posts | CRUD (스키마 검증) | ✗ | 읽기 | rules 테스트 |
| generationMetrics / opsDaily / photoDeletionJobs / accountDeletions | ✗ | ✗ | 읽기 | rules 테스트 (이번 추가) |
| config/service | ✗ | ✗ | 읽기·쓰기(필드 검증) | rules 테스트 |
| signupGrants | ✗ | ✗ | ✗ | rules 테스트 |
| Storage `users/{uid}/**` | 읽기 | ✗ | 읽기 | storage rules 테스트, 쓰기는 모두 ✗ |
| getGenerationStatus | 본인 기록만 | not-found | – | callable 테스트 |
- **변경**: 생성 비용·토큰을 사용자가 읽을 수 있는 `generations` 에서 관리자 전용 `generationMetrics` 로 분리 (원가 정보 노출 방지)

## 4. 요청 속도·사용량 제한 — ✅
- 사용자별: 분당 3회, 일일 20회(실패 포함), 동시 2건, 사진 200MB — 차감 전 거부 (통합 테스트)
- 서비스 전체: `DAILY_COST_LIMIT_USD`(기본 $30) 초과 시 신규 생성 중단, `config/service.generationEnabled=false` 로 **재배포 없이 즉시 중지** (이번 추가, 통합 테스트)
- 함수: `maxInstances: 10`, Claude 호출 240초 제한, 웹 검색 `max_uses` 5
- 권장: Anthropic Console 월 지출 한도 + Google Cloud 예산 알림

## 5. 함수 장애 시 크레딧 자동 복구 — ✅
- 실패 즉시 복구 / 중단 건은 lease(6분) 만료 후 조회 시 또는 5분 주기 스케줄러가 복구
- 이중 환급 방지: `status==processing` 확인 + 원장 `refund_{id}` create — 조회·스케줄러·실패처리 동시 실행 테스트에서 환급 1회 확인
- 복구 후 늦게 도착한 결과는 반영되지 않음 (함수 제한 300초 < lease 360초라 정상 흐름에서 발생 불가)

## 6. 비밀키·개인정보 로그 노출 — ✅
- 키는 Secret Manager → `generatePost`/`adminCheckAiConfig` 에만 바인딩. 응답·Firestore·로그에 키 없음 (callable·통합 테스트)
- 로그 필드는 generationId·사유 코드·HTTP 상태·토큰 수만. 정적 테스트가 `logger.*` 호출에서 입력·이메일·키·결과 필드명을 금지, `console.*` 금지
- SDK 오류 원문(메시지)은 로그·응답에 남기지 않음 (사유 코드로 변환)
- 웹 번들·git 추적 파일에 키 형태 없음 (정적 테스트)
- 주의: Firebase Auth 로그·Cloud Run 요청 로그에는 uid·IP 가 기록됨 (Google 기본 동작) — 개인정보처리방침에 명시

## 7. 기타 확인
- ✅ 이메일 미인증 사용자 생성 불가 (서버 확인)
- ✅ 회원 탈퇴: 최근 로그인(10분) 요구, 확인 문구, 사진·글·생성 기록 삭제 (Auth 삭제 트리거는 ⚠️ 에뮬레이터 미지원으로 미검증)
- ⚠️ 저장 글 `photos` 경로는 클라이언트가 임의로 쓸 수 있으나, 읽기는 Storage 규칙(본인 경로)으로 막힘
- ⚠️ CSP(Content-Security-Policy) 헤더 미적용 — Firebase·reCAPTCHA·Google Fonts 도메인을 허용하는 정책을 스테이징에서 Report-Only 로 먼저 시험 권장
- ⚠️ 사진 보관 정책의 경합: 90일 지난 미저장 생성을 삭제하는 순간 그 생성을 저장하면, 저장 글의 사진이 비어 보일 수 있음 (글 내용은 보존, 미리보기는 "보관 기간이 지나 삭제된 사진" 표시). 발생 확률이 매우 낮아 허용
