import './setup-env';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseSettings } from '../src/config';
import type { Collector, RawPosting } from '../src/collectors/types';
import { PoliteHttp } from '../src/http';
import { SeenStore } from '../src/jobs/seen';
import { paths } from '../src/paths';
import { runCollect, type CollectOptions, type CollectReport } from '../src/pipeline/collect';
import { saveCollectReport } from '../src/pipeline/run';
import { selectedFromPreview } from '../src/pipeline/selection';
import { tempDir } from './helpers';

const NOW = new Date('2026-09-24T04:00:00Z');
const raw = (id: string, extra: Partial<RawPosting> = {}): RawPosting => ({ source: 'fake', sourceId: id, sourceUrl: `https://fake.example/${id}`, company: `합성회사${id}`, title: '백엔드 신입', deadline: { date: '2026-09-30' }, experience: 'new', employmentTypes: ['정규직'], roleNames: ['백엔드'], sizeHints: ['대기업'], ...extra });
const collector = (items: RawPosting[]): Collector => ({ id: 'fake', label: '합성 사이트', method: 'http', status: 'ok', note: '', collect: async () => items });
const opts = (): CollectOptions => ({ settings: parseSettings(readFileSync(paths.settingsExample, 'utf8')), now: NOW, http: new PoliteHttp(0), browserPage: async () => { throw new Error('브라우저 사용 금지'); }, seen: new SeenStore(path.join(tempDir(), 'seen.json')), notion: null, dryRun: true, previewOnly: true, sources: ['fake'] });

test('규모 미확인 1,389개를 후보로 올리지 않고 상세/지원링크/AI 보강/Notion 쓰기 없이 보류한다 (AI 는 기업 구분 확인만)', async () => {
  let details = 0, writes = 0, fetches = 0, ai = 0;
  const o = opts();
  o.http = new PoliteHttp(0, (async () => { fetches++; throw new Error('지원 링크 확인 금지'); }) as typeof fetch);
  // 미리보기에서 AI 는 기업 구분 확인에만 쓴다. 여기서는 모르는 회사라고 답해 모두 보류로 남긴다
  o.runAgent = async (run) => {
    if (!/기업 구분에 속하는지/.test(run.systemAppend)) { ai++; throw new Error('AI 보강 금지'); }
    const { companies } = JSON.parse(run.prompt) as { companies: { key: string }[] };
    return { isError: false, text: JSON.stringify({ results: companies.map(c => ({ key: c.key, types: [], reason: '모름' })) }) };
  };
  o.notion = { tags: ['백엔드'], add: async () => { writes++; throw new Error('쓰기 금지'); }, check: async p => p.company === '합성회사0' ? { existing: { id: 'existing', company: p.company, deadline: '2026-09-30', link: '' }, reason: '기존 공고' } : null };
  const items = Array.from({ length: 1389 }, (_, i) => raw(String(i), { sizeHints: [], detail: async () => { details++; throw new Error('상세 요청 금지'); } }));
  o.collectors = [collector(items)];
  const result = await runCollect(o);
  assert.equal(result.phase, 'preview'); assert.equal(result.partial, false);
  assert.equal(result.counts.candidate, undefined); assert.equal(result.counts.company_unknown, 1388); assert.equal(result.counts.duplicate, 1);
  assert.deepEqual({ details, writes, fetches, ai }, { details: 0, writes: 0, fetches: 0, ai: 0 });
  assert.ok(result.items.filter(x => x.outcome === 'candidate').every(x => x.candidate && !('detail' in x.candidate)));
});

test('미리보기는 기본 필터를 적용하고 규모 미확인은 확인 보류로 남긴다', async () => {
  const o = opts();
  o.collectors = [collector([raw('expired', { deadline: { date: '2026-09-01' } }), raw('experienced', { experience: 'experienced' }), raw('small', { sizeHints: ['중소'] }), raw('unknown', { sizeHints: [] })])];
  const result = await runCollect(o);
  assert.equal(result.counts.expired, 1); assert.equal(result.counts.experienced, 1); assert.equal(result.counts.company, 1);
  const candidate = result.items.find(i => i.outcome === 'company_unknown')!;
  assert.equal(candidate.company, '합성회사unknown'); assert.match(candidate.reason!, /기업 규모 정보가 없어/);
  await assert.rejects(runCollect({ ...o, dryRun: false }), /목록 미리보기는 Notion에 등록할 수 없습니다/);
});

test('다음 사이트에서 중단돼도 앞선 사이트의 부분 목록은 디스크에 남는다', async () => {
  const o = opts(), ctl = new AbortController(), dir = tempDir();
  o.sources = ['fake', 'next']; o.signal = ctl.signal;
  o.collectors = [collector([raw('first')]), { ...collector([]), id: 'next', collect: async () => { ctl.abort(new Error('합성 중지')); throw ctl.signal.reason; } }];
  o.onProgress = report => saveCollectReport(dir, report);
  await assert.rejects(runCollect(o), /합성 중지/);
  const saved: CollectReport = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'));
  assert.equal(saved.partial, true); assert.equal(saved.counts.review_pending, 1);
  assert.equal(statSync(path.join(dir, 'report.json')).mode & 0o777, 0o600);
});

