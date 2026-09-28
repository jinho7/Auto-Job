import { addDays, ymd, type RawPosting } from '../collectors/types';
import { classifyCompany } from '../jobs/classify';
import { matchRoles } from '../jobs/roles';
import { SeenStore } from '../jobs/seen';
import { cleanCompanyName, employmentKeys, employmentMatches, type CollectOptions, type CollectReport, type Outcome, type ReportItem } from './collect';

/** List review does not fetch detail pages, verify application links, run enrichment AI, or write to Notion. */
export async function previewReport(raw: RawPosting[], sources: CollectReport['sources'], o: CollectOptions, startedAt: string): Promise<CollectReport> {
  const s = o.settings, now = o.now ?? new Date(), today = ymd(now), lastDay = ymd(addDays(now, s.collect.lookahead_days));
  const items: ReportItem[] = [], unique: RawPosting[] = [];
  const add = (r: RawPosting, outcome: Outcome, extra: Partial<ReportItem> = {}) => items.push({
    id: SeenStore.key(r.source, r.sourceId), outcome, source: r.source, sourceUrl: r.sourceUrl,
    company: cleanCompanyName(r.company), title: r.title,
    deadline: r.deadline ? `${r.deadline.date}${r.deadline.time ? ` ${r.deadline.time}` : ''}` : '상시 / 기한 미정', ...extra,
  });
  for (const r of raw) {
    if (s.collect.exclude_experienced && r.experience === 'experienced') { add(r, 'experienced'); continue; }
    if (!employmentMatches(r.employmentTypes, s.collect.employment_types)) { add(r, 'employment'); continue; }
    if (r.deadline && r.deadline.date < today) { add(r, 'expired'); continue; }
    if (r.deadline && r.deadline.date > lastDay) { add(r, 'too_far'); continue; }
    if (o.seen.skip(SeenStore.key(r.source, r.sourceId), now)) { add(r, 'seen'); continue; }
    unique.push({ ...r, roleNames: [...r.roleNames], sizeHints: [...r.sizeHints] });
  }
  // Known preferred companies first; unknown company size stays explicitly unconfirmed.
  unique.sort((a, b) => Number(classifyCompany(s, b.company, b.sizeHints).priority) - Number(classifyCompany(s, a.company, a.sizeHints).priority)
    || (a.deadline?.date ?? '9999').localeCompare(b.deadline?.date ?? '9999'));
  for (const r of unique) {
    o.signal?.throwIfAborted();
    const verdict = classifyCompany(s, r.company, r.sizeHints, true);
    if (!verdict.include && (verdict.types.length || verdict.reason === '항상 제외할 회사')) {
      add(r, 'company', { companyTypes: verdict.types, reason: verdict.reason }); continue;
    }
    const dup = await o.notion?.check?.({ company: cleanCompanyName(r.company), link: r.applyUrl ?? '', deadline: r.deadline });
    o.signal?.throwIfAborted();
    if (dup) { add(r, 'duplicate', { reason: dup.reason, notionUrl: dup.existing.url }); continue; }
    const { detail: _detail, ...candidate } = r;
    add(r, verdict.include ? 'review_pending' : 'company_unknown', { candidate, companyTypes: verdict.types, applyUrl: r.applyUrl,
      roles: matchRoles(o.notion?.tags ?? [], s.notion.role_rules, [r.title, ...r.roleNames].join(' ')),
      employment: employmentKeys(r.employmentTypes, r.roleNames.join(' '), r.title),
      reason: verdict.include ? '목록 수집 후 희망 직무와 실제 모집 직무를 대조합니다.' : '중소기업 등 제외 조건을 확인할 기업 규모 정보가 없어 후보로 올리지 않았습니다. 회사명에 포함된 단어로 규모를 확정하지 않습니다.' });
  }
  const counts: CollectReport['counts'] = {};
  for (const item of items) counts[item.outcome] = (counts[item.outcome] ?? 0) + 1;
  return { phase: 'preview', partial: true, startedAt, finishedAt: '', dryRun: true, notion: o.notion ? 'connected' : 'not_configured',
    sources: [...sources], items, counts, ai: { linkSearched: 0, linkFound: 0, rolesTagged: 0, costUsd: 0, errors: [] } };
}
