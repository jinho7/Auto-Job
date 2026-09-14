// 공고 수집 파이프라인:
//   수집 → 경력/고용형태/마감 필터 → 이미 처리한 공고 건너뛰기 → 사이트 간 중복 합치기
//   → 상세 정보 → 기업 구분 → 지원 페이지 확인 → 직무 태그 → Notion 등록(중복 제외) → 리포트
import type { Page } from 'playwright-core';
import type { Settings } from '../config';
import { collectorById, COLLECTORS } from '../collectors';
import { addDays, ymd, type CollectorContext, type RawPosting } from '../collectors/types';
import type { PoliteHttp } from '../http';
import { classifyCompany } from '../jobs/classify';
import { sameCompany } from '../jobs/dedup';
import { verifyLink } from '../jobs/link';
import type { JobPosting } from '../jobs/model';
import { matchRoles } from '../jobs/roles';
import { SeenStore } from '../jobs/seen';
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
  | 'no_link' // 실제 지원 페이지 없음
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
};

export type CollectReport = {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  notion: 'connected' | 'not_configured';
  sources: { id: string; label: string; count: number; error?: string }[];
  counts: Partial<Record<Outcome, number>>;
  items: ReportItem[];
};

/** Notion 쪽 연결 (테스트에서 가짜로 바꿀 수 있게) */
export type NotionSink = { tags: string[]; add: (p: JobPosting, opts: { dryRun: boolean }) => Promise<AddResult> };

export type CollectOptions = {
  settings: Settings;
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

export async function runCollect(o: CollectOptions): Promise<CollectReport> {
  const log = o.log ?? (() => {});
  const now = o.now ?? new Date();
  const startedAt = now.toISOString();
  const s = o.settings;
  const items: ReportItem[] = [];
  const add = (r: RawPosting, outcome: Outcome, extra: Partial<ReportItem> = {}) =>
    items.push({ outcome, source: r.source, sourceUrl: r.sourceUrl, company: cleanCompanyName(r.company), title: r.title, deadline: deadlineText(r.deadline), ...extra });

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
  const survivors: RawPosting[] = [];
  for (const r of raw) {
    if (s.collect.exclude_experienced && r.experience === 'experienced') add(r, 'experienced');
    else if (!employmentMatches(r.employmentTypes, s.collect.employment_types)) add(r, 'employment', { reason: r.employmentTypes.join(', ') });
    else if (r.deadline && r.deadline.date < today) add(r, 'expired');
    else if (r.deadline && r.deadline.date > lastDay) add(r, 'too_far');
    else if (o.seen.get(SeenStore.key(r.source, r.sourceId))) add(r, 'seen', { reason: o.seen.get(SeenStore.key(r.source, r.sourceId))!.status });
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

  // 4~7. 상세 → 기업 구분 → 지원 페이지 → 직무 태그 → Notion
  let done = 0;
  for (const r0 of unique) {
    if (o.limit && done >= o.limit) break;
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
    const verdict = classifyCompany(s, r.company, r.sizeHints);
    if (!verdict.include) {
      add(r, 'company', { reason: verdict.reason, companyTypes: verdict.types });
      continue;
    }
    if (!r.applyUrl) {
      add(r, 'no_link', { reason: '공고에 지원 페이지 링크가 없음', companyTypes: verdict.types });
      continue;
    }
    const link = await verifyLink(r.applyUrl, o.http, o.linkPage);
    if (!link.ok) {
      add(r, 'no_link', { reason: link.reason, applyUrl: r.applyUrl, companyTypes: verdict.types });
      continue;
    }

    const text = [r.title, ...r.roleNames].join(' ');
    const posting: JobPosting = {
      company: cleanCompanyName(r.company),
      title: r.title,
      roles: o.notion ? matchRoles(o.notion.tags, s.notion.role_rules, text) : [],
      employment: employmentKeys(r.employmentTypes, text, r.title),
      deadline: r.deadline,
      link: link.url,
      companyType: verdict.types[0],
      priority: verdict.priority,
      source: r.source,
    };
    const base: Partial<ReportItem> = { companyTypes: verdict.types, roles: posting.roles, employment: posting.employment, applyUrl: link.url };
    done++;

    if (!o.notion) {
      add(r, 'would_register', { ...base, reason: 'Notion 미연결 — 중복 확인 없이 미리보기' });
      continue;
    }
    try {
      const res = await o.notion.add(posting, { dryRun: o.dryRun });
      const key = SeenStore.key(r.source, r.sourceId);
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
  return { startedAt, finishedAt: new Date().toISOString(), dryRun: o.dryRun, notion: o.notion ? 'connected' : 'not_configured', sources, counts, items };
}

/** 사람이 읽는 리포트 */
export function formatReport(r: CollectReport, opts: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`공고 수집 ${r.dryRun ? '(미리보기 — Notion 에 쓰지 않음)' : ''}`.trim());
  for (const s of r.sources) lines.push(`  ${s.error ? '❌' : '✅'} ${s.label}: ${s.error ? s.error : `${s.count}건`}`);
  lines.push('', '결과');
  for (const [k, v] of Object.entries(r.counts)) lines.push(`  ${OUTCOME_LABEL[k as Outcome]}: ${v}`);
  const show = (o: Outcome, title: string) => {
    const xs = r.items.filter((i) => i.outcome === o);
    if (!xs.length) return;
    lines.push('', `${title} (${xs.length})`);
    for (const i of xs) {
      lines.push(`  · ${i.deadline.padEnd(16)} ${i.company} — ${i.title}`);
      const meta = [i.companyTypes?.length && `구분: ${i.companyTypes.join('/')}`, i.roles?.length && `직무: ${i.roles.join(', ')}`, i.employment?.length && `분류: ${i.employment.join(', ')}`].filter(Boolean).join('  ');
      if (meta) lines.push(`      ${meta}`);
      if (i.applyUrl) lines.push(`      지원: ${i.applyUrl}`);
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
  }
  return lines.join('\n');
}
