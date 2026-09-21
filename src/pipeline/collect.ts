// 공고 수집 파이프라인:
//   수집 → 경력/고용형태/마감 필터 → 이미 처리한 공고 건너뛰기 → 사이트 간 중복 합치기
//   → 상세 정보 → 기업 구분 → 지원 페이지 확인 → (못 찾으면) AI 웹 검색 → 직무 태그(규칙 → AI)
//   → Notion 등록(중복 제외) → 리포트
import { tmpdir } from 'node:os';
import type { Page } from 'playwright-core';
import type { Settings } from '../config';
import { collectorById, COLLECTORS } from '../collectors';
import { addDays, ymd, type CollectorContext, type RawPosting } from '../collectors/types';
import type { PoliteHttp } from '../http';
import { tagRolesWithAi } from '../jobs/ai-roles';
import { classifyCompany, type CompanyVerdict } from '../jobs/classify';
import { sameCompany, type DuplicateHit } from '../jobs/dedup';
import { findApplyLinks, rejectedDomain, type RunAgent } from '../jobs/find-link';
import { verifyLink } from '../jobs/link';
import type { JobPosting } from '../jobs/model';
import { matchRoles } from '../jobs/roles';
import { SeenStore } from '../jobs/seen';
import { prepareSearch, type SearchPlan } from '../jobs/search-plan';
import type { AddResult } from '../notion/jobs';

export type Outcome =
  | 'registered' // Notion 에 등록함
  | 'would_register' // 미리보기: 등록 대상
  | 'duplicate' // Notion 에 이미 있음
  | 'seen' // 이전 수집에서 처리함
  | 'merged' // 같은 회사, 같은 마감일 공고와 합침 (사이트가 달라도)
  | 'experienced' // 경력직
  | 'employment' // 고용형태가 설정과 다름
  | 'expired' // 마감 지남
  | 'too_far' // 마감이 설정한 기간보다 뒤
  | 'company' // 기업 구분 제외
  | 'no_link' // 실제 지원 페이지 없음 (AI 검색으로도 못 찾음)
  | 'no_role' // 직무 태그 없음 (설정에서 켰을 때만)
  | 'error';

export const OUTCOME_LABEL: Record<Outcome, string> = {
  registered: 'Notion 등록',
  would_register: '등록 대상 (미리보기)',
  duplicate: 'Notion 에 이미 있음',
  seen: '이전에 처리함',
  merged: '같은 회사·마감일 공고와 합침',
  experienced: '경력직',
  employment: '고용형태 다름',
  expired: '마감 지남',
  too_far: '마감이 너무 뒤',
  company: '기업 구분 제외',
  no_link: '지원 페이지 없음',
  no_role: '직무 태그 없음',
  error: '오류',
};

export type ReportItem = {
  outcome: Outcome;
  reason?: string;
  source: string;
  sourceUrl: string;
  company: string;
  title: string;
  deadline: string;
  companyTypes?: string[];
  roles?: string[];
  employment?: string[];
  applyUrl?: string;
  notionUrl?: string;
  dropped?: string[];
  /** 지원 페이지를 어떻게 찾았는지 (AI 검색일 때) */
  found?: string;
};

export type CollectReport = {
  searchPlan?: SearchPlan;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  notion: 'connected' | 'not_configured';
  sources: { id: string; label: string; count: number; error?: string }[];
  counts: Partial<Record<Outcome, number>>;
  /** AI 사용 요약 */
  ai: { linkSearched: number; linkFound: number; rolesTagged: number; costUsd: number; errors: string[] };
  items: ReportItem[];
};

/** Notion 쪽 연결 (테스트에서 가짜로 바꿀 수 있게) */
export type NotionSink = {
  tags: string[];
  add: (p: JobPosting, opts: { dryRun: boolean }) => Promise<AddResult>;
  /** 이미 있는 공고인지 미리 확인 (지원 페이지를 찾기 전에) */
  check?: (p: Pick<JobPosting, 'company' | 'link' | 'deadline'>) => Promise<DuplicateHit | null>;
};

