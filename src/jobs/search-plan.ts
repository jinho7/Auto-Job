import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Settings } from '../config';
import { agentFor, type RunAgent } from '../llm';
import { extractJson } from '../llm/claude-cli';
import { paths } from '../paths';
import { hasSearchProfile, readSearchCorpus, searchBatches, type SearchDocument } from '../profile/search-sources';

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

// ─── 자료 분석 저장 ───
// 자료에서 근거를 뽑는 일은 파일 내용에만 달려 있다. 내용이 같으면 전에 뽑은 근거를 다시 쓰고,
// 바뀌거나 새로 연결한 파일만 AI 로 분석한다 (전에는 수집할 때마다 전부 다시 분석해 몇 시간씩 걸렸다).
type RawEvidence = { source: string; quote: string; fact: string };
const cacheDir = () => path.join(paths.data, 'search-cache');
const partKey = (prompt: string, part: SearchDocument) => createHash('sha256').update(prompt).update('\0').update(part.source).update('\0').update(part.text).digest('hex');
function readCached(key: string): RawEvidence[] | undefined {
  const file = path.join(cacheDir(), `${key}.json`);
  if (!existsSync(file)) return undefined;
  try { return (JSON.parse(readFileSync(file, 'utf8')) as { evidence: RawEvidence[] }).evidence; } catch { return undefined; }
}
function writeCached(key: string, evidence: RawEvidence[]): void {
  mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(cacheDir(), `${key}.json`), JSON.stringify({ evidence }), { mode: 0o600 });
}

