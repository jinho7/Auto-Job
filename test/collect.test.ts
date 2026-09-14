import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { expandDutyGroups, mapCalendar, summarizeDivisions, deadlineFromIso, type DutyGroup } from '../src/collectors/jasoseol';
import { parseExperience, parseSaraminDeadline, parseSaraminDetail, parseSaraminSearch } from '../src/collectors/saramin';
import type { Collector, RawPosting } from '../src/collectors/types';
import { parseSettings, type Settings } from '../src/config';
import { isAllowed, parseRobots, PoliteHttp, RobotsBlockedError } from '../src/http';
import { classifyCompany, sizeHintFromText } from '../src/jobs/classify';
import { matchRoles, tagTokens } from '../src/jobs/roles';
import { SeenStore } from '../src/jobs/seen';
import { paths } from '../src/paths';
import type { RunAgent } from '../src/jobs/find-link';
import { cleanCompanyName, employmentKeys, employmentMatches, runCollect, type NotionSink } from '../src/pipeline/collect';
import { tempDir } from './helpers';

const base = parseSettings(readFileSync(paths.settingsExample, 'utf8'));
const NOW = new Date('2026-09-14T10:00:00+09:00');
const fixture = (f: string) => readFileSync(path.join(paths.fixtures, f), 'utf8');

// ─── robots.txt ───
test('robots: * 규칙, 가장 긴 규칙 우선, 와일드카드, 봇 전용 규칙은 무시', () => {
  const rules = parseRobots(`User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /Search/?stext=\nDisallow: /crt/*\nAllow: /recruit/joblist\nDisallow: /recruit\n`);
  assert.equal(isAllowed(rules, '/Search/?stext=백엔드'), false);
  assert.equal(isAllowed(rules, '/crt/abc'), false);
  assert.equal(isAllowed(rules, '/recruit/joblist?x=1'), true);
  assert.equal(isAllowed(rules, '/recruit/other'), false);
  assert.equal(isAllowed(rules, '/zf_user/search'), true);
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow: /\n'), '/anything'), false);
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow:\n'), '/anything'), true);
});

test('robots: 막힌 주소는 요청하지 않고, 사이트당 간격을 둔다', async () => {
  const calls: string[] = [];
  const slept: number[] = [];
  const fake = (async (url: string) => {
    calls.push(url);
    return new Response(url.endsWith('/robots.txt') ? 'User-agent: *\nDisallow: /private\n' : 'ok', { status: 200 });
  }) as typeof fetch;
  const http = new PoliteHttp(1000, fake, async (ms) => void slept.push(ms));
  await assert.rejects(http.request('https://a.example/private/1'), RobotsBlockedError);
  await http.request('https://a.example/public/1');
  await http.request('https://a.example/public/2');
  assert.deepEqual(calls, ['https://a.example/robots.txt', 'https://a.example/public/1', 'https://a.example/public/2']);
  assert.ok(slept.length >= 2 && slept.every((ms) => ms > 0 && ms <= 1000), `간격: ${slept}`);
});

// ─── 사람인 ───
test('사람인: 마감일 표기', () => {
  assert.deepEqual(parseSaraminDeadline('~ 09/30(수)', NOW), { date: '2026-09-30' });
  assert.deepEqual(parseSaraminDeadline('~ 01/05(월)', NOW), { date: '2027-01-05' }); // 연도 넘김
  assert.deepEqual(parseSaraminDeadline('오늘마감', NOW), { date: '2026-09-14' });
  assert.deepEqual(parseSaraminDeadline('내일마감', NOW), { date: '2026-09-15' });
  assert.deepEqual(parseSaraminDeadline('18시마감', NOW), { date: '2026-09-14', time: '18:00' });
  assert.equal(parseSaraminDeadline('채용시', NOW), null);
  assert.equal(parseSaraminDeadline('상시채용', NOW), null);
  assert.equal(parseExperience('신입·경력'), 'any');
  assert.equal(parseExperience('경력무관'), 'any');
  assert.equal(parseExperience('경력 3년↑'), 'experienced');
});

