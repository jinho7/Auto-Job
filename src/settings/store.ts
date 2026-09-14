// settings.yaml 읽기/쓰기. 주석을 보존하고, 저장 전에 전체 형식을 검증한다.
import { readFileSync, writeFileSync } from 'node:fs';
import YAML, { isScalar, isSeq, type Document } from 'yaml';
import { parseSettings, type Settings } from '../config';

type Seg = string | number;
const split = (p: string): Seg[] => p.split('.').filter(Boolean).map((s) => (/^\d+$/.test(s) ? Number(s) : s));

export class SettingsStore {
  private doc: Document;

  constructor(private readonly file: string) {
    this.doc = YAML.parseDocument(readFileSync(file, 'utf8'));
  }

  get settings(): Settings {
    return parseSettings(String(this.doc), this.file);
  }

  /** 파일에 없는 키(새 버전에서 추가된 설정)는 기본값을 돌려준다 */
  get(p: string): unknown {
    const node = this.doc.getIn(split(p), true);
    if (node === undefined) return split(p).reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string | number, unknown>)[k]), this.settings);
    return node && typeof node === 'object' && 'toJSON' in node ? (node as { toJSON(): unknown }).toJSON() : node;
  }

  /** 복사본에 변경을 적용하고 검증을 통과하면 저장한다. 실패하면 파일은 그대로. */
  private commit(mutate: (doc: Document) => void): void {
    const next = this.doc.clone();
    mutate(next);
    parseSettings(String(next), 'settings.yaml'); // 형식이 틀리면 예외
    this.doc = next;
    writeFileSync(this.file, String(this.doc));
  }

  set(p: string, value: unknown): void {
    const segs = split(p);
    this.commit((doc) => {
      const node = doc.getIn(segs, true);
      if (isScalar(node) && (value === null || typeof value !== 'object')) {
        node.value = value;
      } else if (isSeq(node) && Array.isArray(value)) {
        node.items = value.map((v) => doc.createNode(v));
      } else {
        doc.setIn(segs, doc.createNode(value));
      }
    });
  }

  /** "true" → true, "9222" → 9222, "[a, b]" → 배열, 그 외는 문자열 */
  setFromText(p: string, text: string): void {
    let value: unknown = text;
    try {
      value = YAML.parse(text);
    } catch {
      /* 문자열 그대로 */
    }
    const current = this.get(p);
    if (typeof current === 'string' && typeof value !== 'string') value = text; // 문자열 칸에는 문자열로
    this.set(p, value ?? '');
  }

  addToList(p: string, values: string[]): string[] {
    const cur = (this.get(p) as string[] | undefined) ?? [];
    const added = [...new Set(values.map((v) => v.trim()))].filter((v) => v && !cur.includes(v));
    const next = [...cur, ...added];
    this.commit((doc) => {
      const node = doc.getIn(split(p), true);
      if (isSeq(node)) {
        node.items = next.map((v) => doc.createNode(v));
        node.flow = false;
      } else doc.setIn(split(p), doc.createNode(next));
    });
    return added;
  }

  removeFromList(p: string, values: string[]): string[] {
    const cur = (this.get(p) as string[] | undefined) ?? [];
    const removed = cur.filter((v) => values.includes(v));
    const next = cur.filter((v) => !values.includes(v));
    this.commit((doc) => {
      const node = doc.getIn(split(p), true);
      if (isSeq(node)) {
        node.items = next.map((v) => doc.createNode(v));
        if (!next.length) node.flow = true;
      }
    });
    return removed;
  }
}

/** Notion 페이지/DB URL 이나 ID 에서 UUID 를 뽑는다 */
export function parseNotionId(input: string): string | null {
  const uuid = input.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)?.at(-1);
  // "제목-<32자리>" 형태의 URL 에서는 마지막 32자리가 ID
  const hex = uuid ? uuid.replace(/-/g, '') : input.split('?')[0].match(/[0-9a-f]{32,}/gi)?.at(-1)?.slice(-32);
  if (!hex) return null;
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