/** 새로 분석할 조각만 다시 묶는다 (한 번에 보내는 양은 그대로) */
function regroup(parts: SearchDocument[], size = 30_000): SearchDocument[][] {
  const batches: SearchDocument[][] = [];
  let batch: SearchDocument[] = [], used = 0;
  for (const part of parts) {
    if (used + part.text.length > size && batch.length) { batches.push(batch); batch = []; used = 0; }
    batch.push(part); used += part.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * 동시에 몇 개씩 돌린다 (AI 호출 하나하나가 오래 걸려서).
 * 하나가 실패하면 새로 시작하지 않고, **이미 돌고 있는 것이 끝날 때까지 기다린 뒤** 실패를 알린다.
 * (바로 실패로 끝내면 부르는 쪽이 작업 폴더를 지워, 아직 돌던 AI 가 엉뚱한 오류로 실패한다)
 */
export async function inParallel<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (next < items.length && failure === undefined) {
      const i = next++;
      try { await fn(items[i], i); } catch (e) { failure ??= e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure;
}
export const SEARCH_PARALLEL = 3;
/** 한 번에 종합할 근거의 양 (글자). 넘으면 나눠 종합한 뒤 합친다 */
export const PLAN_CHUNK = 100_000;

function regroupBy<T>(items: T[], size: (item: T) => number, limit: number): T[][] {
  const groups: T[][] = [];
  let group: T[] = [], used = 0;
  for (const item of items) {
    const n = size(item);
    if (used + n > limit && group.length) { groups.push(group); group = []; used = 0; }
    group.push(item); used += n;
  }
  if (group.length) groups.push(group);
  return groups;
}
const unique = (xs: string[]) => [...new Map(xs.map((v) => v.trim()).filter(Boolean).map((v) => [v.toLowerCase(), v])).values()];

export async function prepareSearch(settings: Settings, profile: Record<string, any>, o: { cwd: string; runAgent?: RunAgent; log?: (m: string) => void; signal?: AbortSignal; planChunk?: number }): Promise<SearchPlan> {
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
  const parts = searchBatches(corpus.documents).flat();
  const evidencePrompt = readFileSync(path.join(paths.prompts, 'search-evidence.md'), 'utf8');
  const keys = parts.map((part) => partKey(evidencePrompt, part));
  const cached = keys.map((key) => readCached(key));
  const fresh = parts.filter((_, i) => !cached[i]);
  const batches = regroup(fresh);
  const warnings = [...corpus.warnings];
  const evidence: SearchEvidence[] = [];
  const run = o.runAgent ?? agentFor(settings);
  mkdirSync(o.cwd, { recursive: true });
  const dir = mkdtempSync(path.join(o.cwd, '.search-ai-'));
  let costUsd = 0;
  const ask = async (prompt: string, system: string) => {
    // 동시에 도는 AI 가 서로의 파일을 건드리지 않게 호출마다 작업 폴더를 따로 쓴다
    const cwd = mkdtempSync(path.join(dir, 'call-'));
    const call = () => run({ prompt, systemAppend: readFileSync(path.join(paths.prompts, system), 'utf8'), tools: [], isolated: true, cwd, signal: o.signal,
      onEvent: (ev) => ev.type === 'switch' && o.log?.(`  🔁 ${ev.from}: ${ev.reason} → 다음 AI 연결`) });
    // 실행이 잠깐 시작되지 못한 경우(명령·폴더는 있음)는 한 번 더 해 본다
    const result = await call().catch(async (e: Error) => {
      if (!/실행을 시작하지 못했습니다/.test(e.message)) throw e;
      o.log?.(`  ↻ ${e.message.slice(0, 120)} — 다시 시도합니다`);
      return call();
    });
    if (result.isError) throw new Error(`맞춤 검색 AI 분석에 실패했습니다: ${result.text.replace(/\s+/g, ' ').slice(0, 200)} — AI 연결 상태를 확인한 뒤 다시 실행해 주세요. (이미 분석한 자료는 저장돼 있어 다음에 이어서 합니다)`);
    costUsd += result.costUsd ?? 0;
    return extractJson<unknown>(result.text);
  };
  try {
    const reused = parts.length - fresh.length;
    o.log?.(`  자료 ${corpus.filesRead}개 (${parts.length}조각): ${reused ? `${reused}조각은 전에 분석한 결과를 다시 씀, ` : ''}${batches.length ? `${fresh.length}조각을 ${batches.length}번에 나눠 새로 분석 (${SEARCH_PARALLEL}개씩 동시에)` : '새로 분석할 것 없음'}`);
    // 1) 새로 분석: 조각마다 결과를 저장해 다음 수집에서 다시 쓴다
    const found = new Map<SearchDocument, RawEvidence[]>();
    let done = 0;
    await inParallel(batches, SEARCH_PARALLEL, async (batch) => {
      o.signal?.throwIfAborted();
      const got = evidenceSchema.parse(await ask(JSON.stringify({ documents: batch }), 'search-evidence.md'));
      for (const part of batch) found.set(part, []);
      let rejected = 0;
      for (const item of got.evidence) {
        const part = batch.find((doc) => doc.source === item.source && normalize(doc.text).includes(normalize(item.quote)));
        if (!part) { rejected++; warnings.push('원문과 일치하지 않는 AI 근거를 제외했습니다.'); continue; }
        found.get(part)!.push(item);
      }
      // 확인된 근거만 저장한다. 근거를 전부 원문에서 못 찾은 분석은 믿을 수 없어 저장하지 않는다 (다음 수집에서 다시 분석)
      const verified = batch.reduce((n, part) => n + found.get(part)!.length, 0);
      if (!rejected || verified) for (const part of batch) writeCached(keys[parts.indexOf(part)], found.get(part)!);
      o.log?.(`  자료 분석 ${++done}/${batches.length}`);
    });
    // 2) 원래 순서대로 모은다 (저장해 둔 것 + 새로 뽑은 것)
    for (const [i, part] of parts.entries()) {
      for (const item of cached[i] ?? found.get(part) ?? []) {
        if (!normalize(part.text).includes(normalize(item.quote))) continue;
        if (!evidence.some((e) => e.source === item.source && e.quote === item.quote)) evidence.push({ ...item, id: `e${evidence.length + 1}` });
      }
    }
    if (!evidence.length) throw new Error('자료에서 확인 가능한 직무·경험 근거를 찾지 못했습니다. 내 정보나 연결한 자료를 보완해 주세요.');
    // 종합에는 확인이 끝난 사실만 보낸다 (인용문은 원문 대조용이라 빼도 된다). 그래도 많으면 나눠 종합한 뒤 합친다
    const compact = evidence.map((e) => ({ id: e.id, source: path.basename(e.source), fact: e.fact }));
    const groups = regroupBy(compact, (e) => JSON.stringify(e).length, o.planChunk ?? PLAN_CHUNK);
    let proposed: z.infer<typeof planSchema>;
    const planKey = createHash('sha256').update(readFileSync(path.join(paths.prompts, 'search-plan.md'), 'utf8')).update(readFileSync(path.join(paths.prompts, 'search-plan-merge.md'), 'utf8'))
      .update(JSON.stringify({ compact, manualKeywords })).digest('hex');
    const planFile = path.join(cacheDir(), `plan-${planKey}.json`);
    const savedPlan = existsSync(planFile) ? planSchema.safeParse(JSON.parse(readFileSync(planFile, 'utf8'))) : undefined;
    if (savedPlan?.success) {
      o.log?.('  자료가 그대로여서 전에 만든 검색 계획을 다시 씁니다');
      proposed = savedPlan.data;
    } else if (groups.length === 1) {
      proposed = planSchema.parse(await ask(JSON.stringify({ evidence: groups[0], manualKeywords }), 'search-plan.md'));
    } else {
      o.log?.(`  근거 ${evidence.length}개를 ${groups.length}묶음으로 나눠 종합한 뒤 합칩니다`);
      const candidates: z.infer<typeof planSchema>['directions'] = [];
      await inParallel(groups, SEARCH_PARALLEL, async (group) => {
        const part = planSchema.parse(await ask(JSON.stringify({ evidence: group, manualKeywords }), 'search-plan.md'));
        candidates.push(...part.directions);
        warnings.push(...part.warnings);
      });
      if (!candidates.length) throw new Error('근거가 있는 검색 직무를 정하지 못했습니다. 희망 직무나 본인 경험 자료를 보완해 주세요.');
      proposed = planSchema.parse(await ask(JSON.stringify({ candidates, manualKeywords }), 'search-plan-merge.md'));
    }
    if (!savedPlan?.success) { mkdirSync(cacheDir(), { recursive: true, mode: 0o700 }); writeFileSync(planFile, JSON.stringify(proposed), { mode: 0o600 }); }
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
