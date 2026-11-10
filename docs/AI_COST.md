# AI 생성 비용 기록 · 측정

## 자동 기록 (생성마다)
`generations/{id}` 에 저장 (관리자만 전체 조회 가능, 사용자는 본인 것만):
- `usage.inputTokens / outputTokens / cacheCreationInputTokens / cacheReadInputTokens / webSearchRequests`
- `costUsd` — `functions/src/config/pricing.js` 정가 × 사용량 (예상치)
- `model`, `latencyMs`, `apiRequestCount`(pause_turn 이어쓰기 포함)
- Cloud Logging: `generation succeeded` 로그에 generationId·사용량·비용 (입력 내용·이메일·키는 기록하지 않음)

## claude-sonnet-4-6 정가 (2026-11 기준)
입력 $3 / 1M 토큰 · 출력 $15 / 1M 토큰 · 웹 검색 $10 / 1,000회

### 1회 예상 (실측 전 추정치)
| 항목 | 가정 | 비용 |
|---|---|---|
| 입력 | 프롬프트 ~1.5K + 사진 5장 × ~1.6K + 웹검색 결과 ~8K ≈ 17K 토큰 | ≈ $0.05 |
| 출력 | 본문 1,500~1,800자 + 제목·키워드·해시태그·릴스·썸네일 JSON ≈ 3~4K 토큰 | ≈ $0.05~0.06 |
| 웹 검색 | 2~3회 | ≈ $0.02~0.03 |
| **합계** | | **≈ $0.10~0.15 (약 140~210원)** |

> ⚠️ 위 값은 추정입니다. 실제 키로 아래 방법으로 측정한 뒤 크레딧 가격(STEP 3)을 정하세요. 웹 검색 결과 토큰은 검색어·결과에 따라 크게 달라집니다.

## 측정 방법
1. **단발 측정 (권장, 키 필요)**
   ```bash
   ANTHROPIC_API_KEY=sk-ant-... npm run test:live
   ```
   사진 1장 + 짧은 분량으로 실제 호출 1회 → 토큰·웹검색 횟수·`estimatedCostUsd`·소요시간 출력.
   모델 비교: `CLAUDE_MODEL=claude-sonnet-5-5 ANTHROPIC_API_KEY=... npm run test:live`
2. **운영 데이터** (관리자): Firestore 콘솔에서 `generations` 를 `status == succeeded` 로 조회해 `costUsd` 평균, 또는 BigQuery 내보내기 후 집계
3. **실제 청구액 대조**: Anthropic Console → Usage / Cost (API 키별) 와 `costUsd` 합계를 주 1회 비교 (캐시·할인·환율 차이 확인)

## 비용 통제 장치 (구현됨)
- 1크레딧 = 1회, 크레딧 없으면 호출 자체를 하지 않음
- 사용자별 분당 3회 · 일일 20회 · 동시 2건 (`functions/.env`)
- `WEB_SEARCH_MAX_USES=5`, `CLAUDE_MAX_TOKENS=8192`, 호출 시간 240초
- 함수 `maxInstances: 10`
- 권장: Anthropic Console 에서 **월 지출 한도(spend limit)** 설정, Google Cloud 예산 알림
