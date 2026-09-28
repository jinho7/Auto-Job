import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseSettings } from '../src/config';
import { catchCollector } from '../src/collectors/catch';
import { jobkorea } from '../src/collectors/jobkorea';
import { saramin } from '../src/collectors/saramin';
import { mapCalendar } from '../src/collectors/jasoseol';
import { openToNewcomers, positionsOf } from '../src/collectors/types';
import { classifyCompany } from '../src/jobs/classify';
import { PoliteHttp } from '../src/http';
import { paths } from '../src/paths';
import { SeenStore } from '../src/jobs/seen';
import { runCollect, type CollectOptions } from '../src/pipeline/collect';
import { previewReport } from '../src/pipeline/preview';
import { screenPreviewReport } from '../src/pipeline/preview-screen';
import { tempDir } from './helpers';

const settings = () => parseSettings(readFileSync(paths.settingsExample, 'utf8'));
test('사이트 직무 필터는 생성 검색어 12개로 반복되지 않고 실제 직무 조건을 전달한다', async () => {
  const s = settings(); s.collect.keywords = Array.from({ length: 12 }, (_, i) => `검색${i}`);
  s.collect.saramin.duty_categories = ['IT개발·데이터'];
  s.collect.jobkorea.duty_categories = ['AI·개발·데이터'];
  s.collect.catch.duty_categories = ['IT/인터넷'];
  const calls: { url: URL; body: URLSearchParams }[] = [];
  const http = new PoliteHttp(0, (async (url: string, options: RequestInit = {}) => {
    const u = new URL(url); calls.push({ url: u, body: new URLSearchParams(String(options.body ?? '')) });
    if (u.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /');
    if (u.pathname.endsWith('job-category')) return new Response('<script>{"MCLS_CD_NO":"2","MCLS_CD_NM":"IT개발·데이터"}</script>');
    if (u.pathname.endsWith('joblist')) return new Response('<input id="duty_step1_10031" name="duty" value="10031"><label for="duty_step1_10031"><span><span>AI·개발·데이터</span></span></label>');
    if (u.pathname.endsWith('RecruitSearch')) return new Response('<input id="workSub_06"><label for="workSub_06">IT/인터넷 전체</label>');
    if (u.pathname.endsWith('getRecruitList')) return new Response('{"recruitData":[]}');
    return new Response('');
  }) as typeof fetch);
  const ctx = { settings: s, http, now: new Date(), log: () => {}, browserPage: async () => { throw new Error('사용 금지'); } };
  for (const c of [saramin, jobkorea, catchCollector]) await c.collect(ctx);
  const sar = calls.filter(x => x.url.pathname.endsWith('/search/recruit')); assert.equal(sar.length, 1);
  assert.equal(sar[0].url.searchParams.get('cat_mcls'), '2'); assert.equal(sar[0].url.searchParams.get('searchword'), '');
  const jk = calls.filter(x => x.url.pathname.includes('_GI_List')); assert.equal(jk.length, 1);
  assert.equal(jk[0].body.get('condition[dutyCtgr]'), '10031'); assert.equal(jk[0].body.has('condition[textinclude]'), false);
  const ca = calls.filter(x => x.url.pathname.endsWith('getRecruitList')); assert.equal(ca.length, 1);
  assert.equal(ca[0].url.searchParams.get('JobCode'), '06'); assert.equal(ca[0].url.searchParams.get('Keyword'), ''); assert.equal(ca[0].url.searchParams.get('Career'), '0,1');
});

test('자소설 직무 분류는 같은 공고의 비개발 신입과 경력 개발자를 섞지 않는다', () => {
  const duty = [{ id: 94, name: 'IT·인터넷', category: 'large', group_id: null }, { id: 176, name: '서버·백엔드개발', category: 'small', group_id: 94 }];
  const entry = { id: 1, name: '합성기업', title: '부문별 채용', end_time: '2026-10-20T00:00:00+09:00', business_size: 'big_business', employments: [{ division: 1, duty_groups: [{ group_id: 91 }] }, { division: 2, duty_groups: [{ group_id: 176 }] }] };
  const options = { dutyNames: ['IT·인터넷'], keywords: [], now: new Date('2026-09-24'), excludeExperienced: true };
  assert.equal(mapCalendar([entry], duty, options).length, 0);
  entry.employments[1].division = 1;
  const [row] = mapCalendar([entry], duty, options);
  assert.deepEqual(row.roleNames, ['서버·백엔드개발']);
});

test('기업명 단어만으로 대기업을 확정하지 않고 사이트 근거나 명시적 회사 설정을 요구한다', () => {
  const s = settings();
  assert.equal(classifyCompany(s, '현대사무용품', [], true).include, false);
  assert.equal(classifyCompany(s, '확인된회사', ['대기업'], true).include, true);
  assert.equal(classifyCompany(s, '카카오', [], true).include, true);
  s.overrides.always_exclude = ['카카오'];
  assert.equal(classifyCompany(s, '(주)카카오', [], true).include, false);
});

test('직무 심사는 원문 근거가 있는 관련 공고만 후보로 올리고 무관/불명확/가짜 인용을 보류한다', async () => {
  const s = settings(); s.collect.keywords = ['백엔드'];
  const rows = ['good', 'sales', 'uncertain', 'invented'].map(id => ({ source: 'fake', sourceId: id, sourceUrl: `https://example.test/${id}`, company: `합성${id}`, title: id === 'sales' ? '와인 판매' : '백엔드 신입', roleNames: ['서버'], experience: 'new' as const, employmentTypes: ['정규직'], deadline: null, sizeHints: ['대기업'] }));
  const o: CollectOptions = { settings: s, http: new PoliteHttp(0), browserPage: async () => { throw new Error('사용 금지'); }, seen: new SeenStore(path.join(tempDir(), 'seen.json')), notion: null, dryRun: true, previewOnly: true, sources: ['fake'], collectors: [{ id: 'fake', label: '가짜', method: 'http', status: 'ok', note: '', collect: async () => rows }], runAgent: async request => {
    assert.deepEqual(request.tools, []); assert.equal(request.isolated, true);
    return { isError: false, text: JSON.stringify({ results: [
      { key: 'fake:good', decision: 'related', direction: '백엔드', quote: '백엔드 신입', reason: '백엔드 개발 모집' },
      { key: 'fake:sales', decision: 'unrelated', reason: '판매 업무이며 서버 분류만으로 개발 직무로 볼 수 없음' },
      { key: 'fake:uncertain', decision: 'pending', reason: '추가 자격 확인 필요' },
      { key: 'fake:invented', decision: 'related', direction: '백엔드', quote: '원문에 없는 Python', reason: '가짜 인용' },
    ] }) };
  } };
  const report = await runCollect(o);
  assert.equal(report.counts.candidate, 1); assert.equal(report.counts.role_mismatch, 1); assert.equal(report.counts.review_pending, 2);
  assert.match(report.items.find(x => x.outcome === 'candidate')!.matchedRole!, /백엔드 신입/);
});

test('직무 심사 시간 초과: 후보로 통과시키지 않고, 그 묶음만 한 번 더 한 뒤 다음 묶음은 계속 확인한다', async () => {
  const s = settings(); s.collect.keywords = ['검증용직무']; let calls = 0;
  const rows = Array.from({ length: 31 }, (_, i) => ({ source: 'timeout', sourceId: String(i), sourceUrl: `https://example.test/${i}`, company: `시간초과합성${i}`, title: '검증용직무 채용', roleNames: ['검증용직무'], experience: 'new' as const, employmentTypes: ['정규직'], deadline: null, sizeHints: ['대기업'] }));
  const o: CollectOptions = { settings: s, http: new PoliteHttp(0), browserPage: async () => { throw new Error('사용 금지'); }, seen: new SeenStore(path.join(tempDir(), 'seen.json')), notion: null, dryRun: true,
    runAgent: request => { calls++; return new Promise((_, reject) => request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true })); } };
  const report = await previewReport(rows, [], o, new Date().toISOString());
  await screenPreviewReport(report, { ...o, reviewTimeoutMs: 5 });
  // 31건 = 15·15·1 세 묶음. 묶음마다 한 번 더 해 보고(2회), 한 묶음이 실패해도 다음 묶음으로 간다
  assert.equal(calls, 6); assert.equal(report.counts.candidate, undefined); assert.equal(report.counts.review_pending, 31);
  assert.match(report.ai.errors[0], /제한 시간/);
});

