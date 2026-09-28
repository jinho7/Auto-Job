import './setup-env';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers';
import { CollectTask } from '../src/pipeline/task';
import type { CollectReport } from '../src/pipeline/collect';

const result = () => ({ dir: '/synthetic/run', report: { startedAt: '', finishedAt: '', dryRun: true, notion: 'not_configured', sources: [], counts: {}, ai: { linkSearched: 0, linkFound: 0, rolesTagged: 0, costUsd: 0, errors: [] }, items: [] } as CollectReport });

test('수집은 바로 접수하고 진행/결과는 새 요청으로 다시 조회할 수 있다', async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const manager = new CollectTask(async o => { o.log?.('자료 분석 1/3'); await gate; return result(); });
  const started = manager.start({ dryRun: true });
  assert.equal(started.status, 'running');
  await delay(0);
  assert.match(manager.snapshot().log.join(), /자료 분석 1\/3/);
  assert.throws(() => manager.start({ dryRun: false }), /이미 수집 중/);
  started.log.push('변조');
  assert.ok(!manager.snapshot().log.includes('변조'));
  finish();
  const done = await manager.wait();
  assert.equal(done.status, 'completed'); assert.equal(done.result?.report.dryRun, true);
  assert.ok(done.finishedAt); assert.match(done.log.join(), /Notion에 등록하지 않았습니다/);
  assert.equal(manager.snapshot().result?.dir, '/synthetic/run');
});

test('수집 중지는 해당 실행만 취소하고 정리가 끝나기 전 중복 실행을 막는다', async () => {
  let settled = false;
  const manager = new CollectTask(async o => {
    await delay(5000, undefined, { signal: o.signal }).catch(async () => { await delay(20); settled = true; o.signal!.throwIfAborted(); });
    return result();
  });
  const first = manager.start({ dryRun: true }); await delay(0);
  assert.throws(() => manager.stop('다른 실행'), /다른 요청/);
  assert.equal(manager.stop(first.id).status, 'stopping');
  assert.throws(() => manager.start({ dryRun: true }), /이미 수집 중/);
  const stopped = await manager.wait();
  assert.ok(settled); assert.equal(stopped.status, 'stopped'); assert.equal(stopped.result, undefined);
  assert.match(stopped.error!, /사용자가 수집을 중지/);
  const next = manager.start({ dryRun: true });
  assert.notEqual(next.id, first.id);
  assert.throws(() => manager.stop(first.id), /다른 요청/);
  await manager.close(); assert.equal(manager.snapshot().status, 'stopped');
});

test('제한 시간과 실패를 명시하고 다음 수집을 허용한다', async () => {
  const manager = new CollectTask(async o => { await delay(5000, undefined, { signal: o.signal }); return result(); }, 20);
  manager.start({ dryRun: true });
  const stopped = await manager.wait();
  assert.equal(stopped.status, 'stopped'); assert.match(stopped.error!, /진행이 없어/);
  const broken = new CollectTask(async () => { throw new Error('합성 분석 오류'); });
  broken.start({ dryRun: true });
  assert.equal((await broken.wait()).status, 'error');
  assert.match(broken.snapshot().error!, /합성 분석 오류/);
  broken.start({ dryRun: true }); await broken.wait();
});


test('진행이 계속되면 총 실행 시간이 제한보다 길어도 중단하지 않는다', async () => {
  const manager = new CollectTask(async o => {
    for (let i = 0; i < 5; i++) { await delay(30, undefined, { signal: o.signal }); o.log?.(`사이트 ${i} 완료`); }
    return result();
  }, 100);
  manager.start({ dryRun: true });
  assert.equal((await manager.wait()).status, 'completed');
});

test('중지와 서버 재시작 후에도 부분 결과와 검토 목록을 보존한다', async () => {
  const file = path.join(tempDir(), 'collection-task.json');
  const manager = new CollectTask(async o => {
    const partial = result(); partial.report.phase = 'preview'; partial.report.partial = true;
    o.onProgress?.(partial);
    await delay(5000, undefined, { signal: o.signal }); return result();
  }, 1000, file);
  const start = manager.start({ dryRun: true }); await delay(0);
  manager.stop(start.id); const stopped = await manager.wait();
  assert.equal(stopped.result?.report.partial, true);
  const restored = new CollectTask(undefined, undefined, file).snapshot();
  assert.equal(restored.status, 'stopped'); assert.equal(restored.preview?.dir, '/synthetic/run');
  const stale = JSON.parse(readFileSync(file, 'utf8')); stale.status = 'running'; writeFileSync(file, JSON.stringify(stale));
  const recovered = new CollectTask(undefined, undefined, file).snapshot();
  assert.equal(recovered.status, 'stopped'); assert.equal(recovered.result?.report.partial, true);
  assert.match(recovered.error!, /재시작/);
});

test('완료된 미리보기의 묶음 설정을 저장하고 확인 도중 수집 시작과 중복 변경을 막는다', async () => {
  const dir = tempDir(), stateFile = path.join(tempDir(), 'task.json');
  const manager = new CollectTask(async () => ({ ...result(), dir, report: { ...result().report, phase: 'preview' } }), undefined, stateFile);
  manager.start({ dryRun: true }); await manager.wait();
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const updating = manager.updatePreview(async report => { await gate; report.groupAffiliates = true; });
  assert.throws(() => manager.start({ dryRun: true }), /묶음을 확인 중/);
  await assert.rejects(manager.updatePreview(async () => {}), /변경할 수 없습니다/);
  finish(); await updating;
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8')).groupAffiliates, true);
  assert.equal(new CollectTask(undefined, undefined, stateFile).snapshot().preview?.report.groupAffiliates, true);
  await assert.rejects(manager.updatePreview(async () => { throw new Error('실패'); }), /실패/);
  assert.equal(manager.snapshot().preview?.report.groupAffiliates, true);
});
