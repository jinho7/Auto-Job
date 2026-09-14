// 내 정보 검사: 필수 항목, 형식, 항목 정의에 없는 키(오타)
import { isEmptyValue, validateScalar, type Fields, type ProfileSchema } from './schema';

export type Issue = { path: string; where: string; message: string };
export type CheckReport = { missing: Issue[]; errors: Issue[]; unknown: string[]; filled: number; total: number };

export function checkProfile(data: Record<string, unknown>, schema: ProfileSchema, filesDir?: string): CheckReport {
  const r: CheckReport = { missing: [], errors: [], unknown: [], filled: 0, total: 0 };

  const walk = (fields: Fields, value: unknown, p: string, where: string) => {
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    for (const k of Object.keys(obj)) if (!fields[k]) r.unknown.push(`${p}.${k}`);

    for (const [k, f] of Object.entries(fields)) {
      const v = obj[k];
      const fp = `${p}.${k}`;
      const fw = `${where} > ${f.label}`;
      if (f.type === 'group') {
        walk(f.fields, v, fp, fw);
      } else if (f.type === 'list') {
        const arr = Array.isArray(v) ? v : [];
        if (v != null && !Array.isArray(v)) r.errors.push({ path: fp, where: fw, message: '목록이어야 합니다' });
        if (f.min_items && arr.length < f.min_items) r.missing.push({ path: fp, where: fw, message: `${f.min_items}개 이상 필요` });
        arr.forEach((item, i) => walk(f.item, item, `${fp}.${i}`, `${fw} #${i + 1}`));
      } else {
        r.total++;
        if (isEmptyValue(v)) {
          if (f.required) r.missing.push({ path: fp, where: fw, message: '비어 있음' });
          continue;
        }
        r.filled++;
        if (f.type === 'tags') {
          if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' && typeof x !== 'number')) {
            r.errors.push({ path: fp, where: fw, message: '문자열 목록이어야 합니다' });
          }
          continue;
        }
        const err = validateScalar(f, String(v), filesDir);
        if (err) r.errors.push({ path: fp, where: fw, message: `${err} (현재: ${v})` });
      }
    }
  };

  for (const [name, sec] of Object.entries(schema.sections)) walk(sec.fields, data[name], name, sec.label);
  for (const k of Object.keys(data)) if (!schema.sections[k]) r.unknown.push(k);
  return r;
}
