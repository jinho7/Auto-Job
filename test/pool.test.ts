import './setup-env';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pickMainPid } from '../src/browser/activate';
import { importPasswords, lastImport, listProfiles } from '../src/browser/default-profile';
import { loginHelp } from '../src/apply/run';
import { parseSettings, type Settings } from '../src/config';
import { agentFor, modelForConnection } from '../src/llm';
import type { AgentRun } from '../src/llm/claude-cli';
import { addConnection, loginCommand, moveConnection, removeConnection, updateConnection } from '../src/llm/connections';
import { classifyFailure, clearConnection, parseResetTime, restingState, type Connection } from '../src/llm/pool';
import { paths } from '../src/paths';
import { connectionKeyName, getSecret, setSecret } from '../src/secrets';
import { SettingsStore } from '../src/settings/store';
import { freshSettingsFile, tempDir } from './helpers';

const base = parseSettings(readFileSync(paths.settingsExample, 'utf8'));
const conn = (id: string, type: Connection['type'] = 'claude-cli', over: Partial<Connection> = {}): Connection => ({ id, type, label: id, model: '', account_dir: '', effort: '', enabled: true, ...over });
const withConns = (connections: Connection[]): Settings => ({ ...base, llm: { ...base.llm, connections } });
const run: AgentRun = { prompt: 'p', systemAppend: 's', cwd: '/tmp' };

test('실패 종류와 한도가 풀리는 시각', () => {
  assert.equal(classifyFailure("You've hit your usage limit · resets 3pm (Asia/Seoul)"), 'limit');
  assert.equal(classifyFailure('Claude 사용량 한도에 걸려 멈췄습니다'), 'limit');
  assert.equal(classifyFailure('AI API 요청 실패 (429): rate_limit_error'), 'limit');
  assert.equal(classifyFailure('Not logged in · Please run /login'), 'auth');
  assert.equal(classifyFailure('codex 명령을 찾지 못했습니다'), 'unavailable');
  assert.equal(classifyFailure('AI 응답에서 JSON 을 찾지 못했습니다'), null);
  const now = new Date('2026-09-15T13:10:00');
  assert.equal(parseResetTime('resets 3pm', now)?.getHours(), 15);
  assert.equal(parseResetTime('resets at 9:30am', now)?.getDate(), 16); // 이미 지난 시각이면 다음 날
  assert.equal(parseResetTime('limit reached|1789999999', now)?.getTime(), 1789999999000);
  assert.equal(parseResetTime('no time', now), null);
});

test('돌려쓰기: 한도면 쉬게 하고 다음 연결로, 쉬는 연결은 건너뛰고, 시간이 지나면 다시 쓴다', async () => {
  const s = withConns([conn('a'), conn('b', 'codex-cli'), conn('c', 'anthropic-api', { enabled: false })]);
  for (const id of ['a', 'b', 'c']) clearConnection(id);
  const used: string[] = [];
  const switches: string[] = [];
  let aLimited = true;
  const agent = agentFor(s, {
    runOne: async (c) => (used.push(c.id), c.id === 'a' && aLimited ? { text: "You've hit your usage limit · resets 3pm", isError: true } : { text: `ok-${c.id}`, isError: false }),
  });
  const r1 = await agent({ ...run, onEvent: (e) => e.type === 'switch' && switches.push(e.from) });
  assert.deepEqual([r1.text, r1.connection, used], ['ok-b', 'b', ['a', 'b']]);
  assert.deepEqual(switches, ['a']);
  assert.equal(restingState('a')?.kind, 'limit');
  used.length = 0;
  const skipMsgs: string[] = [];
  await agent({ ...run, onEvent: (e) => e.type === 'switch' && skipMsgs.push(`${e.from}: ${e.reason}`) });
  assert.deepEqual(used, ['b']); // 쉬는 a 는 건너뜀, 꺼진 c 는 안 씀
  assert.equal(skipMsgs.length, 1); // 건너뛴다는 것을 대화방에 한 번은 알려 준다
  assert.match(skipMsgs[0], /사용량 한도 — .*\d{1,2}:\d{2}까지 쉬는 중이라 건너뜁니다/);
  skipMsgs.length = 0;
  await agent({ ...run, onEvent: (e) => e.type === 'switch' && skipMsgs.push(e.from) });
  assert.deepEqual(skipMsgs, []); // 같은 쉬는 시간 동안 두 번 말하지 않는다
  // 풀리는 시각 뒤에는 다시 a 부터
  aLimited = false;
  const later = agentFor(s, { runOne: async (c) => (used.push(c.id), { text: `ok-${c.id}`, isError: false }), now: () => new Date(Date.now() + 2 * 86_400_000) });
  used.length = 0;
  assert.equal((await later(run)).text, 'ok-a');
});

