# FREE / PRO 회원 정책 · 운영 설정

## 1. 정책 요약
| 항목 | FREE (신규 가입 기본) | PRO |
|---|---|---|
| 전환 | 회원가입 시 | **첫 유료 크레딧 결제 시 (STEP 3 — 아직 미구현)** |
| 유지 | — | 크레딧을 모두 써도 PRO 유지 · 월 구독 아님 |
| 가입 무료 크레딧 | 이메일 인증 후 **1회** 지급 (기본 5개) · 매월 재지급 없음 · 같은 이메일 재가입 시 재지급 없음 | — |
| AI 생성·재생성 | 1회 = 1크레딧 (실패 시 자동 복구) | 같음 (크레딧 구매로 계속 이용) |
| 계정 저장 글 | **최대 5개** (삭제하면 다시 저장 가능, 수정 저장은 개수 그대로) | 제한 없음 (서버 안정성을 위한 기술적 상한 5,000개 + 목록 30개씩 더 보기) |
| JSON 내보내기 | **가입 후 누적 5회** (월 초기화 없음) | 무제한 |
| JSON 불러오기 | 무제한 | 무제한 |
| 개인화 작성 스타일 | **1개** 저장·수정 | 여러 개 (기술적 상한 20개) |
| 크레딧이 들지 않는 것 | 결과 확인·본문 수정·복사·저장·삭제·사진 업로드/순서 변경/미리보기·JSON 내보내기/불러오기·스타일 설정 | 같음 |

한도에 도달해도 이미 저장한 글 보기·수정·복사는 계속 가능합니다. 한도 초과 시 화면에 PRO 안내 창이 열리며, **결제 버튼은 "결제 준비 중"으로 비활성화**되어 있습니다(결제·등급 변경을 흉내 내지 않음).

## 2. 서버에서만 판단합니다
- 회원 문서 `users/{uid}` 의 `plan`, `freeCredits`/`paidCredits`, `exportCount`, `savedPostCount`, `styleCount`, `upgradedAt` 은 **서버만 수정** (보안 규칙이 클라이언트 변경을 거부 — 규칙 테스트로 확인)
- 저장 글·내보내기·스타일은 callable(`savePost`, `authorizeExport`, `saveStyle`)이 **회원 문서를 읽는 Firestore 트랜잭션** 안에서 한도를 확인 → 여러 기기·탭의 동시 요청도 초과 불가 (통합 테스트: 남은 자리 2개에 6건 동시 → 정확히 2건)
- 새로고침·다른 기기에서도 같은 값 (모두 Firestore 에 저장)
- 화면의 "3 / 5개" 표시는 안내용이며, 실제 허용 여부는 항상 서버 응답으로 결정

## 3. 운영 설정 바꾸기 — `config/policy`
코드에 숫자를 고정하지 않고 Firestore `config/policy` 문서에서 읽습니다 (없으면 기본값, 범위 밖 값은 무시).

| 항목 | 기본값 | 허용 범위 |
|---|---|---|
| `signupBonusCredits` | 5 | 0 ~ 100 |
| `freeExportLimit` | 5 | 0 ~ 1000 |
| `freeSavedPostLimit` | 5 | 0 ~ 1000 |
| `freeStyleLimit` | 1 | 0 ~ 50 |
| `proSavedPostLimit` | 5000 | 1 ~ 100000 (기술적 상한) |
| `proStyleLimit` | 20 | 1 ~ 200 (기술적 상한) |

**변경 방법 (둘 중 하나)**
1. 스크립트 (미리보기 → `--apply` 로 적용):
   ```bash
   node scripts/policy.mjs --project jaeinit-staging
   ```
   ```bash
   node scripts/policy.mjs --project jaeinit-staging --set signupBonusCredits=3 --apply
   ```
   (실행 전 `gcloud auth application-default login` — 관리자 권한 계정)
2. Firebase 콘솔 → Firestore → `config` 컬렉션 → `policy` 문서에서 숫자(정수) 필드 수정 (관리자 계정만 쓰기 가능, 규칙이 범위 검증)

**적용 범위**
- 가입 무료 크레딧: 바꾼 **이후 신규 가입(지급) 시점**부터 새 값. 기존 회원의 잔액·원장은 그대로 (재지급·회수 없음)
- 저장·내보내기·스타일 한도: 바꾼 이후의 요청부터 적용. 이미 저장된 글이 새 한도보다 많아도 삭제하지 않으며, 새로 저장만 막습니다.
- 화면 안내 문구(예: "무료 크레딧 5개", "3 / 5개")는 같은 문서를 읽어 자동으로 바뀝니다 (페이지 새로고침 시).

## 4. 테스트 회원 조정 (운영 데이터와 분리)
테스트 계정의 잔액·등급만 바꾸고 `config/policy` 나 다른 회원은 건드리지 않습니다. **잔액·카운터를 Firestore 콘솔에서 직접 고치지 마세요** — 원장 합계와 잔액이 어긋납니다.
```bash
node scripts/test-member.mjs --project jaeinit-staging --email tester@example.com
```
```bash
node scripts/test-member.mjs --project jaeinit-staging --email tester@example.com --credits +10 --reason "테스트 충전" --apply
```
```bash
node scripts/test-member.mjs --project jaeinit-staging --email tester@example.com --plan pro --reason "PRO 화면 테스트" --apply
```
- 크레딧 조정 = `adminAdjustCredits` (원장에 `admin_adjust` 기록, 원장 합계 = 잔액 유지)
- 등급 변경 = `adminSetPlan` (`planSource:'admin_test'` — 실제 결제와 구분). 앱의 관리자 계정은 callable `adminSetPlan` 으로도 가능
- 내보내기 횟수를 다시 테스트하려면 새 테스트 계정을 만드세요 (카운터 직접 초기화 도구는 일부러 두지 않았습니다)
- `staging-check` 는 테스트 계정을 자동 생성·삭제하며, 가입 크레딧이 운영 설정대로 지급되는지 확인한 뒤 **테스트 계정 잔액만** 2개로 조정합니다(실제 Claude 호출 수 절약).

## 5. 기존 데이터 마이그레이션
- 이 정책 코드는 아직 어떤 Firebase 프로젝트에도 배포된 적이 없으므로 **보통 마이그레이션할 데이터가 없습니다.**
- 예전 형식 회원 문서(plan·카운터 없음)는 로그인 시 `plan:'free'` 로 채워지고, 카운터는 첫 저장·내보내기·스타일 요청 때 실제 문서 수로 계산됩니다. **기존 잔액·원장은 바꾸지 않습니다** (예전 가입자가 2크레딧을 받았어도 5개로 맞추지 않음).
- 예전 클라이언트가 직접 저장한 글(`posts`)은 그대로 읽고 수정·삭제할 수 있습니다. FREE 회원이 이미 5개를 넘게 가지고 있으면 삭제하지 않고, 개수가 한도 아래로 내려갈 때까지 새 저장만 막습니다.
- 사진 데이터 정리: [PHOTOS_AND_BACKUP.md](PHOTOS_AND_BACKUP.md) 2절 (조회 → 확인 후 적용, 임의 삭제 없음)

## 6. STEP 3 에서 할 일 (이번 단계 범위 아님)
- 토스페이먼츠 결제 확정 트랜잭션에서 `paidCredits += n`, `creditLedger/purchase_{orderId}` 와 **같은 트랜잭션**으로 `plan:'pro', planSource:'purchase', upgradedAt` 설정
- 상품 가격 확정 (실측 원가 기반 — [AI_COST.md](AI_COST.md))
- PRO 안내 창의 결제 버튼 활성화
