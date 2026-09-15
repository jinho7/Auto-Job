import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ApplyJobManager, toMessage } from '../src/apply/jobs';
import type { ApplyOptions, ApplyReport } from '../src/apply/run';
import { parseSettings } from '../src/config';
import { listPostings } from '../src/notion/postings';
import type { NotionClient } from '../src/notion/client';
import { paths } from '../src/paths';

const tick = () => new Promise((r) => setTimeout(r, 5));
const report = (o: ApplyOptions): ApplyReport =>
  ({ company: o.target, link: o.target, startedAt: '', finishedAt: '', steps: o.steps ?? [], summary: '다 했습니다', blanks: [], notes: [], actions: [], agent: { text: '', isError: false }, completed: true, dir: `/runs/${o.target}` }) as unknown as ApplyReport;

/** 가짜 지원서 작성: 로그를 남기고, a 는 사람에게 묻고, 끝날 때까지 기다린다 */
function fakeRun() {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const run = async (o: ApplyOptions) => {
    started.push(o.target);
    assert.deepEqual(o.window, { newWindow: true, background: true }); // 지원서마다 새 창, 뒤에서
    o.log?.('③ AI 가 인적사항을 입력합니다');
    o.log?.('   💭 학력 입력 중');
    if (o.target === 'a') {
      const ans = await o.ask('로그인하고 알려 주세요');
      o.log?.(`   답: ${ans}`);
    }
    await new Promise<void>((resolve, reject) => {
      finish.set(o.target, resolve);
      o.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
    return report(o);
  };
  return { run, started, finish };
}

test('대화방: 동시에 정한 개수만 진행하고 나머지는 대기, 질문은 빨간 점(대기 중)과 알림, 답하면 이어서', async () => {
  const f = fakeRun();
  const notes: string[] = [];
  const fronts: number[] = [];
  const m = new ApplyJobManager({ run: f.run, maxParallel: () => 2, notify: (t, msg) => notes.push(`${t}|${msg}`), bringToFront: async () => void fronts.push(1) });
  const jobs = m.start([{ target: 'a', title: 'A사' }, { target: 'b', title: 'B사' }, { target: 'c', title: 'C사' }]);
  await tick();
  assert.deepEqual(f.started, ['a', 'b']);
  const by = () => Object.fromEntries(m.snapshot().jobs.map((j) => [j.title, j.status]));
  assert.deepEqual(by(), { A사: 'waiting', B사: 'running', C사: 'queued' });
  const snap = m.snapshot();
  assert.equal(snap.jobs.find((j) => j.title === 'A사')!.waiting, '로그인하고 알려 주세요');
  assert.match(notes.join('\n'), /Auto-Job — A사\|로그인하고 알려 주세요/);
  assert.ok(snap.messages.some((x) => x.kind === 'ai' && x.text === '학력 입력 중'));

  // 묻지 않은 방에 보내면 기록만
  assert.deepEqual(m.answer(jobs[1].id, '안녕'), { answered: false });
  // 답하면 이어서
  assert.deepEqual(m.answer(jobs[0].id, '로그인 했어'), { answered: true });
  await tick();
  assert.equal(by().A사, 'running');
  assert.ok(m.snapshot().messages.some((x) => x.kind === 'you' && x.text === '로그인 했어'));

  // 하나가 끝나면 대기하던 것이 시작
  f.finish.get('b')!();
  await tick();
  assert.deepEqual(f.started, ['a', 'b', 'c']);
  assert.equal(by().B사, 'done');
  assert.ok(m.snapshot().messages.some((x) => x.kind === 'done' && /다 했습니다/.test(x.text)));
  assert.throws(() => m.remove(jobs[0].id), /먼저 중지/);

  // 중지
  m.stop(jobs[0].id);
  await tick();
  assert.equal(by().A사, 'stopped');
  m.remove(jobs[0].id);
  assert.equal(m.snapshot().jobs.length, 2);

  // since 이후 새 말풍선만
  const seq = m.snapshot().seq;
  f.finish.get('c')!();
  await tick();
  assert.ok(m.snapshot(seq).messages.every((x) => x.seq > seq));
  assert.throws(() => m.start(Array.from({ length: 9 }, (_, i) => ({ target: `t${i}` }))), /8개까지/);
});

test('대화방: 시작 전 취소, 오류, 로그 정리', async () => {
  const m = new ApplyJobManager({ run: async () => Promise.reject(new Error('지원 페이지가 열리지 않습니다')), maxParallel: () => 1 });
  const [a, b] = m.start([{ target: 'x' }, { target: 'y' }]);
  m.stop(b.id);
  await tick();
  const by = Object.fromEntries(m.snapshot().jobs.map((j) => [j.id, j]));
  assert.equal(by[a.id].status, 'error');
  assert.match(by[a.id].activity, /열리지 않습니다/);
  assert.equal(by[b.id].status, 'stopped');
  assert.deepEqual(toMessage('   💭 주소 팝업을 여는 중'), { kind: 'ai', text: '주소 팝업을 여는 중' });
  assert.deepEqual(toMessage('   ✏️  홍길동 — 입력했습니다'), { kind: 'log', text: '✏️  홍길동 — 입력했습니다' });
});

test('고를 공고 목록: 마감 지난 것은 빼고 마감 가까운 순, 상시는 뒤', async () => {
  const settings = parseSettings(readFileSync(paths.settingsExample, 'utf8'));
  const page = (id: string, company: string, deadline: string | null, status = '제출전') => ({
    id, url: `https://notion.so/${id}`, properties: {
      [settings.notion.fields.company]: { type: 'title', title: [{ plain_text: company }] },
      [settings.notion.fields.deadline]: { type: 'date', date: deadline ? { start: deadline } : null },
      [settings.notion.fields.status]: { type: 'select', select: { name: status } },
      [settings.notion.fields.link]: { type: 'url', url: `https://apply/${id}` },
    },
  });
  const client = { queryPages: async () => [page('1', '늦은사', '2026-10-30'), page('2', '지난사', '2026-09-01'), page('3', '상시사', null), page('4', '빠른사', '2026-09-20T18:00:00.000+09:00')] } as unknown as NotionClient;
  const list = await listPostings(client, settings, 'ds', new Date('2026-09-15T00:00:00Z'));
  assert.deepEqual(list.map((p) => p.company), ['빠른사', '늦은사', '상시사']);
  assert.equal(list[0].link, 'https://apply/4');
});