test('직무 심사 연결 문제(로그인 만료 등)는 다시 해도 같으므로 바로 멈추고 남은 공고를 보류한다', async () => {
  const s = settings(); s.collect.keywords = ['검증용직무']; let calls = 0;
  const rows = Array.from({ length: 31 }, (_, i) => ({ source: 'auth', sourceId: String(i), sourceUrl: `https://example.test/${i}`, company: `연결문제합성${i}`, title: '검증용직무 채용', roleNames: ['검증용직무'], experience: 'new' as const, employmentTypes: ['정규직'], deadline: null, sizeHints: ['대기업'] }));
  const o: CollectOptions = { settings: s, http: new PoliteHttp(0), browserPage: async () => { throw new Error('사용 금지'); }, seen: new SeenStore(path.join(tempDir(), 'seen.json')), notion: null, dryRun: true,
    runAgent: async () => { calls++; return { isError: true, text: 'Failed to authenticate: OAuth session expired' }; } };
  const report = await previewReport(rows, [], o, new Date().toISOString());
  await screenPreviewReport(report, o);
  assert.equal(calls, 1); assert.equal(report.counts.candidate, undefined); assert.equal(report.counts.review_pending, 31);
  assert.ok(report.items.some(i => /AI 연결 문제로 남은 공고/.test(i.reason ?? '')));
});

