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
import { LIMIT_SIGNAL } from '../src/llm/claude-cli';
import { classifyFailure } from '../src/llm/pool';
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
  assert.equal(modelFor(withLlm({ backend: 'anthropic-api' })), 'claude-opus-5');
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
  const urls: string[] = [];
  const f = (async (url: string | URL | Request, init: RequestInit) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init.body)));
    headers.push(Object.fromEntries(new Headers(init.headers as HeadersInit).entries()));
    return new Response(JSON.stringify(responses[bodies.length - 1]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, bodies, headers, urls };
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

test('Claude Code: 읽을 폴더는 --add-dir 로만 열고, 파일 도구는 허용 목록에 넣지 않는다 (폴더 밖은 거절되게)', async () => {
  const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs');
  const dir = tempDir();
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  // 받은 인자를 기록하고 결과 한 줄을 내는 가짜 claude
  writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args.txt"\ncat > /dev/null\necho '{"type":"result","result":"ok","is_error":false}'\n`);
  chmodSync(path.join(bin, 'claude'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const { runClaudeAgent } = await import('../src/llm/claude-cli');
    await runClaudeAgent({ prompt: 'p', systemAppend: 's', tools: ['Read', 'Glob', 'Grep'], readDirs: ['/stories/a', '/stories/b'], cwd: dir });
  } finally {
    process.env.PATH = oldPath;
  }
  const args = readFileSync(path.join(dir, 'args.txt'), 'utf8').split('\n');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.ok(!args.includes('--allowedTools')); // 파일 도구만 있으면 허용 목록 없음 → 작업 폴더 밖 읽기는 dontAsk 로 거절
  assert.deepEqual(args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : [])), ['/stories/a', '/stories/b']);
});

test('연결별 계정 폴더: Claude Code 는 CLAUDE_CONFIG_DIR, Codex 는 CODEX_HOME 으로 넘긴다', async () => {
  const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs');
  const { runOnConnection } = await import('../src/llm');
  const dir = tempDir();
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "$CLAUDE_CONFIG_DIR" > "${dir}/env.txt"\ncat > /dev/null\necho '{"type":"result","result":"ok","is_error":false}'\n`);
  chmodSync(path.join(bin, 'claude'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const r = await runOnConnection(base, { id: 'c2', type: 'claude-cli', label: '', model: '', effort: '', account_dir: path.join(dir, 'acct'), enabled: true }, { prompt: 'p', systemAppend: 's', cwd: dir });
    assert.equal(r.text, 'ok');
  } finally {
    process.env.PATH = oldPath;
  }
  assert.equal(readFileSync(path.join(dir, 'env.txt'), 'utf8').trim(), path.join(dir, 'acct'));
});

test('Anthropic API (최신 모델): 새 웹 도구, 추론 성능(output_config.effort), 거절 대체(fallbacks)', async () => {
  const { f, bodies, headers, urls } = fakeFetch([{ stop_reason: 'end_turn', content: [{ type: 'text', text: '끝' }] }]);
  await runApiAgent('anthropic', { prompt: 'p', systemAppend: 's', tools: ['WebSearch'], effort: 'xhigh', cwd: tempDir() }, { apiKey: 'k', model: 'claude-opus-5', fetchImpl: f });
  assert.deepEqual(bodies[0].tools.map((t: { type: string }) => t.type), ['web_search_20260209', 'web_fetch_20260209']);
  assert.deepEqual(bodies[0].output_config, { effort: 'xhigh' });
  assert.equal(bodies[0].fallbacks, 'default');
  assert.match(headers[0]['anthropic-beta'] ?? '', /server-side-fallback-2026-07-01/);
  assert.match(urls[0], /\/v1\/messages/);
  // Haiku 는 effort 를 보내지 않는다
  const h = fakeFetch([{ stop_reason: 'end_turn', content: [{ type: 'text', text: '끝' }] }]);
  await runApiAgent('anthropic', { prompt: 'p', systemAppend: 's', effort: 'high', cwd: tempDir() }, { apiKey: 'k', model: 'claude-haiku-4-5', fetchImpl: h.f });
  assert.equal(h.bodies[0].output_config, undefined);
});

test('추론 성능: Claude Code 는 --effort, Codex 는 model_reasoning_effort (최대는 high 로)', () => {
  const dir = tempDir();
  const args = codexArgs({ prompt: 'p', systemAppend: 's', effort: 'max', cwd: dir }, path.join(dir, 'l'));
  assert.ok(args.includes('model_reasoning_effort="high"'));
});

test('한도 신호: 오류 없이 기다리려 해도 바로 잡아내고, 아무 말 없이 멈춰 있으면 넘어간다', async () => {
  // 실제로 오는 말들
  for (const t of [
    "You've hit your session limit · resets 8:20pm (Asia/Seoul)",
    'Claude usage limit reached',
    '작업 중에 사용량 한도에 도달했지만 지금은 재설정되었습니다. 중단했던 부분부터 계속 진행해 주세요.',
    '5-hour limit reached ∙ your limit will reset at 3pm',
  ]) {
    assert.ok(LIMIT_SIGNAL.test(t), t);
    assert.equal(classifyFailure(`사용량 한도에 걸렸습니다: ${t}`), 'limit');
  }
  // 평범한 자기소개서 글은 걸리지 않는다
  for (const t of ['주어진 한도 안에서 최선을 다했습니다', '예산 한도를 지켰습니다', 'API 사용량을 줄였습니다']) assert.ok(!LIMIT_SIGNAL.test(t), t);

  const dir = tempDir();
  const bin = path.join(paths.fixtures, 'llm', 'fake-codex.mjs');
  const base = { systemAppend: '지시', tools: [], cwd: dir };

  const limited = await runCodexAgent({ ...base, prompt: 'LIMIT' }, bin);
  assert.equal(limited.isError, true);
  assert.match(limited.text, /사용량 한도에 걸렸습니다/);
  assert.equal(classifyFailure(limited.text), 'limit'); // → 다음 연결로

  const stalled = await runCodexAgent({ ...base, prompt: 'SLEEP', stallMs: 300 }, bin);
  assert.equal(stalled.isError, true);
  assert.match(stalled.text, /아무 반응이 없어/);
  assert.equal(classifyFailure(stalled.text), 'unavailable'); // → 다음 연결로
});
