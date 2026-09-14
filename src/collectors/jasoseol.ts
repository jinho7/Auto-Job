// 자소설닷컴: 채용 달력. 사이트가 브라우저가 아닌 요청을 막으므로(Cloudflare) 자동화 브라우저에서 페이지를 열고,
// 페이지가 스스로 부르는 것과 같은 요청(/employment/calendar_list.json, /api/v1/…)을 페이지 안에서 부른다.
// 차단 우회는 하지 않는다. 확인 화면(CAPTCHA 등)이 나오면 멈추고 사용자에게 맡긴다.
import type { Page } from 'playwright-core';
import { isAllowed, parseRobots } from '../http';
import { addDays, type Collector, type CollectorContext, type Experience, type RawPosting } from './types';

const BASE = 'https://jasoseol.com';

/** 자소설닷컴 채용형태 코드 (사이트 스크립트 기준) */
export const DIVISION: Record<number, { label: string; types: string[]; exp: Experience }> = {
  1: { label: '신입', types: ['신입'], exp: 'new' },
  2: { label: '경력', types: [], exp: 'experienced' },
  3: { label: '인턴', types: ['인턴'], exp: 'new' },
  4: { label: '계약직', types: ['계약직'], exp: 'any' },
  5: { label: '신입/경력', types: ['신입'], exp: 'any' },
  6: { label: '신입/인턴', types: ['신입', '인턴'], exp: 'new' },
  7: { label: '교육', types: ['교육'], exp: 'new' },
};

export const BUSINESS_SIZE: Record<string, string> = { big_business: '대기업', middle_market: '중견', public_institution: '공기업' };

export type DutyGroup = { id: number; name: string; category: string; group_id: number | null };
type CalendarEntry = {
  id: number;
  name: string;
  title: string;
  end_time: string | null;
  business_size: string | null;
  employments: { division: number; duty_groups: { group_id: number }[] }[];
};
type DetailResponse = {
  employment_page_url?: string | null;
  employments?: { field?: string; division?: number[]; duty_group_ids?: number[] }[];
};

/** 여러 채용형태를 합친다: 하나라도 신입/인턴 계열이면 경력 전용이 아니다 */
export function summarizeDivisions(divs: number[]): { types: string[]; experience: Experience } {
  const known = divs.map((d) => DIVISION[d]).filter(Boolean);
  const types = [...new Set(known.flatMap((d) => d.types))];
  const exps = new Set(known.map((d) => d.exp));
  const experience: Experience = !known.length ? 'unknown' : exps.has('new') ? 'new' : exps.has('any') ? 'any' : 'experienced';
  return { types, experience };
}

/** "2026-09-14T17:00:00.000+09:00" → 마감 (사이트 표기 그대로의 날짜와 시각) */
export function deadlineFromIso(iso: string | null): RawPosting['deadline'] {
  if (!iso) return null;
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!m) return null;
  return m[2] === '00:00' || m[2] === '23:59' ? { date: m[1] } : { date: m[1], time: m[2] };
}

/** 고른 직무 분류 이름 → 하위 분류까지 포함한 ID 들 */
export function expandDutyGroups(all: DutyGroup[], names: string[]): Set<number> {
  const picked = new Set(all.filter((g) => names.includes(g.name)).map((g) => g.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of all) if (g.group_id != null && picked.has(g.group_id) && !picked.has(g.id)) (picked.add(g.id), (grew = true));
  }
  return picked;
}

export function mapCalendar(entries: CalendarEntry[], duty: DutyGroup[], opts: { dutyNames: string[]; keywords: string[]; now: Date }): Omit<RawPosting, 'detail'>[] {
  const names = new Map(duty.map((g) => [g.id, g.name]));
  const selected = opts.dutyNames.length ? expandDutyGroups(duty, opts.dutyNames) : null;
  const kws = opts.keywords.map((k) => k.toLowerCase());
  const out: Omit<RawPosting, 'detail'>[] = [];
  for (const e of entries) {
    if (e.end_time && new Date(e.end_time) < opts.now) continue; // 이미 마감
    const groupIds = [...new Set(e.employments.flatMap((x) => (x.duty_groups ?? []).map((g) => g.group_id)))];
    const groupNames = groupIds.map((id) => names.get(id)).filter((n): n is string => !!n);
    if (selected) {
      if (!groupIds.some((id) => selected.has(id))) continue;
    } else if (kws.length) {
      const hay = `${e.title} ${groupNames.join(' ')}`.toLowerCase();
      if (!kws.some((k) => hay.includes(k))) continue;
    }
    const { types, experience } = summarizeDivisions(e.employments.map((x) => x.division));
    out.push({
      source: 'jasoseol',
      sourceId: String(e.id),
      sourceUrl: `${BASE}/recruit/${e.id}`,
      company: e.name,
      title: e.title,
      deadline: deadlineFromIso(e.end_time),
      experience,
      employmentTypes: types,
      roleNames: groupNames,
      sizeHints: e.business_size && BUSINESS_SIZE[e.business_size] ? [BUSINESS_SIZE[e.business_size]] : [],
    });
  }
  return out;
}

