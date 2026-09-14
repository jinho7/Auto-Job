// 웹 UI 서버: 임시 AUTOJOB_HOME 에서 실제 HTTP 로 확인한다.
import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ensureInitialized } from '../src/init';
import { startServer } from '../src/server/server';

const home = process.env.AUTOJOB_HOME!; // setup-env 가 만든 임시 폴더

let base = '';
const TOKEN = 'a'.repeat(32);
let close: () => void;

before(async () => {
  ensureInitialized();
  const { server, url } = await startServer(0, TOKEN);
  base = new URL(url).origin;
  close = () => server.close();
});
after(() => close?.());

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = { 'X-AutoJob-Token': TOKEN }) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
}

test('토큰이 없거나 틀리면 API 를 쓸 수 없다', async () => {
  assert.equal((await call('GET', '/api/state', undefined, {})).status, 401);
  assert.equal((await call('GET', '/api/state', undefined, { 'X-AutoJob-Token': 'b'.repeat(32) })).status, 401);
});

test('화면 파일은 토큰 없이 열린다', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Auto-Job 설정/);
});

test('상태 조회: 항목 정의, 내 정보, 설정, 비밀값 상태', async () => {
  const { status, json } = await call('GET', '/api/state');
  assert.equal(status, 200);
  assert.ok(json.schema.sections.basic);
  assert.deepEqual(json.settings.collect.keywords, []);
  assert.equal(json.secrets.NOTION_TOKEN.set, false);
});

test('내 정보: 저장, 형식 오류, 목록 추가/삭제', async () => {
  const ok = await call('POST', '/api/profile/set', { path: 'basic.name.ko', value: '홍길동' });
  assert.equal(ok.json.profile.basic.name.ko, '홍길동');
  const bad = await call('POST', '/api/profile/set', { path: 'basic.birth', value: '1999-03-02' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /YYYY\.MM\.DD/);
  const added = await call('POST', '/api/profile/add', { path: 'education.universities' });
  assert.equal(added.json.index, 0);
  const removed = await call('POST', '/api/profile/remove', { path: 'education.universities.0' });
  assert.deepEqual(removed.json.profile.education.universities, []);
});

test('내 정보: 파일 올리기 (경로 문자는 없앤다)', async () => {
  const r = await call('POST', '/api/profile/upload', { name: '../../사진.png', base64: Buffer.from('png').toString('base64'), path: 'basic.photo' });
  assert.equal(r.status, 200);
  assert.equal(r.json.profile.basic.photo, '사진.png');
  assert.equal(readFileSync(path.join(home, 'profile', 'me', 'files', '사진.png'), 'utf8'), 'png');
  assert.equal((await call('POST', '/api/profile/upload', { name: '.env', base64: '' })).status, 400);
});

test('설정: 값 저장, 목록 추가/삭제, 형식 오류는 거부', async () => {
  await call('POST', '/api/settings/list', { path: 'collect.keywords', add: ['백엔드', 'AWS'] });
  const r = await call('POST', '/api/settings/list', { path: 'collect.keywords', remove: ['AWS'] });
  assert.deepEqual(r.json.settings.collect.keywords, ['백엔드']);
  const t = await call('POST', '/api/settings/set', { path: 'company_types.중소.include', value: true });
  assert.equal(t.json.settings.company_types['중소'].include, true);
  assert.equal((await call('POST', '/api/settings/set', { path: 'browser.driver', value: 'firefox' })).status, 400);
});

test('비밀값: 화면에는 가린 값만, 파일 권한은 600', async () => {
  const r = await call('POST', '/api/secrets/set', { key: 'ANTHROPIC_API_KEY', value: 'sk-ant-1234567890abcdef' });
  assert.equal(r.json.secrets.ANTHROPIC_API_KEY.set, true);
  assert.equal(r.json.secrets.ANTHROPIC_API_KEY.masked, 'sk-ant-…cdef');
  assert.ok(!JSON.stringify(r.json).includes('1234567890abcdef'));
  const env = path.join(home, '.env');
  assert.match(readFileSync(env, 'utf8'), /ANTHROPIC_API_KEY=sk-ant-1234567890abcdef/);
  assert.equal(statSync(env).mode & 0o777, 0o600);
  assert.equal((await call('POST', '/api/secrets/set', { key: 'PATH', value: 'x' })).status, 400);
  const cleared = await call('POST', '/api/secrets/set', { key: 'ANTHROPIC_API_KEY', value: '' });
  assert.equal(cleared.json.secrets.ANTHROPIC_API_KEY.set, false);
});

test('Notion: 토큰이 없으면 안내 메시지', async () => {
  const r = await call('GET', '/api/notion/databases');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Notion 토큰이 없습니다/);
});