test('사람인: 검색 결과 해석', () => {
  const items = parseSaraminSearch(fixture('saramin-search.html'), NOW);
  assert.equal(items.length, 3);
  const [a, b, c] = items;
  assert.deepEqual(
    { id: a.sourceId, company: a.company, title: a.title, deadline: a.deadline, exp: a.experience, types: a.employmentTypes, roles: a.roleNames, apply: a.applyUrl },
    { id: '1001', company: '(주)가나다소프트', title: '신입 백엔드 개발자 모집', deadline: { date: '2026-09-30' }, exp: 'new', types: ['정규직'], roles: ['백엔드/서버개발', 'SI개발'], apply: 'https://www.saramin.co.kr/zf_user/jobs/view?rec_idx=1001' },
  );
  assert.equal(b.applyUrl, undefined); // 홈페이지 지원 → 상세에서 찾는다
  assert.equal(b.experience, 'any');
  assert.deepEqual(b.employmentTypes, ['계약직']);
  assert.equal(c.experience, 'experienced');
  assert.equal(c.deadline, null);
  assert.deepEqual(c.employmentTypes, ['정규직', '프리랜서']);
});

test('사람인: 상세에서 기업형태와 홈페이지 지원 링크', () => {
  assert.deepEqual(parseSaraminDetail(fixture('saramin-detail.html')), {
    sizeHints: ['중견'],
    homepageUrl: 'https://example.career.greetinghr.com/ko/o/123',
    companyTypeText: '중견기업, 코스닥 상장',
  });
  assert.deepEqual(sizeHintFromText('중소기업, 주식회사'), ['중소']);
  assert.deepEqual(sizeHintFromText('대기업, 외국계'), ['대기업', '외국계']);
});

// ─── 자소설닷컴 ───
const duty: DutyGroup[] = [
  { id: 94, name: 'IT·인터넷', category: 'large', group_id: null },
  { id: 162, name: '웹개발', category: 'medium', group_id: 94 },
  { id: 176, name: '서버·백엔드개발', category: 'small', group_id: 162 },
  { id: 91, name: '경영·사무', category: 'large', group_id: null },
];
const entry = (id: number, name: string, divisions: number[], groups: number[], end = '2026-09-30T17:00:00.000+09:00', size: string | null = null) => ({
  id,
  name,
  title: `${name} 채용`,
  end_time: end,
  business_size: size,
  employments: divisions.map((d) => ({ division: d, duty_groups: groups.map((g) => ({ group_id: g })) })),
});

test('자소설닷컴: 채용형태 코드와 마감 시각', () => {
  assert.deepEqual(summarizeDivisions([1, 1]), { types: ['신입'], experience: 'new' });
  assert.deepEqual(summarizeDivisions([2]), { types: [], experience: 'experienced' });
  assert.deepEqual(summarizeDivisions([2, 3]), { types: ['인턴'], experience: 'new' });
  assert.deepEqual(summarizeDivisions([5]), { types: ['신입'], experience: 'any' });
  assert.deepEqual(deadlineFromIso('2026-09-14T17:00:00.000+09:00'), { date: '2026-09-14', time: '17:00' });
  assert.deepEqual(deadlineFromIso('2026-09-14T23:59:00.000+09:00'), { date: '2026-09-14' });
  assert.equal(deadlineFromIso(null), null);
});

test('자소설닷컴: 상위 직무 분류를 고르면 하위 분류도 포함', () => {
  assert.deepEqual([...expandDutyGroups(duty, ['IT·인터넷'])].sort(), [162, 176, 94]);
  const list = mapCalendar(
    [entry(1, '가사', [1], [176], undefined, 'big_business'), entry(2, '나사', [1], [91]), entry(3, '다사', [1], [176], '2026-09-01T10:00:00.000+09:00')],
    duty,
    { dutyNames: ['IT·인터넷'], keywords: [], now: NOW },
  );
  assert.deepEqual(list.map((x) => x.company), ['가사']); // 경영 직무 제외, 마감 지난 공고 제외
  assert.deepEqual(list[0].sizeHints, ['대기업']);
  assert.deepEqual(list[0].roleNames, ['서버·백엔드개발']);
  assert.equal(list[0].sourceUrl, 'https://jasoseol.com/recruit/1');

  const byKeyword = mapCalendar([entry(1, '가사', [1], [176]), entry(2, '나사', [1], [91])], duty, { dutyNames: [], keywords: ['백엔드'], now: NOW });
  assert.deepEqual(byKeyword.map((x) => x.company), ['가사']);
});

