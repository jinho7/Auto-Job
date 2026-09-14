// 내 정보를 AI 가 읽기 좋은 문서로 만든다. 항목 정의(schema.yaml)의 한글 라벨을 쓰고, 빈 값도 "(비어 있음)"으로 보여준다.
import { isEmptyValue, type Fields, type ProfileSchema } from '../profile/schema';

const FORMAT: Record<string, string> = { date: 'YYYY.MM.DD', month: 'YYYY.MM' };

export function renderProfileForAgent(data: Record<string, unknown>, schema: ProfileSchema, opts: { sections?: string[] } = {}): string {
  const lines: string[] = [];
  const walk = (fields: Fields, value: unknown, indent: string) => {
    const obj = (value ?? {}) as Record<string, unknown>;
    for (const [k, f] of Object.entries(fields)) {
      const v = obj[k];
      if (f.type === 'group') {
        lines.push(`${indent}- ${f.label}`);
        walk(f.fields, v, `${indent}  `);
      } else if (f.type === 'list') {
        const arr = Array.isArray(v) ? v : [];
        lines.push(`${indent}- ${f.label}: ${arr.length ? `${arr.length}개` : '(없음)'}`);
        arr.forEach((item, i) => {
          lines.push(`${indent}  - ${f.label} #${i + 1}`);
          walk(f.item, item, `${indent}    `);
        });
      } else {
        const fmt = f.type !== 'tags' && FORMAT[f.type] ? ` [형식 ${FORMAT[f.type]}]` : '';
        const text = isEmptyValue(v) ? '(비어 있음)' : Array.isArray(v) ? v.join(', ') : String(v).replace(/\n/g, ' / ');
        if (isEmptyValue(v) && f.type === 'longtext') continue;
        lines.push(`${indent}- ${f.label}: ${text}${isEmptyValue(v) ? '' : fmt}`);
      }
    }
  };
  for (const [name, sec] of Object.entries(schema.sections)) {
    if (opts.sections && !opts.sections.includes(name)) continue;
    lines.push(`\n### ${sec.label}`);
    walk(sec.fields, data[name], '');
  }
  return lines.join('\n').trim();
}
