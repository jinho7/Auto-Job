// 중복 판단. "중복은 절대 넣지 않는다"가 원칙이라, 애매하면 중복으로 본다.
//   1) 지원 링크가 같으면 중복
//   2) 회사명이 같고 마감일(또는 둘 다 상시)이 같으면 중복
import type { JobPosting } from './model';

const TRACKING = /^(utm_|fbclid$|gclid$|ref$|referrer$|source$|src$|trk$|from$)/i;

export function normalizeLink(link: string): string {
  try {
    const u = new URL(link.trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.hostname}${path}${u.search}`;
  } catch {
    return link.trim().toLowerCase();
  }
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|co\.,?\s*ltd\.?|corp\.?|inc\.?/g, '')
    .replace(/[^0-9a-z가-힣]/g, '');

/** "[CJ] 올리브영" → {"cj올리브영", "올리브영"} */
export function companyVariants(name: string): Set<string> {
  const out = new Set<string>();
  const add = (s: string) => {
    const n = norm(s);
    if (n) out.add(n);
  };
  add(name);
  add(name.replace(/^\s*[[(（【][^\])）】]*[\])）】]\s*/, '')); // 앞의 [그룹명] 제거
  return out;
}

export function sameCompany(a: string, b: string): boolean {
  const va = companyVariants(a);
  for (const v of companyVariants(b)) if (va.has(v)) return true;
  return false;
}

export type ExistingJob = { id: string; url?: string; company: string; link: string; deadline: string };
export type DuplicateHit = { existing: ExistingJob; reason: string };

export function findDuplicate(p: Pick<JobPosting, 'company' | 'link' | 'deadline'>, existing: ExistingJob[]): DuplicateHit | null {
  const link = p.link ? normalizeLink(p.link) : '';
  const deadline = p.deadline?.date ?? '';
  for (const e of existing) {
    if (link && e.link && normalizeLink(e.link) === link) return { existing: e, reason: '지원 링크가 같음' };
  }
  for (const e of existing) {
    if (sameCompany(p.company, e.company) && e.deadline.slice(0, 10) === deadline) {
      return { existing: e, reason: deadline ? `같은 회사, 같은 마감일(${deadline})` : '같은 회사, 둘 다 상시 채용' };
    }
  }
  return null;
}
