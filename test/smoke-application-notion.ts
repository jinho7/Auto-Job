// Actual Codex, synthetic browser + in-memory Notion HTTP API. No live Notion writes.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentTaskState, ApplicationBrowser } from '../src/apply/agent-tools';
const home = mkdtempSync(path.join(tmpdir(), 'autojob-notion-smoke-'));
process.env.AUTOJOB_HOME = home;
for (const key of ['NOTION_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[key];
const { paths, ROOT } = await import('../src/paths');
const { parseSettings } = await import('../src/config');
const { applicationToolset } = await import('../src/apply/agent-tools');
const { notionToolset } = await import('../src/apply/notion-tools');
const { conversationTools } = await import('../src/apply/conversation-tools');
const { startBridge } = await import('../src/apply/bridge');
const { runCodexAgent } = await import('../src/llm/codex-cli');
const { buildSystemPrompt } = await import('../src/apply/run');
const { notionFixture } = await import('./fixtures/notion-api');
const { blockText } = await import('../src/notion/client');
const settings = parseSettings(readFileSync(paths.settingsExample, 'utf8'));
const f = notionFixture();
const answers = ['사용자 요청을 정확히 듣는 개발자가 되고 싶습니다.', '테스트를 보완해 동일한 오류의 재발을 막았습니다.', '동료와 로그를 함께 읽어 원인을 찾았습니다.', '보고 방식이 달라 문서 양식을 함께 정했다는 가정한 초안입니다.', '정확성과 신뢰를 가장 중요하게 생각합니다.'];
const results: unknown[] = [];
const conversation: { kind: string; text: string }[] = [{ kind: 'ai', text: '지원서에 1~5번을 입력했습니다. 4번은 가정한 초안입니다. 비밀번호 미입력으로 임시저장을 완료하지 못했고 최종제출하지 않았습니다.' }];
try {
  for (const request of ['다 끝나면 노션에 정리까지가 마무리아님? 현재 작성한 내용을 노션에 정리해 줘.', '2번 답변을 방금 고쳤어. 노션에도 최신 답변으로 반영하고 정리됐는지 확인해 줘.']) {
    if (results.length) answers[1] = '실패한 입력을 재현하는 테스트를 추가하고 배포 전에 검증했습니다.';
    const state: AgentTaskState = { questions: [], answers: [], filled: [], notion: { available: true, verified: false } };
    let asked = 0; const calls: string[] = [];
    const tools: ApplicationBrowser = { isAnswerField: async () => true, isOwnEdit: async () => false, fill: async () => { throw new Error('이번 요청은 Notion 정리만입니다'); }, valueOf: async () => '', missingRequired: async () => ['비밀번호'], invalidateSave: async () => {}, saveObservation: async () => undefined };
    const handlers = { ask: async () => { asked++; throw new Error('Notion 정리에 사이트 인증은 필요하지 않습니다'); }, event: () => {} };
    const fixture = { list: () => [{ name: 'browser_snapshot', description: '현재 지원서 화면을 읽습니다.', inputSchema: { type: 'object' as const, properties: {} } }], call: async () => ({ content: [{ type: 'text' as const, text: `합성기업 지원서. 임시저장 실패: 비밀번호를 입력하세요. 최종제출하지 않음.\n${answers.map((a, i) => `${i + 1}. 경험을 설명해 주세요 (${800}자 이내)\n- textbox "${i + 1}번 답변" [ref=e${i + 1}]: ${a}`).join('\n')}` }] }) };
    const notion = notionToolset({ client: f.client, pageId: f.pageId, state: state.notion!, settings });
    const base = applicationToolset({ browser: conversationTools(fixture, handlers), tools, settings, state, profile: {}, request, notion, notionRequired: true,
      context: { latest_request: request, conversation, original_scope: ['basic', 'essay'], target: { company: '합성기업', notionPageId: f.pageId }, last_result: {} } });
    const bridge = await startBridge({ ...handlers, tools: { list: () => base.list(), call: async (name, args) => { calls.push(name); const result = await base.call(name, args); console.log('완료:', name); return result; } } });
    try {
      const result = await runCodexAgent({ prompt: 'context를 읽고 최신 사용자 요청을 수행하세요.', systemAppend: buildSystemPrompt(settings), effort: 'low', isolated: true, tools: [], cwd: home, signal: AbortSignal.timeout(300_000),
        onEvent: e => { if (e.type === 'tool') console.log('도구:', e.name); if (e.type === 'text') console.log(e.text.slice(0, 120)); },
        mcp: { server: 'autojob', command: process.execPath, args: [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'src/mcp/browser-server.ts')], env: { AUTOJOB_BRIDGE_URL: bridge.url, AUTOJOB_BRIDGE_TOKEN: bridge.token } } });
      assert.equal(result.isError, false, result.text); assert.equal(asked, 0);
      assert.ok(calls.includes('notion_read_page')); assert.ok(calls.includes('notion_verify'));
      const body = f.tree.get(f.pageId)!.map(blockText).join('\n');
      for (const answer of answers) assert.ok(body.includes(answer), `답변 전문 누락: ${answer}`);
      assert.match(body, /가정/); assert.match(body, /미완료|실패|미입력|미저장/);
      assert.match(body, /사용자가 직접 적은 메모/);
      assert.equal(state.notion?.verified, true); assert.equal(state.save?.ok, undefined);
      assert.equal(state.finish?.status, 'completed', JSON.stringify(state.finish));
      if (results.length) assert.ok(calls.includes('notion_update_block'), '기존 답변 갱신 도구를 사용하지 않음');
      results.push({ request, actualCodex: true, syntheticNotion: true, calls, asked, status: state.finish, finalText: result.text });
      conversation.push({ kind: 'you', text: request }, { kind: 'ai', text: result.text });
      console.log(`Notion ${results.length}차: 전문 반영·가정 표시·저장 상태 분리·재조회 확인 통과`);
    } finally { await bridge.close(); }
  }
  const out = path.join(ROOT, 'data/verification'); mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'application-notion.json'), JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2), { mode: 0o600 });
} finally { rmSync(home, { recursive: true, force: true }); }
