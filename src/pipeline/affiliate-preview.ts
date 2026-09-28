import { matchesAffiliatePolicy, verifyAffiliatePolicies } from '../jobs/affiliates';
import type { PoliteHttp } from '../http';
import type { CollectReport } from './collect';

/** Keep individual candidates intact so turning grouping off never loses a posting. */
export async function groupPreview(report: CollectReport, enabled: boolean, http: PoliteHttp): Promise<void> {
  report.groupAffiliates = enabled;
  report.affiliateGroups = [];
  report.groupingWarnings = [];
  if (!enabled) return;
  const candidates = report.items.filter(i => i.outcome === 'candidate' && i.id && i.candidate);
  const { verified, warnings } = await verifyAffiliatePolicies(candidates.map(i => i.candidate!), http);
  report.groupingWarnings = warnings;
  report.affiliateGroups = verified.map(policy => ({ policy,
    memberIds: candidates.filter(i => matchesAffiliatePolicy(i.candidate!, policy)).map(i => i.id!),
  }));
}
