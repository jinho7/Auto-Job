// 지원서 작성 후 Notion 공고 페이지 정리:
//   본문의 제목(절차 / 회사·조직 소개 / 지원 직무 / 자기소개서 질문 / 프로젝트 및 동아리 작성 여부 / 제출 자료 여부)을 찾아
//   그 아래에 내용을 넣고, 제출 상태를 바꾼다. 이미 내용이 있는 섹션은 건드리지 않는다.
import type { Settings } from '../config';
import { blockText, type NotionBlock, type NotionClient } from './client';
import { optionsOf } from './mapping';

export type SectionKey = 'procedure' | 'company' | 'role' | 'essays' | 'projects' | 'documents';
export const SECTION_KEYS: SectionKey[] = ['procedure', 'company', 'role', 'essays', 'projects', 'documents'];

/** 섹션에 넣을 내용 (없는 것은 넣지 않는다) */
export type PageContent = {
  procedure?: string[];
  company?: { summary?: string; values?: string[]; recent?: string[]; sources?: string[] };
  role?: { title?: string; description?: string };
  essays?: { question: string; answer: string; limit?: string }[];
  projects?: string[];
  documents?: string[];
};

export type SectionResult = { key: SectionKey; title: string; status: 'filled' | 'skipped_has_content' | 'added_heading' | 'no_data'; blocks: number };

const HEADINGS = new Set(['heading_1', 'heading_2', 'heading_3']);
/** 섹션이 끝나는 블록 (다음 제목, 접기 블록, 구분선) */
const SECTION_END = new Set([...HEADINGS, 'toggle', 'divider', 'child_page', 'child_database']);
const norm = (s: string) => s.replace(/[*\s#:·/]/g, '').toLowerCase();

const text = (content: string, opts: { bold?: boolean } = {}) =>
  chunks(content).map((c) => ({ type: 'text', text: { content: c }, ...(opts.bold ? { annotations: { bold: true } } : {}) }));
/** Notion 글 조각은 2000자까지 */
function chunks(s: string, size = 1900): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length ? out : [''];
}
const para = (s: string, opts: { bold?: boolean } = {}) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: text(s, opts) } });
const bullet = (s: string) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: text(s) } });
const numbered = (s: string) => ({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: text(s) } });

/** 섹션 내용 → Notion 블록 */
export function sectionBlocks(key: SectionKey, c: PageContent): unknown[] {
  switch (key) {
    case 'procedure':
      return (c.procedure ?? []).filter(Boolean).map(numbered);
    case 'company': {
      const x = c.company;
      if (!x || !(x.summary || x.values?.length || x.recent?.length)) return [];
      return [
        ...(x.summary ? [para(x.summary)] : []),
        ...(x.values?.length ? [bullet(`인재상/핵심가치: ${x.values.join(', ')}`)] : []),
        ...(x.recent ?? []).map((r) => bullet(`최근: ${r}`)),
        ...(x.sources?.length ? [para(`출처: ${x.sources.join(' , ')}`)] : []),
      ];
    }
    case 'role': {
      const r = c.role;
      if (!r || !(r.title || r.description)) return [];
      return [...(r.title ? [bullet(r.title)] : []), ...(r.description ? [para(r.description)] : [])];
    }
    case 'essays':
      return (c.essays ?? []).flatMap((e, i) => [
        para(`${i + 1}. ${e.question}${e.limit ? ` (${e.limit})` : ''}`, { bold: true }),
        ...e.answer.split(/\n+/).filter((l) => l.trim()).map((l) => para(l)),
        para(''),
      ]);
    case 'projects':
      return (c.projects ?? []).filter(Boolean).map(bullet);
    case 'documents':
      return (c.documents ?? []).filter(Boolean).map(bullet);
  }
}

/** 본문 블록에서 섹션 제목과, 그 섹션에 이미 내용이 있는지 */
export function locateSections(blocks: NotionBlock[], titles: Record<SectionKey, string>): Record<SectionKey, { headingId?: string; hasContent: boolean }> {
  const out = {} as Record<SectionKey, { headingId?: string; hasContent: boolean }>;
  for (const key of SECTION_KEYS) {
    const want = norm(titles[key]);
    const idx = blocks.findIndex((b) => HEADINGS.has(b.type) && norm(blockText(b)).includes(want));
    if (idx < 0) {
      out[key] = { hasContent: false };
      continue;
    }
    let hasContent = false;
    for (let i = idx + 1; i < blocks.length && !SECTION_END.has(blocks[i].type); i++) {
      const b = blocks[i];
      if (blockText(b) || !['paragraph', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'quote'].includes(b.type)) {
        hasContent = true; // 글이 있거나, 이미지/표/파일 같은 블록이 있으면 내용이 있는 것
        break;
      }
    }
    out[key] = { headingId: blocks[idx].id, hasContent };
  }
  return out;
}

/** 페이지 본문을 채운다. 제목이 없는 섹션은 맨 끝에 제목과 함께 넣는다. */
export async function fillPageSections(client: NotionClient, pageId: string, content: PageContent, titles: Record<SectionKey, string>): Promise<SectionResult[]> {
  const found = locateSections(await client.listAllBlocks(pageId), titles);
  const results: SectionResult[] = [];
  for (const key of SECTION_KEYS) {
    const blocks = sectionBlocks(key, content);
    const title = titles[key];
    if (!blocks.length) {
      results.push({ key, title, status: 'no_data', blocks: 0 });
      continue;
    }
    const f = found[key];
    if (f.hasContent) {
      results.push({ key, title, status: 'skipped_has_content', blocks: 0 });
      continue;
    }
    if (f.headingId) {
      await client.appendBlocks(pageId, blocks, f.headingId);
      results.push({ key, title, status: 'filled', blocks: blocks.length });
    } else {
      const heading = { object: 'block', type: 'heading_2', heading_2: { rich_text: text(title), color: 'yellow_background' } };
      await client.appendBlocks(pageId, [heading, ...blocks]);
      results.push({ key, title, status: 'added_heading', blocks: blocks.length });
    }
  }
  return results;
}

/** 제출 상태를 바꾼다. DB 에 그 옵션이 없으면 바꾸지 않고 알려준다 (새 옵션을 만들지 않음). */
export async function setSubmitStatus(client: NotionClient, pageId: string, settings: Settings): Promise<string> {
  const n = settings.notion;
  const want = n.status_options.after_apply;
  const page = await client.getPage(pageId);
  const cur = page.properties[n.fields.status];
  if (!cur) return `"${n.fields.status}" 속성이 없어 제출 상태를 바꾸지 않았습니다`;
  const dsId = page.parent?.data_source_id;
  if (dsId) {
    const ds = await client.getDataSource(dsId);
    const opts = optionsOf(ds.properties[n.fields.status]);
    if (opts.length && !opts.includes(want)) return `"${want}" 옵션이 DB에 없어 제출 상태를 바꾸지 않았습니다`;
  }
  const value = cur.type === 'status' ? { status: { name: want } } : cur.type === 'multi_select' ? { multi_select: [{ name: want }] } : { select: { name: want } };
  await client.updatePage(pageId, { [n.fields.status]: value });
  return `제출 상태 → ${want}`;
}
