// Actual Codex conversation replay against synthetic tools/data, no browser or portal writes.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentTaskState, ApplicationBrowser } from '../src/apply/agent-tools';
const home = mkdtempSync(path.join(tmpdir(), 'autojob-drafting-'));
process.env.AUTOJOB_HOME = home;
for (const key of ['NOTION_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[key];
const { paths, ROOT } = await import('../src/paths');
const { parseSettings } = await import('../src/config');
const { applicationToolset } = await import('../src/apply/agent-tools');
const { conversationTools } = await import('../src/apply/conversation-tools');
const { startBridge } = await import('../src/apply/bridge');
const { runCodexAgent } = await import('../src/llm/codex-cli');
const { buildSystemPrompt } = await import('../src/apply/run');
const settings = parseSettings(readFileSync(paths.settingsExample, 'utf8'));
settings.apply.save_draft = false;
settings.essay.subtitle = false;
const question = '4. 실제 세대차이로 인한 이견이나 갈등을 경험한 사례와 이를 해결하기 위해 노력한 과정을 기술해 주세요. (800자 이내)';
const scenarios = [
  { name: 'explicit-example', request: '4번 지어내줘', conversation: [{ kind: 'ask', text: '4번은 실제 세대차이 갈등 경험을 묻습니다. 상대 / 이견 / 본인이 한 행동 / 결과를 알려 주세요.' }] },
  { name: 'accept-suggested-direction', request: 'ㅇㅇ 지금 너가 말한 그런느낌이야', conversation: [
    { kind: 'you', text: '4번 지어내줘' },
    { kind: 'ask', text: '예를 들어 사회복무 때 나이 차이가 있는 담당자와 구두 보고와 문서 보고 방식이 달라서, 보고 양식을 정리해 재확인을 줄인 경험처럼 쓸 수 있습니다. 실제 경험을 알려 주세요.' },
  ] },
];
const results: unknown[] = [];
try {
  for (const scenario of scenarios) {
    let value = '', asked = 0;
    const calls: string[] = [], messages: string[] = [];
    const state: AgentTaskState = { questions: [], answers: [], filled: [] };
    const tools: ApplicationBrowser = {
      isAnswerField: async ref => ref === 'e4', isOwnEdit: async () => false,
      fill: async (_ref, text) => { value = text; return '합성 입력칸에 반영됨'; }, valueOf: async () => value,
      missingRequired: async () => [], invalidateSave: async () => {}, saveObservation: async () => undefined,
    };
    const handlers = { ask: async () => { asked++; throw new Error('동일한 사실확인 질문으로 멈췄습니다.'); }, event: () => {} };
    const fixture = { list: () => [{ name: 'browser_snapshot', description: '현재 지원서 화면을 읽습니다.', inputSchema: { type: 'object' as const, properties: {} } }], call: async () => ({ content: [{ type: 'text' as const, text: `${question}\n- textbox "4번 답변" [ref=e4]: ${value}` }] }) };
    const base = applicationToolset({ browser: conversationTools(fixture, handlers), tools, settings, state, profile: {}, request: scenario.request,
      context: { latest_request: scenario.request, conversation: scenario.conversation, original_scope: ['essay'], profile: '사회복무 경험이 있습니다. 구체적인 세대차이 갈등 사례는 기록되어 있지 않습니다.', questions: [{ id: 4, question, ref: 'e4', maxChars: 800 }] } });
    const bridge = await startBridge({ ...handlers, tools: { list: () => base.list(), call: async (name, args) => { calls.push(name); return base.call(name, args); } } });
    try {
      const result = await runCodexAgent({ prompt: 'context를 읽고 최신 사용자 요청을 수행하세요.', systemAppend: buildSystemPrompt(settings), isolated: true, tools: [], cwd: home, signal: AbortSignal.timeout(180000),
        mcp: { server: 'autojob', command: process.execPath, args: [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'src/mcp/browser-server.ts')], env: { AUTOJOB_BRIDGE_URL: bridge.url, AUTOJOB_BRIDGE_TOKEN: bridge.token } },
        onEvent: e => { if (e.type === 'text') messages.push(e.text); },
      });
      assert.equal(result.isError, false, result.text);
      assert.equal(asked, 0, `${scenario.name}: ${result.text}`);
      assert.ok(value.length >= 200 || result.text.length >= 300, `완성된 초안이 없음: ${result.text}`);
      if (value) assert.ok([...value].length <= 800, '사이트 문항 제한 초과');
      assert.match(messages.join('\n') + result.text, /가정|가상|예시|각색|사실로 확인|실제 경험으로 확인/, '가정한 경험을 사실처럼 단정하면 안 됨');
      results.push({ scenario: scenario.name, actualCodex: true, syntheticTools: true, calls, asked, answerCharacters: value.length, finalText: result.text });
      console.log(`${scenario.name}: 초안 작성, 가정 표시, 반복 질문 없음 — 통과`);
    } finally { await bridge.close(); }
  }
  const out = path.join(ROOT, 'data/verification'); mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'application-drafting.json'), JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2), { mode: 0o600 });
} finally { rmSync(home, { recursive: true, force: true }); }
