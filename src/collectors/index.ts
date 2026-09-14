import { catchCollector } from './catch';
import { jasoseol } from './jasoseol';
import { jobkorea } from './jobkorea';
import { saramin } from './saramin';
import type { Collector } from './types';
import { wanted } from './wanted';

const blocked = (id: string, label: string, note: string): Collector => ({
  id,
  label,
  method: 'http',
  status: 'blocked',
  note,
  collect: async () => {
    throw new Error(note);
  },
});

/** 수집기 목록. status 가 ok 인 것만 실제로 돈다. */
export const COLLECTORS: Collector[] = [
  saramin,
  jasoseol,
  jobkorea,
  catchCollector,
  wanted,
  blocked('incruit', '인크루트', 'robots.txt 가 모든 자동 접근을 막고 있어 수집하지 않습니다'),
];

export const collectorById = (id: string) => COLLECTORS.find((c) => c.id === id);