// ─── 판정 ───
test('기업 구분: 목록, 회사명 단어, 사이트 정보, 여러 구분이면 포함/작성중 합치기', () => {
  const v = (name: string, hints: string[] = []) => classifyCompany(base, name, hints);
  assert.deepEqual(v('카카오페이').types, ['유명IT']);
  assert.equal(v('카카오페이').priority, true);
  assert.deepEqual(v('KB국민은행').types, ['금융']);
  assert.deepEqual(v('SK하이닉스').types, ['대기업']);
  assert.deepEqual(v('DESKTOP 솔루션').types, []); // "SK" 가 영단어 속에 있는 경우는 아님
  assert.deepEqual(v('한국도로공사').types, ['공기업']);
  const small = v('가나다소프트', ['중소']);
  assert.equal(small.include, false);
  assert.equal(v('토스', ['중소']).include, true); // 유명IT 목록이 있으면 포함
  assert.equal(v('모르는회사').include, true);
  assert.match(v('모르는회사').reason, /알 수 없어 포함/);
  const s2: Settings = { ...base, overrides: { always_include: ['가나다소프트'], always_exclude: ['나쁜회사'], priority: [] } };
  assert.equal(classifyCompany(s2, '(주)가나다소프트', ['중소']).include, true);
  assert.equal(classifyCompany(s2, '나쁜회사', ['대기업']).include, false);
});

test('직무 태그: 규칙이 없으면 태그 이름의 단어로', () => {
  assert.deepEqual(tagTokens('백엔드 (서버)'), ['백엔드', '서버']);
  assert.deepEqual(tagTokens('FEP 개발자'), ['FEP']);
  const tags = ['백엔드 (서버)', '클라우드/인프라', 'AI', 'IT', '게임', '기타'];
  assert.deepEqual(matchRoles(tags, {}, '신입 Nest/Spring 백엔드 개발자 모집 SI개발'), ['백엔드 (서버)']);
  assert.deepEqual(matchRoles(tags, {}, 'AI 플랫폼 인프라 엔지니어'), ['클라우드/인프라', 'AI']);
  assert.deepEqual(matchRoles(tags, {}, 'Maintenance 담당'), []); // "AI" 가 영단어 속에 있어도 아님
  assert.deepEqual(matchRoles(tags, { 게임: ['Unity', '게임서버'] }, 'Unity 클라이언트'), ['게임']);
});

test('고용형태: 설정과 비교, Notion 채용 분류로 변환, 회사명 정리', () => {
  assert.equal(employmentMatches(['정규직'], ['신입']), true);
  assert.equal(employmentMatches(['인턴'], ['채용연계형 인턴']), true);
  assert.equal(employmentMatches(['프리랜서'], ['신입', '인턴']), false);
  assert.equal(employmentMatches([], ['신입']), true);
  assert.deepEqual(employmentKeys(['신입'], '신입 공채'), ['정규직']);
  assert.deepEqual(employmentKeys(['계약직'], '백엔드 채용연계형 인턴', '백엔드 채용연계형 인턴'), ['채용연계형인턴']);
  assert.deepEqual(employmentKeys(['인턴'], '하계 인턴'), []); // 형태를 모르면 비움
  assert.equal(cleanCompanyName('(주)엘지씨엔에스'), '엘지씨엔에스');
  assert.equal(cleanCompanyName('데이원 주식회사'), '데이원');
});

// ─── 파이프라인 ───
const raw = (over: Partial<RawPosting>): RawPosting => ({
  source: 'fake',
  sourceId: over.company ?? 'x',
  sourceUrl: `https://fake/${over.company}`,
  company: 'A사',
  title: '백엔드 신입',
  deadline: { date: '2026-09-30' },
  experience: 'new',
  employmentTypes: ['정규직'],
  roleNames: [],
  sizeHints: [],
  applyUrl: `https://apply.example/${over.company ?? 'x'}`,
  ...over,
});

function fakeCollector(items: RawPosting[]): Collector {
  return { id: 'fake', label: '가짜', method: 'http', status: 'ok', note: '', collect: async () => items };
}
const okHttp = new PoliteHttp(0, (async () => new Response('ok', { status: 200 })) as typeof fetch, async () => {});

