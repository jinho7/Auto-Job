// profile/me/<섹션>.yaml 읽기/쓰기. YAML 문서 노드를 직접 고쳐 사용자가 단 주석을 보존한다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML, { isMap, isScalar, isSeq, type Document, type Pair, type Scalar, type YAMLMap, type YAMLSeq } from 'yaml';
import {
  describe,
  emptyFields,
  isEmptyValue,
  resolveField,
  splitPath,
  validateScalar,
  type Field,
  type Fields,
  type ProfileSchema,
  type Segment,
} from './schema';

/** 문자열은 항상 따옴표로 저장한다. 03001(우편번호), 4.0(만점) 같은 값이 숫자로 바뀌지 않게. */
function str(doc: Document, v: string): Scalar {
  const node = doc.createNode(v) as Scalar;
  node.type = v.includes('\n') ? 'BLOCK_LITERAL' : 'QUOTE_DOUBLE';
  return node;
}

/** 항목 정의로 주석이 달린 빈 섹션 문서를 만든다 */
export function generateSection(schema: ProfileSchema, section: string): Document {
  const sec = schema.sections[section];
  const doc = new YAML.Document(emptyFields(sec.fields));
  doc.commentBefore =
    ` ${sec.label}\n` +
    ` 편집: autojob profile edit ${section}   검사: autojob profile check\n` +
    ` 값이 없으면 "" 로 두세요. AI는 빈 값을 추정해서 채우지 않고 빈칸으로 둡니다.`;
  annotate(doc.contents as YAMLMap, sec.fields);
  return doc;
}

function annotate(map: YAMLMap, fields: Fields): void {
  for (const item of map.items as Pair[]) {
    const field = fields[String((item.key as { value: unknown }).value)];
    if (!field) continue;
    const text = ` ${describe(field)}`;
    if (field.type === 'group') {
      (item.key as { commentBefore?: string }).commentBefore = text;
      annotate(item.value as YAMLMap, field.fields);
    } else if (field.type === 'list' || field.type === 'tags') {
      (item.key as { commentBefore?: string }).commentBefore = text;
    } else if (isScalar(item.value)) {
      item.value.comment = text;
    }
  }
}

export class ProfileStore {
  private readonly docs = new Map<string, Document>();

  constructor(readonly dir: string, readonly schema: ProfileSchema) {
    for (const s of Object.keys(schema.sections)) {
      const file = this.file(s);
      this.docs.set(s, existsSync(file) ? YAML.parseDocument(readFileSync(file, 'utf8')) : generateSection(schema, s));
    }
  }

  get filesDir(): string {
    return path.join(this.dir, 'files');
  }

  private file(section: string): string {
    return path.join(this.dir, `${section}.yaml`);
  }

  private doc(section: Segment): Document {
    const d = this.docs.get(String(section));
    if (!d) throw new Error(`알 수 없는 섹션: ${section}`);
    return d;
  }

  /** 섹션 파일이 없으면 만든다. 이미 있으면 건드리지 않는다. */
  initFiles(): string[] {
    mkdirSync(this.filesDir, { recursive: true });
    const created: string[] = [];
    for (const s of Object.keys(this.schema.sections)) {
      if (!existsSync(this.file(s))) {
        this.save(s);
        created.push(`${s}.yaml`);
      }
    }
    return created;
  }

