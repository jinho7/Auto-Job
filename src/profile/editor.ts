// `autojob profile edit`: 항목 정의(schema.yaml)를 따라 움직이는 대화형 편집기
import { existsSync, readdirSync } from 'node:fs';
import type { Prompter, Choice } from '../ui/prompter';
import { multiline } from '../ui/prompter';
import { checkProfile } from './check';
import {
  describe,
  isEmptyValue,
  validateScalar,
  type Field,
  type Fields,
  type ListField,
  type Segment,
} from './schema';
import type { ProfileStore } from './store';

const BACK = '__back';
const FILL = '__fill';
const ADD = '__add';
const SKIP = '__skip';
const CLEAR = '__clear';
const OTHER = '__other';

export class ProfileEditor {
  constructor(private readonly store: ProfileStore, private readonly p: Prompter, private readonly log = console.log) {}

  async run(section?: string): Promise<void> {
    if (section) {
      const sec = this.store.schema.sections[section];
      if (!sec) throw new Error(`알 수 없는 섹션: ${section} (가능: ${Object.keys(this.store.schema.sections).join(', ')})`);
      return this.editGroup([section], sec.fields, sec.label);
    }
    for (;;) {
      const report = checkProfile(this.store.toJSON(), this.store.schema, this.store.filesDir);
      const choices: Choice<string>[] = Object.entries(this.store.schema.sections).map(([name, sec]) => {
        const missing = report.missing.filter((m) => m.path.startsWith(`${name}.`)).length;
        const errors = report.errors.filter((m) => m.path.startsWith(`${name}.`)).length;
        const flags = [missing && `필수 ${missing}개 비어 있음`, errors && `오류 ${errors}개`].filter(Boolean).join(', ');
        return { name: `${sec.label}${flags ? `  (${flags})` : ''}`, value: name };
      });
      choices.push({ name: '◀ 종료 (입력한 내용은 바로 저장됩니다)', value: BACK });
      const pick = await this.p.select({ message: '어떤 정보를 편집할까요?', choices });
      if (pick === BACK) return;
      const sec = this.store.schema.sections[pick];
      await this.editGroup([pick], sec.fields, sec.label);
    }
  }

  private summary(segs: Segment[], field: Field): string {
    const v = this.store.get(segs);
    if (field.type === 'group') return `${field.label} ▸`;
    if (field.type === 'list') return `${field.label} (${Array.isArray(v) ? v.length : 0}개) ▸`;
    const req = field.required ? ' *' : '';
    if (isEmptyValue(v)) return `${field.label}${req}: ·`;
    const text = Array.isArray(v) ? v.join(', ') : String(v).replace(/\n/g, ' ⏎ ');
    return `${field.label}${req}: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`;
  }

  private async editGroup(segs: Segment[], fields: Fields, title: string): Promise<void> {
    for (;;) {
      const choices: Choice<string>[] = Object.entries(fields).map(([k, f]) => ({ name: this.summary([...segs, k], f), value: k }));
      choices.push({ name: '▶ 빈 칸만 차례로 입력', value: FILL }, { name: '◀ 뒤로', value: BACK });
      const pick = await this.p.select({ message: title, choices });
      if (pick === BACK) return;
      if (pick === FILL) {
        await this.fill(segs, fields, true);
        continue;
      }
      await this.open([...segs, pick], fields[pick], `${title} > ${fields[pick].label}`);
    }
  }

  private async open(segs: Segment[], field: Field, title: string): Promise<void> {
    if (field.type === 'group') return this.editGroup(segs, field.fields, title);
    if (field.type === 'list') return this.editList(segs, field, title);
    return this.editValue(segs, field);
  }

  /** 항목을 순서대로 묻는다. onlyEmpty 면 비어 있는 칸만. 목록은 건너뛴다. */
  private async fill(segs: Segment[], fields: Fields, onlyEmpty: boolean): Promise<void> {
    for (const [k, f] of Object.entries(fields)) {
      const path = [...segs, k];
      if (f.type === 'group') await this.fill(path, f.fields, onlyEmpty);
      else if (f.type === 'list') continue;
      else if (!onlyEmpty || this.store.isEmpty(path)) await this.editValue(path, f);
    }
  }

  private itemTitle(item: Record<string, unknown>, field: ListField): string {
    const parts = Object.entries(field.item)
      .filter(([k, f]) => f.type !== 'group' && f.type !== 'list' && f.type !== 'longtext' && !isEmptyValue(item[k]))
      .slice(0, 3)
      .map(([k]) => (Array.isArray(item[k]) ? (item[k] as string[]).join(', ') : String(item[k])));
    return parts.length ? parts.join(' / ') : '(비어 있음)';
  }

