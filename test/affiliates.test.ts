import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseSettings } from '../src/config';
import type { RawPosting } from '../src/collectors/types';
import { PoliteHttp } from '../src/http';
import { AFFILIATE_POLICIES, combineAffiliatePostings, matchesAffiliatePolicy, verifyAffiliatePolicies } from '../src/jobs/affiliates';
import type { JobPosting } from '../src/jobs/model';
import { SeenStore } from '../src/jobs/seen';
import { type DataSource, type NotionClient, type NotionPage } from '../src/notion/client';
import { affiliateBlocks, NotionJobWriter } from '../src/notion/jobs';
import { paths } from '../src/paths';
import { groupPreview } from '../src/pipeline/affiliate-preview';
import { runCollect, type CollectReport } from '../src/pipeline/collect';
import { tempDir } from './helpers';

const policy = AFFILIATE_POLICIES[0];
const verified = { ...policy, checkedAt: '2026-09-24T07:00:00.000Z' };
const now = new Date(verified.checkedAt);
const base = parseSettings(readFileSync(paths.settingsExample, 'utf8'));
const postings: JobPosting[] = policy.companies.slice(0, 8).map((company, i) => ({
  company, title: '2026 신입사원 모집', deadline: { date: policy.deadline, time: policy.deadlineTime },
  link: `https://apply.example/${i}`, sourceUrl: `https://source.example/${i}`, roles: ['백엔드 (서버)'],
  recruitmentRoles: [`서버 개발 ${i}`], employment: ['정규직'], companyType: '대기업',
}));
const raws: RawPosting[] = postings.map((p, i) => ({
  company: p.company, title: p.title!, deadline: p.deadline, source: 'fake', sourceId: String(i), sourceUrl: p.sourceUrl!,
  applyUrl: p.link, roleNames: ['백엔드 개발'], sizeHints: ['대기업'], employmentTypes: ['정규직'], experience: 'new',
}));
function http(valid = true) {
  const calls: string[] = [];
  const value = new PoliteHttp(0, (async (url: string) => {
    calls.push(String(url));
    const body = url.endsWith('robots.txt') ? '' : url === policy.policyUrl ? (valid ? policy.quote : '안내 변경') : url === policy.campaignUrl ? `${policy.campaignText} ${policy.deadlineEvidence}` : '지원 공고';
    return new Response(body, { status: 200 });
  }) as typeof fetch, async () => {});
  return { value, calls };
}
function report(): CollectReport {
  return { phase: 'preview', dryRun: true, startedAt: '', finishedAt: '', notion: 'not_configured', sources: [], counts: { candidate: 8 },
    ai: { costUsd: 0, errors: [], linkFound: 0, linkSearched: 0, rolesTagged: 0 },
    items: raws.map((r, i) => ({ id: String(i), candidate: structuredClone(r), outcome: 'candidate', company: r.company, title: r.title, deadline: policy.deadline, source: r.source, sourceUrl: r.sourceUrl })),
  };
}

test('계열사: 명시된 회사와 같은 신입 공채 회차만 해당한다', () => {
  assert.equal(base.collect.group_affiliates, false);
  assert.ok(postings.every(p => matchesAffiliatePolicy(p, policy)));
  for (const delta of [{ company: 'CJ테스트기업' }, { title: '2026 신입사원 인턴 채용' }, { title: '2027 신입사원 모집' },
    { deadline: { date: '2026-10-01' } }, { deadline: { date: policy.deadline, time: '18:00' } }]) {
    assert.equal(matchesAffiliatePolicy({ ...postings[0], ...delta }, policy), false);
  }
});

test('계열사: 현재 공식 규정과 회차 안내를 모두 확인하며 불확실하면 묶지 않는다', async () => {
  const good = await verifyAffiliatePolicies(postings, http().value, now);
  assert.deepEqual(good.verified, [verified]);
  const bad = await verifyAffiliatePolicies(postings, http(false).value, now);
  assert.equal(bad.verified.length, 0); assert.equal(bad.warnings.length, 1);
  const one = http(); await verifyAffiliatePolicies(postings.slice(0, 1), one.value, now);
  assert.equal(one.calls.length, 0);
});

test('계열사: 미리보기 8개는 한 묶음으로 표시하며 해제해도 원본 8개가 유지된다', async () => {
  const r = report(), h = http();
  const original = structuredClone(r.items);
  await groupPreview(r, false, h.value); assert.equal(h.calls.length, 0);
  await groupPreview(r, true, h.value);
  assert.equal(r.affiliateGroups?.length, 1); assert.equal(r.affiliateGroups?.[0].memberIds.length, 8);
  assert.deepEqual(r.items, original);
  await groupPreview(r, false, h.value);
  assert.deepEqual(r.affiliateGroups, []); assert.deepEqual(r.items, original);
});

async function collect(group = true, selected = raws, valid = true) {
  const settings = structuredClone(base);
  settings.collect.group_affiliates = group; settings.collect.ai_roles.mode = 'off'; settings.collect.link_search.enabled = false;
  const writes: JobPosting[] = [], seen = new SeenStore(path.join(tempDir(), 'seen.json'));
  const r = await runCollect({ settings, selectedPostings: selected.map(r => ({ ...r })), now, http: http(valid).value,
    seen, dryRun: false, browserPage: async () => { throw new Error('No browser in fixture'); },
    notion: { tags: ['백엔드 (서버)'], add: async p => { writes.push(p); return { status: 'created', pageId: 'one', url: 'https://notion.so/one', dropped: [], usedTemplate: false }; } },
  });
  return { r, writes, seen };
}