export type CollectOptions = {
  settings: Settings;
  /** Production entrypoints always supply the current user's profile. */
  profile?: Record<string, unknown>;
  http: PoliteHttp;
  /** 수집기용 브라우저 탭 */
  browserPage: () => Promise<Page>;
  /** 지원 페이지 확인용 브라우저 탭 (수집기 탭과 따로) */
  linkPage?: () => Promise<Page>;
  seen: SeenStore;
  notion: NotionSink | null;
  dryRun: boolean;
  sources?: string[];
  /** 등록/미리보기 최대 건수 (시험 실행용) */
  limit?: number;
  now?: Date;
  log?: (msg: string) => void;
  /** 테스트용: 수집기 대신 쓸 목록 */
  collectors?: typeof COLLECTORS;
  /** AI 작업 폴더 */
  cwd?: string;
  /** 테스트에서 가짜 AI 로 바꿀 수 있게 */
  runAgent?: RunAgent;
};

const EMP_CANON: Record<string, string> = { 신입: '정규직', 정규직: '정규직', 인턴: '인턴', 인턴직: '인턴', '채용연계형 인턴': '인턴', '체험형 인턴': '인턴', 계약직: '계약직' };
const canon = (t: string) => EMP_CANON[t.replace(/\s+/g, ' ').trim()] ?? t.trim();

/** 설정의 고용형태와 겹치는지. 공고에 고용형태 정보가 없으면 통과 */
export function employmentMatches(postingTypes: string[], wanted: string[]): boolean {
  if (!postingTypes.length) return true;
  const w = new Set(wanted.map(canon));
  return postingTypes.some((t) => w.has(canon(t)));
}

/** 공고의 고용형태 → Notion 채용 분류 키. 인턴은 형태를 알 수 있을 때만.
 *  제목에 "인턴"이 있으면 인턴으로 본다 (사이트가 인턴을 "계약직"으로 적는 경우가 많다). */
export function employmentKeys(types: string[], text: string, title = text): string[] {
  const keys = new Set<string>();
  const list = types.map(canon);
  const intern = /인턴/.test(title);
  if (intern && !list.includes('인턴')) list.push('인턴');
  for (const t of list) {
    if (intern && t === '계약직') continue;
    if (t === '정규직') keys.add('정규직');
    if (t === '계약직') keys.add('계약직');
    if (t === '인턴') {
      if (/체험/.test(text)) keys.add('체험형인턴');
      else if (/연계|전환/.test(text)) keys.add('채용연계형인턴');
    }
  }
  return [...keys];
}

