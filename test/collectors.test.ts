import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { catchDeadline, mapCatchItem, parseCatchDetail, type CatchItem } from '../src/collectors/catch';
import { parseDutyCategories, parseJobkoreaDetail, parseJobkoreaList } from '../src/collectors/jobkorea';
import { mapWantedDetail, mapWantedItem, wantedExperience } from '../src/collectors/wanted';
import { COLLECTORS } from '../src/collectors';
import { paths } from '../src/paths';

const NOW = new Date('2026-09-14T10:00:00+09:00');
const fixture = (f: string) => readFileSync(path.join(paths.fixtures, f), 'utf8');

test('수집기 목록: 잡코리아·캐치·원티드 사용 가능, 인크루트는 수집 안 함', () => {
  const st = Object.fromEntries(COLLECTORS.map((c) => [c.id, c.status]));
  assert.deepEqual(st, { saramin: 'ok', jasoseol: 'ok', jobkorea: 'ok', catch: 'ok', wanted: 'ok', incruit: 'blocked' });
});

// ─── 잡코리아 ───
test('잡코리아: 목록 해석 (즉시지원은 잡코리아 공고 페이지가 지원 페이지)', () => {
  const [a, b, c] = parseJobkoreaList(fixture('jobkorea-list.html'), NOW);
  assert.deepEqual(
    { id: a.sourceId, company: a.company, title: a.title, deadline: a.deadline, exp: a.experience, types: a.employmentTypes, roles: a.roleNames, apply: a.applyUrl, loc: a.location },
    { id: '1001', company: '㈜가나다소프트', title: '신입 백엔드 개발자 채용', deadline: { date: '2026-10-14' }, exp: 'new', types: ['정규직'], roles: ['백엔드개발자', '서버개발자', 'Java'], apply: 'https://www.jobkorea.co.kr/Recruit/GI_Read/1001', loc: '서울 강남구' },
  );
  assert.equal(b.experience, 'any'); // 신입·경력
  assert.deepEqual(b.employmentTypes, ['정규직']); // "정규직 외"
  assert.equal(b.deadline, null); // 상시채용
  assert.equal(b.applyUrl, undefined); // 홈페이지 지원 → 상세에서
  assert.equal(c.experience, 'experienced');
  assert.deepEqual(c.deadline, { date: '2026-09-14' });
});

test('잡코리아: 직무 대분류 목록과 상세(홈페이지 지원 링크, 기업 구분)', () => {
  assert.deepEqual(parseDutyCategories(fixture('jobkorea-joblist.html')), [
    { code: '10026', name: '기획·전략' },
    { code: '10031', name: 'AI·개발·데이터' },
  ]);
  assert.deepEqual(parseJobkoreaDetail(fixture('jobkorea-detail.html')), {
    homepageUrl: 'https://lamaba.example.com/careers/jobs/77?from=jk&a=1',
    companyTypeText: '중견기업',
    sizeHints: ['중견'],
  });
  assert.deepEqual(parseJobkoreaDetail('<html></html>'), { homepageUrl: undefined, companyTypeText: undefined, sizeHints: [] });
});

// ─── 캐치 ───
test('캐치: 목록 해석과 마감 시각(UTC → 한국 시각)', () => {
  const items = (JSON.parse(fixture('catch-list.json')) as { recruitData: CatchItem[] }).recruitData.map(mapCatchItem);
  const [a, b, c] = items;
  assert.deepEqual(
    { id: a.sourceId, url: a.sourceUrl, company: a.company, deadline: a.deadline, exp: a.experience, types: a.employmentTypes, roles: a.roleNames, size: a.sizeHints },
    { id: '571001', url: 'https://www.catch.co.kr/NCS/RecruitInfoDetails/571001', company: '가나다로보틱스', deadline: { date: '2026-10-05' }, exp: 'any', types: ['정규직', '인턴'], roles: ['로봇 백엔드 개발 엔지니어', '웹개발', '응용프로그램개발'], size: ['중견'] },
  );
  assert.deepEqual(b.deadline, { date: '2026-09-21', time: '18:00' });
  assert.equal(b.experience, 'experienced');
  assert.deepEqual(c.employmentTypes, ['교육생']);
  assert.deepEqual(c.sizeHints, ['스타트업']);
  assert.equal(catchDeadline('2026-10-05T14:59:59.000Z', '상시채용'), null);
  assert.equal(catchDeadline(null), null);
});

test('캐치: 상세에서 지원 링크(\\u002F 풀기)와 기업 규모', () => {
  assert.deepEqual(parseCatchDetail(fixture('catch-detail.html')), {
    applyUrl: 'https://ganada.recruiter.example/career/jobs/128390',
    companySize: '중견기업',
    sizeHints: ['중견'],
  });
  assert.equal(parseCatchDetail('<script>I.ApplyURL=b;</script>').applyUrl, undefined); // 값이 없는 공고
});

// ─── 원티드 ───
test('원티드: 목록과 상세 해석 (바깥 지원 링크가 없으면 원티드에서 지원)', () => {
  const inHouse = mapWantedItem({ id: 11, position: '백엔드 엔지니어 (신입)', company: { name: '가나다랩' }, address: { location: '서울', district: '강남구' }, is_newbie: true, annual_from: 0, annual_to: 0, employment_type: 'regular', is_outlink: false });
  assert.equal(inHouse.applyUrl, 'https://www.wanted.co.kr/wd/11');
  assert.deepEqual(inHouse.employmentTypes, ['정규직']);
  assert.equal(inHouse.experience, 'new');
  assert.equal(inHouse.location, '서울 강남구');
  const out = mapWantedItem({ id: 12, position: 'SRE', company: { name: '라마바' }, annual_from: 0, annual_to: 5, is_outlink: true });
  assert.equal(out.applyUrl, undefined);
  assert.equal(out.experience, 'any');
  assert.equal(wantedExperience({ annual_from: 3, annual_to: 7 }), 'experienced');
  assert.deepEqual(
    mapWantedDetail({ job: { id: 12, due_time: '2026-10-01', out_link: 'https://careers.lamaba.example/jobs/9', employment_type: 'intern', category_tag: { child_tags: [{ text: 'DevOps / 시스템 관리자' }] } } }),
    { deadline: { date: '2026-10-01' }, applyUrl: 'https://careers.lamaba.example/jobs/9', roleNames: ['DevOps / 시스템 관리자'], employmentTypes: ['인턴'] },
  );
  assert.deepEqual(mapWantedDetail({ job: { id: 13, due_time: null } }), { deadline: null, roleNames: [] });
});
