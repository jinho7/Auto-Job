import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildPageContent } from '../src/apply/run';
import { parseSettings } from '../src/config';
import type { NotionBlock, NotionClient } from '../src/notion/client';
import { fillPageSections, locateSections, sectionBlocks, setSubmitStatus } from '../src/notion/page-fill';
import { paths } from '../src/paths';

const settings = parseSettings(readFileSync(paths.settingsExample, 'utf8'));
const titles = settings.notion.section_map;

const rt = (s: string) => [{ plain_text: s }];
const h2 = (id: string, t: string): NotionBlock => ({ id, type: 'heading_2', heading_2: { rich_text: rt(t) } });
const p = (id: string, t = ''): NotionBlock => ({ id, type: 'paragraph', paragraph: { rich_text: t ? rt(t) : [] } });
const li = (id: string, t: string): NotionBlock => ({ id, type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(t) } });

/** 사용자 템플릿 모양: 제목 + 빈 줄, 마지막에 접기 블록(추가 프롬프트) */
const templatePage = (): NotionBlock[] => [
  h2('h1', '절차'), p('e1'),
  h2('h2', '회사/조직 소개'), p('e2'),
  h2('h3', '지원 직무'), li('c3', 'IT Strategy&Management'), // 이미 내용 있음
  h2('h4', '자기소개서 질문'), p('e4'),
  h2('h5', '프로젝트 및 동아리 작성 여부'), p('e5'),
  h2('h6', '제출 자료 여부'), p('e6'), p('e7'),
  { id: 't1', type: 'toggle', toggle: { rich_text: rt('추가 프롬프트') } },
];

test('섹션 찾기: 제목 매칭, 빈 줄만 있으면 비어 있음, 접기 블록은 섹션 밖', () => {
  const s = locateSections(templatePage(), titles);
  assert.equal(s.procedure.headingId, 'h1');
  assert.equal(s.procedure.hasContent, false);
  assert.equal(s.role.hasContent, true);
  assert.equal(s.essays.headingId, 'h4'); // 굵은 글씨 제목도 글자로 매칭
  assert.equal(s.documents.hasContent, false); // 뒤의 접기 블록은 내용으로 치지 않음
  const img: NotionBlock = { id: 'i', type: 'image', image: {} };
  assert.equal(locateSections([h2('h1', '절차'), img], titles).procedure.hasContent, true); // 이미지도 내용
});

test('섹션 내용 → 블록: 절차는 번호, 자소서는 굵은 문항 + 문단', () => {
  const blocks = sectionBlocks('procedure', { procedure: ['서류전형', '코딩테스트'] }) as any[];
  assert.deepEqual(blocks.map((b) => b.type), ['numbered_list_item', 'numbered_list_item']);
  const essay = sectionBlocks('essays', { essays: [{ question: '지원 동기', answer: '[제목]\n첫 문단\n\n둘째 문단', limit: '최대 600자' }] }) as any[];
  assert.equal(essay[0].paragraph.rich_text[0].annotations.bold, true);
  assert.equal(essay[0].paragraph.rich_text[0].text.content, '1. 지원 동기 (최대 600자)');
  assert.deepEqual(essay.slice(1).map((b) => b.paragraph.rich_text[0].text.content), ['[제목]', '첫 문단', '둘째 문단', '']);
  const long = sectionBlocks('company', { company: { summary: '가'.repeat(4500) } }) as any[];
  assert.equal(long[0].paragraph.rich_text.length, 3); // 2000자 제한 때문에 나눔
  assert.deepEqual(sectionBlocks('projects', {}), []);
});

function fakeClient(blocks: NotionBlock[], opts: { statusType?: string; options?: string[] } = {}) {
  const appended: { after?: string; types: string[] }[] = [];
  const updated: Record<string, unknown>[] = [];
  const client = {
    listAllBlocks: async () => blocks,
    appendBlocks: async (_: string, children: any[], after?: string) => void appended.push({ after, types: children.map((c) => c.type) }),
    getPage: async () => ({ id: 'pg', url: '', parent: { type: 'data_source_id', data_source_id: 'ds' }, properties: { '제출 상태': { type: opts.statusType ?? 'select', select: { name: '제출전' } } } }),
    getDataSource: async () => ({ id: 'ds', title: '', properties: { '제출 상태': { id: 's', name: '제출 상태', type: opts.statusType ?? 'select', select: { options: (opts.options ?? ['제출전', '작성중']).map((name) => ({ name })) } } } }),
    updatePage: async (_: string, props: Record<string, unknown>) => void updated.push(props),
  } as unknown as NotionClient;
  return { client, appended, updated };
}

