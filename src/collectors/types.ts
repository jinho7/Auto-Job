import type { Page } from 'playwright-core';
import type { Settings } from '../config';
import type { PoliteHttp } from '../http';
import type { JobPosting } from '../jobs/model';

export type Experience = 'new' | 'experienced' | 'any' | 'unknown';

/** 수집기가 돌려주는 공고 (사이트마다 다른 표기를 이 형태로 맞춘다) */
export type RawPosting = {
  source: string;
  sourceId: string;
  /** 사이트의 공고 페이지 */
  sourceUrl: string;
  company: string;
  title: string;
  deadline: JobPosting['deadline'];
  experience: Experience;
  /** 정규직 / 계약직 / 인턴 / 교육 … */
  employmentTypes: string[];
  /** 사이트의 직무명, 직무 분류 */
  roleNames: string[];
  /** 사이트가 알려준 기업 규모 (기업 구분 이름) */
  sizeHints: string[];
  /** 실제 지원 페이지 (알 수 있을 때) */
  applyUrl?: string;
  location?: string;
  /** 필터를 통과한 공고만 상세 정보를 더 가져온다 (요청 수 줄이기) */
  detail?: () => Promise<Partial<RawPosting>>;
};

export type CollectorContext = {
  settings: Settings;
  http: PoliteHttp;
  now: Date;
  log: (msg: string) => void;
  /** 자동화 브라우저의 새 탭 (브라우저 수집기만) */
  browserPage: () => Promise<Page>;
};

export type CollectorStatus = 'ok' | 'planned' | 'blocked';

export interface Collector {
  id: string;
  label: string;
  method: 'http' | 'browser';
  status: CollectorStatus;
  note: string;
  collect(ctx: CollectorContext): Promise<RawPosting[]>;
}

/** YYYY-MM-DD (현지 날짜) */
export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}
