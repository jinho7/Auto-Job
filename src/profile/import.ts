// 붙여넣어 채우기: 사용자가 붙여넣은 글을 AI 가 내 정보 항목에 맞게 나누고,
// 코드가 형식을 맞추고 검사한 뒤 미리보기를 보여 준다. 적용은 사용자가 고른 섹션만, 빈 값으로 기존 값을 지우지 않는다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../config';
import { agentFor, modelFor, type RunAgent } from '../llm';
import { extractJson } from '../llm/claude-cli';
import { paths } from '../paths';
import { describe, isEmptyValue, validateScalar, type Field, type Fields, type ProfileSchema, type ScalarField, type Segment } from './schema';
import type { ProfileStore } from './store';

export type ImportData = Record<string, unknown>;
export type ImportChange = {
  section: string;
  path: string;
  where: string;
  before: string;
  after: string;
  kind: 'new' | 'changed' | 'same';
  /** 형식 문제로 넣지 않을 값 */
  error?: string;
};
export type ImportPreview = { data: ImportData; rules: string[]; changes: ImportChange[]; unknown: string[]; costUsd?: number };

// ─── AI 에게 줄 항목 틀 ───
function template(fields: Fields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(fields)) {
    if (f.type === 'group') out[k] = template(f.fields);
    else if (f.type === 'list') out[k] = [template(f.item)];
    else out[k] = describe(f) + (f.type === 'tags' ? ' [문자열 배열]' : '');
  }
  return out;
}

export function schemaTemplate(schema: ProfileSchema): string {
  return JSON.stringify(Object.fromEntries(Object.entries(schema.sections).map(([k, s]) => [k, template(s.fields)])), null, 1);
}

// ─── 형식 맞추기 ───
const pad = (n: string) => n.padStart(2, '0');

/** 사람이 흔히 쓰는 표기를 항목 형식으로: "2022.3" → "2022.03", "2028.07.27." → "2028.07.27", "01012345678" → "010-1234-5678" */
export function normalizeValue(f: ScalarField, raw: unknown): string {
  let v = String(raw ?? '').trim();
  if (f.type === 'longtext') return String(raw ?? '').replace(/\s+$/, '');
  if (f.type === 'date' || f.type === 'month') {
    const m = v.replace(/\s/g, '').match(/^(\d{4})[.\-/년](\d{1,2})(?:[.\-/월](\d{1,2}))?[.일]?$/);
    if (m) v = `${m[1]}.${pad(m[2])}${m[3] ? `.${pad(m[3])}` : ''}`;
  } else if (f.type === 'number') {
    const m = v.replace(/,/g, '').match(/\d+(\.\d+)?/);
    if (m) v = m[0];
  } else if (f.type === 'select' && f.options && !f.options.includes(v)) {
    const key = (x: string) => x.replace(/\s+/g, '').toLowerCase();
    v = f.options.find((o) => key(o) === key(v)) ?? v;
  }
  if (f.pattern?.includes('\\d{3,4}-\\d{4}')) {
    const d = v.replace(/\D/g, '');
    if (/^0\d{9,10}$/.test(d)) v = d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : d.startsWith('02') ? `02-${d.slice(2, 6)}-${d.slice(6)}` : `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return v;
}

/** AI 결과를 항목 정의에 맞게 정리: 없는 키는 모으고, 값은 형식을 맞춘다 */
export function cleanImport(schema: ProfileSchema, raw: unknown): { data: ImportData; unknown: string[] } {
  const unknown: string[] = [];
  const walk = (fields: Fields, value: unknown, p: string): Record<string, unknown> => {
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const f = fields[k];
      if (!f) {
        if (!isEmptyValue(v)) unknown.push(`${p}.${k}`);
        continue;
      }
      if (f.type === 'group') out[k] = walk(f.fields, v, `${p}.${k}`);
      else if (f.type === 'list') {
        const arr = (Array.isArray(v) ? v : []).map((item, i) => walk(f.item, item, `${p}.${k}.${i}`)).filter((item) => Object.values(item).some((x) => !isEmptyValue(x)));
        if (arr.length) out[k] = arr;
      } else if (f.type === 'tags') {
        const arr = (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);
        if (arr.length) out[k] = arr;
      } else {
        const s = normalizeValue(f, v);
        if (s) out[k] = s;
      }
    }
    return out;
  };
  const data: ImportData = {};
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  for (const [name, sec] of Object.entries(schema.sections)) {
    if (obj[name] === undefined) continue;
    const d = walk(sec.fields, obj[name], name);
    if (Object.keys(d).length) data[name] = d;
  }
  for (const k of Object.keys(obj)) if (!schema.sections[k]) unknown.push(k);
  return { data, unknown };
}

// ─── 미리보기 ───
const show = (v: unknown) => (isEmptyValue(v) ? '' : Array.isArray(v) ? v.join(', ') : String(v).replace(/\n/g, ' / '));

function itemTitle(item: Record<string, unknown>, fields: Fields): string {
  return (
    Object.entries(fields)
      .filter(([k, f]) => f.type !== 'longtext' && !isEmptyValue(item[k]))
      .slice(0, 2)
      .map(([k]) => show(item[k]))
      .join(' / ') || '(항목)'
  );
}

export function previewChanges(schema: ProfileSchema, data: ImportData, current: Record<string, unknown>, filesDir?: string): ImportChange[] {
  const changes: ImportChange[] = [];
  const walk = (section: string, fields: Fields, value: Record<string, unknown>, cur: Record<string, unknown>, p: string, where: string) => {
    for (const [k, v] of Object.entries(value)) {
      const f = fields[k];
      const fp = `${p}.${k}`;
      const fw = where ? `${where} > ${f.label}` : f.label;
      const before = cur?.[k];
      if (f.type === 'group') walk(section, f.fields, v as Record<string, unknown>, (before ?? {}) as Record<string, unknown>, fp, fw);
      else if (f.type === 'list') {
        const items = v as Record<string, unknown>[];
        const old = Array.isArray(before) ? before : [];
        const errors: string[] = [];
        items.forEach((item, i) => {
          for (const [ik, iv] of Object.entries(item)) {
            const sf = f.item[ik];
            if (sf && sf.type !== 'group' && sf.type !== 'list' && sf.type !== 'tags') {
              const err = validateScalar(sf, String(iv), filesDir);
              if (err) errors.push(`#${i + 1} ${sf.label} "${iv}": ${err}`);
            }
          }
        });
        const after = `${items.length}개 — ${items.map((it) => itemTitle(it, f.item)).join(' · ')}`;
        const compact = (xs: unknown[]) => JSON.stringify(xs.map((it) => Object.fromEntries(Object.entries((it ?? {}) as Record<string, unknown>).filter(([, x]) => !isEmptyValue(x)).sort())));
        const same = compact(old) === compact(items);
        changes.push({ section, path: fp, where: fw, before: old.length ? `${old.length}개 — ${old.map((it) => itemTitle(it as Record<string, unknown>, f.item)).join(' · ')}` : '', after, kind: same ? 'same' : old.length ? 'changed' : 'new', ...(errors.length ? { error: `넣지 않을 값: ${errors.join('; ')}` } : {}) });
      } else {
        const after = show(v);
        const err = f.type === 'tags' ? null : validateScalar(f as ScalarField, String(v), filesDir);
        const b = show(before);
        changes.push({ section, path: fp, where: fw, before: b, after, kind: b === after ? 'same' : b ? 'changed' : 'new', ...(err ? { error: err } : {}) });
      }
    }
  };
  for (const [name, value] of Object.entries(data)) {
    const sec = schema.sections[name];
    if (sec) walk(name, sec.fields, value as Record<string, unknown>, (current[name] ?? {}) as Record<string, unknown>, name, sec.label);
  }
  return changes;
}