test('돌려쓰기: 로그인 문제도 넘어가고, 다른 오류는 넘어가지 않으며, 모두 막히면 이유를 알려 준다', async () => {
  const s = withConns([conn('x'), conn('y')]);
  for (const id of ['x', 'y']) clearConnection(id);
  const auth = agentFor(s, { runOne: async (c) => (c.id === 'x' ? Promise.reject(new Error('Not logged in · Please run /login')) : { text: 'ok', isError: false }) });
  assert.equal((await auth(run)).connection, 'y');
  clearConnection('x');
  const other = agentFor(s, { runOne: async () => ({ text: '문항을 찾지 못했습니다', isError: true }) });
  const o = await other(run);
  assert.deepEqual([o.text, o.isError, o.connection], ['문항을 찾지 못했습니다', true, 'x']); // 한도가 아닌 실패는 넘어가지 않고 그대로
  const none = agentFor(s, { runOne: async () => ({ text: 'usage limit reached', isError: true }) });
  const r = await none(run);
  assert.equal(r.isError, true);
  assert.match(r.text, /쓸 수 있는 AI 연결이 없습니다 — x: 사용량 한도 \/ y: 사용량 한도/);
});

test('모델: 연결 종류에 맞는 이름만 쓴다', () => {
  const s: Settings = { ...base, llm: { ...base.llm, model: 'claude-opus-5' } };
  assert.equal(modelForConnection(s, conn('a'), 'claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(modelForConnection(s, conn('a')), 'claude-opus-5');
  assert.equal(modelForConnection(s, conn('b', 'codex-cli'), 'claude-sonnet-5'), undefined); // Codex 에 Claude 모델은 건너뜀
  assert.equal(modelForConnection(s, conn('c', 'openai-api')), 'gpt-5');
  assert.equal(modelForConnection(s, conn('d', 'openai-api', { model: 'gpt-5-mini' }), 'claude-x'), 'gpt-5-mini');
});

test('연결 편집: 예전 설정을 첫 연결로, 같은 CLI 두 번째는 계정 폴더, 순서 바꾸기, 연결별 API 키', () => {
  const store = new SettingsStore(freshSettingsFile());
  const c2 = addConnection(store, 'claude-cli');
  let list = store.settings.llm.connections;
  assert.deepEqual(list.map((c) => [c.id, c.type, !!c.account_dir]), [['c1', 'claude-cli', false], ['c2', 'claude-cli', true]]);
  assert.match(loginCommand(c2)!, /^CLAUDE_CONFIG_DIR='.*claude-c2' claude/);
  assert.equal(loginCommand(list[0]), 'claude   # 열리면 /login 을 입력');
  const c3 = addConnection(store, 'anthropic-api');
  assert.equal(c3.account_dir, '');
  moveConnection(store, 'c3', -1);
  updateConnection(store, 'c1', { label: '내 계정', enabled: false });
  list = store.settings.llm.connections;
  assert.deepEqual(list.map((c) => c.id), ['c1', 'c3', 'c2']);
  assert.deepEqual([list[0].label, list[0].enabled], ['내 계정', false]);
  setSecret(connectionKeyName('c3'), 'sk-ant-test-000000');
  assert.equal(getSecret('LLM_KEY_C3'), 'sk-ant-test-000000');
  removeConnection(store, 'c3');
  assert.equal(getSecret('LLM_KEY_C3'), undefined); // 연결을 지우면 키도 지움
  assert.throws(() => setSecret('WHATEVER' as never, 'x'), /알 수 없는 비밀값/);
});

test('기본 프로필 비밀번호 가져오기: 비밀번호 파일만 복사, 원래 파일은 .bak, 프로필 이름 검사', async () => {
  const data = tempDir();
  mkdirSync(path.join(data, 'Profile 1'), { recursive: true });
  writeFileSync(path.join(data, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 1': { name: '내 프로필' } } } }));
  writeFileSync(path.join(data, 'Profile 1', 'Login Data'), 'SRC-LOGIN');
  mkdirSync(path.join(data, 'Profile 1', 'Network'), { recursive: true });
  writeFileSync(path.join(data, 'Profile 1', 'Network', 'Cookies'), 'SRC-COOKIES');
  assert.deepEqual(listProfiles(data), [{ dir: 'Profile 1', name: '내 프로필' }]);
  const auto = tempDir();
  mkdirSync(path.join(auto, 'Default'), { recursive: true });
  writeFileSync(path.join(auto, 'Default', 'Login Data'), 'OLD');
  const settings: Settings = { ...base, browser: { ...base.browser, aside: { ...base.browser.aside, profile_dir: auto } } };
  const r = await importPasswords({ settings, driver: 'aside', profile: 'Profile 1', dataDir: data, now: new Date('2026-09-15T00:00:00Z') });
  assert.deepEqual(r.copied, ['Login Data']);
  assert.equal(readFileSync(path.join(auto, 'Default', 'Login Data'), 'utf8'), 'SRC-LOGIN');
  assert.ok(existsSync(path.join(auto, 'Default', `Login Data.bak-${'2026-09-15T00-00-00-000Z'}`)));
  assert.ok(!existsSync(path.join(auto, 'Default', 'Network', 'Cookies'))); // 안 고르면 쿠키는 가져오지 않음
  assert.deepEqual(lastImport(settings, 'aside'), { at: '2026-09-15T00:00:00.000Z', profile: 'Profile 1', files: ['Login Data'], cookies: false });
  await assert.rejects(importPasswords({ settings, driver: 'aside', profile: '../etc', dataDir: data }), /프로필 이름/);
  await assert.rejects(importPasswords({ settings, driver: 'aside', profile: 'Default', dataDir: data }), /비밀번호 파일이 없습니다/);

  // 로그인 상태까지 고르면 쿠키도 복사하고 기록을 남긴다
  const r2 = await importPasswords({ settings, driver: 'aside', profile: 'Profile 1', cookies: true, dataDir: data, now: new Date('2026-09-16T00:00:00Z') });
  assert.deepEqual(r2.copied, ['Login Data', path.join('Network', 'Cookies')]);
  assert.equal(readFileSync(path.join(auto, 'Default', 'Network', 'Cookies'), 'utf8'), 'SRC-COOKIES');
  assert.equal(lastImport(settings, 'aside')?.cookies, true);
});

test('브라우저 본체 프로세스 고르기: 도우미(Helper)와 번호가 한 바퀴 돈 경우', () => {
  const ps = [
    '  3652 /Applications/Aside.app/Contents/Frameworks/Aside Framework.framework/Versions/1.0/Helpers/Aside Helper (Renderer).app/Contents/MacOS/Aside Helper (Renderer)',
    ' 90666 /Applications/Aside.app/Contents/MacOS/Aside',
    ' 90674 /Applications/Aside.app/Contents/Frameworks/Aside Framework.framework/Versions/1.0/Helpers/Aside Helper.app/Contents/MacOS/Aside Helper',
  ].join('\n');
  assert.equal(pickMainPid(ps, [3652, 90666, 90674]), 90666); // 번호가 가장 작은 3652 는 도우미
  assert.equal(pickMainPid('', [7, 3]), 3); // 못 찾으면 가장 작은 번호
  assert.equal(pickMainPid('', []), null);
});

test('로그인 대기 안내: 아직 안 가져왔으면 가져오라고 알려 준다', () => {
  const settings: Settings = { ...base, browser: { ...base.browser, aside: { ...base.browser.aside, profile_dir: tempDir() } } };
  assert.match(loginHelp(settings), /비밀번호 가져오기/);
  assert.match(loginHelp(settings, () => ({ at: '', profile: 'Default', files: ['Login Data'], cookies: false })), /자동 완성/);
  assert.match(loginHelp(settings, () => ({ at: '', profile: 'Default', files: ['Login Data'], cookies: true })), /로그인 상태까지/);
});
