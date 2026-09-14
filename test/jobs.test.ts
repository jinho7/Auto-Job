import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseSettings } from '../src/config';
import { companyVariants, findDuplicate, normalizeLink, sameCompany } from '../src/jobs/dedup';
import { parseDeadline, type JobPosting } from '../src/jobs/model';
import { bootstrapDatabase, bootstrapProperties } from '../src/notion/bootstrap';
import type { DataSource, NotionClient, NotionPage, NotionProperty } from '../src/notion/client';
import { buildProperties, decideStatus, NotionJobWriter, sectionBlocks } from '../src/notion/jobs';
import { paths } from '../src/paths';
import { SettingsStore } from '../src/settings/store';
import { freshSettingsFile } from './helpers';

const settings = parseSettings(readFileSync(paths.settingsExample, 'utf8'));

// ─── 마감일 ───
test('마감일 해석', () => {
  assert.deepEqual(parseDeadline('2026-09-30 18:00'), { date: '2026-09-30', time: '18:00' });
  assert.deepEqual(parseDeadline('2026.9.3'), { date: '2026-09-03' });
  assert.deepEqual(parseDeadline('2026/09/30 9:05'), { date: '2026-09-30', time: '09:05' });
  assert.equal(parseDeadline('상시'), null);
  assert.equal(parseDeadline('채용시 마감'), null);
  assert.equal(parseDeadline(''), null);
  assert.throws(() => parseDeadline('다음주 금요일'), /형식/);
  assert.throws(() => parseDeadline('2026-09-30 25:00'), /시간/);
});

// ─── 중복 ───
test('링크 정규화: 추적 파라미터, www, 끝 슬래시, # 무시', () => {
  assert.equal(normalizeLink('https://www.Example.com/jobs/1/?utm_source=x&b=2&a=1#top'), 'example.com/jobs/1?a=1&b=2');
  assert.equal(normalizeLink('https://example.com/jobs/1'), normalizeLink('http://www.example.com/jobs/1/'));
});

test('회사명 비교', () => {
  assert.ok(sameCompany('[CJ] 올리브영', 'CJ올리브영'));
  assert.ok(sameCompany('(주)카카오', '카카오'));
  assert.ok(sameCompany('주식회사 토스', '토스'));
  assert.ok(!sameCompany('카카오', '카카오페이'));
  assert.deepEqual([...companyVariants('[CJ] 올리브영')], ['cj올리브영', '올리브영']);
});

test('중복 판단: 링크, 회사+마감일, 상시끼리', () => {
  const existing = [
    { id: '1', company: '[CJ] 올리브영', link: 'https://recruit.cj.net/1', deadline: '2026-09-30' },
    { id: '2', company: '토스', link: 'https://toss.im/career/2', deadline: '' },
  ];
  const d = (c: string, link: string, date: string | null) => findDuplicate({ company: c, link, deadline: date ? { date } : null }, existing);
  assert.equal(d('다른회사', 'https://recruit.cj.net/1/', '2026-10-01')?.reason, '지원 링크가 같음');
  assert.match(d('CJ올리브영', 'https://other/1', '2026-09-30')!.reason, /같은 마감일/);
  assert.equal(d('CJ올리브영', 'https://other/1', '2026-10-15'), null); // 다른 회차
  assert.match(d('(주)토스', 'https://toss.im/career/9', null)!.reason, /상시/);
});

// ─── 속성 ───
const prop = (name: string, type: string, options?: string[]): NotionProperty => ({ id: name, name, type, ...(options ? { [type]: { options: options.map((o) => ({ name: o })) } } : {}) });
const ds: DataSource = {
  id: 'ds1',
  title: '서류 제출 자료',
  properties: Object.fromEntries(
    [
      prop('회사명', 'title'),
      prop('직무', 'multi_select', ['백엔드 (서버)', '클라우드/인프라']),
      prop('채용 분류', 'multi_select', ['정규직', '채용 연계/전환형 인턴', '체험형 인턴', '계약직']),
      prop('지원 마감 시간', 'date'),
      prop('제출 상태', 'select', ['제출전', '작성중', '제출완료']),
      prop('합불 여부', 'multi_select', ['대기', '불합격']),
      prop('참고 키워드', 'rich_text'),
      prop('지원 링크', 'url'),
    ].map((p) => [p.name, p]),
  ),
};
const posting: JobPosting = {
  company: 'A사',
  link: 'https://a.example/apply/1',
  deadline: { date: '2026-09-30', time: '18:00' },
  roles: ['백엔드 (서버)', '게임'],
  employment: ['정규직', '채용연계형인턴'],
  note: '코딩테스트 있음',
  companyType: '대기업',
};

