// `autojob profile show` / `autojob profile schema` 출력
import { isEmptyValue, type Fields, type ProfileSchema } from './schema';

export function renderProfile(data: Record<string, unknown>, schema: ProfileSchema, opts: { section?: string; filledOnly?: boolean } = {}): string {
  let out: string[] = [];
  const walk = (fields: Fields, value: unknown, indent: string) => {
    const obj = (value ?? {}) as Record<string, unknown>;
    for (const [k, f] of Object.entries(fields)) {
      const v = obj[k];
      if (f.type === 'group') {
        const outer = out;
        out = [];
        walk(f.fields, v, `${indent}  `);
        const inner = out;
        out = outer;
        if (inner.length || !opts.filledOnly) out.push(`${indent}${f.label}`, ...inner);
      } else if (f.type === 'list') {
        const arr = Array.isArray(v) ? v : [];
        if (!arr.length && opts.filledOnly) continue;
        out.push(`${indent}${f.label} (${arr.length}개)`);
        arr.forEach((item, i) => {
          out.push(`${indent}  #${i + 1}`);
          walk(f.item, item, `${indent}    `);
        });
      } else {
        if (isEmptyValue(v) && opts.filledOnly) continue;
        const text = isEmptyValue(v) ? '·' : Array.isArray(v) ? v.join(', ') : String(v);
        const lines = text.split('\n');
        out.push(`${indent}${f.label}: ${lines[0]}`);
        for (const l of lines.slice(1)) out.push(`${indent}${' '.repeat(f.label.length + 2)}${l}`);
      }
    }
  };
  for (const [name, sec] of Object.entries(schema.sections)) {
    if (opts.section && opts.section !== name) continue;
    out.push(`\n[${sec.label}]  (${name})`);
    walk(sec.fields, data[name], '  ');
  }
  return out.join('\n');
}

/** 경로 목록: profile set / add 에 쓸 수 있는 경로와 라벨 */
export function renderSchemaPaths(schema: ProfileSchema): string {
  const out: string[] = [];
  const walk = (fields: Fields, prefix: string, indent: string) => {
    for (const [k, f] of Object.entries(fields)) {
      const p = `${prefix}.${k}`;
      if (f.type === 'group') {
        out.push(`${indent}${p}  — ${f.label}`);
        walk(f.fields, p, `${indent}  `);
      } else if (f.type === 'list') {
        out.push(`${indent}${p}  — ${f.label} [목록: profile add ${p} key=값 ...]`);
        walk(f.item, `${p}.<번호>`, `${indent}  `);
      } else {
        const type = f.type === 'text' ? '' : ` (${f.type}${f.type === 'select' && 'options' in f ? `: ${f.options?.join('/')}` : ''})`;
        out.push(`${indent}${p}  — ${f.label}${f.required ? ' *' : ''}${type}`);
      }
    }
  };
  for (const [name, sec] of Object.entries(schema.sections)) {
    out.push(`\n${name}  — ${sec.label}`);
    walk(sec.fields, name, '  ');
  }
  return out.join('\n');
}
