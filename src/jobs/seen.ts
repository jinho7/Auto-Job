// 이미 처리한 공고 기록 (data/seen.json). 등록했거나 중복이었던 공고는 다음 수집에서 다시 확인하지 않는다.
// AI 로도 지원 페이지를 못 찾은 공고(no_link)는 일정 기간이 지나면 다시 확인한다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type SeenStatus = 'registered' | 'duplicate' | 'no_link';

/** no_link 공고를 다시 확인하기까지의 기간 */
export const NO_LINK_RETRY_DAYS = 7;
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

  /** 이번 수집에서 건너뛸 공고인지 (no_link 는 기간이 지나면 다시 본다) */
  skip(key: string, now = new Date()): SeenEntry | undefined {
    const e = this.data[key];
    if (!e) return undefined;
    if (e.status === 'no_link' && now.getTime() - Date.parse(e.at) > NO_LINK_RETRY_DAYS * 86_400_000) return undefined;
    return e;
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
