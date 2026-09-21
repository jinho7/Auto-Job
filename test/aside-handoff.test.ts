import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { handoffDocument, prepareAsideHandoff } from '../src/apply/aside-handoff';
import { ApplyJobManager } from '../src/apply/jobs';
import type { ApplyOptions, ApplyReport } from '../src/apply/run';
import { loadSettings } from '../src/config';
import { ensureInitialized } from '../src/init';
import { tempDir } from './helpers';

const tick = () => new Promise(r => setTimeout(r, 5));
const result = (o: ApplyOptions): ApplyReport => ({ company: o.target, link: o.target, startedAt: '', finishedAt: '', steps: [], summary: 'old result', blanks: [], notes: [], actions: [], agent: { text: '', isError: false }, completed: true, dir: '/synthetic' });
const packet = { file: '/synthetic/context.md', prompt: 'synthetic', url: 'https://example.test', createdAt: 'test' };

test('Aside 선택은 AI/브라우저를 실행하지 않으며 선택과 자료를 재시작 후에도 보존한다', async () => {
  let runs = 0; let lastContext: ApplyOptions['context'];
  const storageFile = path.join(tempDir(), 'jobs.json');
  const deps = { storageFile, maxParallel: () => 1, run: async (o: ApplyOptions) => { runs++; lastContext = o.context; return result(o); } };
  const m = new ApplyJobManager(deps);
  const [job] = m.start([{ target: 'https://example.test' }], ['basic'], 'aside');
  await tick(); assert.equal(runs, 0); assert.equal(job.status, 'idle');
  await m.handoff(job.id, async () => packet);
  assert.throws(() => m.answer(job.id, '계속해'), /Aside 패널/);
  assert.throws(() => m.stop(job.id), /Aside 패널/);
  await m.close();
  const restored = new ApplyJobManager(deps);
  assert.deepEqual(restored.jobs.get(job.id)?.asideHandoff, packet);
  assert.equal(restored.jobs.get(job.id)?.executionMode, 'aside');
  restored.useAutoJob(job.id); assert.equal(runs, 0);
  restored.answer(job.id, '현재 화면부터 다시 확인해'); await tick();
  assert.equal(runs, 1); assert.match(JSON.stringify(lastContext?.external_work), /동기화되지/); await restored.close();
});

test('Aside 전환은 이 회사만 취소하고 실행 정리를 기다린 뒤 자료를 만든다', async () => {
  const order: string[] = []; const signals: AbortSignal[] = [];
  const m = new ApplyJobManager({ maxParallel: () => 2, run: o => {
    signals.push(o.signal!);
    return new Promise<ApplyReport>((_resolve, reject) => o.signal!.addEventListener('abort', () => {
      order.push(`cancel:${o.target}`);
      setTimeout(() => { order.push(`exit:${o.target}`); reject(o.signal!.reason); }, 20);
    }));
  } });
  const [a, b] = m.start([{ target: 'a' }, { target: 'b' }]); await tick();
  const transfer = m.handoff(a.id, async job => { order.push(`prepare:${job.target}`); return packet; });
  assert.throws(() => m.answer(a.id, '새 지시'), /자료를 준비/);
  assert.throws(() => m.remove(a.id), /종료/);
  await transfer;
  assert.deepEqual(order, ['cancel:a', 'exit:a', 'prepare:a']);
  assert.equal(signals[1].aborted, false); assert.equal(b.status, 'running');
  assert.equal(a.executionMode, 'aside'); assert.equal(a.summary, undefined);
  await m.close();
});

test('자료 준비 실패는 Aside 전환 성공으로 기록하지 않고 재시도할 수 있다', async () => {
  const m = new ApplyJobManager({ maxParallel: () => 1, run: async o => result(o) });
  const [job] = m.start([{ target: 'a' }]); await tick();
  await assert.rejects(m.handoff(job.id, async () => { throw new Error('disk failed'); }), /disk failed/);
  assert.equal(job.executionMode, 'autojob'); assert.equal(job.asideHandoff, undefined);
  assert.equal(job.summary, 'old result');
  await m.handoff(job.id, async () => packet); assert.equal(job.executionMode, 'aside');
  await m.close();
});

test('Aside 자료는 개인 자료와 대화/Notion 요청을 담되 연결 자격 증명은 내보내지 않는다', async () => {
  ensureInitialized();
  const m = new ApplyJobManager({ maxParallel: () => 1 });
  const [job] = m.start([{ target: 'https://example.test/application', title: '검증회사' }], ['basic', 'essay'], 'aside');
  job.messages.push({ seq: 1, job: job.id, at: '', kind: 'you', text: '줄어든 교육 설명을 고쳐줘' });
  const settings = loadSettings();
  settings.llm.connections = [{ id: 'secretconnection', type: 'codex-cli', label: 'PRIVATE_CONNECTION', model: '', effort: '', enabled: true, account_dir: '/private/credentials' }];
  const doc = handoffDocument({ job, settings, target: { company: '검증회사', link: job.target, notionUrl: 'https://notion.so/example' },
    profile: '합성 지원자', sources: [{ path: '/synthetic/profile-folder' }], files: [] });
  assert.match(doc, /합성 지원자/); assert.match(doc, /줄어든 교육 설명/);
  assert.match(doc, /Notion 정리: 요청함/); assert.match(doc, /최종 제출은 하지/);
  assert.doesNotMatch(doc, /PRIVATE_CONNECTION|private\/credentials/);
  const handoff = await prepareAsideHandoff(job);
  assert.equal(statSync(handoff.file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(handoff.file)).mode & 0o777, 0o700);
  assert.match(readFileSync(handoff.file, 'utf8'), /줄어든 교육 설명/);
  assert.ok(handoff.prompt.includes(handoff.file));
  assert.equal(handoff.url, job.target);
  await m.close();
});
