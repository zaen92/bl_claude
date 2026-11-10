'use strict';
/**
 * Secret Manager 에 보관하는 비밀값 정의.
 * STEP 1 에서는 어떤 함수에도 바인딩하지 않는다 (배포 시 값 입력을 요구하지 않도록).
 * STEP 2/3 에서 함수 옵션 { secrets: [ANTHROPIC_API_KEY, ...] } 로 바인딩하고 .value() 로 읽는다.
 *
 *   firebase functions:secrets:set ANTHROPIC_API_KEY
 *   firebase functions:secrets:set NAVER_CLIENT_ID
 *   firebase functions:secrets:set NAVER_CLIENT_SECRET
 *   firebase functions:secrets:set TOSS_SECRET_KEY
 *
 * 이 값들은 절대 클라이언트 코드/Firestore/localStorage 에 두지 않는다.
 */
const { defineSecret } = require('firebase-functions/params');

module.exports = {
  ANTHROPIC_API_KEY: () => defineSecret('ANTHROPIC_API_KEY'),
  NAVER_CLIENT_ID: () => defineSecret('NAVER_CLIENT_ID'),
  NAVER_CLIENT_SECRET: () => defineSecret('NAVER_CLIENT_SECRET'),
  TOSS_SECRET_KEY: () => defineSecret('TOSS_SECRET_KEY'),
};
