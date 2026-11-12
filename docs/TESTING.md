# 테스트

## 실행
```bash
npm run test:unit       # 순수 로직 + 실제 SDK ↔ 가짜 HTTP 서버 + live 테스트 하네스 점검 (에뮬레이터 불필요)
npm run test:security   # 웹 빌드 후 번들·소스·git·로그 호출에서 비밀값/개인정보/토큰 URL 검사
npm run test:web        # JSON 내보내기·불러오기 (사진·민감정보 제외, 예전 형식 호환)
npm run test:emu        # Auth+Firestore+Functions 에뮬레이터: 규칙·크레딧·생성·안정화·callable
npm run staging-check:emu # 스테이징 종합 점검 스크립트를 에뮬레이터로 실행 (Claude=mock)
npm test                # 위 5개
npm run preflight:staging # 배포 사전 점검 (배포하지 않음)
npm run staging-check -- --project <스테이징 ID> --yes  # ⚠️ 배포된 스테이징 + 실제 Claude
npm run test:live:check # ⚠️ 실제 API — 키·모델·웹검색 지원 확인 (과금 없음, 키 필요)
npm run test:live       # ⚠️ 실제 API — 텍스트·사진·웹검색·JSON (비용 발생, 키 필요, 키 없으면 실패)
```
브라우저 E2E (에뮬레이터 + `npm run dev` 실행 중): `npm i --no-save playwright && npx playwright install chromium && npm run test:e2e`

> **mock 과 실제 API 구분**: 에뮬레이터·E2E 의 생성은 `functions/src/ai/mockClient.js`(가짜 Claude)를 사용합니다. 크레딧 예약·확정·복구, 스트리밍, 화면 흐름은 실제 코드 그대로지만 **Claude 응답은 mock** 입니다.
> 실제 Claude 연동은 `test:live` 로만 검증되며, 이 작업 환경에는 API 키가 없어 **미실행(키 없음 → 실패로 종료)** 입니다.

## 최근 실행 결과 (2026-11-12, 사진 미저장 전환 후)
| 묶음 | 결과 | 종류 |
|---|---|---|
| `test:unit` | **31 / 31 통과** | 단위, SDK 와이어(가짜 서버), live 하네스(가짜 서버), 비용 분석 |
| `test:web` | **7 / 7 통과** | JSON 내보내기·불러오기 (사진·Base64·민감정보 제외, 예전 형식 호환) |
| `test:security` | **5 / 5 통과** | 정적 검사 (Storage 미사용·생성 기록에 사진 배열 금지 포함) |
| `test:emu` | **55 / 55 통과** | 에뮬레이터 (Claude = mock) — 규칙·크레딧·생성·안정화·callable |
| `staging-check:emu` | **16 / 16 확인 통과** | 스테이징 점검 스크립트 자체 검증 (Claude = mock) |
| `test:e2e` (Chromium) | **19 / 19 확인 통과**, 콘솔 오류 0 | 브라우저 (Claude = mock) |
| 마이그레이션 스크립트 | 조회 모드 무변경 · `--apply-firestore` 시 사진 필드만 제거 확인 | 에뮬레이터 수동 실행 |
| `test:live` / `staging-check --yes` | **미실행** — API 키·배포 없음 | 실제 API·실제 Firebase |

## 1) 실제 API·실제 Firebase 로 검증한 항목
없음. (키·스테이징 프로젝트가 없음. 준비 후 [STAGING_SETUP.md](STAGING_SETUP.md) 5절 순서대로 실행)

## 2) Mock·가짜 서버로만 검증한 항목
| 항목 | 검증 위치 |
|---|---|
| 요청 구성 (모델, `web_search_20260209`, 사진→텍스트 순서, 프롬프트 원문 요소) | generation.test ③, sdk-wire |
| 실제 SDK 스트림 처리·usage 집계·오류 분류 (529/401/400/응답 도중 SSE 오류/타임아웃) | sdk-wire (가짜 HTTP 서버) |
| 응답 도중 끊김 시 부분 사용량(비용 하한) 기록 | sdk-wire, generation.test |
| live 테스트 코드 자체 (L0~L3 흐름) | live-harness (가짜 서버) |
| 무료 2회 → 0 → 3회째 차단 | generation ①②, callable, e2e |
| API 오류 6종·타임아웃 → 크레딧 복구 | generation ④ |
| 타임아웃 후 같은 요청 재전송 → 추가 차감·AI 호출 없음 | stability |
| 연결 중단(응답 유실)·새로고침 → 결과 복구, 중복 차감 없음 | e2e |
| 재요청(같은 키 5건 동시)·동시 요청(잔액 1에 4건) 정확한 잔액 | generation ⑥⑦ |
| 함수 중단 → 조회·스케줄러·실패처리 동시 복구에도 환급 1회, 늦은 결과 미반영 | stability |
| 서비스 일시중지·일일 비용 상한 → 차감 없이 거부 | stability |
| 사진 여러 장 Claude 전달·[사진N] 배치, 서버(Firestore)에 사진·Base64 없음 | generation ⑧, staging-check:emu, e2e |
| 저장 글 다시 열기 → 배치 자리만, 사진 재첨부 시 미리보기 표시 | e2e |
| JSON 내보내기·불러오기 (무료, 입력·결과 복원, 사진 미복원, 예전 형식 호환) | test:web, e2e |
| 저장 글 규칙: 텍스트 입력값만, 사진 경로·본문 Base64 거부 | firestore rules, staging-check:emu |
| 회원 탈퇴 (글·생성 기록 삭제, 원장·지표 보관, 타 회원 영향 없음, 멱등) | stability, callable, e2e |
| 비용 지표 분리(관리자 전용)·opsDaily 집계·품질 플래그 | generation, rules |
| 다른 회원 데이터 접근 차단, 운영 컬렉션 접근 제한 | firestore rules |
| 키 브라우저·로그 노출 없음, 다운로드 토큰 URL 미사용 | security, e2e |
| STEP 1·2 회귀 | credits, rules, callable, e2e |
| 벤치마크·비용 리포트 스크립트 동작 | 가짜 서버로 수동 실행 (결과 파일은 삭제) |

## 3) 검증하지 못한 항목
- ❗ **실제 Claude 호출 전부**: 텍스트 품질, 실제 JSON 준수율, 사진 내용 이해, 웹 검색 실행·결과 정확도, 실제 토큰·비용·지연시간
- ❗ **스트리밍을 중간에 끊었을 때 Anthropic 실제 과금 여부** (공식 문서에 명시 없음 → Console 로 확인 필요)
- ❗ 네이버 지역검색 실제 호출
- ❗ App Check 강제 (에뮬레이터는 토큰 미검증)
- ❗ **Auth 삭제 트리거(`onAuthUserDeleted`)** — 에뮬레이터가 "emulation error" 로 실행하지 않음. 정리 로직 자체는 테스트됨
- ❗ 실제 Firebase 배포: Secret Manager 바인딩, Cloud Scheduler(멈춘 생성 복구), 인덱스 생성
- Google 로그인 팝업, 실제 이메일 발송, 모바일 레이아웃, 사진 10장 실제 업로드 시간
