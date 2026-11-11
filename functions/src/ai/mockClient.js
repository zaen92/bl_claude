'use strict';
/**
 * 테스트·로컬 에뮬레이터 전용 Claude 대체 클라이언트. (실제 API 를 호출하지 않는다)
 * SDK 의 client.messages.stream() 과 같은 모양: 비동기 이벤트 반복 + finalMessage().
 *
 * 메모(memo)에 아래 표시를 넣어 실패 상황을 재현할 수 있다.
 *   [[mock:error]]      500 오류          [[mock:overloaded]] 529 과부하
 *   [[mock:auth]]       401 (키 오류)     [[mock:refusal]]    stop_reason=refusal
 *   [[mock:empty]]      빈 응답           [[mock:pause]]      pause_turn 1회 후 이어쓰기
 *   [[mock:slow:5000]]  5초 지연 (네트워크 끊김 테스트용)
 */
const { mockGeneration } = require('./mock');

class MockApiError extends Error {
  constructor(status, name) { super(`mock ${status}`); this.status = status; this.name = name || 'APIError'; }
}

function promptText(params) {
  const content = params.messages[0].content;
  const t = content.find((c) => c.type === 'text');
  return t ? t.text : '';
}

function createMockClient() {
  const calls = [];
  const client = {
    calls,
    models: {
      async retrieve(id) {
        return { id, type: 'model', display_name: id, max_input_tokens: 1000000, max_tokens: 128000, capabilities: { server_tools: { supported: true, web_search: { supported: true } } } };
      },
    },
    messages: {
      stream(params, opts = {}) {
        calls.push(params);
        const prompt = promptText(params);
        const memo = (/\n메모:([^\n]*)/.exec(prompt) || [])[1] || '';
        const title = (/제목:([^\n]*)/.exec(prompt) || [])[1] || '제목';
        const type = (/\n유형:([^\n]*)/.exec(prompt) || [])[1] || '맛집';
        const imageCount = params.messages[0].content.filter((c) => c.type === 'image').length;
        const continuing = params.messages.length > 1;
        const slow = /\[\[mock:slow:(\d+)\]\]/.exec(memo);
        let finalMsg = null;

        async function* events() {
          if (slow) await new Promise((r, j) => {
            const t = setTimeout(r, Number(slow[1]));
            if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; j(e); });
          });
          if (memo.includes('[[mock:error]]')) throw new MockApiError(500, 'InternalServerError');
          // 실제 API 처럼: 디코딩할 수 없는 이미지는 400 (스테이징 점검 스크립트의 실패·복구 시나리오용)
          if (params.messages[0].content.some((c) => c.type === 'image' && Buffer.from(c.source.data, 'base64').toString('latin1').startsWith('INVALID'))) throw new MockApiError(400, 'BadRequestError');
          yield { type: 'message_start', message: { id: 'msg_mock', model: params.model, usage: { input_tokens: 1800 + imageCount * 1500, output_tokens: 1 } } };
          if (memo.includes('[[mock:midstream]]')) {
            // 응답 도중 끊김 (과금이 시작된 뒤의 오류)
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"title_1":"' } };
            yield { type: 'message_delta', delta: {}, usage: { output_tokens: 120 } };
            const e = new Error('overloaded'); e.type = 'overloaded_error'; e.name = 'APIError'; throw e;
          }
          if (memo.includes('[[mock:overloaded]]')) throw new MockApiError(529, 'InternalServerError');
          if (memo.includes('[[mock:auth]]')) throw new MockApiError(401, 'AuthenticationError');
          let text = '';
          let stop = 'end_turn';
          if (memo.includes('[[mock:refusal]]')) { stop = 'refusal'; }
          else if (memo.includes('[[mock:empty]]')) { text = ''; }
          else if (memo.includes('[[mock:pause]]') && !continuing) { text = ''; stop = 'pause_turn'; }
          else {
            const r = mockGeneration({ title, type, content: prompt, imageCount });
            text = '검색 결과를 바탕으로 작성했어요.\n' + JSON.stringify(r);
          }
          for (let i = 0; i < text.length; i += 60) {
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 60) } };
          }
          finalMsg = {
            id: 'msg_mock', type: 'message', role: 'assistant', model: params.model,
            content: text ? [{ type: 'text', text }] : [{ type: 'server_tool_use', id: 'srvtoolu_mock', name: 'web_search', input: { query: title } }],
            stop_reason: stop,
            usage: {
              input_tokens: 1800 + imageCount * 1500,
              output_tokens: Math.max(1, Math.round(text.length / 2)),
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              server_tool_use: { web_search_requests: params.tools ? 2 : 0 },
            },
          };
        }
        const it = events();
        return {
          [Symbol.asyncIterator]() { return it; },
          async finalMessage() {
            if (!finalMsg) { for await (const _ of it) { /* drain */ } }
            return finalMsg;
          },
        };
      },
    },
  };
  return client;
}

module.exports = { createMockClient, MockApiError };
