// 공고 → Notion 페이지. 속성 값은 DB 에 이미 있는 옵션만 쓰고(새 태그를 만들지 않음), 중복은 넣지 않는다.
import type { Settings } from '../config';
import { findDuplicate, sameCompany, type DuplicateHit, type ExistingJob } from '../jobs/dedup';
import type { JobPosting } from '../jobs/model';
import { propText, type DataSource, type NotionClient, type NotionProperty } from './client';
import { optionsOf } from './mapping';

type N = Settings['notion'];

/** 기업 구분의 priority, 또는 회사 직접 지정이면 "작성중" 쪽 상태 */
export function decideStatus(settings: Settings, p: Pick<JobPosting, 'company' | 'companyType'>): string {
  const priority =
    settings.overrides.priority.some((c) => sameCompany(c, p.company)) ||
    (p.companyType ? settings.company_types[p.companyType]?.priority === true : false);
  return priority ? settings.notion.status_options.priority : settings.notion.status_options.default;
}

const text = (content: string) => [{ type: 'text', text: { content: content.slice(0, 2000) } }];

/** 속성 타입에 맞춰 값을 넣는다. 없는 옵션은 버리고 dropped 에 남긴다. */
function choiceValue(prop: NotionProperty, values: string[], dropped: string[], label: string): unknown {
  const have = optionsOf(prop);
  const ok = values.filter((v) => {
    if (have.includes(v)) return true;
    dropped.push(`${label}: "${v}" (DB에 없는 옵션이라 뺐습니다)`);
    return false;
  });
  if (prop.type === 'multi_select') return { multi_select: ok.map((name) => ({ name })) };
  if (prop.type === 'select') return { select: ok[0] ? { name: ok[0] } : null };
  if (prop.type === 'status') return ok[0] ? { status: { name: ok[0] } } : undefined;
  return undefined;
}

export function buildProperties(p: JobPosting, n: N, ds: DataSource, status: string): { properties: Record<string, unknown>; dropped: string[] } {
  const dropped: string[] = [];
  const props: Record<string, unknown> = {};
  const prop = (key: string): NotionProperty | undefined => ds.properties[n.fields[key] ?? ''];
  const put = (key: string, value: unknown) => {
    const pr = prop(key);
    if (pr && value !== undefined) props[pr.name] = value;
  };

  const title = prop('company');
  if (!title || title.type !== 'title') throw new Error(`회사명 속성(${n.fields.company})이 DB에 없거나 제목 속성이 아닙니다. 설정 → Notion 에서 매칭 검사를 해주세요.`);
  props[title.name] = { title: text(p.company) };

  const roles = prop('roles');
  if (roles) put('roles', choiceValue(roles, p.roles, dropped, '직무'));

  const emp = prop('employment');
  if (emp) {
    const names = p.employment.map((k) => n.employment_options[k] ?? k);
    put('employment', choiceValue(emp, names, dropped, '채용 분류'));
  }

  const deadline = prop('deadline');
  if (deadline && p.deadline) {
    const start = p.deadline.time ? `${p.deadline.date}T${p.deadline.time}:00${n.timezone_offset}` : p.deadline.date;
    put('deadline', { date: { start } });
  }

  const st = prop('status');
  if (st) put('status', choiceValue(st, [status], dropped, '제출 상태'));
  const result = prop('result');
  if (result) put('result', choiceValue(result, [n.result_default], dropped, '합불 여부'));

  if (p.note && prop('note')?.type === 'rich_text') put('note', { rich_text: text(p.note) });
  if (prop('link')?.type === 'url') put('link', { url: p.link || null });
  return { properties: props, dropped };
}

/** 템플릿이 없을 때 넣는 본문: 노란 배경의 제목 + 빈 줄 */
export function sectionBlocks(sections: string[]): unknown[] {
  return sections.flatMap((s) => [
    { object: 'block', type: 'heading_2', heading_2: { rich_text: text(s), color: 'yellow_background' } },
    { object: 'block', type: 'paragraph', paragraph: { rich_text: [] } },
  ]);
}

