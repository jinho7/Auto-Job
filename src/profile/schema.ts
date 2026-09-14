// profile/schema.yaml 로더와 값 검증. 편집기, 검사, 빈 틀 생성이 모두 여기를 거친다.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export type ScalarType = 'text' | 'longtext' | 'number' | 'date' | 'month' | 'select' | 'file';
type Base = { label: string; required?: boolean; hint?: string; example?: string };
export type ScalarField = Base & { type: ScalarType; options?: string[]; allow_other?: boolean; pattern?: string };
export type TagsField = Base & { type: 'tags' };
export type GroupField = Base & { type: 'group'; fields: Fields };
export type ListField = Base & { type: 'list'; item: Fields; min_items?: number };
export type Field = ScalarField | TagsField | GroupField | ListField;
export type Fields = Record<string, Field>;
export type Section = { label: string; fields: Fields };
export type ProfileSchema = { sections: Record<string, Section> };

const SCALAR_TYPES = new Set(['text', 'longtext', 'number', 'date', 'month', 'select', 'file']);

function normalizeFields(raw: unknown, where: string): Fields {
  if (!raw || typeof raw !== 'object') throw new Error(`${where}: fields/item 이 비어 있습니다`);
  const out: Fields = {};
  for (const [key, def] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    const at = `${where}.${key}`;
    if (!def || typeof def.label !== 'string') throw new Error(`${at}: label 이 필요합니다`);
    const type = (def.type as string | undefined) ?? 'text';
    const base = { label: def.label, required: def.required === true, hint: def.hint as string | undefined, example: def.example as string | undefined };
    if (type === 'group') out[key] = { ...base, type, fields: normalizeFields(def.fields, at) };
    else if (type === 'list') out[key] = { ...base, type, item: normalizeFields(def.item, at), min_items: def.min_items as number | undefined };
    else if (type === 'tags') out[key] = { ...base, type };
    else if (SCALAR_TYPES.has(type)) {
      if (type === 'select' && !Array.isArray(def.options)) throw new Error(`${at}: select 는 options 가 필요합니다`);
      out[key] = {
        ...base,
        type: type as ScalarType,
        options: (def.options as unknown[] | undefined)?.map(String),
        allow_other: def.allow_other === true,
        pattern: def.pattern as string | undefined,
      };
    } else throw new Error(`${at}: 알 수 없는 type "${type}"`);
  }
  return out;
}

export function parseSchema(text: string): ProfileSchema {
  const raw = YAML.parse(text) as { sections?: Record<string, { label?: string; fields?: unknown }> };
  if (!raw?.sections) throw new Error('schema: sections 가 없습니다');
  const sections: Record<string, Section> = {};
  for (const [name, s] of Object.entries(raw.sections)) {
    if (typeof s.label !== 'string') throw new Error(`${name}: label 이 필요합니다`);
    sections[name] = { label: s.label, fields: normalizeFields(s.fields, name) };
  }
  return { sections };
}

export function loadSchema(file: string): ProfileSchema {
  return parseSchema(readFileSync(file, 'utf8'));
}

export type Segment = string | number;

/** "education.universities.0.major" → ['education', 'universities', 0, 'major'] */
export function splitPath(p: string): Segment[] {
  return p.split('.').filter(Boolean).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

/** 경로가 가리키는 항목 정의. 목록 인덱스는 건너뛴다. 섹션 자체면 group 처럼 돌려준다. */
export function resolveField(schema: ProfileSchema, segs: Segment[]): Field | undefined {
  const [section, ...rest] = segs;
  const sec = schema.sections[String(section)];
  if (!sec) return undefined;
  let cur: Field = { label: sec.label, type: 'group', fields: sec.fields };
  for (let i = 0; i < rest.length; i++) {
    const seg = rest[i];
    if (cur.type === 'list') {
      if (typeof seg !== 'number') return undefined;
      cur = { label: `${cur.label} #${seg + 1}`, type: 'group', fields: cur.item };
      continue;
    }
    if (cur.type !== 'group' || typeof seg !== 'string') return undefined;
    const next: Field | undefined = cur.fields[seg];
    if (!next) return undefined;
    cur = next;
  }
  return cur;
}

export function emptyValue(field: Field): unknown {
  switch (field.type) {
    case 'group':
      return emptyFields(field.fields);
    case 'list':
    case 'tags':
      return [];
    default:
      return '';
  }
}

export function emptyFields(fields: Fields): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, emptyValue(f)]));
}

const FORMAT_HINT: Partial<Record<ScalarType, string>> = {
  date: 'YYYY.MM.DD',
  month: 'YYYY.MM',
  number: '숫자',
  file: 'profile/me/files/ 안의 파일 이름',
  longtext: '여러 줄',
};

/** "생년월일 (필수) — YYYY.MM.DD" 같은 한 줄 설명 */
export function describe(field: Field): string {
  const parts: string[] = [];
  if (field.type !== 'group' && field.type !== 'list' && field.type !== 'tags') {
    const fmt = FORMAT_HINT[field.type];
    if (fmt) parts.push(fmt);
    if (field.type === 'select' && field.options) parts.push(`선택: ${field.options.join(' / ')}${field.allow_other ? ' / 직접 입력' : ''}`);
  }
  if (field.type === 'tags') parts.push('쉼표로 구분');
  if (field.hint) parts.push(field.hint);
  if (field.example) parts.push(`예: ${field.example}`);
  const req = field.required || (field.type === 'list' && field.min_items) ? ' (필수)' : '';
  return `${field.label}${req}${parts.length ? ` — ${parts.join(', ')}` : ''}`;
}

const DATE_RE = /^\d{4}\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}\.(0[1-9]|1[0-2])$/;

/** 비어 있지 않은 값의 형식을 검사한다. 문제가 없으면 null */
export function validateScalar(field: ScalarField, value: string, filesDir?: string): string | null {
  switch (field.type) {
    case 'date':
      if (!DATE_RE.test(value)) return '날짜는 YYYY.MM.DD 형식입니다 (예: 2019.03.02)';
      break;
    case 'month':
      if (!MONTH_RE.test(value)) return '연월은 YYYY.MM 형식입니다 (예: 2019.03)';
      break;
    case 'number':
      if (!/^\d+(\.\d+)?$/.test(value)) return '숫자만 입력합니다 (예: 3.85)';
      break;
    case 'select':
      if (!field.allow_other && !field.options?.includes(value)) return `다음 중 하나여야 합니다: ${field.options?.join(', ')}`;
      break;
    case 'file':
      if (filesDir && !existsSync(path.join(filesDir, value))) return `${filesDir}/${value} 파일이 없습니다`;
      break;
  }
  if (field.pattern && !new RegExp(field.pattern).test(value)) {
    return `형식이 맞지 않습니다${field.example ? ` (예: ${field.example})` : ''}`;
  }
  return null;
}

export const isEmptyValue = (v: unknown) =>
  v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