  save(section: string): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(section), String(this.doc(section)));
  }

  field(p: string | Segment[]): Field {
    const segs = typeof p === 'string' ? splitPath(p) : p;
    const f = resolveField(this.schema, segs);
    if (!f) throw new Error(`항목 정의에 없는 경로: ${segs.join('.')}  (autojob profile schema 로 확인)`);
    return f;
  }

  get(p: string | Segment[]): unknown {
    const [section, ...rest] = typeof p === 'string' ? splitPath(p) : p;
    const v = rest.length ? this.doc(section).getIn(rest) : this.doc(section).contents;
    return isMap(v) || isSeq(v) || isScalar(v) ? v.toJSON() : v;
  }

  toJSON(): Record<string, unknown> {
    return Object.fromEntries([...this.docs].map(([s, d]) => [s, d.toJS() ?? {}]));
  }

  /** 한 줄 글/날짜/선택 등 단일 값, 또는 tags 목록을 저장한다. 형식이 틀리면 예외. */
  set(p: string | Segment[], value: string | string[]): void {
    const segs = typeof p === 'string' ? splitPath(p) : p;
    const field = this.field(segs);
    const [section, ...rest] = segs;
    const doc = this.doc(section);

    if (field.type === 'tags') {
      const values = (Array.isArray(value) ? value : value.split(',')).map((v) => v.trim()).filter(Boolean);
      const node = doc.getIn(rest, true);
      if (isSeq(node)) {
        node.items = values.map((v) => str(doc, v));
        node.flow = true;
      } else {
        const seq = doc.createNode([]) as YAMLSeq;
        seq.items = values.map((v) => str(doc, v));
        seq.flow = true;
        doc.setIn(rest, seq);
      }
      return this.save(String(section));
    }
    if (field.type === 'group' || field.type === 'list') throw new Error(`${segs.join('.')} 는 묶음/목록이라 값을 직접 넣을 수 없습니다`);
    if (Array.isArray(value)) throw new Error(`${segs.join('.')} 는 값 하나만 받습니다`);

    const v = value.trim() === '' ? '' : field.type === 'longtext' ? value.replace(/\s+$/, '') : value.trim();
    if (v) {
      const err = validateScalar(field, v, this.filesDir);
      if (err) throw new Error(`${field.label}: ${err}`);
    }
    const node = doc.getIn(rest, true);
    if (isScalar(node)) {
      node.value = v;
      node.type = v.includes('\n') ? 'BLOCK_LITERAL' : 'QUOTE_DOUBLE';
    } else {
      doc.setIn(rest, str(doc, v));
    }
    this.save(String(section));
  }

  /** 목록에 항목을 추가하고 새 인덱스를 돌려준다 */
  addItem(listPath: string | Segment[], values: Record<string, string | string[]> = {}): number {
    const segs = typeof listPath === 'string' ? splitPath(listPath) : listPath;
    const field = this.field(segs);
    if (field.type !== 'list') throw new Error(`${segs.join('.')} 는 목록이 아닙니다`);
    for (const k of Object.keys(values)) if (!field.item[k]) throw new Error(`${field.label}에 "${k}" 항목이 없습니다`);

    const [section, ...rest] = segs;
    const doc = this.doc(section);
    const item = doc.createNode(emptyFields(field.item)) as YAMLMap;
    const seq = doc.getIn(rest, true);
    let index: number;
    if (isSeq(seq)) {
      seq.flow = false;
      index = seq.items.push(item) - 1;
    } else {
      doc.setIn(rest, doc.createNode([]));
      (doc.getIn(rest, true) as { items: unknown[] }).items.push(item);
      index = 0;
    }
    try {
      for (const [k, v] of Object.entries(values)) this.set([...segs, index, k], v);
    } catch (e) {
      this.removeItem([...segs, index]);
      throw e;
    }
    this.save(String(section));
    return index;
  }

  removeItem(itemPath: string | Segment[]): void {
    const segs = typeof itemPath === 'string' ? splitPath(itemPath) : itemPath;
    const idx = segs.at(-1);
    if (typeof idx !== 'number') throw new Error('삭제할 항목의 번호가 필요합니다 (예: education.universities.0)');
    const [section, ...rest] = segs;
    const doc = this.doc(section);
    const seq = doc.getIn(rest.slice(0, -1), true);
    if (!isSeq(seq) || idx >= seq.items.length) throw new Error(`${segs.join('.')} 항목이 없습니다`);
    seq.items.splice(idx, 1);
    if (!seq.items.length) seq.flow = true;
    this.save(String(section));
  }

  length(listPath: string | Segment[]): number {
    const v = this.get(listPath);
    return Array.isArray(v) ? v.length : 0;
  }

  isEmpty(p: string | Segment[]): boolean {
    return isEmptyValue(this.get(p));
  }
}