export function toExisting(pages: Awaited<ReturnType<NotionClient['queryPages']>>, n: N): ExistingJob[] {
  return pages.map((pg) => ({
    id: pg.id,
    url: pg.url,
    company: propText(pg.properties[n.fields.company]),
    link: propText(pg.properties[n.fields.link]),
    deadline: propText(pg.properties[n.fields.deadline]),
  }));
}

export type AddResult =
  | { status: 'created'; pageId: string; url: string; dropped: string[]; usedTemplate: boolean; templateApplied?: boolean }
  | { status: 'duplicate'; duplicate: DuplicateHit }
  | { status: 'dry-run'; properties: Record<string, unknown>; dropped: string[]; usedTemplate: boolean };

/** Notion 에 공고를 올리는 도구. 기존 페이지 목록은 한 번 읽어 두고 새로 만든 것도 바로 반영한다. */
export class NotionJobWriter {
  private existing: ExistingJob[] | null = null;
  private template: { type: 'default' } | null | undefined;

  constructor(
    private readonly client: NotionClient,
    private readonly settings: Settings,
    private readonly ds: DataSource,
    private readonly wait = { pollMs: 700, timeoutMs: 15_000 },
  ) {}

  /** 템플릿은 비동기로 적용된다. 본문이 채워질 때까지 기다린다 (시간 초과면 false). */
  private async waitForTemplate(pageId: string): Promise<boolean> {
    const deadline = Date.now() + this.wait.timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.client.listBlocks(pageId, 1)).length) return true;
      await new Promise((r) => setTimeout(r, this.wait.pollMs));
    }
    return false;
  }

  async loadExisting(): Promise<ExistingJob[]> {
    this.existing ??= toExisting(await this.client.queryPages(this.ds.id), this.settings.notion);
    return this.existing;
  }

  /** DB 기본 템플릿을 쓸 수 있으면 { type: 'default' } */
  private async pickTemplate(): Promise<{ type: 'default' } | null> {
    if (this.template !== undefined) return this.template;
    if (!this.settings.notion.use_db_template) return (this.template = null);
    try {
      const templates = await this.client.listTemplates(this.ds.id);
      this.template = templates.some((t) => t.is_default) ? { type: 'default' } : null;
    } catch {
      this.template = null; // 템플릿 목록을 못 읽으면 본문을 직접 넣는다
    }
    return this.template;
  }

  async add(p: JobPosting, opts: { dryRun?: boolean } = {}): Promise<AddResult> {
    if (!p.company.trim()) throw new Error('회사명이 비어 있습니다');
    const dup = findDuplicate(p, await this.loadExisting());
    if (dup) return { status: 'duplicate', duplicate: dup };

    const { properties, dropped } = buildProperties(p, this.settings.notion, this.ds, decideStatus(this.settings, p));
    const template = await this.pickTemplate();
    if (opts.dryRun) return { status: 'dry-run', properties, dropped, usedTemplate: !!template };

    const page = await this.client.createPage({
      parent: { type: 'data_source_id', data_source_id: this.ds.id },
      properties,
      ...(template ? { template } : { children: sectionBlocks(this.settings.notion.page_sections) }),
    });
    this.existing!.push({ id: page.id, url: page.url, company: p.company, link: p.link, deadline: p.deadline?.date ?? '' });
    let templateApplied: boolean | undefined;
    if (template) {
      // 템플릿에 들어 있는 속성 값(제목 "회사명", 기본 상태 등)이 우리가 넣은 값을 덮을 수 있어서, 적용이 끝난 뒤 한 번 더 넣는다
      templateApplied = await this.waitForTemplate(page.id);
      await this.client.updatePage(page.id, properties);
    }
    return { status: 'created', pageId: page.id, url: page.url, dropped, usedTemplate: !!template, templateApplied };
  }
}