// ─── AI 호출 ───
export async function importProfileText(
  text: string,
  o: { settings: Settings; store: ProfileStore; cwd: string; runAgent?: RunAgent },
): Promise<ImportPreview> {
  if (!text.trim()) throw new Error('붙여넣은 글이 없습니다');
  const run = o.runAgent ?? agentFor(o.settings);
  const system = readFileSync(path.join(paths.prompts, 'profile-import.md'), 'utf8');
  const defaultRules = readFileSync(path.join(paths.prompts, 'fill-basic-info.md'), 'utf8');
  const r = await run({
    prompt: [
      '## 항목 틀 (이 모양대로 JSON 을 만듭니다)',
      schemaTemplate(o.store.schema),
      '',
      '## 이미 있는 규칙 (뜻이 같은 규칙은 rules 에 넣지 않습니다)',
      defaultRules,
      ...o.settings.apply.extra_rules.map((x) => `- ${x}`),
      '',
      '## 붙여넣은 글',
      text,
    ].join('\n'),
    systemAppend: system,
    tools: [],
    model: modelFor(o.settings),
    cwd: o.cwd,
  });
  if (r.isError) throw new Error(r.text);
  const out = extractJson<{ profile?: unknown; rules?: unknown }>(r.text);
  const { data, unknown } = cleanImport(o.store.schema, out.profile);
  const rules = (Array.isArray(out.rules) ? out.rules : []).map((x) => String(x).trim()).filter((x) => x && !o.settings.apply.extra_rules.includes(x));
  return { data, rules, unknown, changes: previewChanges(o.store.schema, data, o.store.toJSON(), o.store.filesDir), costUsd: r.costUsd };
}

// ─── 적용 ───
/** 고른 섹션만 넣는다. 빈 값은 넣지 않고(기존 값 유지), 목록은 붙여넣은 목록으로 바꾼다. 형식이 틀린 값은 건너뛰고 알려 준다. */
export function applyImport(store: ProfileStore, data: ImportData, sections: string[]): { written: number; skipped: string[] } {
  let written = 0;
  const skipped: string[] = [];
  const setOne = (segs: Segment[], f: Field, v: unknown) => {
    try {
      store.set(segs, f.type === 'tags' ? (v as string[]) : String(v));
      written++;
    } catch (e) {
      skipped.push((e as Error).message);
    }
  };
  const walk = (fields: Fields, value: Record<string, unknown>, segs: Segment[]) => {
    for (const [k, v] of Object.entries(value ?? {})) {
      const f = fields[k];
      if (!f || isEmptyValue(v)) continue;
      const p = [...segs, k];
      if (f.type === 'group') walk(f.fields, v as Record<string, unknown>, p);
      else if (f.type === 'list') {
        for (let i = store.length(p) - 1; i >= 0; i--) store.removeItem([...p, i]);
        for (const item of v as Record<string, unknown>[]) {
          const idx = store.addItem(p);
          walk(f.item, item, [...p, idx]);
        }
      } else setOne(p, f, v);
    }
  };
  for (const s of sections) {
    const sec = store.schema.sections[s];
    if (sec && data[s]) walk(sec.fields, data[s] as Record<string, unknown>, [s]);
  }
  return { written, skipped };
}
