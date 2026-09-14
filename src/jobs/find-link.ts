// 지원 페이지를 못 찾은 공고: AI 가 웹 검색으로 실제 지원 페이지를 찾는다 (결과는 코드가 다시 열어 확인한다).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../config';
import { extractJson, type AgentRun } from '../llm/claude-cli';
import { agentFor, modelFor } from '../llm';
import { paths } from '../paths';

export type LinkQuery = { key: string; company: string; title: string; deadline: string; sourceUrl: string; candidate?: string; reason?: string };
export type LinkAnswer = { key: string; url?: string; note: string };
export type RunAgent = (o: AgentRun) => Promise<{ text: string; isError: boolean; costUsd?: number }>;

/** 지원 페이지로 인정하지 않는 사이트인지 (카페, 블로그, 검색 결과 …) */
export function rejectedDomain(url: string, domains: string[]): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return '주소 형식이 아님';
  }
  const d = domains.find((x) => host === x.toLowerCase() || host.endsWith(`.${x.toLowerCase()}`));
  return d ? `${d} 는 지원 페이지로 인정하지 않음` : null;
}

export function linkQueryDoc(qs: LinkQuery[]): string {
  return qs
    .map((q) =>
      [
        `- key: ${q.key}`,
        `  회사: ${q.company}`,
        `  공고 제목: ${q.title}`,
        `  마감: ${q.deadline}`,
        `  처음 본 곳: ${q.sourceUrl}`,
        q.candidate ? `  확인 실패한 링크: ${q.candidate} (${q.reason ?? ''})` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n');
}

export async function findApplyLinks(
  qs: LinkQuery[],
  o: { settings: Settings; cwd: string; runAgent?: RunAgent; log?: (m: string) => void },
): Promise<{ answers: LinkAnswer[]; costUsd: number }> {
  const cfg = o.settings.collect.link_search;
  const run = o.runAgent ?? agentFor(o.settings);
  const system = readFileSync(path.join(paths.prompts, 'find-apply-link.md'), 'utf8');
  const answers: LinkAnswer[] = [];
  let cost = 0;
  for (let i = 0; i < qs.length; i += cfg.batch_size) {
    const batch = qs.slice(i, i + cfg.batch_size);
    o.log?.(`  🔎 AI 가 지원 페이지 찾는 중 (${batch.map((q) => q.company).join(', ')})`);
    try {
      const r = await run({
        prompt: `아래 공고들의 실제 지원 페이지를 찾아 주세요.\n\n${linkQueryDoc(batch)}`,
        systemAppend: system,
        tools: ['WebSearch', 'WebFetch'],
        model: modelFor(o.settings, cfg.model),
        cwd: o.cwd,
      });
      cost += r.costUsd ?? 0;
      if (r.isError) throw new Error(r.text);
      const got = extractJson<{ results?: LinkAnswer[] }>(r.text).results ?? [];
      for (const q of batch) {
        const a = got.find((x) => x.key === q.key);
        answers.push({ key: q.key, url: a?.url?.trim() || undefined, note: a?.note ?? 'AI 응답에 이 공고가 없음' });
      }
    } catch (e) {
      for (const q of batch) answers.push({ key: q.key, note: `AI 검색 실패: ${(e as Error).message.slice(0, 120)}` });
      if (/usage limit|사용량/.test((e as Error).message)) break; // 한도에 걸리면 나머지는 시도하지 않는다
    }
  }
  return { answers, costUsd: cost };
}
