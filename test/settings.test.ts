import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveHome } from '../src/paths';
import { parseNotionId, SettingsStore } from '../src/settings/store';
import { freshSettingsFile } from './helpers';

test('예시 설정은 중립 기본값이다 (개인 값 없음)', () => {
  const s = new SettingsStore(freshSettingsFile()).settings;
  assert.deepEqual(s.collect.keywords, []);
  assert.equal(s.notion.database_id, '');
  assert.deepEqual(s.essay.banned_phrases, []);
});

test('set/add/remove 는 주석을 보존하며 저장한다', () => {
  const file = freshSettingsFile();
  const store = new SettingsStore(file);
  store.setFromText('browser.driver', 'chrome');
  store.setFromText('browser.aside.cdp_port', '9333');
  assert.deepEqual(store.addToList('collect.keywords', ['백엔드', ' Spring Boot ', '백엔드']), ['백엔드', 'Spring Boot']);
  assert.deepEqual(store.addToList('collect.keywords', ['백엔드']), []);
  assert.deepEqual(store.removeFromList('collect.keywords', ['백엔드', '없는값']), ['백엔드']);

  const reloaded = new SettingsStore(file).settings;
  assert.equal(reloaded.browser.driver, 'chrome');
  assert.equal(reloaded.browser.aside.cdp_port, 9333);
  assert.deepEqual(reloaded.collect.keywords, ['Spring Boot']);
  assert.match(readFileSync(file, 'utf8'), /driver: chrome +# aside \| chrome/);
});

test('예전 설정 파일에 없는 목록에 추가해도 기본값을 잃지 않는다', () => {
  const file = freshSettingsFile();
  writeFileSync(file, readFileSync(file, 'utf8').replace(/  page_sections:\n(    - .*\n)+/, ''));
  const store = new SettingsStore(file);
  assert.equal(store.settings.notion.page_sections.length, 6); // 기본값
  store.addToList('notion.page_sections', ['메모']);
  assert.deepEqual(new SettingsStore(file).settings.notion.page_sections.slice(-2), ['제출 자료 여부', '메모']);
  assert.equal(new SettingsStore(file).settings.notion.page_sections.length, 7);
});

test('형식에 맞지 않는 값은 저장하지 않는다', () => {
  const file = freshSettingsFile();
  const store = new SettingsStore(file);
  const before = readFileSync(file, 'utf8');
  assert.throws(() => store.setFromText('browser.driver', 'firefox'));
  assert.throws(() => store.setFromText('browser.aside.cdp_port', 'abc'));
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(store.settings.browser.driver, 'aside');
});

test('Notion URL/ID 에서 UUID 를 뽑는다', () => {
  const id = '0123abcd-4567-ef89-0123-abcd4567ef89';
  assert.equal(parseNotionId('https://app.notion.com/p/0123abcd4567ef890123abcd4567ef89?pvs=204'), id);
  assert.equal(parseNotionId('https://www.notion.so/Page-Title-0123abcd4567ef890123abcd4567ef89?v=abc'), id);
  assert.equal(parseNotionId('https://www.notion.so/workspace/Cafe-0123abcd4567ef890123abcd4567ef89'), id);
  assert.equal(parseNotionId(id), id);
  assert.equal(parseNotionId('not an id'), null);
});

test('개인 데이터 위치: 환경 변수 → 내려받은 저장소 → ~/.autojob', () => {
  const has = (...found: string[]) => (p: string) => found.includes(p);
  // 1. AUTOJOB_HOME 이 이긴다 (빈 값은 '설정 안 함')
  assert.equal(resolveHome('/app', '/tmp/mine', '/home/u', () => true), '/tmp/mine');
  // 2. 저장소 안에서 쓰면(.git 또는 이미 만든 settings.yaml) 저장소 폴더
  assert.equal(resolveHome('/app', '', '/home/u', has('/app/.git')), '/app');
  assert.equal(resolveHome('/app', '', '/home/u', has('/app/settings.yaml')), '/app');
  // 3. 전역 설치처럼 저장소가 아니면 개인 폴더 (설치 폴더에 개인 데이터를 쓰지 않는다)
  assert.equal(resolveHome('/usr/local/lib/node_modules/auto-job', '', '/home/u', () => false), '/home/u/.autojob');
});
