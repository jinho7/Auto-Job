import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ApplyJobManager, toMessage } from '../src/apply/jobs';
import type { ApplyOptions, ApplyReport } from '../src/apply/run';
import { MissingApplicationTab, type BrowserSession } from '../src/browser/session';
import { parseSettings } from '../src/config';
import { listPostings } from '../src/notion/postings';
import type { NotionClient } from '../src/notion/client';
import { paths } from '../src/paths';
import { tempDir } from './helpers';

const tick = () => new Promise(r => setTimeout(r, 5));
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await tick(); assert.ok(check(), 'condition did not become true'); }
const report = (o: ApplyOptions): ApplyReport => ({ company: o.target, link: o.target, startedAt: '', finishedAt: '', steps: o.steps ?? [], summary: '작성 결과', blanks: [], notes: [], actions: [], agent: { text: '', isError: false }, completed: true, dir: `/runs/${o.target}` });
const tab = (targetId = 'owned') => ({ connected: true, page: { isClosed: () => false }, reference: async () => ({ targetId, cdpPort: 9222 }), detach: async () => {}, show: async () => {} }) as unknown as BrowserSession;

test('질문과 작성은 같은 에이전트로 전달하고 답변 턴은 이전 작성 결과를 유지한다', async () => {
  const calls: ApplyOptions[] = [];
  const m = new ApplyJobManager({ maxParallel: () => 1, run: async o => {
    calls.push(o); if (o.request) return { ...report(o), outcome: 'answered', summary: 'API 개발 경험으로 골랐습니다.', completed: false };
    o.onRole?.({ title: '백엔드', reason: 'API 개발 경험' }); return report(o);
  } });
  const [j] = m.start([{ target: 'a' }]); await until(() => j.status === 'done');
  m.answer(j.id, '왜 이 직무야?'); await until(() => j.status === 'idle');
  assert.equal(calls.length, 2); assert.equal(calls[1].request, '왜 이 직무야?');
  assert.deepEqual(calls[1].context?.requested_role, { title: '백엔드', reason: 'API 개발 경험' });
  assert.equal(j.summary, '작성 결과'); assert.equal(j.reportDir, '/runs/a');
  assert.ok(j.messages.some(m => m.text === 'API 개발 경험으로 골랐습니다.')); await m.close();
});

test('새 지시는 해당 작업만 취소하고 이전 실행이 종료된 뒤 정확한 탭으로 직접 전달한다', async () => {
  const calls: ApplyOptions[] = []; const order: string[] = []; const session = tab(); let release!: () => void;
  const m = new ApplyJobManager({ maxParallel: () => 2, run: async o => {
    calls.push(o);
    if (!o.request) {
      if (o.target === 'a') await o.onSession?.(session);
      await new Promise<void>(r => { if (o.target === 'a') release = r; else o.signal!.addEventListener('abort', () => r(), { once: true }); });
      order.push(`settled:${o.target}`); o.log?.('OLD LATE LOG');
    } else { assert.equal(o.session, session); assert.equal(o.request, 'SW로 지원해'); order.push('new-agent'); }
    return report(o);
  } });
  const [a, b] = m.start([{ target: 'a' }, { target: 'b' }]); await until(() => !!release && calls.length === 2);
  m.answer(a.id, 'SW로 지원해'); assert.ok(calls[0].signal!.aborted); assert.equal(calls[1].signal!.aborted, false);
  await tick(); assert.deepEqual(order, []); release(); await until(() => a.status === 'done');
  assert.deepEqual(order.slice(0, 2), ['settled:a', 'new-agent']); assert.equal(b.status, 'running');
  assert.ok(!a.messages.some(m => m.text === 'OLD LATE LOG')); await m.close();
});

test('인증 대기는 슬롯을 반환하고 문맥과 답을 같은 에이전트에 넘긴다', async () => {
  let resumed: ApplyOptions | undefined;
  const m = new ApplyJobManager({ maxParallel: () => 1, run: async o => {
    if (o.target === 'a' && !o.request) await o.ask('실제 브라우저에서 인증해 주세요');
    if (o.request) resumed = o; return report(o);
  } });
  const [a,b] = m.start([{ target: 'a' }, { target: 'b' }]); await until(() => b.status === 'done');
  assert.equal(a.status, 'waiting'); m.answer(a.id, '인증했어. 이어서'); await until(() => a.status === 'done');
  assert.match(String(resumed?.context?.waiting), /인증/); assert.equal(resumed?.request, '인증했어. 이어서'); await m.close();
});

