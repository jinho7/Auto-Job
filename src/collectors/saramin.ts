// 사람인: 검색 결과(/zf_user/search/recruit)와 상세(/zf_user/jobs/relay/view-ajax). 둘 다 robots.txt 허용 경로.
import { parse, type HTMLElement } from 'node-html-parser';
import { sizeHintFromText } from '../jobs/classify';
import type { JobPosting } from '../jobs/model';
import { addDays, ymd, type Collector, type CollectorContext, type Experience, type RawPosting } from './types';

const BASE = 'https://www.saramin.co.kr';
const text = (el: HTMLElement | null | undefined) => (el?.text ?? '').replace(/\s+/g, ' ').trim();

/** "~ 09/30(수)", "오늘마감", "내일마감", "18시마감", "채용시", "상시채용" */
export function parseSaraminDeadline(raw: string, now: Date): JobPosting['deadline'] | 'unknown' {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (/채용시|상시/.test(t)) return null;
  if (/오늘마감/.test(t)) return { date: ymd(now) };
  if (/내일마감/.test(t)) return { date: ymd(addDays(now, 1)) };
  const hour = t.match(/(\d{1,2})시\s*마감/);
  if (hour) return { date: ymd(now), time: `${hour[1].padStart(2, '0')}:00` };
  const m = t.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return 'unknown';
  const month = Number(m[1]);
  // 연도는 표시되지 않는다. 이번 달보다 앞선 달이면 내년으로 본다.
  const year = month < now.getMonth() + 1 ? now.getFullYear() + 1 : now.getFullYear();
  return { date: `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` };
}

export function parseExperience(s: string): Experience {
  if (/무관|신입\s*[·/,및]\s*경력|경력\s*[·/,및]\s*신입/.test(s)) return 'any';
  if (/신입/.test(s)) return 'new';
  if (/경력/.test(s)) return 'experienced';
  return 'unknown';
}

const EMPLOYMENT_WORDS = /정규직|계약직|인턴|파견직|프리랜서|아르바이트|위촉직|전임|병역특례|교육생/;

export function normalizeEmployment(s: string): string[] {
  return s
    .split(/[·,/]/)
    .map((x) => x.trim().replace(/^인턴직$/, '인턴'))
    .filter((x) => EMPLOYMENT_WORDS.test(x));
}

/** 검색 결과 HTML → 공고 목록 */
export function parseSaraminSearch(html: string, now: Date): Omit<RawPosting, 'detail'>[] {
  const root = parse(html);
  return root.querySelectorAll('.item_recruit').map((item) => {
    const id = item.getAttribute('value') ?? '';
    const a = item.querySelector('.job_tit a');
    const conditions = item.querySelectorAll('.job_condition > span').map(text);
    const dateText = text(item.querySelector('.job_date .date')) || text(item.querySelector('.job_date'));
    const deadline = parseSaraminDeadline(dateText, now);
    const expText = conditions.find((c) => /신입|경력/.test(c)) ?? '';
    const empText = conditions.find((c) => EMPLOYMENT_WORDS.test(c)) ?? '';
    const onSaramin = /입사지원/.test(text(item.querySelector('.job_date')));
    return {
      source: 'saramin',
      sourceId: id,
      sourceUrl: `${BASE}/zf_user/jobs/view?rec_idx=${id}`,
      company: text(item.querySelector('.corp_name a')) || text(item.querySelector('.corp_name')),
      title: a?.getAttribute('title') ?? text(a),
      deadline: deadline === 'unknown' ? null : deadline,
      experience: parseExperience(expText),
      employmentTypes: normalizeEmployment(empText),
      roleNames: item.querySelectorAll('.job_sector a').map(text).filter(Boolean),
      sizeHints: [],
      // 사람인에서 바로 지원하는 공고는 사람인 공고 페이지가 곧 지원 페이지
      applyUrl: onSaramin ? `${BASE}/zf_user/jobs/view?rec_idx=${id}` : undefined,
      location: conditions[0],
    };
  });
}

/** 상세(view-ajax) HTML → 기업형태, 홈페이지 지원 링크 */
export function parseSaraminDetail(html: string): { sizeHints: string[]; homepageUrl?: string; companyTypeText?: string } {
  const root = parse(html);
  let companyTypeText: string | undefined;
  for (const dt of root.querySelectorAll('dt')) {
    if (text(dt) === '기업형태') companyTypeText = text(dt.nextElementSibling);
  }
  const homepage = root.querySelectorAll('[data-href]').map((el) => el.getAttribute('data-href') ?? '').find((h) => /^https?:\/\//.test(h) && !/saramin\.co\.kr/.test(h));
  return { sizeHints: companyTypeText ? sizeHintFromText(companyTypeText) : [], homepageUrl: homepage, companyTypeText };
}

export const saramin: Collector = {
  id: 'saramin',
  label: '사람인',
  method: 'http',
  status: 'ok',
  note: '검색 결과와 상세 정보 (robots.txt 허용 범위)',
  async collect(ctx: CollectorContext): Promise<RawPosting[]> {
    const { settings, http, now, log } = ctx;
    const perPage = Math.min(100, settings.collect.max_per_keyword);
    const out = new Map<string, RawPosting>();
    for (const keyword of settings.collect.keywords) {
      let got = 0;
      for (let page = 1; got < settings.collect.max_per_keyword; page++) {
        const q = new URLSearchParams({ searchType: 'search', searchword: keyword, recruitPage: String(page), recruitPageCount: String(perPage), recruitSort: 'relation' });
        if (settings.collect.exclude_experienced) q.set('exp_cd', '1'); // 신입
        const res = await http.request(`${BASE}/zf_user/search/recruit?${q}`);
        if (res.status !== 200) throw new Error(`사람인 검색 실패 (${res.status})`);
        const items = parseSaraminSearch(res.text, now);
        for (const it of items) {
          if (!it.sourceId || out.has(it.sourceId)) continue;
          out.set(it.sourceId, { ...it, detail: () => saraminDetail(ctx, it.sourceId, it.applyUrl) });
        }
        got += items.length;
        if (items.length < perPage) break;
      }
      log(`  사람인 "${keyword}": ${got}건`);
    }
    return [...out.values()];
  },
};

async function saraminDetail(ctx: CollectorContext, recIdx: string, applyUrl?: string): Promise<Partial<RawPosting>> {
  const res = await ctx.http.request(`${BASE}/zf_user/jobs/relay/view-ajax`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      // 상세 내용은 공고 페이지에서 불러오는 조각이라, 어느 공고 페이지인지 알려줘야 한다
      Referer: `${BASE}/zf_user/jobs/relay/view?rec_idx=${recIdx}`,
    },
    body: new URLSearchParams({ rec_idx: recIdx, rec_seq: '0', view_type: 'search' }).toString(),
  });
  if (res.status !== 200) return {};
  const d = parseSaraminDetail(res.text);
  return { sizeHints: d.sizeHints, applyUrl: applyUrl ?? d.homepageUrl };
}
