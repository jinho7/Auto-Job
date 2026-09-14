// 원티드: 채용 목록 페이지가 부르는 목록(/api/chaos/navigation/v1/results)과 공고 상세(/api/chaos/jobs/v5/…/details).
// 원티드는 브라우저가 아닌 요청을 막으므로 자동화 브라우저에서 페이지를 열고 페이지 안에서 부른다.
// robots.txt 를 읽을 수 없으면(지금은 사이트가 robots.txt 요청 자체를 403 으로 막고 있음) 수집하지 않는다.
import type { Page } from 'playwright-core';
import { isAllowed, parseRobots } from '../http';
import type { Experience, Collector, CollectorContext, RawPosting } from './types';

const BASE = 'https://www.wanted.co.kr';
const PAGE_SIZE = 20; // 원티드 목록 페이지가 쓰는 크기

export type WantedListItem = {
  id: number;
  position: string;
  company: { name: string };
  address?: { location?: string; district?: string };
  is_newbie?: boolean;
  annual_from?: number | null;
  annual_to?: number | null;
  employment_type?: string | null;
  is_outlink?: boolean;
};

export type WantedDetail = {
  job: {
    id: number;
    status?: string;
    due_time: string | null;
    out_link?: string | null;
    employment_type?: string | null;
    category_tag?: { parent_tag?: { text: string }; child_tags?: { text: string }[] };
  };
};

const EMPLOYMENT: Record<string, string> = { regular: '정규직', contract: '계약직', intern: '인턴' };

export function wantedExperience(x: Pick<WantedListItem, 'is_newbie' | 'annual_from' | 'annual_to'>): Experience {
  if (x.is_newbie || x.annual_from === 0) return (x.annual_to ?? 0) > 1 ? 'any' : 'new';
  return x.annual_from == null ? 'unknown' : 'experienced';
}

export function mapWantedItem(x: WantedListItem): Omit<RawPosting, 'detail'> {
  return {
    source: 'wanted',
    sourceId: String(x.id),
    sourceUrl: `${BASE}/wd/${x.id}`,
    company: x.company.name,
    title: x.position,
    deadline: null, // 목록에는 마감일이 없다 → 상세에서
    experience: wantedExperience(x),
    employmentTypes: x.employment_type && EMPLOYMENT[x.employment_type] ? [EMPLOYMENT[x.employment_type]] : [],
    roleNames: [],
    sizeHints: [],
    // 바깥 지원 링크가 없는 공고는 원티드에서 바로 지원한다
    applyUrl: x.is_outlink ? undefined : `${BASE}/wd/${x.id}`,
    location: [x.address?.location, x.address?.district].filter(Boolean).join(' ') || undefined,
  };
}

export function mapWantedDetail(d: WantedDetail): Partial<RawPosting> {
  const j = d.job;
  const due = j.due_time?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  const tags = j.category_tag;
  return {
    deadline: due ? { date: due } : null,
    ...(j.out_link && /^https?:\/\//.test(j.out_link) ? { applyUrl: j.out_link } : {}),
    roleNames: (tags?.child_tags ?? []).map((t) => t.text),
    ...(j.employment_type && EMPLOYMENT[j.employment_type] ? { employmentTypes: [EMPLOYMENT[j.employment_type]] } : {}),
  };
}

async function pageJson<T>(page: Page, path: string): Promise<T> {
  const r = await page.evaluate(async (p) => {
    const res = await fetch(p, { headers: { Accept: 'application/json' } });
    return { status: res.status, text: await res.text() };
  }, path);
  if (r.status !== 200) throw new Error(`원티드 ${path.split('?')[0]} 요청 실패 (${r.status})`);
  return JSON.parse(r.text) as T;
}

export const wanted: Collector = {
  id: 'wanted',
  label: '원티드',
  method: 'browser',
  status: 'ok',
  note: 'robots.txt 를 읽을 수 있을 때만 수집합니다 (지금은 원티드가 robots.txt 요청을 막고 있어 건너뛸 수 있음)',
  async collect(ctx: CollectorContext): Promise<RawPosting[]> {
    const { settings, log } = ctx;
    const page = await ctx.browserPage();
    if (!page.url().startsWith(BASE)) await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const robots = await page.evaluate(() => fetch('/robots.txt').then(async (r) => ({ status: r.status, text: await r.text() })));
    if (robots.status !== 200) throw new Error(`원티드 robots.txt 를 확인할 수 없어(${robots.status}) 수집하지 않습니다`);
    const rules = parseRobots(robots.text);
    for (const p of ['/api/chaos/navigation/v1/results', '/api/chaos/jobs/v5/1/details']) {
      if (!isAllowed(rules, p)) throw new Error(`원티드 robots.txt 가 ${p} 를 막고 있어 수집하지 않습니다`);
    }

    const groups: (number | null)[] = settings.collect.wanted.job_group_ids.length ? settings.collect.wanted.job_group_ids : [null];
    const kws = settings.collect.keywords.map((k) => k.toLowerCase());
    const limit = settings.collect.max_per_keyword * Math.max(1, kws.length);
    const out = new Map<string, RawPosting>();
    for (const g of groups) {
      let seen = 0;
      for (let offset = 0; seen < limit; offset += PAGE_SIZE) {
        const q = new URLSearchParams({ country: 'kr', job_sort: 'job.latest_order', locations: 'all', limit: String(PAGE_SIZE), offset: String(offset) });
        if (g != null) q.set('job_group_id', String(g));
        if (settings.collect.exclude_experienced) q.set('years', '0');
        await new Promise((r) => setTimeout(r, settings.collect.request_delay_ms));
        const res = await pageJson<{ data: WantedListItem[] }>(page, `/api/chaos/navigation/v1/results?${q}`);
        for (const it of res.data ?? []) {
          if (kws.length && !kws.some((k) => it.position.toLowerCase().includes(k))) continue;
          const r = mapWantedItem(it);
          if (out.has(r.sourceId)) continue;
          out.set(r.sourceId, {
            ...r,
            detail: async () => {
              await new Promise((ok) => setTimeout(ok, settings.collect.request_delay_ms));
              return mapWantedDetail((await pageJson<{ data: WantedDetail }>(page, `/api/chaos/jobs/v5/${r.sourceId}/details`)).data);
            },
          });
        }
        seen += res.data?.length ?? 0;
        if ((res.data?.length ?? 0) < PAGE_SIZE) break;
      }
      log(`  원티드${g != null ? ` 직군 ${g}` : ''}: ${seen}건 중 키워드에 맞는 공고 ${out.size}건`);
    }
    return [...out.values()];
  },
};