test('속성: 기존 옵션만 쓰고, 표준 채용 분류는 DB 옵션 이름으로 바꾼다', () => {
  const { properties, dropped } = buildProperties(posting, settings.notion, ds, '작성중');
  assert.deepEqual(properties['회사명'], { title: [{ type: 'text', text: { content: 'A사' } }] });
  assert.deepEqual(properties['직무'], { multi_select: [{ name: '백엔드 (서버)' }] });
  assert.deepEqual(properties['채용 분류'], { multi_select: [{ name: '정규직' }, { name: '채용 연계/전환형 인턴' }] });
  assert.deepEqual(properties['지원 마감 시간'], { date: { start: '2026-09-30T18:00:00+09:00' } });
  assert.deepEqual(properties['제출 상태'], { select: { name: '작성중' } });
  assert.deepEqual(properties['합불 여부'], { multi_select: [{ name: '대기' }] });
  assert.deepEqual(properties['지원 링크'], { url: 'https://a.example/apply/1' });
  assert.deepEqual(properties['참고 키워드'], { rich_text: [{ type: 'text', text: { content: '코딩테스트 있음' } }] });
  assert.deepEqual(dropped, ['직무: "게임" (DB에 없는 옵션이라 뺐습니다)']);
});

test('속성: 상시면 마감일을 비우고, 제목 속성이 없으면 오류', () => {
  const { properties } = buildProperties({ ...posting, deadline: null, note: undefined }, settings.notion, ds, '제출전');
  assert.equal('지원 마감 시간' in properties, false);
  assert.equal('참고 키워드' in properties, false);
  const noTitle = { ...ds, properties: { ...ds.properties } };
  delete noTitle.properties['회사명'];
  assert.throws(() => buildProperties(posting, settings.notion, noTitle, '제출전'), /회사명 속성/);
});

test('제출 상태: 기업 구분 priority, 회사 직접 지정', () => {
  assert.equal(decideStatus(settings, { company: 'A', companyType: '대기업' }), '작성중');
  assert.equal(decideStatus(settings, { company: 'A', companyType: '중견' }), '제출전');
  assert.equal(decideStatus(settings, { company: 'A' }), '제출전');
  const s2 = { ...settings, overrides: { ...settings.overrides, priority: ['(주)에이'] } };
  assert.equal(decideStatus(s2, { company: '에이', companyType: '중견' }), '작성중');
});

// ─── 쓰기 ───
type Created = Parameters<NotionClient['createPage']>[0];
function fakeClient(opts: { pages?: NotionPage[]; templates?: { id: string; name: string; is_default: boolean }[]; blocksAfterPolls?: number } = {}) {
  const created: Created[] = [];
  const updated: { id: string; properties: Record<string, unknown> }[] = [];
  let polls = 0;
  const client = {
    queryPages: async () => opts.pages ?? [],
    listTemplates: async () => opts.templates ?? [],
    createPage: async (b: Created) => {
      created.push(b);
      return { id: `p${created.length}`, url: `https://notion.so/p${created.length}` };
    },
    // 템플릿 적용은 비동기: 몇 번 조회한 뒤에야 본문이 생긴다
    listBlocks: async () => (++polls > (opts.blocksAfterPolls ?? 2) ? [{ id: 'b', type: 'heading_2' }] : []),
    updatePage: async (id: string, properties: Record<string, unknown>) => void updated.push({ id, properties }),
  } as unknown as NotionClient;
  return { client, created, updated, polls: () => polls };
}
const fast = { pollMs: 1, timeoutMs: 500 };
const page = (company: string, link: string, date: string | null): NotionPage => ({
  id: company,
  url: `https://notion.so/${company}`,
  properties: {
    회사명: { type: 'title', title: [{ plain_text: company }] },
    '지원 링크': { type: 'url', url: link },
    '지원 마감 시간': { type: 'date', date: date ? { start: date } : null },
  },
});