/** 페이지 안에서 JSON 요청 (페이지가 스스로 부르는 것과 같은 방식) */
async function pageJson<T>(page: Page, path: string, body?: unknown): Promise<T> {
  const r = await page.evaluate(
    async ({ path, body }) => {
      const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, text: await res.text() };
    },
    { path, body },
  );
  if (r.status !== 200) throw new Error(`자소설닷컴 ${path} 요청 실패 (${r.status})`);
  return JSON.parse(r.text) as T;
}

/** 자소설닷컴 직무 분류 목록 (설정 화면용) */
export async function loadDutyGroups(page: Page): Promise<DutyGroup[]> {
  await openRecruit(page);
  return pageJson<DutyGroup[]>(page, '/api/v1/duty-groups');
}

async function openRecruit(page: Page): Promise<void> {
  if (!page.url().startsWith(BASE)) await page.goto(`${BASE}/recruit`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const title = await page.title();
  if (/Attention Required|Just a moment|확인/.test(title)) {
    throw new Error('자소설닷컴이 사람 확인 화면을 띄웠습니다. 자동화 브라우저에서 직접 확인을 마친 뒤 다시 실행해 주세요.');
  }
}

export const jasoseol: Collector = {
  id: 'jasoseol',
  label: '자소설닷컴',
  method: 'browser',
  status: 'ok',
  note: '채용 달력 (대기업 공채 위주). 자동화 브라우저로 페이지를 열어 가져옵니다',
  async collect(ctx: CollectorContext): Promise<RawPosting[]> {
    const page = await ctx.browserPage();
    await openRecruit(page);
    const robots = parseRobots(await page.evaluate(() => fetch('/robots.txt').then((r) => r.text())));
    for (const p of ['/employment/calendar_list.json', '/api/v1/duty-groups', '/api/v1/employment_companies/1']) {
      if (!isAllowed(robots, p)) throw new Error(`자소설닷컴 robots.txt 가 ${p} 를 막고 있어 수집하지 않습니다`);
    }
    const { settings, now } = ctx;
    const duty = await pageJson<DutyGroup[]>(page, '/api/v1/duty-groups');
    const cal = await pageJson<{ employment: CalendarEntry[] }>(page, '/employment/calendar_list.json', {
      start_time: now.toISOString(),
      end_time: addDays(now, settings.collect.lookahead_days).toISOString(),
    });
    const items = mapCalendar(cal.employment ?? [], duty, {
      dutyNames: settings.collect.jasoseol.duty_groups,
      keywords: settings.collect.keywords,
      now,
    });
    ctx.log(`  자소설닷컴: 달력 ${cal.employment?.length ?? 0}건 중 직무 조건에 맞는 ${items.length}건`);
    const dutyNames = new Map(duty.map((g) => [g.id, g.name]));
    return items.map((it) => ({
      ...it,
      detail: async () => {
        await new Promise((r) => setTimeout(r, settings.collect.request_delay_ms));
        await openRecruit(page);
        const d = await pageJson<DetailResponse>(page, `/api/v1/employment_companies/${it.sourceId}?skip_read_log=true`);
        const emps = d.employments ?? [];
        const { types, experience } = summarizeDivisions(emps.flatMap((e) => e.division ?? []));
        const fields = emps.map((e) => e.field).filter((f): f is string => !!f);
        const groupNames = emps.flatMap((e) => e.duty_group_ids ?? []).map((id) => dutyNames.get(id)).filter((n): n is string => !!n);
        return {
          applyUrl: d.employment_page_url || undefined,
          roleNames: [...new Set([...fields, ...groupNames, ...it.roleNames])],
          ...(types.length ? { employmentTypes: types, experience } : {}),
        };
      },
    }));
  },
};
