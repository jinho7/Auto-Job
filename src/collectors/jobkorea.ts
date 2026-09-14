// 잡코리아: 채용정보 목록(/recruit/joblist 가 부르는 /Recruit/Home/_GI_List)과 공고 상세(/Recruit/GI_Read/…).
// 둘 다 robots.txt 허용 경로. 사이트 검색(/Search?stext=)은 robots.txt 가 막고 있어 쓰지 않고,
// 목록 페이지의 "포함 키워드"와 직무 대분류 조건으로 거른다.
import { parse, type HTMLElement } from 'node-html-parser';
import type { PoliteHttp } from '../http';
import { sizeHintFromText } from '../jobs/classify';
import { normalizeEmployment, parseExperience, parseSaraminDeadline } from './saramin';
import type { Collector, CollectorContext, RawPosting } from './types';

const BASE = 'https://www.jobkorea.co.kr';
const LIST_PAGE = `${BASE}/recruit/joblist?menucode=duty`;
const PAGE_SIZE = 40;
const text = (el: HTMLElement | null | undefined) => (el?.text ?? '').replace(/\s+/g, ' ').trim();

export type DutyCategory = { code: string; name: string };

/** 목록 페이지의 직무 대분류 (설정 화면용) */
export function parseDutyCategories(html: string): DutyCategory[] {
  const root = parse(html);
  const out: DutyCategory[] = [];
  for (const input of root.querySelectorAll('input[name="duty"]')) {
    if (!/^duty_step1_/.test(input.id)) continue;
    const label = root.querySelector(`label[for="${input.id}"]`);
    const name = text(label?.querySelector('span span') ?? label);
    const code = input.getAttribute('value') ?? '';
    if (code && name && !out.some((d) => d.code === code)) out.push({ code, name });
  }
  return out;
}

export async function loadDutyCategories(http: PoliteHttp): Promise<DutyCategory[]> {
  const res = await http.request(LIST_PAGE);
  if (res.status !== 200) throw new Error(`잡코리아 채용정보 페이지를 열지 못했습니다 (${res.status})`);
  return parseDutyCategories(res.text);
}

/** 목록 조각 HTML → 공고 */
export function parseJobkoreaList(html: string, now: Date): Omit<RawPosting, 'detail'>[] {
  const root = parse(html);
  return root.querySelectorAll('tr.devloopArea').map((row) => {
    const gno = row.getAttribute('data-gno') ?? '';
    const a = row.querySelector('td.tplTit strong a') ?? row.querySelector('td.tplTit a');
    const cells = row.querySelectorAll('td.tplTit p.etc span.cell').map((c) => text(c).replace(/\s*외$/, ''));
    const expText = cells.find((c) => /신입|경력/.test(c)) ?? '';
    const empText = cells.find((c) => normalizeEmployment(c).length) ?? '';
    const odd = row.querySelector('td.odd');
    const deadline = parseSaraminDeadline(text(odd?.querySelector('.date')), now);
    const onSite = /즉시지원/.test(text(odd?.querySelector('button')));
    const readUrl = `${BASE}/Recruit/GI_Read/${gno}`;
    return {
      source: 'jobkorea',
      sourceId: gno,
      sourceUrl: readUrl,
      company: text(row.querySelector('td.tplCo a')),
      title: a?.getAttribute('title') ?? text(a),
      deadline: deadline === 'unknown' ? null : deadline,
      experience: parseExperience(expText),
      employmentTypes: normalizeEmployment(empText),
      roleNames: text(row.querySelector('p.dsc'))
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      sizeHints: [],
      // 잡코리아에서 바로 지원하는 공고는 잡코리아 공고 페이지가 곧 지원 페이지
      applyUrl: onSite ? readUrl : undefined,
      location: cells.find((c) => /[시군구]$|서울|경기|인천|부산|대구|광주|대전|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주/.test(c) && !/신입|경력|학력|졸/.test(c)),
    };
  });
}

function unescapeJson(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
}