  private async editList(segs: Segment[], field: ListField, title: string): Promise<void> {
    for (;;) {
      const items = (this.store.get(segs) as Record<string, unknown>[] | undefined) ?? [];
      const choices: Choice<number | string>[] = items.map((it, i) => ({ name: `#${i + 1} ${this.itemTitle(it, field)}`, value: i }));
      choices.push({ name: `+ ${field.label} 추가`, value: ADD }, { name: '◀ 뒤로', value: BACK });
      const pick = await this.p.select<number | string>({ message: `${title}${field.hint ? ` — ${field.hint}` : ''}`, choices });
      if (pick === BACK) return;
      if (pick === ADD) {
        const idx = this.store.addItem(segs);
        await this.fill([...segs, idx], field.item, false);
        const added = (this.store.get([...segs, idx]) as Record<string, unknown>) ?? {};
        if (Object.values(added).every(isEmptyValue)) {
          this.store.removeItem([...segs, idx]);
          this.log('  아무것도 입력하지 않아 추가하지 않았습니다.');
        }
        continue;
      }
      const i = pick as number;
      const action = await this.p.select({
        message: `${field.label} #${i + 1}`,
        choices: [
          { name: '수정', value: 'edit' },
          { name: '삭제', value: 'delete' },
          { name: '◀ 뒤로', value: BACK },
        ],
      });
      if (action === 'edit') await this.editGroup([...segs, i], field.item, `${title} #${i + 1}`);
      if (action === 'delete' && (await this.p.confirm({ message: `#${i + 1}을(를) 삭제할까요?`, default: false }))) {
        this.store.removeItem([...segs, i]);
      }
    }
  }

  private async editValue(segs: Segment[], field: Exclude<Field, { type: 'group' | 'list' }>): Promise<void> {
    const current = this.store.get(segs);
    const has = !isEmptyValue(current);
    const message = describe(field);
    const save = (v: string | string[]) => {
      try {
        this.store.set(segs, v);
      } catch (e) {
        this.log(`  ❌ ${(e as Error).message}`);
      }
    };

    if (field.type === 'tags') {
      const cur = Array.isArray(current) ? current.join(', ') : '';
      const v = await this.p.input({ message: `${message}${has ? '  [Enter 유지, - 비우기]' : ''}`, default: cur || undefined });
      if (v === '-') return save([]);
      if (v !== cur) save(v);
      return;
    }

    if (field.type === 'longtext') {
      let mode = 'new';
      if (has) {
        this.log(`  현재: ${String(current).replace(/\n/g, '\n        ')}`);
        mode = await this.p.select({
          message,
          choices: [
            { name: '유지', value: 'keep' },
            { name: '새로 쓰기', value: 'new' },
            { name: '비우기', value: CLEAR },
          ],
        });
      }
      if (mode === CLEAR) return save('');
      if (mode === 'new') {
        const text = await multiline(this.p, message);
        if (text) save(text);
      }
      return;
    }

    if (field.type === 'select' || field.type === 'file') {
      const options =
        field.type === 'select'
          ? (field.options ?? [])
          : existsSync(this.store.filesDir)
            ? readdirSync(this.store.filesDir).filter((f) => !f.startsWith('.'))
            : [];
      if (field.type === 'file' && !options.length) {
        this.log(`  ${this.store.filesDir}/ 에 파일을 먼저 넣어주세요.`);
      }
      const choices: Choice<string>[] = options.map((o) => ({ name: o, value: o }));
      if (has && !options.includes(String(current))) choices.unshift({ name: `${current} (현재)`, value: String(current) });
      if (field.type === 'file' || field.allow_other) choices.push({ name: '직접 입력…', value: OTHER });
      choices.push(has ? { name: '(비우기)', value: CLEAR } : { name: '(건너뛰기)', value: SKIP });
      const pick = await this.p.select({ message, choices, default: has ? String(current) : undefined });
      if (pick === SKIP) return;
      if (pick === CLEAR) return save('');
      if (pick === OTHER) {
        const v = await this.p.input({ message: `${field.label} 직접 입력`, validate: (x) => x === '' || validateScalar({ ...field, allow_other: true }, x, this.store.filesDir) || true });
        if (v) save(v);
        return;
      }
      if (pick !== current) save(pick);
      return;
    }

    const cur = has ? String(current) : '';
    const v = await this.p.input({
      message: `${message}${has ? '  [Enter 유지, - 비우기]' : ''}`,
      default: cur || undefined,
      validate: (x) => x === '' || x === '-' || (validateScalar(field, x.trim(), this.store.filesDir) ?? true),
    });
    if (v === '-') return save('');
    if (v.trim() !== cur) save(v);
  }
}
