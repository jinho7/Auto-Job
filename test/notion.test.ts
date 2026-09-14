import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NotionClient, NotionError, type NotionProperty } from '../src/notion/client';
import { checkMapping, suggestedFixes } from '../src/notion/mapping';
import { parseSettings } from '../src/config';
import { paths } from '../src/paths';

const notion = parseSettings(readFileSync(paths.settingsExample, 'utf8')).notion;

const prop = (name: string, type: string, options?: string[]): NotionProperty => ({
  id: name,
  name,
  type,
  ...(options ? { [type]: { options: options.map((o) => ({ name: o })) } } : {}),
});

const goodProps = Object.fromEntries(
  [
    prop('회사명', 'title'),
    prop('직무', 'multi_select', ['백엔드 (서버)']),
    prop('채용 분류', 'multi_select', ['정규직', '채용 연계/전환형 인턴', '체험형 인턴', '계약직']),
    prop('지원 마감 시간', 'date'),
    prop('제출 상태', 'select', ['제출전', '작성중', '제출완료']),
    prop('합불 여부', 'multi_select', ['대기', '불합격']),
    prop('참고 키워드', 'rich_text'),
    prop('지원 링크', 'url'),
    prop('서류 합격 발표 일자', 'date'),
    prop('제출 자료', 'files'),
  ].map((p) => [p.name, p]),
);

test('매칭 검사: 기본 설정과 같은 DB는 통과', () => {
  const r = checkMapping(notion, { id: 'ds', title: 'DB', properties: goodProps });
  assert.equal(r.ok, true, JSON.stringify(r, null, 2));
});

test('매칭 검사: 이름이 다른 속성은 후보를 제안하고, 없는 옵션을 알려준다', () => {
  const props = { ...goodProps };
  delete props['지원 링크'];
  props['공고 URL'] = prop('공고 URL', 'url');
  props['채용 분류'] = prop('채용 분류', 'multi_select', ['정규직', '채용 연계/전환형 인턴', '체형형인턴', '계약직']);
  const r = checkMapping(notion, { id: 'ds', title: 'DB', properties: props });
  assert.equal(r.ok, false);
  const link = r.fields.find((f) => f.key === 'link')!;
  assert.equal(link.ok, false);
  assert.equal(link.suggestion, '공고 URL');
  assert.deepEqual(suggestedFixes(r), { link: '공고 URL' });
  assert.deepEqual(r.optionProblems, ['채용 분류: "체험형 인턴" 옵션이 없음 (채용 분류 옵션 매핑)']);
});

test('매칭 검사: 타입이 틀린 속성', () => {
  const props = { ...goodProps, '지원 링크': prop('지원 링크', 'rich_text') };
  const link = checkMapping(notion, { id: 'ds', title: 'DB', properties: props }).fields.find((f) => f.key === 'link')!;
  assert.match(link.problem!, /타입이 rich_text/);
});

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
function fakeFetch(responses: Record<string, [number, unknown]>, calls: Call[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method!, headers: init.headers as Record<string, string>, body: init.body as string | undefined });
    const key = `${init.method} ${url.replace('https://api.notion.com/v1', '')}`;
    const [status, json] = responses[key] ?? [404, { code: 'object_not_found', message: 'nope' }];
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
}

test('클라이언트: 토큰 확인, 버전 헤더, 에러 메시지', async () => {
  const calls: Call[] = [];
  const ok = new NotionClient('tok', fakeFetch({ 'GET /users/me': [200, { name: 'Auto-Job', bot: { workspace_name: '내 워크스페이스' } }] }, calls));
  assert.deepEqual(await ok.me(), { name: 'Auto-Job', workspace: '내 워크스페이스' });
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].headers['Notion-Version'], '2026-03-11');

  const bad = new NotionClient('tok', fakeFetch({ 'GET /users/me': [401, { code: 'unauthorized' }] }));
  await assert.rejects(bad.me(), (e) => e instanceof NotionError && e.status === 401 && /토큰이 올바르지/.test(e.message));
});

test('클라이언트: DB 목록 검색과 database ID → data source 해석', async () => {
  const calls: Call[] = [];
  const client = new NotionClient('tok', fakeFetch({
    'POST /search': [200, { results: [{ id: 'ds1', title: [{ plain_text: '서류 제출 자료' }], parent: { type: 'database_id', database_id: 'db1' }, properties: goodProps }], has_more: false, next_cursor: null }],
    'GET /databases/db1': [200, { data_sources: [{ id: 'ds1', name: '서류 제출 자료' }] }],
    'GET /data_sources/ds1': [200, { id: 'ds1', title: [{ plain_text: '서류 제출 자료' }], parent: { type: 'database_id', database_id: 'db1' }, properties: goodProps }],
  }, calls));
  const list = await client.listDataSources();
  assert.deepEqual(list.map((d) => [d.id, d.title, d.databaseId]), [['ds1', '서류 제출 자료', 'db1']]);
  assert.deepEqual(JSON.parse(calls[0].body!).filter, { property: 'object', value: 'data_source' });

  const ds = await client.resolveDataSource('db1'); // data source 로는 404 → database 로 재시도
  assert.equal(ds.id, 'ds1');
  assert.equal(ds.databaseId, 'db1');
});