test('구조: 자소설 달력의 직무별 신입/경력을 합치지 않고 직무마다 넘긴다 (예: "IT개발 — 신입")', () => {
  const duty = [{ id: 94, name: 'IT·인터넷', category: 'large', group_id: null }, { id: 176, name: '서버·백엔드개발', category: 'small', group_id: 94 }, { id: 91, name: '영업', category: 'small', group_id: null }];
  // 제목은 "신입/경력"이지만, 개발 직무는 신입이고 경력 직무는 영업이다
  const entry = { id: 7, name: '합성항공', title: '전문인력(신입/경력) 모집', end_time: '2026-10-20T00:00:00+09:00', business_size: 'big_business',
    employments: [{ division: 1, duty_groups: [{ group_id: 176 }] }, { division: 2, duty_groups: [{ group_id: 91 }] }] };
  const [row] = mapCalendar([entry], duty, { dutyNames: [], keywords: [], now: new Date('2026-09-01'), excludeExperienced: true });
  assert.deepEqual(row.positions, [{ name: '서버·백엔드개발', career: 'new' }]); // 경력 전용 영업은 빠지고, 개발은 신입으로 남는다
});

test('구조: 직무별 정보가 없는 사이트는 공고 전체의 신입/경력 값으로 직무를 만든다', () => {
  assert.deepEqual(positionsOf({ title: 'PSK 수시채용', roleNames: ['IT Infra Management', '네트워크/서버/보안'], experience: 'any' }),
    [{ name: 'IT Infra Management', career: 'any' }, { name: '네트워크/서버/보안', career: 'any' }]);
  assert.equal(openToNewcomers({ name: 'x', career: 'any' }), true);
  assert.equal(openToNewcomers({ name: 'x', career: 'unknown' }), true); // 모르면 막지 않는다
  assert.equal(openToNewcomers({ name: 'x', career: 'experienced' }), false);
});

