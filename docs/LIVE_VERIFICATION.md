# 실제 Claude API 검증 절차

> 이 저장소의 작업 환경에는 Anthropic API 키가 없어 **실제 API 호출은 아직 한 번도 검증되지 않았습니다.**
> 아래 절차는 키를 직접 등록한 뒤 순서대로 진행하도록 만든 것입니다. 키가 없으면 `npm run test:live` 는 **실패**로 끝납니다 (성공으로 처리되지 않음).

## 0. 공식 문서로 확인한 사항 (2026-11-10)
| 항목 | 내용 | 출처 |
|---|---|---|
| 기본 모델 | `claude-sonnet-4-6` — **Active**, 은퇴 예정 *2027-02-17 이후* (최소 60일 전 통보) | platform.claude.com/docs/en/about-claude/model-deprecations |
| 요금 | 입력 $3 / 출력 $15 (1M 토큰당), 캐시 쓰기 1.25배·읽기 0.1배, 1M 컨텍스트 전 구간 동일 단가 | …/about-claude/pricing |
| 웹 검색 | `web_search_20250305`(기본) · `web_search_20260209`(동적 필터링, 4.6 이후 모델) · `web_search_20260318`(응답 포함 제어). $10 / 1,000회, **오류 난 검색은 과금 안 함**, 검색 결과는 입력 토큰으로 과금 | …/tool-use/web-search-tool |
| 웹 검색 사용 조건 | 조직 관리자가 Console 에서 끄지 않았다면 기본 사용 가능 (꺼져 있으면 400 오류) | 같은 문서 |
| 사진 | sonnet-4-6 은 표준 해상도: 장당 최대 1,568 토큰 (긴 변 1,568px). 4.7 이후 모델은 최대 4,784 토큰 → **모델 변경 시 사진 비용 최대 3배** | …/build-with-claude/vision |
| 사진 한도 | 장당 10MB(base64), 요청 128MB, 20장 초과 시 더 엄격한 크기 제한 (우리 서비스는 최대 10장) | 같은 문서 |
| 대체 후보 | `claude-sonnet-5-5` ($2/$10, 은퇴 2027-09-28 이후), `claude-opus-5-5` ($4/$20). 5.x 는 tokenizer 가 달라 같은 글도 토큰이 약 30% 더 나옴 | 모델 개요·가격 문서 |

`web_search_20260209` 은 동적 필터링을 위해 내부적으로 코드 실행을 사용합니다 (추가 요금 없음, 토큰만 과금). 이 서비스는 `WEB_SEARCH_TOOL_TYPE=auto` 로 이 버전을 사용합니다.

