import { parse } from 'node-html-parser';
import type { PoliteHttp } from '../http';
import { sameCompany } from './dedup';
import type { JobPosting } from './model';

export type AffiliatePolicy = {
  key: string; title: string; companies: string[]; deadline: string; deadlineTime: string;
  policyUrl: string; quote: string; exception: string; campaignUrl: string; campaignText: string; deadlineEvidence: string;
};
export type VerifiedAffiliatePolicy = AffiliatePolicy & { checkedAt: string };
type PostingScope = { company: string; title?: string; deadline: JobPosting['deadline'] };

/** Explicit, round-scoped official evidence. A shared company prefix is never a grouping rule. */
export const AFFILIATE_POLICIES: AffiliatePolicy[] = [{
  key: 'cj-2026-second-half-new', title: 'CJ그룹 2026년 하반기 신입사원 모집',
  companies: ['CJ 4DPLEX', 'CJ제일제당', 'CJ푸드빌', 'CJ ENM(커머스)', 'CJ ENM(엔터테인먼트)', 'CJ올리브영', 'CJ프레시웨이', 'CJ대한통운', 'CJ CGV', 'CJ올리브네트웍스'],
  deadline: '2026-09-30', deadlineTime: '17:00',
  policyUrl: 'https://recruit.cj.net/recruit/ko/recruit/guide/guide.fo',
  quote: '신입사원 모집 공고의 경우에도 동시에 여러 개 회사/직무로 지원 불가능 합니다.',
  exception: '기존 전형이 최종 종료된 뒤 다른 공고에 지원하는 것은 가능하다는 예외가 있습니다.',
  campaignUrl: 'https://cjnews.cj.net/?p=79966', campaignText: '2026년 하반기 신입사원 공개 채용',
  deadlineEvidence: '9월 30일 오후 5시',
}];

export function matchesAffiliatePolicy(p: PostingScope, policy: AffiliatePolicy): boolean {
  return policy.companies.some(company => sameCompany(company, p.company)) && p.deadline?.date === policy.deadline &&
    (!p.deadline.time || p.deadline.time === policy.deadlineTime) &&
    /2026(?:년)?\s*(?:하반기\s*)?신입사원\s*(?:모집|채용)/.test(p.title ?? '') &&
    !/경력|인턴|변호사|박사|장학생|외국인|생산직/.test(p.title ?? '');
}

export async function verifyAffiliatePolicies(postings: PostingScope[], http: PoliteHttp, now = new Date(), policies = AFFILIATE_POLICIES): Promise<{ verified: VerifiedAffiliatePolicy[]; warnings: string[] }> {
  const verified: VerifiedAffiliatePolicy[] = [], warnings: string[] = [];
  for (const policy of policies) {
    if (postings.filter(p => matchesAffiliatePolicy(p, policy)).length < 2) continue;
    try {
      const policyPage = await http.request(policy.policyUrl), campaign = await http.request(policy.campaignUrl);
      const text = (html: string) => { const root = parse(html); root.querySelectorAll('script,style').forEach(el => el.remove()); return root.text.replace(/\s+/g, ' ').trim(); };
      if (policyPage.status !== 200 || campaign.status !== 200 || !text(policyPage.text).includes(policy.quote) ||
        !text(campaign.text).includes(policy.campaignText) || !text(campaign.text).includes(policy.deadlineEvidence)) throw new Error('현재 공식 안내의 금지 규정 또는 채용 회차와 마감을 확인하지 못했습니다.');
      verified.push({ ...policy, checkedAt: now.toISOString() });
    } catch (e) { warnings.push(`${policy.title}: ${(e as Error).message}`); }
  }
  return { verified, warnings };
}

export function combineAffiliatePostings(members: JobPosting[], policy: VerifiedAffiliatePolicy): JobPosting {
  if (!members.length || !members.every(p => matchesAffiliatePolicy(p, policy))) throw new Error('같은 계열사 채용 회차로 확인되지 않은 공고는 묶을 수 없습니다.');
  return {
    company: policy.title, title: policy.title, deadline: { date: policy.deadline, time: policy.deadlineTime },
    roles: [...new Set(members.flatMap(p => p.roles))], employment: [...new Set(members.flatMap(p => p.employment))],
    // The group page opens the official round announcement; individual application links stay in the body.
    link: policy.campaignUrl, companyType: members[0].companyType, priority: members.some(p => p.priority),
    applicationGroup: { policy, members },
  };
}
