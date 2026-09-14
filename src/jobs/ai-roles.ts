// AI 직무 태그: 규칙(설정의 직무 태그 규칙)으로 먼저 달고, 설정에 따라 AI 가 빈 태그를 채우거나 다시 본다.
// AI 가 돌려준 태그 중 DB 에 없는 이름은 코드가 버린다 (새 태그를 만들지 않는다).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../config';
import { extractJson } from '../llm/claude-cli';
import { agentFor, modelFor } from '../llm';
import { paths } from '../paths';
import type { RunAgent } from './find-link';

export type RoleQuery = { key: string; company: string; title: string; roleNames: string[]; sourceUrl: string; ruleRoles: string[] };
export type RoleAnswer = { key: string; roles: string[]; reason?: string };

const CHUNK = 15;

export function roleQueryDoc(qs: RoleQuery[]): string {
  return qs
    .map((q) =>
      [
        `- key: ${q.key}`,
        `  회사: ${q.company}`,
        `  공고 제목: ${q.title}`,
        q.roleNames.length ? `  사이트의 직무명: ${q.roleNames.join(', ')}` : '',
        `  공고 페이지: ${q.sourceUrl}`,
        q.ruleRoles.length ? `  규칙으로 단 태그: ${q.ruleRoles.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n');
}

export function tagListDoc(tags: string[], rules: Record<string, string[]>): string {
  return tags.map((t) => `- ${t}${rules[t]?.length ? ` (관련 단어: ${rules[t].join(', ')})` : ''}`).join('\n');
}

/** 공고별 태그. AI 가 실패한 공고는 결과에 없다 (호출한 쪽에서 규칙 결과를 쓴다) */
export async function tagRolesWithAi(
  qs: RoleQuery[],
  o: { settings: Settings; tags: string[]; cwd: string; runAgent?: RunAgent; log?: (m: string) => void },
): Promise<{ answers: RoleAnswer[]; costUsd: number; errors: string[] }> {
  const run = o.runAgent ?? agentFor(o.settings);
  const system = readFileSync(path.join(paths.prompts, 'tag-roles.md'), 'utf8');
  const allowed = new Set(o.tags);
  const answers: RoleAnswer[] = [];
  const errors: string[] = [];
  let cost = 0;
  for (let i = 0; i < qs.length; i += CHUNK) {
    const batch = qs.slice(i, i + CHUNK);
    o.log?.(`  🏷️  AI 직무 태그 (${i + 1}~${i + batch.length} / ${qs.length})`);
    try {
      const r = await run({
        prompt: `## 쓸 수 있는 직무 태그\n${tagListDoc(o.tags, o.settings.notion.role_rules)}\n\n## 공고\n${roleQueryDoc(batch)}`,
        systemAppend: system,
        tools: ['WebSearch', 'WebFetch'],
        model: modelFor(o.settings, o.settings.collect.ai_roles.model),
        cwd: o.cwd,
      });
      cost += r.costUsd ?? 0;
      if (r.isError) throw new Error(r.text);
      const got = extractJson<{ results?: RoleAnswer[] }>(r.text).results ?? [];
      for (const q of batch) {
        const a = got.find((x) => x.key === q.key);
        if (a) answers.push({ key: q.key, roles: [...new Set((a.roles ?? []).filter((t) => allowed.has(t)))], reason: a.reason });
      }
    } catch (e) {
      errors.push((e as Error).message.slice(0, 160));
      if (/usage limit|사용량/.test((e as Error).message)) break;
    }
  }
  return { answers, costUsd: cost, errors };
}