test('파이프라인: 필터, 합치기, 기업 구분, 지원 페이지, 직무 태그, 등록, 기록', async () => {
  const s: Settings = { ...base, collect: { ...base.collect, sources: { fake: true }, lookahead_days: 30 } };
  const items = [
    raw({ company: '가사', title: '백엔드 신입', sizeHints: ['대기업'] }),
    raw({ company: '(주)가사', title: '프론트 신입', sizeHints: ['대기업'] }), // 같은 회사+마감일 → 합침
    raw({ company: '경력사', experience: 'experienced' }),
    raw({ company: '프리사', employmentTypes: ['프리랜서'] }),
    raw({ company: '지난사', deadline: { date: '2026-09-01' } }),
    raw({ company: '먼사', deadline: { date: '2026-12-31' } }),
    raw({ company: '작은사', sizeHints: ['중소'] }),
    raw({ company: '링크없는사', applyUrl: undefined }),
    raw({ company: '이미본사' }),
    raw({ company: '상시사', deadline: null, title: 'AI 인프라 엔지니어' }),
  ];
  const seen = new SeenStore(path.join(tempDir(), 'seen.json'));
  seen.mark(SeenStore.key('fake', '이미본사'), { status: 'registered', company: '이미본사', title: '' });
  const added: string[] = [];
  const notion: NotionSink = {
    tags: ['백엔드 (서버)', 'AI', '클라우드/인프라'],
    add: async (p) => {
      added.push(`${p.company}|${p.roles.join(',')}|${p.employment.join(',')}|${p.priority}`);
      return { status: 'created', pageId: 'p', url: `https://notion.so/${p.company}`, dropped: [], usedTemplate: false };
    },
  };
  const noAi: RunAgent = async () => ({ text: '```json\n{"results":[]}\n```', isError: false });
  const r = await runCollect({ settings: s, http: okHttp, browserPage: async () => { throw new Error('브라우저 필요 없음'); }, seen, notion, dryRun: false, now: NOW, collectors: [fakeCollector(items)], runAgent: noAi });

  const by = Object.fromEntries(r.items.map((i) => [i.company, i.outcome]));
  assert.deepEqual(by, {
    경력사: 'experienced', 프리사: 'employment', 지난사: 'expired', 먼사: 'too_far', 이미본사: 'seen',
    가사: 'registered', 작은사: 'company', 링크없는사: 'no_link', 상시사: 'registered',
  });
  assert.equal(r.counts.merged, 1);
  assert.deepEqual(added, ['가사|백엔드 (서버)|정규직|true', '상시사|AI,클라우드/인프라|정규직|false']);
  assert.equal(seen.get(SeenStore.key('fake', '가사'))?.status, 'registered');
  assert.equal(seen.get(SeenStore.key('fake', '링크없는사'))?.status, 'no_link'); // AI 로도 못 찾음 → 기록
});

/** 가짜 AI: 지원 페이지 찾기와 직무 태그 요청을 구분해 정해진 답을 준다 */
function fakeAgent(links: Record<string, string>, roles: Record<string, string[]>) {
  const calls: { kind: string; prompt: string }[] = [];
  const run: RunAgent = async (o) => {
    const kind = /실제 지원 페이지/.test(o.systemAppend ?? '') ? 'link' : 'roles';
    calls.push({ kind, prompt: o.prompt });
    const keys = [...o.prompt.matchAll(/key: (\S+)/g)].map((m) => m[1]);
    const results = kind === 'link'
      ? keys.map((key) => ({ key, url: links[key] ?? '', note: links[key] ? '회사 채용 사이트' : '못 찾음' }))
      : keys.map((key) => ({ key, roles: roles[key] ?? [] }));
    return { text: `찾았습니다.\n\`\`\`json\n${JSON.stringify({ results })}\n\`\`\``, isError: false, costUsd: 0.01 };
  };
  return { run, calls };
}

