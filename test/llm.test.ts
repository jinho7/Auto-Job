import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseSettings, type Settings } from '../src/config';
import { modelFor, testAi } from '../src/llm';
import { runApiAgent } from '../src/llm/api-agent';
import type { AgentEvent, AgentRun } from '../src/llm/claude-cli';
import { writeClaudeMcpConfig } from '../src/llm/claude-cli';
import { codexArgs, runCodexAgent } from '../src/llm/codex-cli';
import { connectMcp, type ToolHost } from '../src/llm/tool-host';
import { paths, ROOT } from '../src/paths';
import { tempDir } from './helpers';

const base = parseSettings(readFileSync(paths.settingsExample, 'utf8'));
const withLlm = (llm: Partial<Settings['llm']>): Settings => ({ ...base, llm: { ...base.llm, ...llm } });
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const echoSpec = { server: 'echo', command: TSX, args: [path.join(paths.fixtures, 'llm', 'echo-mcp.ts')], env: { ECHO_TAG: 'T' } };

test('모델: 기능별 → AI 연결 → 방식별 기본', () => {
  assert.equal(modelFor(withLlm({ backend: 'claude-cli' })), undefined);
  assert.equal(modelFor(withLlm({ backend: 'claude-cli', model: 'claude-sonnet-5' })), 'claude-sonnet-5');
  assert.equal(modelFor(withLlm({ backend: 'anthropic-api' })), 'claude-sonnet-5');
  assert.equal(modelFor(withLlm({ backend: 'openai-api', model: 'x' }), 'y'), 'y');
});

test('Claude Code: MCP 설정 파일에 alwaysLoad 와 환경 변수', () => {
  const dir = tempDir();
  const file = writeClaudeMcpConfig(echoSpec, dir);
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(cfg.mcpServers.echo.alwaysLoad, true);
  assert.deepEqual(cfg.mcpServers.echo.env, { ECHO_TAG: 'T' });
});

test('Codex: 인자(읽기 전용, 웹 검색, MCP), 지시문을 앞에 붙이고, 이벤트와 마지막 답을 읽는다', async () => {
  const dir = tempDir();
  const o: AgentRun = { prompt: '작업', systemAppend: '지시', tools: ['WebSearch'], mcp: { ...echoSpec, server: 'autojob' }, model: 'gpt-x', cwd: dir };
  const args = codexArgs(o, path.join(dir, 'last.txt'));
  assert.deepEqual(args.slice(0, 5), ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only']);
  assert.ok(args.includes('tools.web_search=true'));
  assert.ok(args.includes(`mcp_servers.autojob.command=${JSON.stringify(TSX)}`));
  assert.ok(args.includes('mcp_servers.autojob.env={ "ECHO_TAG" = "T" }'));
  assert.equal(args.at(-1), '-');
  assert.ok(!codexArgs({ ...o, tools: [], mcp: undefined }, 'x').some((a) => a.startsWith('tools.') || a.startsWith('mcp_servers')));

  const events: AgentEvent[] = [];
  const bin = path.join(paths.fixtures, 'llm', 'fake-codex.mjs');
  const r = await runCodexAgent({ ...o, onEvent: (e) => events.push(e) }, bin);
  assert.deepEqual(r, { text: '끝 {"ok":true}', isError: false });
  const call = JSON.parse(readFileSync(path.join(dir, 'fake-codex-call.json'), 'utf8'));
  assert.match(call.input, /^# 지시\n지시\n\n# 작업\n작업$/);
  assert.deepEqual(events.filter((e) => e.type === 'tool').map((e) => (e as { name: string }).name), ['snapshot']);

  const bad = await runCodexAgent({ ...o, prompt: 'FAIL' }, bin);
  assert.equal(bad.isError, true);
  assert.match(bad.text, /한도 초과/);
});

/** 정해진 응답을 차례로 돌려주는 가짜 fetch */
function fakeFetch(responses: unknown[]) {
  const bodies: any[] = [];
  const headers: Record<string, string>[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    headers.push(init.headers as Record<string, string>);
    return new Response(JSON.stringify(responses[bodies.length - 1]), { status: 200 });
  }) as typeof fetch;
  return { f, bodies, headers };
}

const fakeHost = (): ToolHost & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    tools: [{ name: 'snapshot', description: '입력칸 목록', inputSchema: { type: 'object', properties: {} } }],
    call: async (name, args) => (calls.push(`${name}:${JSON.stringify(args)}`), { text: '[f0-1] 이름', images: [{ data: 'aW1n', mimeType: 'image/jpeg' }], isError: false }),
    close: async () => {},
  };
};