## 1. Anthropic API 키 만들기
1. [Claude Console](https://platform.claude.com) 로그인 → **Settings → API Keys → Create Key**
   - 이름 예: `jaeinit-prod-functions` (운영), `jaeinit-dev` (개발) — **운영과 개발 키를 분리**
   - 생성 직후 한 번만 표시되므로 바로 다음 단계에서 등록
2. **Settings → Limits** 에서 월 지출 한도(spend limit) 설정 (예: 첫 달 $50)
3. **Settings → Capabilities** 에서 웹 검색이 꺼져 있지 않은지 확인
4. 이전 버전(v3)에서 브라우저에 넣었던 키가 있다면 **Console 에서 삭제(revoke)** 하세요

## 2. Secret Manager 에 등록 (키는 화면·파일·채팅에 붙여넣지 마세요)
```bash
npx firebase use <프로젝트ID>
```
```bash
npx firebase functions:secrets:set ANTHROPIC_API_KEY
```
프롬프트가 나오면 키를 붙여넣고 Enter (입력값은 화면에 표시되지 않음). 네이버 검색을 쓰지 않으면 아래 두 값에 `-` 입력:
```bash
npx firebase functions:secrets:set NAVER_CLIENT_ID
```
```bash
npx firebase functions:secrets:set NAVER_CLIENT_SECRET
```
등록 확인 (값은 출력되지 않음):
```bash
npx firebase functions:secrets:get ANTHROPIC_API_KEY
```
키를 바꾼 뒤에는 Functions 를 다시 배포해야 새 버전이 적용됩니다 (`npx firebase deploy --only functions`). 이전 버전은 `npx firebase functions:secrets:prune` 으로 정리.

## 3. 로컬에서 실제 API 검증 (`test:live`)
키를 셸 기록에 남기지 않도록 Secret Manager 에서 바로 읽어 환경변수로 넘깁니다 (gcloud CLI 필요, 권한: Secret Manager Secret Accessor):
```bash
ANTHROPIC_API_KEY="$(gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY --project=<프로젝트ID>)" npm run test:live:check
```
`test:live:check` 는 키 형식·모델 ID·웹 검색 지원만 확인합니다 (**과금 없음**). 통과하면 전체 검증:
```bash
ANTHROPIC_API_KEY="$(gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY --project=<프로젝트ID>)" npm run test:live
```
| 단계 | 확인 내용 | 예상 비용 |
|---|---|---|
| L0 | 키 형식, `models.retrieve(claude-sonnet-4-6)`, 웹 검색 지원 | 0 |
| L1 텍스트 | 사진·검색 없이 블로그 생성 → **엄격한 JSON 파싱** + 필수 필드·해시태그·마크다운 금지 검사 | ≈ $0.04 |
| L2 사진 | 빨강/파랑 단색 사진 색상 맞히기(이미지 전달 확인) + 사진 3장 → 본문 `[사진1~3]` 배치 | ≈ $0.06 |
| L3 웹 검색 | 실제 업장(명동교자) → `usage.server_tool_use.web_search_requests ≥ 1`, 주소 채움 여부 | ≈ $0.08 |

출력되는 `[live:...]` 줄에 토큰·예상 비용·경고(분량, 인사말 누락 등)가 나옵니다. 마지막 `[live:total]` 이 이번 실행의 예상 비용입니다.
네이버 검색까지 확인하려면 `NAVER_CLIENT_ID=… NAVER_CLIENT_SECRET=…` 를 같은 방식으로 추가.

> 테스트 코드 자체는 가짜 Anthropic 서버로 점검되어 있습니다 (`functions/test/unit/live-harness.test.js`) — 실제 API 검증은 아닙니다.

## 4. 로컬 앱에서 실제 Claude 로 전체 흐름 확인 (크레딧 차감 포함)
1. `functions/.secret.local` 에 실제 키 (gitignore 됨):
   ```
   ANTHROPIC_API_KEY=<개발용 키>
   NAVER_CLIENT_ID=-
   NAVER_CLIENT_SECRET=-
   ```
2. `functions/.env.local` 생성 (에뮬레이터에서 `.env.demo-jaeinit` 보다 우선):
   ```
   AI_MOCK=false
   ```
3. `npm run emulators:clean` + `npm run dev` → 가입·인증 → 사진 0/3장으로 2회 생성 → 3회째 차단 → 저장·다시 열기
4. 끝나면 `functions/.env.local` 삭제 (다시 mock 으로)

## 5. 배포 후 스테이징 확인
1. 관리자 계정 지정: `npm run set-admin -- --project <id> <이메일>` → 재로그인
2. 앱 → 👤 내 계정 → **🛠 AI 설정 점검 (관리자)**: 키 ✅ 형식 ✅ 모델 ✅ 웹검색 ✅ 확인 (생성 비용 없음)
3. 테스트 계정으로 실제 생성 2회 → Firestore `generationMetrics` 에서 토큰·`costUsd` 확인
4. Anthropic Console → Usage 에서 같은 시간대 사용량과 `costUsd` 합계 대조

## 6. 비용 측정 (상품 가격 결정 전)
무료 사전 측정 (입력 토큰만):
```bash
ANTHROPIC_API_KEY="$(gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY --project=<프로젝트ID>)" npm run benchmark -- --count-only
```
실제 측정 (사진 0/3/5/10장 × 짧은/보통/긴 글 = 12회, 약 $1.5~3 예상). 실제 사진 폴더를 쓰는 것을 권장:
```bash
ANTHROPIC_API_KEY="$(gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY --project=<프로젝트ID>)" npm run benchmark -- --yes --photos-dir ./samples
```
모델 비교: `--models claude-sonnet-4-6,claude-sonnet-5-5`. 결과는 `cost-reports/` (gitignore).
손익 계산 (가격은 확정하지 않음 — 손익분기·목표 마진 가격만 계산):
```bash
npm run cost-report -- --benchmark cost-reports/benchmark-<시각>.json --usd-krw <환율> --pg-fee <PG 수수료율>
```