test('계열사: 선택한 8개를 한 번만 등록하고 각 원본의 처리 기록에 같은 페이지를 남긴다', async () => {
  const { r, writes, seen } = await collect();
  assert.equal(writes.length, 1); assert.equal(writes[0].applicationGroup?.members.length, 8);
  assert.equal(r.createdPages, 1);
  assert.equal(r.counts.registered, 8); assert.equal(new Set(r.items.map(i => i.notionUrl)).size, 1);
  for (const raw of raws) assert.equal(seen.get(SeenStore.key(raw.source, raw.sourceId))?.notionUrl, 'https://notion.so/one');
  assert.equal((await collect(false)).writes.length, 8);
});

test('계열사: 규정 확인 실패 또는 일부 상세 확인 실패 시 개별 등록으로 바꾸지 않는다', async () => {
  await assert.rejects(collect(true, raws, false), /등록을 중지/);
  const failed = raws.map((r, i) => i ? r : { ...r, detail: async () => { throw new Error('합성 상세 오류'); } });
  const result = await collect(true, failed);
  assert.equal(result.writes.length, 0); assert.equal(result.r.counts.error, 8);
  const changed = raws.map((r, i) => i ? r : { ...r, detail: async () => ({ deadline: { date: '2026-09-29' } }) });
  assert.equal((await collect(true, changed)).writes.length, 0);
});

const ds: DataSource = { id: 'fixture', title: 'fixture', properties: {
  회사명: { id: 'title', name: '회사명', type: 'title' },
  '지원 마감 시간': { id: 'date', name: '지원 마감 시간', type: 'date' },
} };
function fakeNotion(template = false, existing: NotionPage[] = []) {
  const pages = [...existing], bodies: Record<string, unknown[]> = {}, creates: Parameters<NotionClient['createPage']>[0][] = [];
  const updates: unknown[] = [];
  const client = {
    queryPages: async () => pages,
    listTemplates: async () => template ? [{ is_default: true }] : [],
    createPage: async (body: Parameters<NotionClient['createPage']>[0]) => {
      const id = `page${creates.length}`; creates.push(body);
      // Read API includes plain_text, unlike write input.
      const properties = JSON.parse(JSON.stringify(body.properties));
      for (const p of Object.values(properties) as any[]) {
        if (p.title) { p.type = 'title'; p.title.forEach((t: any) => { t.plain_text = t.text.content; }); }
        if (p.date) p.type = 'date';
      }
      const page = { id, url: `https://notion.so/${id}`, properties }; pages.push(page);
      bodies[id] = body.children as unknown[] ?? [];
      return page;
    },
    listBlocks: async () => [{ id: 'template', type: 'heading_2' }],
    listAllBlocks: async (id: string) => (bodies[id] as any[]).map(b => {
      const copy = structuredClone(b); copy[copy.type].rich_text.forEach((t: any) => { t.plain_text = t.text.content; }); return copy;
    }),
    appendBlocks: async (id: string, blocks: unknown[]) => { bodies[id].push(...blocks); },
    updatePage: async (...args: unknown[]) => { updates.push(args); },
  } as unknown as NotionClient;
  return { client, bodies, creates, updates };
}

test('계열사: Notion 한 페이지 본문에 8개 회사의 직무, 마감, 원문, 지원 링크와 규정을 보존한다', async () => {
  const p = combineAffiliatePostings(postings, verified), f = fakeNotion();
  const writer = new NotionJobWriter(f.client, base, ds);
  const dry = await writer.add(p, { dryRun: true });
  assert.equal(dry.status, 'dry-run'); assert.equal(f.creates.length, 0);
  assert.equal((await writer.add(p)).status, 'created');
  assert.equal(f.creates.length, 1);
  const blocks = f.bodies.page0 as any[], body = JSON.stringify(blocks);
  assert.equal(blocks.filter(b => b.type === 'heading_3').length, 8);
  for (const member of postings) for (const text of [member.company, member.link, member.sourceUrl!, member.recruitmentRoles![0]]) assert.ok(body.includes(text));
  assert.ok(body.includes(policy.policyUrl)); assert.ok(body.includes('17:00'));
  assert.equal((await writer.add(postings[0])).status, 'duplicate');
  // New process / grouping turned off still finds members via group page body.
  const restarted = new NotionJobWriter(f.client, base, ds);
  assert.equal((await restarted.add({ ...postings[1], link: 'https://another-source.example/1' })).status, 'duplicate');
  assert.equal(f.creates.length, 1);
});

test('계열사: DB 템플릿을 유지하고 계열사 내용을 덧붙인다', async () => {
  const f = fakeNotion(true), p = combineAffiliatePostings(postings, verified);
  await new NotionJobWriter(f.client, base, ds, { pollMs: 1, timeoutMs: 100 }).add(p);
  assert.deepEqual(f.creates[0].template, { type: 'default' }); assert.equal(f.creates[0].children, undefined);
  assert.equal(f.updates.length, 1); assert.deepEqual(f.bodies.page0, affiliateBlocks(p));
});

test('계열사: 기존 개별 페이지가 하나라도 있으면 그룹 페이지를 중복 생성하지 않는다', async () => {
  const f = fakeNotion();
  const writer = new NotionJobWriter(f.client, base, ds);
  await writer.add(postings[0]);
  assert.equal((await writer.add(combineAffiliatePostings(postings, verified))).status, 'duplicate');
  assert.equal(f.creates.length, 1);
});