test('페이지 채우기: 빈 섹션만 채우고, 내용 있는 섹션은 두고, 없는 제목은 끝에 추가', async () => {
  const blocks = templatePage().filter((b) => b.id !== 'h5' && b.id !== 'e5'); // "프로젝트 및 동아리" 제목이 없는 페이지
  const { client, appended } = fakeClient(blocks);
  const results = await fillPageSections(
    client,
    'pg',
    {
      procedure: ['서류전형', '면접'],
      company: { summary: '회사 소개', values: ['도전'] },
      role: { title: '백엔드' },
      essays: [{ question: 'Q', answer: 'A' }],
      projects: ['프로젝트 입력란 있음'],
      documents: [],
    },
    titles,
  );
  const by = Object.fromEntries(results.map((r) => [r.key, r.status]));
  assert.deepEqual(by, { procedure: 'filled', company: 'filled', role: 'skipped_has_content', essays: 'filled', projects: 'added_heading', documents: 'no_data' });
  assert.deepEqual(appended.map((a) => a.after), ['h1', 'h2', 'h4', undefined]); // 제목 바로 뒤에, 없는 제목은 끝에
  assert.equal(appended[3].types[0], 'heading_2');
});

test('제출 상태: 옵션이 있으면 바꾸고, 없으면 새로 만들지 않는다. status 타입도 지원', async () => {
  const a = fakeClient([]);
  assert.equal(await setSubmitStatus(a.client, 'pg', settings), '제출 상태 → 작성중');
  assert.deepEqual(a.updated, [{ '제출 상태': { select: { name: '작성중' } } }]);

  const b = fakeClient([], { options: ['제출전'] });
  assert.match(await setSubmitStatus(b.client, 'pg', settings), /옵션이 DB에 없어/);
  assert.deepEqual(b.updated, []);

  const c = fakeClient([], { statusType: 'status' });
  (c.client as any).getDataSource = async () => ({ id: 'ds', title: '', properties: { '제출 상태': { id: 's', name: '제출 상태', type: 'status', status: { options: [{ name: '작성중' }] } } } });
  await setSubmitStatus(c.client, 'pg', settings);
  assert.deepEqual(c.updated, [{ '제출 상태': { status: { name: '작성중' } } }]);
});

test('지원서 결과 → 페이지 내용: 절차는 지원서 화면 우선, 없으면 조사 결과', () => {
  const essay = {
    questions: [{ id: 1, question: '지원 동기', unit: 'chars' as const, maxChars: 600 }],
    filled: [],
    result: {
      input: { company: '', role: '', questions: [] },
      research: { company_summary: '요약', values: ['v'], recent: [], role: '서버 개발', procedure: ['서류', '면접'], sources: [] },
      strategy: [],
      answers: [{ id: 1, text: '답' }],
      checks: [],
      reviews: [],
      rounds: 0,
      reviewedBeforeLastRevision: false,
      costUsd: 0,
      ok: true,
    },
  };
  const c1 = buildPageContent({ essay, formInfo: null, role: '백엔드', uploads: ['photo.jpg'] });
  assert.deepEqual(c1.procedure, ['서류', '면접']);
  assert.deepEqual(c1.essays, [{ question: '지원 동기', answer: '답', limit: '최대 600자' }]);
  assert.deepEqual(c1.role, { title: '백엔드', description: '서버 개발' });
  assert.deepEqual(c1.documents, ['올린 파일: photo.jpg']);
  const c2 = buildPageContent({ essay, formInfo: { projects: ['없음'], documents: ['포트폴리오(선택)'], procedure: ['서류전형', 'AI 역량검사'] }, uploads: [] });
  assert.deepEqual(c2.procedure, ['서류전형', 'AI 역량검사']);
  assert.deepEqual(c2.documents, ['포트폴리오(선택)']);
});