test('구조: 직무 심사 AI 는 관련성만 판단하고, 신입 여부는 데이터로 정하며, 확인할 조건은 후보에 붙여 보여 준다', async () => {
  const s = settings(); s.collect.keywords = ['백엔드'];
  const base = { source: 'fake', employmentTypes: ['정규직'], deadline: null, sizeHints: ['대기업'] };
  const rows = [
    { ...base, sourceId: 'mixed', sourceUrl: 'https://example.test/mixed', company: '합성항공', title: '전문인력(신입/경력) 모집', roleNames: ['서버·백엔드개발'], experience: 'any' as const,
      positions: [{ name: 'IT개발', career: 'new' as const }] },
    { ...base, sourceId: 'career', sourceUrl: 'https://example.test/career', company: '합성경력', title: '개발자 채용', roleNames: ['백엔드'], experience: 'any' as const,
      positions: [{ name: '백엔드', career: 'experienced' as const }] },
    { ...base, sourceId: 'degree', sourceUrl: 'https://example.test/degree', company: '합성연구', title: '석·박사 연구장학생', roleNames: ['서버·백엔드개발'], experience: 'new' as const },
  ];
  const asked: any[] = [];
  const o: CollectOptions = { settings: s, http: new PoliteHttp(0), browserPage: async () => { throw new Error('사용 금지'); }, seen: new SeenStore(path.join(tempDir(), 'seen.json')), notion: null, dryRun: true, previewOnly: true, sources: ['fake'],
    collectors: [{ id: 'fake', label: '가짜', method: 'http', status: 'ok', note: '', collect: async () => rows }],
    runAgent: async request => {
      const input = JSON.parse(request.prompt);
      asked.push(...input.postings);
      assert.match(request.systemAppend, /신입 여부를 이유로 보류하지 않는다/);
      return { isError: false, text: JSON.stringify({ results: input.postings.map((p: any) => p.key === 'fake:mixed'
        ? { key: p.key, decision: 'related', direction: '백엔드', quote: 'IT개발', caution: '', reason: 'IT개발 신입 모집' }
        : { key: p.key, decision: 'related', direction: '백엔드', quote: '서버·백엔드개발', caution: '석·박사 대상', reason: '백엔드 개발 분류' }) }) };
    } };
  const report = await runCollect(o);
  const by = (id: string) => report.items.find(x => x.id === `fake:${id}`)!;
  // AI 에는 직무별 채용 형태가 그대로 간다 (제목의 "신입/경력"에 흔들리지 않게)
  assert.deepEqual(asked.find(p => p.key === 'fake:mixed').positions, [{ name: 'IT개발', career: 'new' }]);
  assert.equal(by('mixed').outcome, 'candidate'); // 제목이 신입/경력이어도 IT개발이 신입이면 후보
  assert.equal(by('career').outcome, 'experienced'); // 경력 전용 직무뿐이면 AI 에 묻지 않고 뺀다
  assert.ok(!asked.some(p => p.key === 'fake:career'));
  assert.equal(by('degree').outcome, 'candidate'); // 조건이 있어도 숨기지 않고
  assert.equal(by('degree').caution, '석·박사 대상'); // 확인할 조건으로 붙인다
});

test('잘 맞는 정도: 직무명이 업무를 직접 가리키면 strong, 넓은 분류만 있으면 broad (모르면 broad)', async () => {
  const s = settings(); s.collect.keywords = ['백엔드'];
  const base = { source: 'fit', employmentTypes: ['정규직'], deadline: null, sizeHints: ['대기업'], experience: 'new' as const };
  const rows = [
    { ...base, sourceId: 'direct', sourceUrl: 'https://example.test/d', company: '합성직접', title: '신입 채용', roleNames: ['서버·백엔드개발'] },
    { ...base, sourceId: 'wide', sourceUrl: 'https://example.test/w', company: '합성넓음', title: '신입 공채', roleNames: ['AI'] },
    { ...base, sourceId: 'none', sourceUrl: 'https://example.test/n', company: '합성모름', title: '신입 공채', roleNames: ['데이터'] },
  ];
  const o: CollectOptions = { settings: s, http: new PoliteHttp(0), browserPage: async () => { throw new Error('사용 금지'); }, seen: new SeenStore(path.join(tempDir(), 'seen.json')), notion: null, dryRun: true, previewOnly: true, sources: ['fit'],
    collectors: [{ id: 'fit', label: '가짜', method: 'http', status: 'ok', note: '', collect: async () => rows }],
    runAgent: async request => ({ isError: false, text: JSON.stringify({ results: JSON.parse(request.prompt).postings.map((p: any) => ({ key: p.key, decision: 'related', direction: '백엔드', quote: p.positions[0].name,
      ...(p.key === 'fit:direct' ? { fit: 'strong' } : p.key === 'fit:wide' ? { fit: 'broad' } : {}), reason: 'x' })) }) }) };
  const report = await runCollect(o);
  const fit = (id: string) => report.items.find(x => x.id === `fit:${id}`)!.fit;
  assert.equal(fit('direct'), 'strong'); assert.equal(fit('wide'), 'broad'); assert.equal(fit('none'), 'broad');
});
