import './setup-env';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { formatDoctor, runDoctor } from '../src/doctor';
import { ensureInitialized } from '../src/init';
import { paths } from '../src/paths';
import { setSecret } from '../src/secrets';
import { SettingsStore } from '../src/settings/store';

const deps = { version: async (bin: string) => (bin === 'claude' ? '2.1.0 (Claude Code)' : null), cdpUp: async () => false };
const by = (checks: Awaited<ReturnType<typeof runDoctor>>) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

test('점검: 설치 직후에는 할 일을 알려 주고, 채우면 완료로 바뀐다', async () => {
  rmSync(paths.settings, { force: true });
  const none = await runDoctor(deps);
  assert.deepEqual(by(none), { node: 'ok', settings: 'bad' });
  assert.match(formatDoctor(none), /autojob init/);

  ensureInitialized();
  const fresh = await runDoctor(deps);
  assert.equal(by(fresh).profile, 'warn'); // 필수 항목 비어 있음
  assert.equal(by(fresh).keywords, 'warn');
  assert.equal(by(fresh).notion, 'warn');
  assert.equal(by(fresh).ai, 'ok'); // claude 있음
  assert.match(fresh.find((c) => c.id === 'sources')!.detail, /잡코리아/);

  const store = new SettingsStore(paths.settings);
  store.addToList('collect.keywords', ['백엔드']);
  store.set('llm.backend', 'codex-cli');
  setSecret('NOTION_TOKEN', 'ntn_test_token_1234567890');
  store.set('notion.data_source_id', 'ds1');
  const later = await runDoctor(deps);
  assert.equal(by(later).keywords, 'ok');
  assert.equal(by(later).notion, 'ok');
  assert.equal(by(later).ai, 'bad'); // codex 명령 없음
  assert.match(later.find((c) => c.id === 'ai')!.detail, /codex login/);

  store.set('llm.backend', 'anthropic-api');
  assert.equal(by(await runDoctor(deps)).ai, 'bad'); // API 키 없음
  assert.equal(by(await runDoctor({ ...deps, nodeVersion: '20.1.0' })).node, 'bad');
});

test('설치: 운영체제별 브라우저 찾기', async () => {
  const { detectBrowserApps } = await import('../src/init');
  const has = (xs: string[]) => (p: string) => xs.includes(p);
  assert.deepEqual(detectBrowserApps('darwin', has(['/Applications/Aside.app'])), { aside: '/Applications/Aside.app', chrome: undefined });
  assert.deepEqual(detectBrowserApps('linux', has(['/usr/bin/chromium'])), { chrome: '/usr/bin/chromium' });
  assert.deepEqual(detectBrowserApps('win32', has(['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']), { PROGRAMFILES: 'C:\\Program Files' }), { chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
});
