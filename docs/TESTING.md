# 테스트

## 실행
```bash
npm run test:unit   # 순수 로직 (에뮬레이터 불필요)
npm run test:emu    # Auth + Firestore + Functions 에뮬레이터를 띄우고 규칙/통합 테스트 실행
npm test            # 둘 다
```
브라우저 스모크(선택): 에뮬레이터 + `npm run dev` 실행 후
```bash
npm i --no-save playwright && npx playwright install chromium && node tests/e2e/smoke.cjs
```

## 시나리오 목록

### 단위 (functions/test/unit) — 14개
- 이메일 정규화: 대소문자·공백·`+태그`·Gmail 점/googlemail 통합, 비정상 입력
- 프롬프트: 원본 문구·분량·사진 배치 규칙·네이버 정보 병합 형식 유지
- 응답 파싱: 정상 JSON(앞뒤 잡음), 깨진 JSON → `recover` 폴백, 필드 타입 정규화
- generatePost 입력 검증: 필수값, 유형/분량, 길이, 사진 형식/개수, clientRequestId

### 크레딧 통합 (functions/test/integration/credits.test.js) — Firestore 에뮬레이터
| # | 시나리오 | 기대 |
|---|---|---|
| 1 | 신규 인증 회원 | credits=2, 원장 `signup_bonus_{uid}` 1건 (+2, 0→2) |
| 2 | 같은 사용자 5회 연속 호출 (중복 로그인) | credits=2, 원장 1건 |
| 3 | 같은 사용자 **20건 동시 호출** | granted=true 정확히 1건, credits=2, 원장 1건 |
| 4 | **재가입**: users 문서 삭제 후 같은 이메일(`jaenit@gmail.com`, `Jae.Nit+2@googlemail.com`)로 새 uid | 미지급, `ineligible/email_already_used` |
| 5 | 이메일 미인증 → 인증 | 0 → 2, 이후 재호출해도 2 |
| 6 | 미인증 계정이 남의 이메일 선점 시도 | 실제 소유자가 인증하면 정상 지급 |
| 7 | 이메일 없는 계정 | ineligible |
| 8 | 재로그인 시 사용자가 바꾼 표시 이름 보존 | |
| 9 | 관리자 조정 | 원장 기록, requestId 멱등, 음수 잔액 거부, 없는 사용자/소수 delta 거부 |

### Callable E2E (functions/test/integration/callable.test.js) — Auth + Functions 에뮬레이터
- 비로그인: 5개 callable 모두 401 `UNAUTHENTICATED` (**미로그인 AI 생성 차단**)
- 이메일 가입 → 미인증 0 → 인증 후 8건 동시 호출 → 정확히 1번 지급, 잔액 2
- generatePost: 잘못된 입력 400, 정상 입력은 모의 결과(`[사진1]` 포함)
- createOrder: `UNIMPLEMENTED`
- adminAdjustCredits: 일반 사용자 403, admin claim 사용자 성공 + 멱등

### 보안 규칙 (tests/rules) — 11개 테스트
- 비로그인: 개인 데이터 전부 거부, 상품 목록만 공개
- users: 본인만 읽기, 생성/삭제 불가, credits/role/signupBonus 수정 불가, displayName(1~40자)만 수정
- creditLedger: 본인 항목만, uid 필터 없는 쿼리 거부, 쓰기·수정·삭제 거부
- orders/generations: 본인 읽기만, 쓰기 거부
- signupGrants: 관리자 포함 접근 불가
- creditPackages: 일반 사용자 쓰기 거부, 관리자만 유효 필드로 쓰기
- 관리자: 전체 읽기 가능하나 잔액·원장·주문 직접 쓰기 불가
- posts: 본인 CRUD, 타인 접근 거부, 스키마 위반(타인 uid·uid 변경·임의 필드·createdAt 위조·길이) 거부, legacy ID 조회 범위 제한

## 최근 실행 결과 (2026-11-10, 이 저장소의 커밋 기준)
- `npm run test:unit` — **14 / 14 통과**
- `npm run test:emu` — **26 / 26 통과** (규칙 11 + 크레딧 9 + callable 6)
- `tests/e2e/smoke.cjs` (Chromium, 에뮬레이터) — 통과, 콘솔 오류 0
  - 기존 API 키 3종 localStorage 에서 제거, 기존 저장 글은 보존
  - 비로그인 생성 클릭 → 로그인 모달 / 미인증 생성 클릭 → 인증 모달
  - 이메일 가입 → 인증 → 헤더 "크레딧 2개", 계정 모달 원장 "🎁 가입 축하 +2"
  - 사진 1장 + 생성 → 결과 카드·스트리밍 박스·미리보기 이미지 1개
  - 저장 → 저장 탭 1개 → 이전 글 2개 가져오기 → 3개, 새로고침 후에도 3개(중복 없음), localStorage 원본 2개 유지
  - 불러오기, 로그아웃 후 목록 비움

## 확인하지 못한 부분 (수동 확인 필요)
- ❗ **실제 AI 생성**: 운영 환경에서는 STEP 2 전까지 `generatePost` 가 `unimplemented` 를 반환합니다 (에뮬레이터에서만 모의 결과). 기존 v3 의 실제 생성 품질·네이버 검색은 이번 단계에서 동작하지 않습니다.
- ❗ **Google 로그인**: 코드만 구현. 에뮬레이터 팝업/실제 Google 계정 흐름은 자동 테스트하지 않았습니다.
- ❗ **실제 이메일 발송**(인증·비밀번호 재설정): 에뮬레이터 OOB 링크로만 확인했습니다.
- ❗ **실제 Firebase 프로젝트 배포**: 수행하지 않았습니다 (실 프로젝트·결제 계정 없음). 복합 인덱스 생성 포함.
- 모바일(900px 이하) 레이아웃, 클립보드 복사, Safari 등 다른 브라우저: 미확인 (CSS·로직은 원본과 동일).
- 대용량 사진 여러 장 업로드 시 callable 요청 크기(실제 Claude 전송은 STEP 2).
