# 사진 보관 정책 · 보안 · 비용

## 정책 (STEP 2.5 적용)
| 대상 | 보관 | 구현 |
|---|---|---|
| 저장하지 않은 생성 결과의 사진 | **생성 후 90일** 후 삭제 | `photoRetentionDaily`(매일 04:10 KST)가 만료 건 검사 → 삭제 작업 등록 |
| 저장 글(posts)이 참조하는 생성의 사진 | **글이 남아 있는 동안 유지** | 만료 시점에 `posts.generationId` 참조가 있으면 7일 뒤 재검사 (글 삭제 후 다음 검사에서 삭제) |
| 생성 실패한 요청의 사진 | 즉시 삭제 | 실패 처리 직후 삭제, 실패 시 삭제 작업으로 재시도 |
| 회원 탈퇴 | `users/{uid}/` 전체 즉시 삭제 | `deleteAccount` / Auth 삭제 트리거, 실패 시 삭제 작업 |
| 사용자별 용량 | 200MB (`STORAGE_QUOTA_MB`) | 생성 예약 시 확인, 삭제 시 `users.storageBytes` 반환 |

### 참조 관계 (삭제가 글·결과를 손상시키지 않는 이유)
- 사진은 `generations/{id}.photos` 와, 그 생성을 저장한 `posts.photos` 에서 같은 경로를 참조합니다.
- 보관 검사는 **같은 트랜잭션 안에서** 해당 생성을 참조하는 저장 글이 있는지 조회한 뒤 삭제 여부를 결정합니다.
- 삭제되는 것은 **사진 파일과 `generations.photos` 목록뿐**이고, 생성 결과(제목·본문·해시태그 등)와 저장 글 내용은 그대로입니다.
- 사진이 지워진 결과를 다시 열면 미리보기에 "보관 기간이 지나 삭제된 사진이에요" 가 표시됩니다.
- 파일을 지우면 객체 메타데이터도 함께 사라지므로 별도 토큰 정리가 필요 없습니다 (STEP 2.5 부터 다운로드 토큰 자체를 만들지 않음).

### 삭제 작업 큐 (`photoDeletionJobs`, 관리자만 읽기)
- 상태: `pending` → `running`(10분 lease) → `done` / 실패 시 `pending` 으로 지수 백오프(2·4·8·16분…, 최대 6시간) 재시도
- **5회 실패 → `failed`** + `lastError` 기록 → `processPhotoDeletionJobs` 가 Cloud Logging 에 `error` 로그 (알림 정책 연결 권장)
- 관리자 확인: Firestore 콘솔에서 `photoDeletionJobs` 를 `status == failed` 로 필터 → 원인 확인 후 `adminRetryDeletionJob({ jobId })` 호출 (또는 문서의 `status` 를 `pending`, `attempts` 를 0 으로 수정)

## 보안
- `storage.rules`: `users/{uid}/**` 는 본인(또는 admin claim)만 **읽기**, **쓰기는 모두 거부** (서버 Admin SDK 만 저장)
- 다운로드 토큰을 만들지 않음 → 토큰 URL 로 규칙을 우회한 열람 불가
- 화면은 `getBlob()`(로그인 토큰 포함 요청 → 규칙 적용) 후 `blob:` URL 로 표시
- 다른 회원의 사진 경로를 저장 글에 적어도 Storage 규칙이 읽기를 거부 (테스트 완료)

### 운영 버킷 CORS 설정 (getBlob 사용에 필요)
`storage.cors.json` 의 `YOUR_PROJECT_ID` 를 실제 값(및 사용하는 커스텀 도메인)으로 바꾼 뒤:
```bash
gcloud storage buckets update gs://<버킷 이름> --cors-file=storage.cors.json
```
버킷 이름은 Firebase 콘솔 → Storage 상단 (`<프로젝트ID>.firebasestorage.app` 형태). 설정하지 않으면 저장 글의 사진이 보이지 않습니다.

## 예상 비용 (Cloud Storage — 단가는 콘솔에서 재확인 필요)
| 가정 | 값 |
|---|---|
| 생성 1회 평균 사진 | 5장 × 350KB ≈ 1.75MB (클라이언트가 1400px·JPEG 82%로 압축) |
| 월 생성 1,000회, 저장 글 비율 30% | 미저장 사진은 90일 후 삭제 → 상시 보관량 ≈ 1.75GB×3개월 + 저장분 누적 |
| 12개월 후 상시 보관량 | ≈ 5GB(미저장 90일분) + 6.3GB(저장분 누적) ≈ 11GB |

- 저장: 약 $0.02~0.03 / GB-월 → 11GB 기준 **월 약 $0.3**
- 다운로드(egress): 저장 글을 다시 열 때 발생, 월 1~2GB 수준 → $0.1~0.3
- 작업 요청(쓰기·읽기·삭제): 월 수만 건 → 수 센트
- `scripts/cost-report.mjs` 는 생성 1건당 평균 사진 용량 × 보관 개월 수로 저장 원가를 원가에 포함합니다.

→ 사진 비용은 AI 호출 비용(생성 1회 약 $0.1 내외 추정, [AI_COST.md](AI_COST.md))의 1% 미만입니다.
