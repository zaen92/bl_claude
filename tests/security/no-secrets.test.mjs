// API 키·비밀값이 브라우저 번들/저장소에 들어가지 않았는지 검사 — `npm run test:security` (먼저 web 빌드)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = new URL('../..', import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

test('웹 번들에 Claude/네이버/토스 키·엔드포인트·위험 헤더가 없다', () => {
  const dist = join(ROOT, 'web/dist');
  assert.ok(existsSync(dist), 'web/dist 없음 — npm run build 먼저');
  const files = walk(dist).filter((f) => /\.(js|html|css|json)$/.test(f));
  const bad = [/sk-ant-[a-z0-9]/i, /api\.anthropic\.com/, /anthropic-dangerous-direct-browser-access/, /x-api-key/i, /openapi\.naver\.com/, /X-Naver-Client-Secret/i, /test_sk_|live_sk_/, /ANTHROPIC_API_KEY/];
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const re of bad) assert.ok(!re.test(s), `${f} 에 ${re} 포함`);
  }
});

test('웹 소스에 localStorage 로 API 키를 저장하는 코드가 없다 (삭제 코드만 허용)', () => {
  for (const f of walk(join(ROOT, 'web/src'))) {
    const s = readFileSync(f, 'utf8');
    assert.ok(!/setItem\(['"]jaeinit_(claude_key|naver_id|naver_sec)/.test(s), f);
  }
});

test('git 에 추적되는 파일에 실제 비밀값 형태가 없다', () => {
  const tracked = execSync('git ls-files', { cwd: ROOT }).toString().split('\n').filter(Boolean)
    .filter((f) => !f.startsWith('legacy/') && !f.endsWith('package-lock.json') && !f.startsWith('tests/'));
  for (const f of tracked) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(!/sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/.test(s), `${f}: Anthropic 키 형태`);
    assert.ok(!/(test|live)_sk_[A-Za-z0-9]{10,}/.test(s), `${f}: 토스 시크릿 키 형태`);
  }
  assert.ok(!tracked.includes('functions/.secret.local'), '.secret.local 은 커밋 금지');
});

test('Functions 로그에 입력 내용·이메일·키·토큰이 들어가지 않는다 (logger 호출 정적 검사)', () => {
  const files = [join(ROOT, 'functions/index.js'), ...walk(join(ROOT, 'functions/src'))].filter((f) => f.endsWith('.js'));
  const banned = /\b(input|content|prompt|memo|title|email|apiKey|key|secret|token|idToken|text|body|result|images?|naver)\b\s*[,}:]/;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/console\.(log|info|warn|error)\(/.test(src), `${f}: console.* 대신 logger 사용`);
    for (const m of src.matchAll(/logger(?:\s*&&\s*logger)?\.(info|warn|error|debug)\(([^;]*?)\);/gs)) {
      const argsText = m[2].replace(/'[^']*'/g, "''"); // 메시지 문자열 제외, 필드 이름만 검사
      assert.ok(!banned.test(argsText), `${f}: 로그 필드에 민감 정보 가능성 → ${m[0].slice(0, 120)}`);
    }
  }
});

test('Storage 다운로드 토큰을 만들지 않고, 웹은 getDownloadURL 을 쓰지 않는다', () => {
  const fn = readFileSync(join(ROOT, 'functions/src/storage/photos.js'), 'utf8');
  assert.ok(!/firebaseStorageDownloadTokens\s*:/.test(fn));
  for (const f of walk(join(ROOT, 'web/src'))) assert.ok(!/getDownloadURL\s*\(/.test(readFileSync(f, 'utf8')), f);
});