test('선택 등록은 저장된 후보 ID만 받으며 경로 탈출과 50개 초과를 거절한다', () => {
  const dir = tempDir(), name = '20260924-120000_collect-preview'; mkdirSync(path.join(dir, name));
  const report = { phase: 'preview', dryRun: true, items: [{ id: 'fake:1', outcome: 'candidate', candidate: raw('1') }] };
  writeFileSync(path.join(dir, name, 'report.json'), JSON.stringify(report));
  assert.deepEqual(selectedFromPreview({ preview: name, ids: ['fake:1'] }, dir), [raw('1')]);
  assert.throws(() => selectedFromPreview({ preview: '../../secrets', ids: ['fake:1'] }, dir), /다시 선택/);
  assert.throws(() => selectedFromPreview({ preview: name, ids: ['fake:other'] }, dir), /결과에 없습니다/);
  assert.throws(() => selectedFromPreview({ preview: name, ids: Array.from({ length: 51 }, (_, i) => `fake:${i}`) }, dir), /1~50개/);
  assert.throws(() => selectedFromPreview({ preview: name, ids: ['fake:1', 'fake:1'] }, dir), /1~50개/);
});

test('선택한 공고만 상세 확인하고 검색/프로필 분석 없이 등록한다', async () => {
  const o = opts(); let details = 0, writes = 0, collected = 0;
  o.previewOnly = false; o.dryRun = false; o.profile = { target: { job_roles: ['백엔드'] } };
  o.collectors = [{ ...collector([]), collect: async () => { collected++; throw new Error('재수집 금지'); } }];
  o.selectedPostings = [raw('selected', { applyUrl: 'https://apply.example/selected', detail: async () => { details++; return {}; } })];
  o.settings.collect.ai_roles.mode = 'off';
  o.runAgent = async () => { throw new Error('선택 공고 등록에서 프로필 분석 금지'); };
  o.http = new PoliteHttp(0, (async () => new Response('ok')) as typeof fetch);
  o.notion = { tags: ['백엔드'], add: async p => { writes++; assert.equal(p.company, '합성회사selected'); return { status: 'created', pageId: 'synthetic', url: 'https://notion.example/synthetic', dropped: [], usedTemplate: false }; } };
  const r = await runCollect(o);
  assert.deepEqual({ details, writes, collected }, { details: 1, writes: 1, collected: 0 });
  assert.equal(r.counts.registered, 1);
});

test('선택 공고의 상세가 실패하거나 고용형태가 바뀌면 등록하지 않는다', async () => {
  const o = opts(); o.previewOnly = false; o.dryRun = false;
  o.selectedPostings = [raw('broken', { detail: async () => { throw new Error('상세 실패'); } }), raw('changed', { detail: async () => ({ employmentTypes: ['프리랜서'] }) })];
  o.notion = { tags: [], add: async () => { throw new Error('등록되면 안 됨'); } };
  const r = await runCollect(o);
  assert.equal(r.counts.error, 1); assert.equal(r.counts.employment, 1); assert.equal(r.counts.registered, undefined);
});

test('기업 규모가 없는 공고: AI 가 확실히 아는 회사만 기업 구분을 정해 직무 확인으로 넘기고, 모르면 보류한다', async () => {
  const o = opts();
  o.collectors = [collector([raw('mobis', { company: '현대모비스', sizeHints: [] }), raw('tiny', { company: '현대사무용품', sizeHints: [] }), raw('sme', { company: '작은회사', sizeHints: [] })])];
  const seen: string[] = [];
  o.runAgent = async (run) => {
    const input = JSON.parse(run.prompt);
    if (input.companies) {
      seen.push(...input.companies.map((c: { company: string }) => c.company));
      const types: Record<string, string[]> = { 현대모비스: ['대기업'], 작은회사: ['중소'] };
      return { isError: false, text: JSON.stringify({ results: input.companies.map((c: { key: string; company: string }) => ({ key: c.key, types: types[c.company] ?? [], reason: 'x' })) }) };
    }
    return { isError: false, text: JSON.stringify({ results: input.postings.map((p: { key: string }) => ({ key: p.key, decision: 'pending', reason: '확인 필요' })) }) };
  };
  const result = await runCollect(o);
  const by = (c: string) => result.items.find(i => i.company === c)!;
  assert.deepEqual(seen.sort(), ['작은회사', '현대모비스', '현대사무용품'].sort());
  assert.equal(by('현대모비스').outcome, 'review_pending'); // 대기업으로 확인 → 직무 확인으로
  assert.deepEqual(by('현대모비스').companyTypes, ['대기업']);
  assert.equal(by('현대사무용품').outcome, 'company_unknown'); // 이름만 비슷한 회사는 그대로 보류
  assert.equal(by('작은회사').outcome, 'company'); // 제외하는 구분(중소)이면 제외
});
