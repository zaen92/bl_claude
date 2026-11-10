# 기존 코드 분석 & 모듈화 구조

원본: [`legacy/jaeinit_blog_studio_v3.html`](../legacy/jaeinit_blog_studio_v3.html) (단일 파일 783줄, 수정하지 않고 보관)

## 1. 기존 코드 분류

| 구분 | 기존 함수/영역 | 문제점 (SaaS 관점) |
|---|---|---|
| **UI** | 헤더, 좌측 입력폼(제목·유형·내용·사진·분량), 우측 3탭(결과/미리보기/저장), `st` `sv` `switchTab` `anim` `show` `renderPreview` `renderSavedList` `reset`, 복사 `cpTxt` `cpId` `cpTags` `cpAll` | 없음 — 그대로 유지 |
| **API 키 관리** | 설정 모달, `loadKeys` `saveKeys` `openSettings` `updateStatus` → `localStorage(jaeinit_claude_key / jaeinit_naver_id / jaeinit_naver_sec)` | ❌ 비밀키가 브라우저에 평문 저장, 사용자별 과금 불가 |
| **외부 API 호출** | `searchNaver` (네이버 지역검색 직접 호출), `gen` (Anthropic API 직접 호출, `anthropic-dangerous-direct-browser-access`, 스트리밍) | ❌ 키 노출, 사용량 통제·크레딧 차감 불가 |
| **데이터 처리** | `buildPrompt` (프롬프트 생성), JSON 추출 + `recover` (깨진 JSON 복구), `nl` (\\n 변환), `compress` `addImg` `reNumber` (이미지 압축) | 프롬프트가 클라이언트에 노출됨 |
| **저장** | `savePost` `getSavedPosts` `renderSavedList` → `localStorage(jaeinit_saved_posts)` | ❌ 기기 종속, 용량 한계(약 5MB), 계정 개념 없음 |

## 2. 새 구조

```
브라우저 (web/, Vite)                         Firebase
┌──────────────────────────────┐   ID 토큰   ┌──────────────────────────────────────┐
│ main.js   화면 흐름·이벤트 연결 │ ─────────▶ │ Cloud Functions (asia-northeast3)    │
│ render.js 결과/미리보기/복사    │  callable  │  ensureUserProfile  가입 크레딧 지급   │
│ images.js 사진 압축            │            │  adminAdjustCredits 관리자 조정       │
│ auth.js   Google/이메일 로그인  │            │  generatePost       (STEP 2: Claude) │
│ api.js    서버 API 호출         │            │  createOrder/confirmPayment (STEP 3) │
│ account.js 프로필·잔액·원장 조회 │            │  src/ai  buildPrompt/parse (서버 이전)│
│ posts.js  저장 글 CRUD·이전     │ ─────────▶ │ Firestore (보안 규칙)                 │
│ state.js  화면 상태             │  읽기/글쓰기 │ Secret Manager (Claude/네이버/토스 키) │
└──────────────────────────────┘            └──────────────────────────────────────┘
```

### 기존 → 신규 매핑

| 기존 | 신규 위치 | 변경 내용 |
|---|---|---|
| `<style>` | `web/src/style.css` | 그대로 복사 + 하단에 로그인/계정 모달용 클래스만 추가 (기존 색상 변수 재사용) |
| 마크업 | `web/index.html` | 동일. API 키 설정 모달 → 로그인/계정 모달, 헤더 버튼 문구만 변경 |
| `buildPrompt`, `recover`, JSON 파싱 | `functions/src/ai/prompt.js`, `parse.js` | **서버로 이전**. 프롬프트 문구 동일 (전역변수 → 인자) |
| 네이버 결과 병합 | `functions/src/ai/prompt.js#mergePlaceInfo` | 서버로 이전 (STEP 2 에서 사용) |
| `gen` | `web/src/main.js#gen` + `api.js#generatePost` → `functions/src/generation/service.js` | 브라우저는 서버 callable 만 호출. 서버가 크레딧 예약 → Claude(`src/ai/claude.js`) → 확정/복구. 스트리밍은 callable stream 으로 유지 |
| `searchNaver` | `functions/src/naver.js` | 서버로 이전 (키는 Secret Manager) |
| `show`, `renderPreview`, `cp*`, `anim`, `switchTab` | `web/src/render.js` | 동일 로직. AI 결과를 innerHTML 로 넣던 곳(위치정보·해시태그)만 HTML 이스케이프 추가 |
| `compress`, `addImg`, `reNumber` | `web/src/images.js` | 동일 |
| `savePost`, `renderSavedList` 등 | `web/src/posts.js`, `main.js` | localStorage → Firestore `posts` (카드 UI 동일) |
| `loadKeys`/`saveKeys` | 삭제 | 앱 시작 시 기존 키 3종을 localStorage 에서 **삭제** |

## 3. 데이터 유실 방지 검토

| 데이터 | 기존 보관 위치 | 처리 |
|---|---|---|
| 저장된 글 (`jaeinit_saved_posts`: `{id,title,type,date,data}`) | localStorage | 로그인 후 "저장된 글" 탭에 **계정으로 가져오기** 배너 표시. 문서 ID `legacy_{uid}_{기존id}` 로 고정 → 여러 번 눌러도 중복 없음. **localStorage 원본은 삭제하지 않음**(백업). `data` 객체는 변환 없이 그대로 저장 |
| 생성 결과 (`resultData`) | 메모리 | 동일 구조(GenerationResult) 유지 → 기존 저장 글도 그대로 불러오기/미리보기 가능 |
| 업로드 사진 (`imgs`) | 메모리 (새로고침 시 사라짐) | STEP 2: 생성 시 서버가 Cloud Storage 에 저장 → 생성 이력·저장 글에서 다시 열면 표시 ([STORAGE.md](STORAGE.md)) |
| 입력 중인 폼 | 메모리 | 기존과 동일 |
| API 키 | localStorage | 보안상 삭제. 서버 Secret Manager 로 이전 |

> ⚠️ 이전 버전에서 브라우저에 저장했던 Claude/네이버 키는 노출 가능성이 있었으므로 **재발급(rotate) 후 Secret Manager 에만 등록**하는 것을 권장합니다.
