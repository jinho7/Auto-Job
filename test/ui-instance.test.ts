import './setup-env';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startOrReuseUi } from '../src/server/ui-instance';
import { tempDir } from './helpers';

const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));

test('반복 실행은 같은 서버와 인증 URL을 재사용하고 종료 시 실행 정보를 지운다', async () => {
  const dir = tempDir();
  const first = await startOrReuseUi(0, dir);
  assert.equal(first.reused, false); if (first.reused) return;
  const port = Number(new URL(first.url).port), file = path.join(dir, `ui-${port}.json`);
  try {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const again = await startOrReuseUi(port, dir);
    assert.equal(again.reused, true); assert.equal(again.url, first.url);
    assert.equal(first.server.listening, true);
    assert.equal((await fetch(`${new URL(first.url).origin}/api/ui-instance`)).status, 401);
    const r = await fetch(`${new URL(first.url).origin}/api/ui-instance`, { headers: { 'X-AutoJob-Token': first.token } });
    assert.deepEqual(await r.json(), { application: 'auto-job', instanceId: first.instanceId });
  } finally { await close(first.server); }
  assert.equal(existsSync(file), false);
});

test('다른 프로그램의 포트는 종료하거나 재사용하지 않고 대안을 안내한다', async () => {
  const server = createServer((_req, res) => res.end('{}'));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try { await assert.rejects(startOrReuseUi(port, tempDir()), /포트가 사용 중.*autojob ui --port/); assert.equal(server.listening, true); }
  finally { await close(server); }
});

test('오래된 인증 정보는 실행 중인 서버로 인정하지 않는다', async () => {
  const dir = tempDir(), first = await startOrReuseUi(0, dir);
  assert.equal(first.reused, false); if (first.reused) return;
  const port = Number(new URL(first.url).port), file = path.join(dir, `ui-${port}.json`);
  const valid = readFileSync(file, 'utf8');
  try {
    writeFileSync(file, JSON.stringify({ ...JSON.parse(valid), token: '0'.repeat(32) }));
    await assert.rejects(startOrReuseUi(port, dir), /현재 Auto-Job 서버로 확인되지/);
    assert.equal(first.server.listening, true);
  } finally { writeFileSync(file, valid); await close(first.server); }
});

test('동시에 시작해도 한 서버만 만들고 나머지는 재사용한다', async () => {
  const dir = tempDir(), reserve = createServer();
  await new Promise<void>(r => reserve.listen(0, '127.0.0.1', r));
  const port = (reserve.address() as { port: number }).port;
  await close(reserve);
  const results = await Promise.all([startOrReuseUi(port, dir), startOrReuseUi(port, dir)]);
  try { assert.equal(results.filter(r => !r.reused).length, 1); assert.equal(results[0].url, results[1].url); }
  finally { for (const r of results) if (!r.reused) await close(r.server); }
});
