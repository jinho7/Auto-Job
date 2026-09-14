// 이미 처리한 공고 기록 (data/seen.json). 등록했거나 중복이었던 공고는 다음 수집에서 다시 확인하지 않는다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type SeenStatus = 'registered' | 'duplicate';
export type SeenEntry = { status: SeenStatus; at: string; company: string; title: string; notionUrl?: string };

export class SeenStore {
  private data: Record<string, SeenEntry>;

  constructor(private readonly file: string) {
    this.data = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, SeenEntry>) : {};
  }

  static key(source: string, sourceId: string): string {
    return `${source}:${sourceId}`;
  }

  get(key: string): SeenEntry | undefined {
    return this.data[key];
  }

  mark(key: string, entry: Omit<SeenEntry, 'at'>): void {
    this.data[key] = { ...entry, at: new Date().toISOString() };
  }

  save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 1));
  }

  get size(): number {
    return Object.keys(this.data).length;
  }
}
