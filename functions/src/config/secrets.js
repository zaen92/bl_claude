'use strict';
/**
 * Secret Manager 에 보관하는 비밀값. generatePost 에 바인딩된다.
 *
 *   firebase functions:secrets:set ANTHROPIC_API_KEY
 *   firebase functions:secrets:set NAVER_CLIENT_ID       # 네이버 검색 미사용 시 값으로 "-" 입력
 *   firebase functions:secrets:set NAVER_CLIENT_SECRET   # 네이버 검색 미사용 시 값으로 "-" 입력
 *   (STEP 3) firebase functions:secrets:set TOSS_SECRET_KEY
 *
 * 로컬 에뮬레이터: functions/.secret.local 에 KEY=value (gitignore 됨)
 * 이 값들은 절대 클라이언트 코드/Firestore/localStorage/로그에 남기지 않는다.
 */
const { defineSecret } = require('firebase-functions/params');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const NAVER_CLIENT_ID = defineSecret('NAVER_CLIENT_ID');
const NAVER_CLIENT_SECRET = defineSecret('NAVER_CLIENT_SECRET');

/** 비어 있거나 "-" 이면 미설정으로 본다 */
function secretValue(s) {
  try {
    const v = (s.value() || '').trim();
    return v && v !== '-' ? v : null;
  } catch (e) {
    return null;
  }
}

module.exports = { ANTHROPIC_API_KEY, NAVER_CLIENT_ID, NAVER_CLIENT_SECRET, secretValue };
