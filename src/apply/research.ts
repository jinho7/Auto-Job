// 로그인 전에 먼저 하는 일: 지원 페이지의 글과 웹 검색으로 모집 직무·전형 절차·회사 소개를 정리하고 지원 직무를 고른다.
// 결과는 Notion 페이지의 절차 / 회사·조직 소개 / 지원 직무 섹션에 먼저 넣고, 자기소개서를 쓸 때도 다시 쓴다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import type { Settings } from '../config';
import { agentFor, type RunAgent } from '../llm';
import { extractJson } from '../llm/claude-cli';
import type { PageContent } from '../notion/page-fill';
import { paths } from '../paths';

export type PreResearch = {
  roles: { title: string; description?: string }[];
  chosen: { title: string; description?: string; reason?: string } | null;
  procedure: string[];
  procedure_source?: string;
  company: { summary?: string; values?: string[]; recent?: string[]; sources?: string[] };
  note?: string;
};

/** 지원 페이지에 보이는 글 (프레임 안 글도 함께). 화면이 다 그려질 때까지 잠깐 기다린다 */
export async function collectPageText(page: Page, max = 40_000): Promise<string> {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  const parts: string[] = [];
  for (const f of page.frames()) {
    const t = await f.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    if (t.trim()) parts.push(t.trim());
  }
  return parts.join('\n\n---\n\n').slice(0, max);
}

export async function preResearch(o: {
  settings: Settings;
  company: string;
  link: string;
  notionRoles?: string;
  pageText: string;
  profileDoc: string;
  cwd: string;
  runAgent?: RunAgent;
  log?: (m: string) => void;
  signal?: AbortSignal;
}): Promise<PreResearch> {
  const run = o.runAgent ?? agentFor(o.settings);
  const r = await run({
    prompt: [
      `지원 회사: ${o.company || '(모름)'}`,
      `지원 페이지: ${o.link}`,
      o.notionRoles ? `Notion 에 적힌 직무 태그: ${o.notionRoles}` : '',
      '',
      '## 지원 페이지에 보이는 글 (자료)',
      o.pageText || '(글을 읽지 못했습니다 — 웹에서 공고를 찾아 주세요)',
      '',
      '## 지원자 (희망 직무, 학력, 경력, 기술)',
      o.profileDoc,
    ]
      .filter((x) => x !== '')
      .join('\n'),
    systemAppend: readFileSync(path.join(paths.prompts, 'pre-research.md'), 'utf8'),
    tools: ['WebSearch', 'WebFetch'],
    model: o.settings.essay.model || undefined,
    effort: o.settings.essay.effort || undefined,
    cwd: o.cwd,
    signal: o.signal,
    onEvent: (ev) => {
      if (ev.type === 'tool') o.log?.(`   🔎 ${ev.name} ${String(ev.input.query ?? ev.input.url ?? '').slice(0, 80)}`);
      if (ev.type === 'switch') o.log?.(`   🔁 ${ev.from}: ${ev.reason} → 다음 AI 연결로 계속`);
    },
  });
  if (r.isError) throw new Error(r.text);
  const j = extractJson<Partial<PreResearch>>(r.text);
  return {
    roles: (j.roles ?? []).filter((x) => x?.title),
    chosen: j.chosen?.title ? j.chosen : null,
    procedure: (j.procedure ?? []).map(String).filter((x) => x.trim()),
    procedure_source: j.procedure_source,
    company: j.company ?? {},
    note: j.note,
  };
}

/** Notion 페이지의 절차 / 회사·조직 소개 / 지원 직무 섹션에 넣을 내용 */
export function preResearchContent(p: PreResearch): PageContent {
  const others = p.roles.filter((r) => r.title !== p.chosen?.title).map((r) => r.title);
  return {
    procedure: p.procedure.length ? p.procedure : undefined,
    company: p.company.summary ? p.company : undefined,
    role: p.chosen
      ? {
          title: p.chosen.title,
          description: [p.chosen.description, p.chosen.reason && `고른 이유: ${p.chosen.reason}`, others.length && `다른 모집 직무: ${others.join(', ')}`].filter(Boolean).join('\n'),
        }
      : undefined,
  };
}

/** 자기소개서를 쓸 때 다시 조사하지 않도록 넘기는 글 */
export function preResearchDoc(p: PreResearch): string {
  return [
    p.company.summary && `회사 요약: ${p.company.summary}`,
    p.company.values?.length && `인재상/가치: ${p.company.values.join(', ')}`,
    p.company.recent?.length && `최근 소식: ${p.company.recent.join(' / ')}`,
    p.chosen && `지원 직무: ${p.chosen.title}${p.chosen.description ? ` — ${p.chosen.description}` : ''}`,
    p.procedure.length && `전형 절차: ${p.procedure.join(' → ')}`,
    p.company.sources?.length && `출처: ${p.company.sources.join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');
}