test('미완료 리포트는 완료가 아니라 확인 대기로 표시한다', async () => {
  const m = new ApplyJobManager({ maxParallel: () => 1, run: async o => ({ ...report(o), completed: false, outcome: 'incomplete', remaining: ['학교 선택 미완료', '저장 확인 필요'] }) });
  const [j] = m.start([{ target: 'a' }]); await until(() => j.status === 'waiting');
  assert.match(j.waiting!, /학교 선택/); assert.ok(!j.messages.some(m => m.kind === 'done')); await m.close();
});

test('연속 지시는 최신 턴만 실행하고 종료 전 결과를 섞지 않는다', async () => {
  let release!: () => void; const requests: string[] = [];
  const m = new ApplyJobManager({ maxParallel: () => 1, run: async o => {
    if (!o.request) return report(o); requests.push(o.request);
    if (o.request === '첫 질문') await new Promise<void>(r => { release = r; });
    return { ...report(o), outcome: 'answered', summary: o.request + ' 답' };
  } });
  const [j] = m.start([{ target: 'a' }]); await until(() => j.status === 'done');
  m.answer(j.id, '첫 질문'); await until(() => !!release); m.answer(j.id, '둘째 질문'); m.answer(j.id, '최신 질문'); release();
  await until(() => j.status === 'idle'); assert.deepEqual(requests, ['첫 질문', '최신 질문']);
  assert.ok(!j.messages.some(m => m.kind === 'ai' && m.text === '첫 질문 답')); await m.close();
});

test('대기 중 중지하면 재실행되지 않고 공통 동시 실행 제한을 지킨다', async () => {
  let release!: () => void; let followups = 0;
  const m = new ApplyJobManager({ maxParallel: () => 1, run: async o => {
    if (o.target === 'busy') await new Promise<void>(r => { release = r; }); if (o.request) followups++; return report(o);
  } });
  const [a] = m.start([{ target: 'a' }]); await until(() => a.status === 'done');
  const [busy] = m.start([{ target: 'busy' }]); await until(() => !!release);
  m.answer(a.id, '질문'); assert.equal(a.status, 'queued'); m.stop(a.id); release(); await until(() => busy.status === 'done');
  assert.equal(followups, 0); await m.close();
});

test('중복 공고는 기존 대화방을 재사용한다', async () => {
  const m = new ApplyJobManager({ maxParallel: () => 1, run: async o => report(o) });
  const [a] = m.start([{ target: 'a' }]); assert.equal(m.start([{ target: 'a' }])[0].id, a.id);
  assert.throws(() => m.start(Array.from({length:9}, (_,i) => ({target:String(i)}))), /8개/);
  assert.deepEqual(toMessage('   💭 확인 중'), {kind:'ai',text:'확인 중'}); await until(() => a.status === 'done'); await m.close();
});

test('대화와 정확한 탭을 저장하고 재시작 후 그 탭에만 이어서 작업한다', async () => {
  const storageFile = path.join(tempDir(), 'state.json'), session = tab('persisted');
  const m = new ApplyJobManager({ storageFile, maxParallel: () => 1, run: async o => { await o.onSession?.(session); o.onRole?.({title:'SW',reason:'경험'}); await o.ask('인증'); return report(o); } });
  const [j] = m.start([{target:'a'}]); await until(() => j.status === 'waiting'); await m.close();
  let restored = false;
  const n = new ApplyJobManager({storageFile,maxParallel:()=>1,restoreSession:async ref=>{assert.deepEqual(ref,{targetId:'persisted',cdpPort:9222});restored=true;return session;},run:async o=>{assert.equal(o.session,session);assert.equal(o.role?.title,'SW');return report(o);}});
  assert.equal(n.jobs.get(j.id)!.status,'stopped'); n.answer(j.id,'이어서'); await until(()=>n.jobs.get(j.id)!.status==='done'); assert.ok(restored); await n.close();
});

test('복구할 탭이 없으면 다른 탭에 쓰지 않는다', async()=>{
  let calls=0; const m=new ApplyJobManager({maxParallel:()=>1,run:async o=>{calls++;return report(o);},restoreSession:async()=>{throw new Error('기존 탭 없음');}});
  const [j]=m.start([{target:'a'}]);await until(()=>j.status==='done');j.sessionRef={targetId:'missing',cdpPort:9222};m.answer(j.id,'이어서');await until(()=>j.status==='error');assert.equal(calls,1);await m.close();
});

