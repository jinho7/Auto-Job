// 캐치: 채용공고 목록(/api/v1.0/recruit/information/getRecruitList — 채용공고 페이지가 부르는 목록)과
// 공고 상세 페이지(/NCS/RecruitInfoDetails/…). 둘 다 robots.txt 허용 경로.
// 로그 기록용 주소(/api/v1.0/recruit/log, …/detail/log)는 robots.txt 가 막고 있고 부르지도 않는다.
import type { PoliteHttp } from '../http';
import { sizeHintFromText } from '../jobs/classify';
import type { JobPosting } from '../jobs/model';
import { normalizeEmployment, parseExperience } from './saramin';
import type { Collector, CollectorContext, RawPosting } from './types';

const BASE = 'https://www.catch.co.kr';
const PAGE_SIZE = 30;

export type CatchItem = {
  RecruitID: number | string;
  RecruitTitle: string;
  CompName: string;
  ApplyEndDatetime: string | null;
  ApplyEndCode?: string | null;
  CareerGubunCode?: string | null;
  GubunCode?: string | null;
  Depth?: string | null;
  AssignedTaskNameListString?: string | null;
  PopularCategory?: string | null;
  WorkArea?: string | null;
};

/** "2026-10-05T14:59:59.000Z" (UTC) → 한국 시각의 마감. 자정 직전/직후면 날짜만 */
export function catchDeadline(iso: string | null | undefined, endCode = ''): JobPosting['deadline'] {
  if (!iso || /상시/.test(endCode)) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime()) || t.getUTCFullYear() >= 9000) return null;
  const k = new Date(t.getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())}`;
  const time = `${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
  return time === '23:59' || time === '00:00' ? { date } : { date, time };
}

const split = (s?: string | null) =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export function mapCatchItem(x: CatchItem): Omit<RawPosting, 'detail'> {
  const id = String(x.RecruitID);
  return {
    source: 'catch',
    sourceId: id,
    sourceUrl: `${BASE}/NCS/RecruitInfoDetails/${id}`,
    company: x.CompName,
    title: x.RecruitTitle,
    deadline: catchDeadline(x.ApplyEndDatetime, x.ApplyEndCode ?? ''),
    experience: parseExperience(x.CareerGubunCode ?? ''),
    employmentTypes: normalizeEmployment(x.GubunCode ?? ''),
    roleNames: [...new Set([...split(x.AssignedTaskNameListString), ...split(x.Depth)])],
    sizeHints: x.PopularCategory ? sizeHintFromText(x.PopularCategory) : [],
    location: x.WorkArea ?? undefined,
  };
}

/** 상세 페이지 HTML → 지원 링크, 기업 규모 */
export function parseCatchDetail(html: string): { applyUrl?: string; companySize?: string; sizeHints: string[] } {
  const str = (key: string) => {
    const m = html.match(new RegExp(`\\.${key}="((?:[^"\\\\]|\\\\.)*)"`));
    if (!m) return undefined;
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return m[1];
    }
  };
  const applyUrl = str('ApplyURL');
  const companySize = str('CompSizeName');
  return {
    applyUrl: applyUrl && /^https?:\/\//.test(applyUrl) ? applyUrl : undefined,
    companySize,
    sizeHints: companySize ? sizeHintFromText(companySize) : [],
  };
}

async function listPage(http: PoliteHttp, keyword: string, page: number): Promise<CatchItem[]> {
  const q = new URLSearchParams({
    Keyword: keyword, JobCode: '', Sido: '', Career: '', JCode: '', Size: '', EduLevel: '', WorkPosition: '', CompID: '', GroupCode: '',
    Sort: '0', curpage: String(page), pageSize: String(PAGE_SIZE), onRecruitYN: 'Y', ExceptIDList: '',
  });
  const res = await http.request(`${BASE}/api/v1.0/recruit/information/getRecruitList?${q}`, { headers: { Accept: 'application/json', Referer: `${BASE}/NCS/RecruitSearch` } });
  if (res.status !== 200) throw new Error(`캐치 목록 요청 실패 (${res.status})`);
  return (JSON.parse(res.text) as { recruitData?: CatchItem[] }).recruitData ?? [];
}

export const catchCollector: Collector = {
  id: 'catch',
  label: '캐치',
  method: 'http',
  status: 'ok',
  note: '채용공고 목록과 상세 (robots.txt 허용 범위)',
  async collect(ctx: CollectorContext): Promise<RawPosting[]> {
    const { settings, http, log } = ctx;
    if (!settings.collect.keywords.length) throw new Error('검색 키워드가 필요합니다');
    const out = new Map<string, RawPosting>();
    for (const kw of settings.collect.keywords) {
      let got = 0;
      for (let page = 1; got < settings.collect.max_per_keyword; page++) {
        const items = await listPage(http, kw, page);
        for (const it of items) {
          const r = mapCatchItem(it);
          if (!r.sourceId || out.has(r.sourceId)) continue;
          out.set(r.sourceId, { ...r, detail: () => catchDetail(http, r.sourceUrl) });
        }
        got += items.length;
        if (items.length < PAGE_SIZE) break;
      }
      log(`  캐치 "${kw}": ${got}건`);
    }
    return [...out.values()];
  },
};

async function catchDetail(http: PoliteHttp, url: string): Promise<Partial<RawPosting>> {
  const res = await http.request(url);
  if (res.status !== 200) return {};
  const d = parseCatchDetail(res.text);
  return { sizeHints: d.sizeHints, ...(d.applyUrl ? { applyUrl: d.applyUrl } : {}) };
}
