# 테스트

## 실행
```bash
npm run test:unit       # 순수 로직 + 실제 SDK ↔ 가짜 HTTP 서버 (에뮬레이터 불필요)
npm run test:security   # 웹 빌드 후 번들/저장소에 비밀값·외부 AI 엔드포인트 없음 확인
npm run test:emu        # Auth+Firestore+Functions+Storage 에뮬레이터: 규칙·크레딧·생성·callable
npm test                # 위 3개
npm run test:live       # ⚠️ 실제 Claude API (ANTHROPIC_API_KEY 있을 때만, 비용 발생)
```
브라우저 E2E (에뮬레이터 + `npm run dev` 실행 중):
```bash
npm i --no-save playwright && npx playwright install chromium && npm run test:e2e
```

> **mock 과 실제 API 구분**: 에뮬레이터·E2E 의 생성은 `functions/src/ai/mockClient.js`(가짜 Claude)를 사용합니다. 크레딧 예약·확정·복구, Storage, 스트리밍, 화면 흐름은 실제 코드 그대로지만 **Claude 응답은 mock** 입니다. 실제 Claude 연동은 `test:live` 로만 검증되며, 이번 작업 환경에는 API 키가 없어 **미실행**입니다.

## 최근 실행 결과 (2026-11-10)
| 묶음 | 결과 | 종류 |
|---|---|---|
| `test:unit` | **24 / 24 통과** | 단위 + SDK 와이어(가짜 서버) |
| `test:security` | **3 / 3 통과** | 정적 검사 |
| `test:emu` | **48 / 48 통과** | 에뮬레이터 (Claude = mock) |
| `test:e2e` (Chromium) | **15 / 15 확인 통과**, 콘솔 오류 0 | 브라우저 (Claude = mock) |
| `test:live` | **미실행 (skip)** — API 키 없음 | 실제 API |

## 요청하신 13개 항목 대응표
| # | 항목 | 검증 위치 | 결과 |
|---|---|---|---|
| 1 | 신규 가입 후 무료 2회 사용 | generation.test ①, callable.test, e2e | ✅ mock |
| 2 | 2회 사용 후 세 번째 차단 | generation.test ②(AI 미호출 확인), callable.test, e2e(충전 예정 안내) | ✅ mock |
| 3 | Claude API 호출 성공 | **live: 미실행**. 대체 검증: generation.test ③(요청 구성), sdk-wire.test(실제 SDK 스트림 처리, 가짜 서버) | ⚠️ 실제 미검증 |
| 4 | API 오류 시 크레딧 복구 | generation.test ④ 6종(500·529·401·refusal·빈 응답·타임아웃), sdk-wire(SDK 오류 분류), callable, e2e | ✅ mock |
| 5 | 네트워크 중단 시 상태 복구 | generation.test ⑤(함수 중단 → lease 만료 복구·스케줄러), e2e(생성 중 새로고침, 응답 유실) | ✅ mock |
| 6 | 더블클릭 중복 차감 방지 | generation.test ⑥(같은 키 5건 동시), callable(재전송), e2e(더블클릭 + 동시 3회 호출) | ✅ |
| 7 | 동시 요청 잔액 초과 방지 | generation.test ⑦(잔액 1에 4건 동시 → 1건), 동시 실행 상한 | ✅ |
| 8 | 사진 여러 장 분석 | generation.test ⑧(3장 → Storage 3개, Claude 이미지 블록 3개, [사진1~3]), e2e | ✅ mock (실제 사진 이해 품질은 미검증) |
| 9 | 생성 후 미리보기·저장 | e2e | ✅ |
| 10 | 저장 글·사진 다시 불러오기 | e2e(새로고침 후 Storage 사진 3장 로드) | ✅ |
| 11 | 다른 회원 데이터 차단 | firestore.rules(generations/posts/ledger), storage.rules(타인 사진), getGenerationStatus 타인 → not-found | ✅ |
| 12 | API 키 브라우저 노출 | security.test(번들·소스·git), callable(응답), e2e(브라우저 요청·페이지) | ✅ |
| 13 | STEP 1 회귀 | credits.test 9, firestore.rules 11, callable(가입·관리자), e2e(키 삭제·로그인·이전 글 가져오기) | ✅ |

## 추가로 검증한 것
- 속도 제한(분당)·일일 한도·저장 용량 초과 → 차감 없이 거부
- 토큰 사용량·예상 비용(sonnet-4-6 정가)·지연시간 기록, 생성 기록에 키 문자열 없음
- 무료 크레딧 우선 차감, 실패 시 **차감했던 버킷**으로 복구
- STEP 1 에서 만든 사용자 문서(버킷 필드 없음)도 정상 차감
- 모든 크레딧 테스트에서 불변식 `credits == free + paid == Σ원장` 확인
- `pause_turn` 이어쓰기, SDK `APIUserAbortError`(타임아웃) 분류 — 이 테스트로 분류 버그를 찾아 수정함

## 확인하지 못한 부분
- ❗ **실제 Claude API 호출** (키 없음): 실제 응답 품질, 웹 검색 결과, 사진 내용 분석 정확도, 실제 토큰·비용, 실제 지연시간
- ❗ **네이버 지역검색 실제 호출** (키 없음) — 코드 이전만 함
- ❗ **App Check 강제 동작** — 에뮬레이터는 토큰을 검증하지 않음. 실제 프로젝트에서 확인 필요 ([APP_CHECK.md](APP_CHECK.md))
- ❗ **실제 Firebase 프로젝트 배포** (Secret Manager 바인딩, 스케줄러, 인덱스, Storage 버킷, CORS) — 미배포
- Google 로그인 실제 팝업, 실제 이메일 발송 (STEP 1 과 동일하게 미확인)
- 대용량 사진 10장 실제 업로드 시간·함수 메모리(1GiB) 적정성, 모바일 레이아웃
