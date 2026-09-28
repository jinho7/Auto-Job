import type { Page } from 'playwright-core';
import type { Settings } from '../config';
import type { PoliteHttp } from '../http';
import type { JobPosting } from '../jobs/model';

export type Experience = 'new' | 'experienced' | 'any' | 'unknown';

/** 공고 안의 모집 직무 하나와 그 직무의 채용 형태. 사이트가 직무별로 알려 주면 그대로, 아니면 공고 전체 값으로 채운다 */
export type Position = { name: string; career: Experience };

/** 직무별 정보를 주지 않는 사이트는 직무명마다 공고 전체의 신입/경력 값을 붙인다 */
export function positionsOf(r: Pick<RawPosting, 'positions' | 'roleNames' | 'experience' | 'title'>): Position[] {
  if (r.positions?.length) return r.positions;
  const names = r.roleNames.length ? r.roleNames : [r.title];
  return names.map((name) => ({ name, career: r.experience }));
}

/** 신입으로 지원할 수 있는 직무인가 (경력 전용만 아니면 된다. 모르면 막지 않는다) */
export const openToNewcomers = (p: Position) => p.career !== 'experienced';

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
  /** 직무별 채용 형태 (사이트가 직무마다 신입/경력을 알려 줄 때). 없으면 positionsOf() 가 roleNames 로 만든다 */
  positions?: Position[];
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
  detail?(ctx: CollectorContext, posting: RawPosting): Promise<Partial<RawPosting>>;
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