test('Anthropic API: 웹 검색 서버 도구 + 우리 도구 호출을 반복하고 마지막 글을 돌려준다', async () => {
  const { f, bodies, headers } = fakeFetch([
    { stop_reason: 'tool_use', content: [{ type: 'text', text: '먼저 봅니다' }, { type: 'tool_use', id: 'tu1', name: 'snapshot', input: {} }] },
    { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: '회사' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '다 했습니다' }] },
  ]);
  const host = fakeHost();
  const events: AgentEvent[] = [];
  const r = await runApiAgent('anthropic', { prompt: '해 줘', systemAppend: '규칙', tools: ['WebSearch', 'WebFetch'], cwd: tempDir(), onEvent: (e) => events.push(e) }, { apiKey: 'k', model: 'm', fetchImpl: f, host });
  assert.deepEqual(r, { text: '다 했습니다', isError: false });
  assert.equal(bodies[0].system, '규칙');
  assert.deepEqual(bodies[0].tools.map((t: { name: string }) => t.name), ['web_search', 'web_fetch', 'snapshot']);
  assert.equal(headers[0]['x-api-key'], 'k');
  const toolResult = bodies[1].messages.at(-1).content[0];
  assert.equal(toolResult.tool_use_id, 'tu1');
  assert.deepEqual(toolResult.content.map((c: { type: string }) => c.type), ['text', 'image']);
  assert.equal(bodies[2].messages.at(-1).role, 'assistant'); // pause_turn 은 그대로 이어서
  assert.deepEqual(host.calls, ['snapshot:{}']);
  assert.deepEqual(events.filter((e) => e.type === 'tool').map((e) => (e as { name: string }).name), ['snapshot', 'web_search']);
});

test('OpenAI API: function 호출 결과를 이어서 보내고, 이미지는 다음 입력으로 붙인다', async () => {
  const { f, bodies } = fakeFetch([
    { id: 'r1', status: 'completed', output: [{ type: 'function_call', name: 'snapshot', arguments: '{}', call_id: 'c1' }] },
    { id: 'r2', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '완료' }] }] },
  ]);
  const host = fakeHost();
  const r = await runApiAgent('openai', { prompt: 'p', systemAppend: 's', tools: ['WebSearch'], cwd: tempDir() }, { apiKey: 'k', model: 'm', fetchImpl: f, host });
  assert.deepEqual(r, { text: '완료', isError: false });
  assert.equal(bodies[0].instructions, 's');
  assert.deepEqual(bodies[0].tools.map((t: { type: string }) => t.type), ['web_search', 'function']);
  assert.equal(bodies[1].previous_response_id, 'r1');
  assert.equal(bodies[1].input[0].type, 'function_call_output');
  assert.equal(bodies[1].input[1].content[0].type, 'input_image');
});

test('API: 키나 모델이 없으면 바로 알려 준다', async () => {
  await assert.rejects(runApiAgent('anthropic', { prompt: '', systemAppend: '', cwd: tempDir() }, { apiKey: '', model: 'm' }), /ANTHROPIC_API_KEY/);
  await assert.rejects(runApiAgent('openai', { prompt: '', systemAppend: '', cwd: tempDir() }, { apiKey: 'k', model: '' }), /모델/);
});

test('MCP 도구 연결: 실제 MCP 서버를 띄워 도구 목록과 글/이미지 결과를 받는다 (API 방식이 쓰는 경로)', async () => {
  const host = await connectMcp(echoSpec);
  try {
    assert.deepEqual(host.tools.map((t) => t.name), ['echo', 'shot']);
    assert.deepEqual(await host.call('echo', { text: '안녕' }), { text: 'echo:안녕:T', images: [], isError: false });
    assert.deepEqual((await host.call('shot', {})).images, [{ data: 'aGVsbG8=', mimeType: 'image/jpeg' }]);
  } finally {
    await host.close();
  }
  // runApiAgent 가 스스로 MCP 서버를 띄우고 닫는다
  const { f, bodies } = fakeFetch([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'echo', input: { text: 'x' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '끝' }] },
  ]);
  const r = await runApiAgent('anthropic', { prompt: 'p', systemAppend: 's', mcp: echoSpec, cwd: tempDir() }, { apiKey: 'k', model: 'm', fetchImpl: f });
  assert.equal(r.text, '끝');
  assert.equal(bodies[1].messages.at(-1).content[0].content[0].text, 'echo:x:T');
});

test('연결 확인: 답이 오면 성공, 오류면 이유', async () => {
  const ok = await testAi(withLlm({ backend: 'claude-cli' }), async () => ({ text: '연결됨', isError: false }));
  assert.equal(ok.ok, true);
  assert.match(ok.message, /Claude Code.*연결됨/);
  const bad = await testAi(withLlm({ backend: 'claude-cli' }), async () => ({ text: 'Invalid API key · Please run /login', isError: true }));
  assert.deepEqual([bad.ok, bad.message], [false, 'Invalid API key · Please run /login']);
});