test('파이프라인: 지원 페이지를 AI 가 찾고 코드가 다시 확인, 카페 링크는 인정 안 함, 이미 있는 공고는 찾지 않음', async () => {
  const s: Settings = { ...base, collect: { ...base.collect, sources: { fake: true } } };
  const items = [
    raw({ company: '찾을사', applyUrl: undefined }),
    raw({ company: '카페사', applyUrl: undefined }),
    raw({ company: '깨진사', applyUrl: 'https://broken.example/x' }),
    raw({ company: '이미있는사', applyUrl: undefined }),
  ];
  const http = new PoliteHttp(0, (async (url: string) => new Response('x', { status: url.includes('broken.example') ? 404 : 200 })) as typeof fetch, async () => {});
  const ai = fakeAgent({ 'fake:찾을사': 'https://careers.find.example/jobs/1', 'fake:카페사': 'https://cafe.naver.com/jobs/1', 'fake:깨진사': 'https://careers.broken-fixed.example/2' }, {});
  const notion: NotionSink = {
    tags: [],
    add: async (p) => ({ status: 'created', pageId: 'p', url: `https://notion.so/${p.company}`, dropped: [], usedTemplate: false }),
    check: async (p) => (p.company === '이미있는사' ? { existing: { id: 'e', url: 'https://notion.so/e', company: p.company, link: '', deadline: '2026-09-30' }, reason: '같은 회사, 같은 마감일' } : null),
  };
  const r = await runCollect({ settings: s, http, browserPage: async () => { throw new Error('x'); }, seen: new SeenStore(path.join(tempDir(), 's.json')), notion, dryRun: false, now: NOW, collectors: [fakeCollector(items)], runAgent: ai.run });
  const by = Object.fromEntries(r.items.map((i) => [i.company, i]));
  assert.equal(by['찾을사'].outcome, 'registered');
  assert.equal(by['찾을사'].applyUrl, 'https://careers.find.example/jobs/1');
  assert.match(by['찾을사'].found ?? '', /AI 검색/);
  assert.equal(by['카페사'].outcome, 'no_link');
  assert.match(by['카페사'].reason ?? '', /cafe\.naver\.com/);
  assert.equal(by['깨진사'].outcome, 'registered'); // 원래 링크가 404 → AI 가 찾은 링크
  assert.equal(by['이미있는사'].outcome, 'duplicate');
  assert.equal(ai.calls.length, 1);
  assert.doesNotMatch(ai.calls[0].prompt, /이미있는사/);
  assert.match(ai.calls[0].prompt, /확인 실패한 링크: https:\/\/broken\.example\/x/);
  assert.deepEqual({ searched: r.ai.linkSearched, found: r.ai.linkFound }, { searched: 3, found: 2 });
});

test('파이프라인: AI 검색 한도를 넘으면 찾지 않고, 꺼 두면 AI 를 부르지 않는다', async () => {
  const items = [raw({ company: '가사', applyUrl: undefined }), raw({ company: '나사', applyUrl: undefined, deadline: { date: '2026-09-29' } })];
  const ai = fakeAgent({ 'fake:가사': 'https://careers.ga.example/1' }, {});
  const limited: Settings = { ...base, collect: { ...base.collect, sources: { fake: true }, link_search: { ...base.collect.link_search, max_per_run: 1 } } };
  const r = await runCollect({ settings: limited, http: okHttp, browserPage: async () => { throw new Error('x'); }, seen: new SeenStore(path.join(tempDir(), 's.json')), notion: null, dryRun: true, now: NOW, collectors: [fakeCollector(items)], runAgent: ai.run });
  assert.deepEqual(r.items.map((i) => [i.company, i.outcome]), [['나사', 'no_link'], ['가사', 'would_register']]);
  assert.match(r.items[0].reason ?? '', /한도/);

  const off: Settings = { ...base, collect: { ...base.collect, sources: { fake: true }, link_search: { ...base.collect.link_search, enabled: false } } };
  const ai2 = fakeAgent({}, {});
  const r2 = await runCollect({ settings: off, http: okHttp, browserPage: async () => { throw new Error('x'); }, seen: new SeenStore(path.join(tempDir(), 's.json')), notion: null, dryRun: true, now: NOW, collectors: [fakeCollector(items)], runAgent: ai2.run });
  assert.equal(r2.counts.no_link, 2);
  assert.equal(ai2.calls.length, 0);
});