test('브라우저가 재시작되어 원래 탭이 사라지면 그 회사의 새 전용 창으로 이어간다', async()=>{
  const calls: ApplyOptions[]=[]; const newTab=tab('replacement');
  const m=new ApplyJobManager({maxParallel:()=>1,restoreSession:async()=>{throw new MissingApplicationTab();},run:async o=>{calls.push(o); if(o.request) {assert.equal(o.session,undefined); assert.equal(o.window?.newWindow,true); await o.onSession?.(newTab);} return report(o);}});
  const [j]=m.start([{target:'https://example.test/owned-posting'}]); await until(()=>j.status==='done');
  j.sessionRef={targetId:'closed',cdpPort:9222}; m.answer(j.id,'이어서'); await until(()=>j.status==='done');
  assert.equal(calls[1].target,j.target); assert.equal(j.sessionRef.targetId,'replacement');
  assert.ok(j.messages.some(x=>/새 창/.test(x.text)&&/복구되지 않을 수/.test(x.text))); await m.close();
});

test('연결이 끊긴 캐시 세션은 다시 붙고 새 탭 ID를 저장한다', async()=>{
  const original=tab('old'), restored=tab('restored'); let attachments=0;
  const m=new ApplyJobManager({maxParallel:()=>1,restoreSession:async()=>{attachments++;return restored;},run:async o=>{if(!o.request)await o.onSession?.(original);else assert.equal(o.session,restored);return report(o);}});
  const [j]=m.start([{target:'a'}]);await until(()=>j.status==='done');Object.assign(original,{connected:false});
  m.answer(j.id,'이어서');await until(()=>j.status==='done');assert.equal(attachments,1);assert.equal(j.sessionRef?.targetId,'restored');await m.close();
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


test('노션 반영 상태는 인증 대기로 중단되어도 저장되고 다음 대화에 전달된다', async () => {
  let context: Record<string, unknown> | undefined;
  const m = new ApplyJobManager({ maxParallel: () => 1, run: async o => {
    if (!o.request) {
      o.onNotion?.({ available: true, verified: true, summary: '가정한 초안과 미저장 상태를 정리함' });
      await o.ask('사이트에서 인증해 주세요');
    }
    context = o.context; return { ...report(o), outcome: 'answered' };
  } });
  const [j] = m.start([{ target: 'a' }]); await until(() => j.status === 'waiting');
  assert.equal((j.reportContext?.notion as any)?.verified, true);
  m.answer(j.id, '노션은 정리됐어?'); await until(() => j.status === 'idle');
  assert.equal(((context?.last_result as any)?.notion)?.verified, true);
  await m.close();
});

test('미완료로 끝나면 사용자를 부르지 않고 남은 일만 스스로 이어서 한다', async () => {
  const calls: ApplyOptions[] = [];
  const m = new ApplyJobManager({ maxParallel: () => 1, run: async o => {
    calls.push(o);
    // 첫 실행은 Notion 정리를 남기고, 이어서 실행에서 끝낸다
    if (calls.length === 1) return { ...report(o), completed: false, outcome: 'incomplete', remaining: ['Notion 정리 결과를 확인하지 못했습니다'] };
    return report(o);
  } });
  const [j] = m.start([{ target: 'a' }]);
  await until(() => j.status === 'done');
  assert.equal(calls.length, 2);
  assert.match(String(calls[1].request), /남은 일을 끝내 주세요/);
  assert.match(String(calls[1].request), /Notion 정리 결과를 확인하지 못했습니다/);
  assert.equal(calls[1].session, calls[0].session); // 같은 창에서 이어서
  assert.ok(j.messages.some(x => x.kind === 'system' && x.text.startsWith('남은 일을 이어서 합니다 (1/2)')));
  assert.equal(j.waiting, null);
  await m.close();
});

test('이어서 해도 같은 일이 남으면 그만두고 사용자에게 알린다 (무한 반복 방지)', async () => {
  const calls: ApplyOptions[] = [];
  const m = new ApplyJobManager({ maxParallel: () => 1, run: async o => {
    calls.push(o);
    return { ...report(o), completed: false, outcome: 'incomplete', remaining: ['임시저장 성공을 확인하지 못했습니다'] };
  } });
  const [j] = m.start([{ target: 'a' }]);
  await until(() => j.status === 'waiting');
  assert.equal(calls.length, 2); // 한 번 더 해 보고, 같은 이유면 멈춘다
  assert.match(String(j.waiting), /임시저장 성공을 확인하지 못했습니다/);
  await m.close();
});