test('쓰기: DB 기본 템플릿이 있으면 템플릿으로, 새로 만든 공고도 바로 중복 판단에 들어간다', async () => {
  const { client, created, updated, polls } = fakeClient({ templates: [{ id: 't', name: '회사명', is_default: true }] });
  const w = new NotionJobWriter(client, settings, ds, fast);
  const r = await w.add(posting);
  assert.equal(r.status, 'created');
  assert.deepEqual(created[0].template, { type: 'default' });
  assert.equal(created[0].children, undefined);
  assert.equal(created[0].parent.data_source_id, 'ds1');
  // 템플릿 적용을 기다린 뒤, 템플릿 속성이 덮지 못하게 같은 값을 다시 넣는다
  assert.equal(r.status === 'created' && r.templateApplied, true);
  assert.equal(polls(), 3);
  assert.deepEqual(updated, [{ id: 'p1', properties: created[0].properties }]);
  assert.equal((await w.add({ ...posting, company: 'A사 (재수집)' })).status, 'duplicate'); // 같은 링크
  assert.equal(created.length, 1);
});

test('쓰기: 템플릿이 없거나 끄면 설정의 제목들로 본문을 만든다', async () => {
  const { client, created, updated } = fakeClient();
  await new NotionJobWriter(client, settings, ds, fast).add(posting);
  assert.equal(created[0].template, undefined);
  assert.deepEqual(updated, []); // 템플릿이 없으면 다시 넣을 필요 없음
  assert.deepEqual(created[0].children, sectionBlocks(settings.notion.page_sections));
  assert.equal((created[0].children as unknown[]).length, settings.notion.page_sections.length * 2);

  const off = { ...settings, notion: { ...settings.notion, use_db_template: false } };
  const t = fakeClient({ templates: [{ id: 't', name: 'x', is_default: true }] });
  await new NotionJobWriter(t.client, off, ds).add(posting);
  assert.equal(t.created[0].template, undefined);
});

test('쓰기: 기존 페이지와 중복이면 넣지 않고, 미리보기는 쓰지 않는다', async () => {
  const { client, created } = fakeClient({ pages: [page('[A] A사', 'https://other', '2026-09-30T18:00:00.000+09:00')] });
  const w = new NotionJobWriter(client, settings, ds);
  const dup = await w.add(posting);
  assert.equal(dup.status, 'duplicate');
  assert.match(dup.status === 'duplicate' ? dup.duplicate.reason : '', /같은 마감일/);
  const dry = await w.add({ ...posting, company: 'B사', link: 'https://b.example/1' }, { dryRun: true });
  assert.equal(dry.status, 'dry-run');
  assert.equal(created.length, 0);
});

// ─── 새 DB ───
test('새 DB: 설정의 속성 이름과 옵션으로 만든다', async () => {
  const props = bootstrapProperties(settings.notion, ['백엔드', '백엔드', ' AI ']) as Record<string, any>;
  assert.deepEqual(props['회사명'], { title: {} });
  assert.deepEqual(props['직무'].multi_select.options.map((o: any) => o.name), ['백엔드', 'AI']);
  assert.deepEqual(props['채용 분류'].multi_select.options.map((o: any) => o.name), ['정규직', '채용 연계/전환형 인턴', '체험형 인턴', '계약직']);
  assert.ok(props['제출 상태'].select.options.some((o: any) => o.name === '작성중'));
  assert.ok(props['합불 여부'].multi_select.options.some((o: any) => o.name === '대기'));

  const store = new SettingsStore(freshSettingsFile());
  const client = { createDatabase: async () => ({ databaseId: 'db9', dataSourceId: 'ds9', url: 'https://notion.so/db9' }) } as unknown as NotionClient;
  await bootstrapDatabase(client, store, 'page1', '서류 제출 자료', []);
  assert.equal(store.settings.notion.database_id, 'db9');
  assert.equal(store.settings.notion.data_source_id, 'ds9');
});