test('파이프라인: AI 직무 태그 (규칙으로 못 단 공고만 / 다시 보기 / 없는 태그는 버림 / 태그 없으면 빼기)', async () => {
  const tags = ['백엔드 (서버)', 'AI', '데이터'];
  const items = [raw({ company: '규칙사', title: '백엔드 신입' }), raw({ company: '애매사', title: '2026 신입 공채', deadline: { date: '2026-09-29' } }), raw({ company: '모름사', title: '신입 공채', deadline: { date: '2026-09-28' } })];
  const notion = (): NotionSink & { added: string[] } => {
    const added: string[] = [];
    return { tags, added, add: async (p) => (added.push(`${p.company}:${p.roles.join(',')}`), { status: 'created', pageId: 'p', url: 'u', dropped: [], usedTemplate: false }) };
  };
  const answers = { 'fake:규칙사': ['백엔드 (서버)', 'AI'], 'fake:애매사': ['데이터', '없는 태그'], 'fake:모름사': [] };
  const go = async (mode: 'off' | 'fill_empty' | 'review', requireRole = false) => {
    const s: Settings = { ...base, collect: { ...base.collect, sources: { fake: true }, ai_roles: { mode, model: '' }, require_role: requireRole } };
    const ai = fakeAgent({}, answers);
    const n = notion();
    const r = await runCollect({ settings: s, http: okHttp, browserPage: async () => { throw new Error('x'); }, seen: new SeenStore(path.join(tempDir(), 's.json')), notion: n, dryRun: false, now: NOW, collectors: [fakeCollector(items)], runAgent: ai.run });
    return { added: n.added, calls: ai.calls, r };
  };
  const fill = await go('fill_empty');
  assert.deepEqual(fill.added, ['규칙사:백엔드 (서버)', '애매사:데이터', '모름사:']);
  assert.doesNotMatch(fill.calls[0].prompt, /규칙사/); // 규칙으로 단 공고는 AI 에게 안 보냄
  const review = await go('review');
  assert.deepEqual(review.added, ['규칙사:백엔드 (서버),AI', '애매사:데이터', '모름사:']);
  assert.match(review.calls[0].prompt, /규칙으로 단 태그: 백엔드 \(서버\)/);
  const off = await go('off');
  assert.equal(off.calls.length, 0);
  assert.deepEqual(off.added, ['규칙사:백엔드 (서버)', '애매사:', '모름사:']);
  const strict = await go('fill_empty', true);
  assert.deepEqual(strict.added, ['규칙사:백엔드 (서버)', '애매사:데이터']);
  assert.equal(strict.r.counts.no_role, 1);
});

test('기록: 지원 페이지를 못 찾은 공고는 7일 뒤 다시 확인한다', () => {
  const seen = new SeenStore(path.join(tempDir(), 's.json'));
  seen.mark('fake:a', { status: 'no_link', company: 'a', title: '' });
  seen.mark('fake:b', { status: 'registered', company: 'b', title: '' });
  const later = new Date(Date.now() + 8 * 86_400_000);
  assert.ok(seen.skip('fake:a'));
  assert.equal(seen.skip('fake:a', later), undefined);
  assert.ok(seen.skip('fake:b', later));
});

test('파이프라인: 미리보기는 기록을 남기지 않고, Notion 이 없어도 돈다', async () => {
  const s: Settings = { ...base, collect: { ...base.collect, sources: { fake: true } } };
  const file = path.join(tempDir(), 'seen.json');
  const seen = new SeenStore(file);
  const r = await runCollect({ settings: s, http: okHttp, browserPage: async () => { throw new Error('x'); }, seen, notion: null, dryRun: true, now: NOW, collectors: [fakeCollector([raw({ company: '가사' })])] });
  assert.equal(r.counts.would_register, 1);
  assert.equal(seen.size, 0);
  assert.equal(r.notion, 'not_configured');
});

test('파이프라인: 수집기 하나가 실패해도 나머지는 계속', async () => {
  const s: Settings = { ...base, collect: { ...base.collect, sources: { fake: true, bad: true } } };
  const bad: Collector = { id: 'bad', label: '고장', method: 'http', status: 'ok', note: '', collect: async () => { throw new Error('사이트 오류'); } };
  const r = await runCollect({ settings: s, http: okHttp, browserPage: async () => { throw new Error('x'); }, seen: new SeenStore(path.join(tempDir(), 's.json')), notion: null, dryRun: true, now: NOW, collectors: [bad, fakeCollector([raw({ company: '가사' })])] });
  assert.deepEqual(r.sources.map((x) => [x.id, x.error ?? x.count]), [['bad', '사이트 오류'], ['fake', 1]]);
  assert.equal(r.counts.would_register, 1);
});