/** 공고 상세 HTML → 홈페이지 지원 링크, 기업 구분 */
export function parseJobkoreaDetail(html: string): { homepageUrl?: string; companyTypeText?: string; sizeHints: string[] } {
  // 상세 데이터는 페이지 안의 문자열(JSON 을 한 번 더 감싼 형태)로 들어 있다
  const s = html.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
  const hp = s.match(/"type":"HOMEPAGE","contents":\["([^"]+)"/);
  const homepageUrl = hp ? unescapeJson(hp[1]) : undefined;
  const companyTypeText = s.match(/"companyTypeName":"([^"]+)"/)?.[1] ?? s.match(/"description":"([^"]+)","icon":"[^"]*","title":"기업구분"/)?.[1];
  return {
    homepageUrl: homepageUrl && /^https?:\/\//.test(homepageUrl) ? homepageUrl : undefined,
    companyTypeText,
    sizeHints: companyTypeText ? sizeHintFromText(companyTypeText) : [],
  };
}

async function listPage(http: PoliteHttp, condition: Record<string, string>, page: number): Promise<string> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(condition)) body.set(`condition[${k}]`, v);
  for (const [k, v] of Object.entries({ page: String(page), order: '2', pagesize: String(PAGE_SIZE), tabindex: '0', direct: '0', onePick: '0', confirm: '0', profile: '0' })) body.set(k, v);
  const res = await http.request(`${BASE}/Recruit/Home/_GI_List/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', Referer: LIST_PAGE },
    body: body.toString(),
  });
  if (res.status !== 200) throw new Error(`잡코리아 목록 요청 실패 (${res.status})`);
  return res.text;
}

export const jobkorea: Collector = {
  id: 'jobkorea',
  label: '잡코리아',
  method: 'http',
  status: 'ok',
  note: '채용정보 목록과 상세 (robots.txt 허용 범위). 사이트 검색 페이지는 쓰지 않습니다',
  async collect(ctx: CollectorContext): Promise<RawPosting[]> {
    const { settings, http, now, log } = ctx;
    const wanted = settings.collect.jobkorea.duty_categories;
    let categories: (DutyCategory | null)[] = [null];
    if (wanted.length) {
      const all = await loadDutyCategories(http);
      const picked = all.filter((d) => wanted.includes(d.name));
      const missing = wanted.filter((n) => !all.some((d) => d.name === n));
      if (missing.length) log(`  ⚠️  잡코리아에 없는 직무 분류: ${missing.join(', ')}`);
      if (!picked.length) throw new Error('설정한 잡코리아 직무 분류를 사이트에서 찾지 못했습니다');
      categories = picked;
    }
    const keywords: (string | null)[] = settings.collect.keywords.length ? settings.collect.keywords : [null];
    if (!wanted.length && !settings.collect.keywords.length) throw new Error('검색 키워드나 잡코리아 직무 분류가 필요합니다');

    const out = new Map<string, RawPosting>();
    for (const cat of categories) {
      for (const kw of keywords) {
        const condition: Record<string, string> = {};
        if (cat) condition.dutyCtgr = cat.code;
        if (kw) condition.textinclude = kw;
        if (settings.collect.exclude_experienced) condition.career = '1'; // 신입 ([신입·경력] 포함)
        let got = 0;
        for (let page = 1; got < settings.collect.max_per_keyword; page++) {
          const items = parseJobkoreaList(await listPage(http, condition, page), now);
          for (const it of items) {
            if (!it.sourceId || out.has(it.sourceId)) continue;
            out.set(it.sourceId, { ...it, detail: () => jobkoreaDetail(http, it.sourceUrl) });
          }
          got += items.length;
          if (items.length < PAGE_SIZE) break;
        }
        log(`  잡코리아 ${[cat?.name, kw && `"${kw}"`].filter(Boolean).join(' ')}: ${got}건`);
      }
    }
    return [...out.values()];
  },
};

async function jobkoreaDetail(http: PoliteHttp, url: string): Promise<Partial<RawPosting>> {
  const res = await http.request(url);
  if (res.status !== 200) return {};
  const d = parseJobkoreaDetail(res.text);
  return { sizeHints: d.sizeHints, ...(d.homepageUrl ? { applyUrl: d.homepageUrl } : {}) };
}