/** "(주)엘지씨엔에스" → "엘지씨엔에스", "데이원 주식회사" → "데이원" */
export function cleanCompanyName(name: string): string {
  return name
    .replace(/\(주\)|㈜|\(유\)|주식회사|유한회사|\(재\)|재단법인|\(사\)|사단법인/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || name.trim();
}

const deadlineText = (d: RawPosting['deadline']) => (d ? `${d.date}${d.time ? ` ${d.time}` : ''}` : '상시');

type Candidate = {
  r: RawPosting;
  verdict: CompanyVerdict;
  /** 확인된 지원 페이지 */
  link?: string;
  /** 지원 페이지를 어떻게 찾았는지 (AI 검색일 때) */
  found?: string;
  /** AI 검색을 기다리는 공고: 확인에 실패한 링크와 이유 */
  pending?: { candidate?: string; reason: string };
  roles: string[];
};

export async function runCollect(o: CollectOptions): Promise<CollectReport> {
  const log = o.log ?? (() => {});
  const now = o.now ?? new Date();
  const startedAt = now.toISOString();
  const searchPlan = o.profile ? await prepareSearch(o.settings, o.profile, { cwd: o.cwd ?? tmpdir(), runAgent: o.runAgent, log }) : undefined;
  // Derived queries apply only to this run. Never replace the user's saved inputs.
  const s = searchPlan ? { ...o.settings, collect: { ...o.settings.collect, keywords: searchPlan.keywords } } : o.settings;
  const items: ReportItem[] = [];
  const ai: CollectReport['ai'] = { linkSearched: 0, linkFound: 0, rolesTagged: 0, costUsd: searchPlan?.costUsd ?? 0, errors: [] };
  const add = (r: RawPosting, outcome: Outcome, extra: Partial<ReportItem> = {}) =>
    items.push({ outcome, source: r.source, sourceUrl: r.sourceUrl, company: cleanCompanyName(r.company), title: r.title, deadline: deadlineText(r.deadline), ...extra });
  const seenKey = (r: RawPosting) => SeenStore.key(r.source, r.sourceId);

  // 1. 수집
  const registry = o.collectors ?? COLLECTORS;
  const enabled = registry.filter((c) => c.status === 'ok' && (o.sources ? o.sources.includes(c.id) : s.collect.sources[c.id]));
  const ctx: CollectorContext = { settings: s, http: o.http, now, log, browserPage: o.browserPage };
  const sources: CollectReport['sources'] = [];
  const raw: RawPosting[] = [];
  for (const c of enabled) {
    log(`▶ ${c.label} 수집`);
    try {
      const got = await c.collect(ctx);
      raw.push(...got);
      sources.push({ id: c.id, label: c.label, count: got.length });
    } catch (e) {
      sources.push({ id: c.id, label: c.label, count: 0, error: (e as Error).message });
      log(`  ❌ ${c.label}: ${(e as Error).message}`);
    }
  }
  for (const id of o.sources ?? []) {
    const c = collectorById(id);
    if (c && c.status !== 'ok') sources.push({ id, label: c.label, count: 0, error: c.note });
  }

  // 2. 필터
  const today = ymd(now);
  const lastDay = ymd(addDays(now, s.collect.lookahead_days));
  const dateFilter = (r: RawPosting): Outcome | null => (r.deadline && r.deadline.date < today ? 'expired' : r.deadline && r.deadline.date > lastDay ? 'too_far' : null);
  const survivors: RawPosting[] = [];
  for (const r of raw) {
    const prev = o.seen.skip(seenKey(r), now);
    if (s.collect.exclude_experienced && r.experience === 'experienced') add(r, 'experienced');
    else if (!employmentMatches(r.employmentTypes, s.collect.employment_types)) add(r, 'employment', { reason: r.employmentTypes.join(', ') });
    else if (dateFilter(r)) add(r, dateFilter(r)!);
    else if (prev) add(r, 'seen', { reason: prev.status });
    else survivors.push(r);
  }

  // 3. 사이트 간 중복 합치기 (같은 회사 + 같은 마감일). 먼저 나온 사이트 것을 남긴다
  const unique: RawPosting[] = [];
  for (const r of survivors) {
    const twin = unique.find((u) => sameCompany(u.company, r.company) && (u.deadline?.date ?? '') === (r.deadline?.date ?? ''));
    if (!twin) {
      unique.push(r);
      continue;
    }
    twin.roleNames = [...new Set([...twin.roleNames, ...r.roleNames])];
    twin.sizeHints = [...new Set([...twin.sizeHints, ...r.sizeHints])];
    twin.applyUrl ??= r.applyUrl;
    const prevDetail = twin.detail;
    if (!twin.applyUrl && r.detail) twin.detail = async () => ({ ...(await r.detail!()), ...((await prevDetail?.()) ?? {}) });
    add(r, 'merged', { reason: `${twin.source === r.source ? '같은 사이트' : twin.source}의 "${twin.title}"와 합침` });
  }

  // 4. 상세 → 기업 구분 → 지원 페이지 확인 (못 찾으면 AI 검색 대기)
  const search = s.collect.link_search;
  const cands: Candidate[] = [];
  let pendingCount = 0;
  for (const r0 of unique) {
    if (o.limit && cands.length >= o.limit) break;
    let r = r0;
    try {
      if (r.detail) {
        const d = await r.detail();
        r = {
          ...r,
          ...d,
          sizeHints: [...new Set([...r.sizeHints, ...(d.sizeHints ?? [])])],
          roleNames: [...new Set([...r.roleNames, ...(d.roleNames ?? [])])],
          applyUrl: d.applyUrl ?? r.applyUrl,
        };
      }
    } catch (e) {
      log(`  ⚠️  ${r.company} 상세 정보 실패: ${(e as Error).message}`);
    }
    if (s.collect.exclude_experienced && r.experience === 'experienced') {
      add(r, 'experienced');
      continue;
    }
    if (dateFilter(r)) {
      add(r, dateFilter(r)!); // 상세에서 마감일을 알게 된 경우
      continue;
    }
    const verdict = classifyCompany(s, r.company, r.sizeHints);
    if (!verdict.include) {
      add(r, 'company', { reason: verdict.reason, companyTypes: verdict.types });
      continue;
    }
    // 이미 Notion 에 있는 공고는 지원 페이지를 찾느라 시간을 쓰지 않는다
    const dup = o.notion?.check ? await o.notion.check({ company: cleanCompanyName(r.company), link: r.applyUrl ?? '', deadline: r.deadline }) : null;
    if (dup) {
      add(r, 'duplicate', { reason: dup.reason, notionUrl: dup.existing.url, companyTypes: verdict.types });
      if (!o.dryRun) o.seen.mark(seenKey(r), { status: 'duplicate', company: r.company, title: r.title, notionUrl: dup.existing.url });
      continue;
    }
    let pending: Candidate['pending'];
    if (r.applyUrl) {
      const link = await verifyLink(r.applyUrl, o.http, o.linkPage);
      if (link.ok) {
        cands.push({ r, verdict, link: link.url, roles: [] });
        continue;
      }
      pending = { candidate: r.applyUrl, reason: link.reason ?? '열리지 않음' };
    } else pending = { reason: '공고에 지원 페이지 링크가 없음' };
    if (search.enabled && pendingCount < search.max_per_run) {
      pendingCount++;
      cands.push({ r, verdict, pending, roles: [] });
    } else {
      add(r, 'no_link', { reason: `${pending.reason}${search.enabled ? ' (이번 수집의 AI 검색 한도를 넘음)' : ''}`, applyUrl: pending.candidate, companyTypes: verdict.types });
    }
  }

  // 5. AI 로 지원 페이지 찾기 → 코드로 다시 열어 확인
  const waiting = cands.filter((c) => c.pending);
  if (waiting.length) {
    log(`▶ 지원 페이지를 못 찾은 공고 ${waiting.length}건: AI 웹 검색`);
    const byKey = new Map(waiting.map((c) => [seenKey(c.r), c]));
    const { answers, costUsd } = await findApplyLinks(
      waiting.map((c) => ({ key: seenKey(c.r), company: cleanCompanyName(c.r.company), title: c.r.title, deadline: deadlineText(c.r.deadline), sourceUrl: c.r.sourceUrl, candidate: c.pending!.candidate, reason: c.pending!.reason })),
      { settings: s, cwd: o.cwd ?? tmpdir(), runAgent: o.runAgent, log },
    );
    ai.linkSearched = waiting.length;
    ai.costUsd += costUsd;
    for (const a of answers) {
      const c = byKey.get(a.key);
      if (!c) continue;
      let why = a.note;
      if (a.url) {
        const bad = rejectedDomain(a.url, search.reject_domains);
        const link = bad ? null : await verifyLink(a.url, o.http, o.linkPage);
        if (link?.ok) {
          c.link = link.url;
          c.found = `AI 검색: ${a.note}`;
          c.pending = undefined;
          ai.linkFound++;
          continue;
        }
        why = `${a.note} → ${bad ?? link?.reason ?? '확인 실패'} (${a.url})`;
      }
      c.pending = { ...c.pending!, reason: `${c.pending!.reason}; AI 검색: ${why}` };
    }
    for (const c of waiting.filter((x) => x.pending)) {
      add(c.r, 'no_link', { reason: c.pending!.reason, applyUrl: c.pending!.candidate, companyTypes: c.verdict.types });
      if (!o.dryRun) o.seen.mark(seenKey(c.r), { status: 'no_link', company: c.r.company, title: c.r.title });
    }
  }
  const ready = cands.filter((c) => c.link);

  // 6. 직무 태그: 규칙 → (설정에 따라) AI
  const tags = o.notion?.tags ?? [];
  const roleText = (c: Candidate) => [c.r.title, ...c.r.roleNames].join(' ');
  for (const c of ready) c.roles = tags.length ? matchRoles(tags, s.notion.role_rules, roleText(c)) : [];
  const mode = s.collect.ai_roles.mode;
  const toTag = mode === 'off' || !tags.length ? [] : ready.filter((c) => mode === 'review' || !c.roles.length);
  if (toTag.length) {
    log(`▶ AI 직무 태그 ${toTag.length}건 (${mode === 'review' ? '모든 공고 다시 보기' : '규칙으로 못 단 공고'})`);
    const res = await tagRolesWithAi(
      toTag.map((c) => ({ key: seenKey(c.r), company: cleanCompanyName(c.r.company), title: c.r.title, roleNames: c.r.roleNames, sourceUrl: c.r.sourceUrl, ruleRoles: c.roles })),
      { settings: s, tags, cwd: o.cwd ?? tmpdir(), runAgent: o.runAgent, log },
    );
    ai.costUsd += res.costUsd;
    ai.errors.push(...res.errors.map((e) => `직무 태그: ${e}`));
    const byKey = new Map(res.answers.map((a) => [a.key, a]));
    for (const c of toTag) {
      const a = byKey.get(seenKey(c.r));
      if (!a) continue;
      if (a.roles.join() !== c.roles.join()) ai.rolesTagged++;
      c.roles = a.roles;
    }
  }

  // 7. Notion 등록
  for (const c of ready) {
    const r = c.r;
    const text = roleText(c);
    const posting: JobPosting = {
      company: cleanCompanyName(r.company),
      title: r.title,
      roles: c.roles,
      employment: employmentKeys(r.employmentTypes, text, r.title),
      deadline: r.deadline,
      link: c.link!,
      companyType: c.verdict.types[0],
      priority: c.verdict.priority,
      source: r.source,
    };
    const base: Partial<ReportItem> = { companyTypes: c.verdict.types, roles: posting.roles, employment: posting.employment, applyUrl: c.link, found: c.found };
    if (s.collect.require_role && o.notion && !posting.roles.length) {
      add(r, 'no_role', base);
      continue;
    }
    if (!o.notion) {
      add(r, 'would_register', { ...base, reason: 'Notion 미연결 — 중복 확인 없이 미리보기' });
      continue;
    }
    try {
      const res = await o.notion.add(posting, { dryRun: o.dryRun });
      const key = seenKey(r);
      if (res.status === 'duplicate') {
        add(r, 'duplicate', { ...base, reason: res.duplicate.reason, notionUrl: res.duplicate.existing.url });
        if (!o.dryRun) o.seen.mark(key, { status: 'duplicate', company: r.company, title: r.title, notionUrl: res.duplicate.existing.url });
      } else if (res.status === 'dry-run') {
        add(r, 'would_register', { ...base, dropped: res.dropped });
      } else {
        add(r, 'registered', { ...base, notionUrl: res.url, dropped: res.dropped });
        o.seen.mark(key, { status: 'registered', company: r.company, title: r.title, notionUrl: res.url });
        log(`  ✅ ${r.company} — ${r.title}`);
      }
    } catch (e) {
      add(r, 'error', { ...base, reason: (e as Error).message });
    }
  }
  if (!o.dryRun) o.seen.save();

  const counts: CollectReport['counts'] = {};
  for (const it of items) counts[it.outcome] = (counts[it.outcome] ?? 0) + 1;
  return { startedAt, finishedAt: new Date().toISOString(), dryRun: o.dryRun, notion: o.notion ? 'connected' : 'not_configured', sources, counts, ai, items, ...(searchPlan ? { searchPlan } : {}) };
}

/** 사람이 읽는 리포트 */
export function formatReport(r: CollectReport, opts: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`공고 수집 ${r.dryRun ? '(미리보기 — Notion 에 쓰지 않음)' : ''}`.trim());
  if (r.searchPlan) {
    const p = r.searchPlan;
    lines.push('', p.mode === 'profile' ? `내 자료 기반 검색 (연결 파일 ${p.filesRead}개 분석)` : '직접 지정한 조건으로 검색', `  검색어: ${p.keywords.join(', ') || '사이트 직무 분류 사용'}`);
    for (const d of p.directions) {
      lines.push(`  ${d.role}: ${d.reason}`, `    검색어: ${d.keywords.join(', ')}`);
      for (const e of p.evidence.filter((e) => d.evidence_ids.includes(e.id))) lines.push(`    근거: ${e.source} — ${e.fact}`);
    }
    for (const w of p.warnings) lines.push(`  ⚠️ ${w}`);
    lines.push('');
  }
  for (const s of r.sources) lines.push(`  ${s.error ? '❌' : '✅'} ${s.label}: ${s.error ? s.error : `${s.count}건`}`);
  lines.push('', '결과');
  for (const [k, v] of Object.entries(r.counts)) lines.push(`  ${OUTCOME_LABEL[k as Outcome]}: ${v}`);
  const a = r.ai;
  if (a && (a.linkSearched || a.rolesTagged || a.errors.length || a.costUsd)) {
    lines.push('', 'AI');
    if (a.linkSearched) lines.push(`  지원 페이지 검색: ${a.linkSearched}건 중 ${a.linkFound}건 찾음`);
    if (a.rolesTagged) lines.push(`  직무 태그를 AI 가 바꾼 공고: ${a.rolesTagged}건`);
    if (a.costUsd) lines.push(`  비용: $${a.costUsd.toFixed(2)}`);
    for (const e of a.errors) lines.push(`  ⚠️  ${e}`);
  }
  const show = (o: Outcome, title: string) => {
    const xs = r.items.filter((i) => i.outcome === o);
    if (!xs.length) return;
    lines.push('', `${title} (${xs.length})`);
    for (const i of xs) {
      lines.push(`  · ${i.deadline.padEnd(16)} ${i.company} — ${i.title}`);
      const meta = [i.companyTypes?.length && `구분: ${i.companyTypes.join('/')}`, i.roles?.length && `직무: ${i.roles.join(', ')}`, i.employment?.length && `분류: ${i.employment.join(', ')}`].filter(Boolean).join('  ');
      if (meta) lines.push(`      ${meta}`);
      if (i.applyUrl) lines.push(`      지원: ${i.applyUrl}`);
      if (i.found) lines.push(`      찾은 방법: ${i.found}`);
      if (i.notionUrl) lines.push(`      Notion: ${i.notionUrl}`);
      if (i.reason) lines.push(`      사유: ${i.reason}`);
      for (const d of i.dropped ?? []) lines.push(`      ⚠️  ${d}`);
    }
  };
  show('registered', '✅ Notion 에 등록');
  show('would_register', '📝 등록 대상');
  show('no_link', '🔗 지원 페이지를 찾지 못해 뺀 공고');
  show('error', '❌ 오류');
  if (opts.verbose) {
    show('duplicate', '⏭️  이미 Notion 에 있음');
    show('company', '🏢 기업 구분 제외');
    show('no_role', '🏷️  직무 태그가 없어 뺀 공고');
  }
  return lines.join('\n');
}
