import { jasoseol } from './jasoseol';
import { saramin } from './saramin';
import type { Collector } from './types';

const planned = (id: string, label: string, note: string): Collector => ({
  id,
  label,
  method: 'http',
  status: 'planned',
  note,
  collect: async () => {
    throw new Error(`${label} 수집기는 아직 준비 중입니다`);
  },
});

/** 수집기 목록. status 가 ok 인 것만 실제로 돈다. */
export const COLLECTORS: Collector[] = [
  saramin,
  jasoseol,
  planned('jobkorea', '잡코리아', '준비 중 — robots.txt 가 검색 페이지를 막아, 허용된 채용정보 목록 페이지로 만들 예정'),
  planned('wanted', '원티드', '준비 중 — robots.txt 를 확인할 수 없어(403) 보류'),
  planned('catch', '캐치', '준비 중 — robots.txt 가 검색 페이지를 막고 있어 허용 범위 확인 필요'),
  { ...planned('incruit', '인크루트', 'robots.txt 가 모든 자동 접근을 막고 있어 수집하지 않습니다'), status: 'blocked' },
];

export const collectorById = (id: string) => COLLECTORS.find((c) => c.id === id);
