// 설정의 Notion 필드 매핑이 실제 DB 와 맞는지 검사하고, 맞지 않으면 후보를 제안한다.
import type { Settings } from '../config';
import type { DataSource, NotionProperty } from './client';

/** 설정 키 → 허용되는 Notion 속성 타입 */
export const FIELD_SPEC: Record<string, { label: string; types: string[]; required: boolean }> = {
  company: { label: '회사명', types: ['title'], required: true },
  roles: { label: '직무', types: ['multi_select'], required: true },
  employment: { label: '채용 분류', types: ['multi_select', 'select'], required: true },
  deadline: { label: '지원 마감 시간', types: ['date'], required: true },
  status: { label: '제출 상태', types: ['select', 'status'], required: true },
  result: { label: '합불 여부', types: ['multi_select', 'select', 'status'], required: true },
  note: { label: '참고 키워드', types: ['rich_text'], required: false },
  link: { label: '지원 링크', types: ['url'], required: true },
  result_date: { label: '서류 합격 발표 일자', types: ['date'], required: false },
  files: { label: '제출 자료', types: ['files'], required: false },
};

export type FieldCheck = {
  key: string;
  label: string;
  configured: string;
  ok: boolean;
  problem?: string;
  suggestion?: string;
};

export type MappingReport = {
  fields: FieldCheck[];
  optionProblems: string[];
  ok: boolean;
};

export const optionsOf = (p?: NotionProperty): string[] =>
  (p?.select?.options ?? p?.multi_select?.options ?? p?.status?.options ?? []).map((o) => o.name);

function suggest(key: string, props: NotionProperty[]): string | undefined {
  const spec = FIELD_SPEC[key];
  const typed = props.filter((p) => spec.types.includes(p.type));
  return typed.find((p) => p.name === spec.label)?.name ?? typed.find((p) => p.name.includes(spec.label) || spec.label.includes(p.name))?.name ?? (typed.length === 1 ? typed[0].name : undefined);
}

export function checkMapping(notion: Settings['notion'], ds: DataSource): MappingReport {
  const props = Object.values(ds.properties);
  const byName = new Map(props.map((p) => [p.name, p]));
  const fields: FieldCheck[] = Object.entries(FIELD_SPEC).map(([key, spec]) => {
    const configured = notion.fields[key] ?? '';
    const prop = byName.get(configured);
    let problem: string | undefined;
    if (!configured) problem = '설정되지 않음';
    else if (!prop) problem = `DB에 "${configured}" 속성이 없음`;
    else if (!spec.types.includes(prop.type)) problem = `타입이 ${prop.type} (필요: ${spec.types.join(' 또는 ')})`;
    const ok = !problem || (!spec.required && !configured);
    return { key, label: spec.label, configured, ok, problem, suggestion: problem ? suggest(key, props) : undefined };
  });

  const optionProblems: string[] = [];
  const need = (fieldKey: string, values: string[], what: string) => {
    const prop = byName.get(notion.fields[fieldKey] ?? '');
    if (!prop) return;
    const have = optionsOf(prop);
    for (const v of values) if (v && !have.includes(v)) optionProblems.push(`${prop.name}: "${v}" 옵션이 없음 (${what})`);
  };
  need('employment', Object.values(notion.employment_options), '채용 분류 옵션 매핑');
  need('status', Object.values(notion.status_options), '제출 상태 값');
  need('result', [notion.result_default], '합불 여부 기본값');

  return { fields, optionProblems, ok: fields.every((f) => f.ok) && optionProblems.length === 0 };
}

/** 제안된 속성 이름을 설정에 반영할 목록 */
export function suggestedFixes(report: MappingReport): Record<string, string> {
  return Object.fromEntries(report.fields.filter((f) => !f.ok && f.suggestion).map((f) => [f.key, f.suggestion!]));
}
