import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Settings } from '../config';
import { agentFor, type RunAgent } from '../llm';
import { extractJson } from '../llm/claude-cli';
import { paths } from '../paths';
import { hasSearchProfile, readSearchCorpus, searchBatches } from '../profile/search-sources';

const evidenceSchema = z.object({ evidence: z.array(z.object({ source: z.string().min(1), quote: z.string().trim().min(1).max(400), fact: z.string().trim().min(1).max(1000) })).max(100) });
const planSchema = z.object({
  directions: z.array(z.object({ role: z.string().trim().min(1).max(100), keywords: z.array(z.string().trim().min(1).max(40)).min(1).max(12), reason: z.string().trim().min(1).max(1200), evidence_ids: z.array(z.string()).min(1) })).max(6),
  warnings: z.array(z.string().max(1000)).max(30).default([]),
});
export type SearchEvidence = z.infer<typeof evidenceSchema>['evidence'][number] & { id: string };
export type SearchPlan = z.infer<typeof planSchema> & {
  mode: 'profile' | 'manual';
  keywords: string[];
  manualKeywords: string[];
  evidence: SearchEvidence[];
  sources: string[];
  filesRead: number;
  costUsd: number;
};
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const unique = (xs: string[]) => [...new Map(xs.map((v) => v.trim()).filter(Boolean).map((v) => [v.toLowerCase(), v])).values()];

export async function prepareSearch(settings: Settings, profile: Record<string, any>, o: { cwd: string; runAgent?: RunAgent; log?: (m: string) => void; signal?: AbortSignal }): Promise<SearchPlan> {
  const manualKeywords = unique(settings.collect.keywords);
  const c = settings.collect;
  const siteFilter = c.jasoseol.duty_groups.length || c.jobkorea.duty_categories.length || c.wanted.job_group_ids.length;
  if (!hasSearchProfile(profile)) {
    if (!manualKeywords.length && !siteFilter) throw new Error('맞춤 검색에 쓸 자료가 없습니다. 내 정보에서 희망 직무·경험을 입력하거나 소재 폴더를 연결해 주세요. 추가 검색어는 선택 사항입니다.');
    return { mode: 'manual', keywords: manualKeywords, manualKeywords, directions: [], evidence: [], sources: [], filesRead: 0, costUsd: 0, warnings: ['개인 자료가 없어 직접 지정한 검색어·사이트 직무 분류만 사용했습니다. 맞춤 검색은 내 정보 또는 소재 폴더를 연결하면 시작합니다.'] };
  }
  o.log?.('▶ 내 정보와 연결한 자료를 읽어 맞춤 검색을 준비합니다');
  const corpus = await readSearchCorpus(profile);
  if (!corpus.documents.length) throw new Error(`맞춤 검색 자료를 읽지 못했습니다. ${corpus.warnings.join(' / ')}`);
  if (corpus.documents.reduce((total, doc) => total + doc.text.length, 0) > 1_200_000) throw new Error('검색 자료가 120만 자를 넘어 한 번에 분석할 수 없습니다. 이번 검색에 사용할 자료 폴더를 좁혀 주세요. 일부만 읽고 검색하지는 않았습니다.');
  const batches = searchBatches(corpus.documents);
  const warnings = [...corpus.warnings];
  const evidence: SearchEvidence[] = [];
  const run = o.runAgent ?? agentFor(settings);
  mkdirSync(o.cwd, { recursive: true });
  const dir = mkdtempSync(path.join(o.cwd, '.search-ai-'));
  let costUsd = 0;
  const ask = async (prompt: string, system: string) => {
    const result = await run({ prompt, systemAppend: readFileSync(path.join(paths.prompts, system), 'utf8'), tools: [], isolated: true, cwd: dir, signal: o.signal,
      onEvent: (ev) => ev.type === 'switch' && o.log?.(`  🔁 ${ev.from}: ${ev.reason} → 다음 AI 연결`) });
    if (result.isError) throw new Error('맞춤 검색 AI 분석에 실패했습니다. AI 연결 상태를 확인한 뒤 다시 실행해 주세요.');
    costUsd += result.costUsd ?? 0;
    return extractJson<unknown>(result.text);
  };
  try {
    for (const [i, batch] of batches.entries()) {
      o.signal?.throwIfAborted();
      o.log?.(`  자료 분석 ${i + 1}/${batches.length} (연결 파일 ${corpus.filesRead}개)`);
      const got = evidenceSchema.parse(await ask(JSON.stringify({ documents: batch }), 'search-evidence.md'));
      for (const item of got.evidence) {
        if (!batch.some((doc) => doc.source === item.source && normalize(doc.text).includes(normalize(item.quote)))) {
          warnings.push('원문과 일치하지 않는 AI 근거를 제외했습니다.'); continue;
        }
        if (!evidence.some((e) => e.source === item.source && e.quote === item.quote)) evidence.push({ ...item, id: `e${evidence.length + 1}` });
      }
    }
    if (!evidence.length) throw new Error('자료에서 확인 가능한 직무·경험 근거를 찾지 못했습니다. 내 정보나 연결한 자료를 보완해 주세요.');
    if (JSON.stringify(evidence).length > 200_000) throw new Error('분석 근거가 너무 많아 한 번에 종합할 수 없습니다. 이번 검색에 사용할 자료 폴더를 좁혀 주세요.');
    const proposed = planSchema.parse(await ask(JSON.stringify({ evidence, manualKeywords }), 'search-plan.md'));
    const ids = new Set(evidence.map((e) => e.id));
    const directions = proposed.directions.filter((d) => d.evidence_ids.every((id) => ids.has(id)));
    if (!directions.length) throw new Error('근거가 있는 검색 직무를 정하지 못했습니다. 희망 직무나 본인 경험 자료를 보완해 주세요.');
    if (directions.length !== proposed.directions.length) warnings.push('출처가 확인되지 않은 검색 직무를 제외했습니다.');
    const generated = unique(directions.flatMap((d) => d.keywords)).slice(0, 12);
    for (const d of directions) d.keywords = d.keywords.filter((k) => generated.some((g) => g.toLowerCase() === k.trim().toLowerCase()));
    const plan: SearchPlan = { mode: 'profile', directions: directions.filter((d) => d.keywords.length), keywords: unique([...generated, ...manualKeywords]), manualKeywords, evidence, sources: corpus.documents.map((d) => d.source), filesRead: corpus.filesRead, costUsd, warnings: unique([...warnings, ...proposed.warnings]) };
    if (!generated.length) throw new Error('맞춤 검색어가 비어 있습니다. 희망 직무나 경험 자료를 보완해 주세요.');
    o.log?.(`  맞춤 검색어: ${generated.join(', ')}${manualKeywords.length ? ` / 직접 추가: ${manualKeywords.join(', ')}` : ''}`);
    for (const warning of plan.warnings) o.log?.(`  ⚠️ ${warning}`);
    return plan;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
