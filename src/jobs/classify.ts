// 기업 구분 판정: 회사 직접 지정 → 구분별 회사 목록 → 회사명 단어 → 사이트가 알려준 기업 규모
import type { Settings } from '../config';
import { sameCompany } from './dedup';

export type CompanyVerdict = { types: string[]; include: boolean; priority: boolean; reason: string };

/** 영문 약어(SK, LG, KT …)는 다른 단어 속 글자와 헷갈리지 않게 단어 경계로 찾는다 */
function nameHas(name: string, keyword: string): boolean {
  const k = keyword.trim();
  if (!k) return false;
  if (/^[A-Za-z0-9&]+$/.test(k)) return new RegExp(`(^|[^A-Za-z])${k.replace(/&/g, '\\&')}([^A-Za-z]|$)`).test(name);
  return name.replace(/\s+/g, '').includes(k.replace(/\s+/g, ''));
}

export function classifyCompany(settings: Settings, company: string, hints: string[] = []): CompanyVerdict {
  const o = settings.overrides;
  const priorityOverride = o.priority.some((c) => sameCompany(c, company));
  if (o.always_exclude.some((c) => sameCompany(c, company))) return { types: [], include: false, priority: false, reason: '항상 제외할 회사' };

  const types = new Set<string>();
  const why: string[] = [];
  for (const [type, t] of Object.entries(settings.company_types)) {
    if ((t.companies ?? []).some((c) => sameCompany(c, company))) {
      types.add(type);
      why.push(`${type} 목록`);
    } else {
      const kw = (t.name_keywords ?? []).find((k) => nameHas(company, k));
      if (kw) {
        types.add(type);
        why.push(`${type} (회사명에 "${kw}")`);
      }
    }
  }
  for (const h of hints) {
    if (settings.company_types[h] && !types.has(h)) {
      types.add(h);
      why.push(`${h} (사이트 정보)`);
    }
  }

  const list = [...types];
  const priority = priorityOverride || list.some((t) => settings.company_types[t]?.priority);
  if (o.always_include.some((c) => sameCompany(c, company))) return { types: list, include: true, priority, reason: '항상 포함할 회사' };
  if (!list.length) return { types: [], include: true, priority, reason: '기업 구분을 알 수 없어 포함' };
  const include = list.some((t) => settings.company_types[t]?.include);
  return { types: list, include, priority, reason: why.join(', ') };
}

/** 사이트별 기업 규모 표기 → 기업 구분 이름 */
export function sizeHintFromText(text: string): string[] {
  const out: string[] = [];
  if (/공기업|공공기관|공사|공단/.test(text)) out.push('공기업');
  if (/대기업/.test(text)) out.push('대기업');
  if (/중견/.test(text)) out.push('중견');
  if (/외국계/.test(text)) out.push('외국계');
  if (/스타트업/.test(text)) out.push('스타트업');
  if (/중소/.test(text)) out.push('중소');
  return out;
}
