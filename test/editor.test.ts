import './setup-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProfileEditor } from '../src/profile/editor';
import { SettingsEditor } from '../src/settings/editor';
import { SettingsStore } from '../src/settings/store';
import { freshProfile, freshSettingsFile, pick, scripted } from './helpers';

const quiet = () => {};

test('프로필 편집기: 묶음 안의 값과 선택 항목을 입력한다', async () => {
  const store = freshProfile();
  const p = scripted([
    pick('이름 ▸'),
    pick('이름(한글)'),
    '홍길동',
    pick('◀ 뒤로'),
    pick('성별'),
    '남',
    pick('◀ 뒤로'),
  ]);
  await new ProfileEditor(store, p, quiet).run('basic');
  assert.equal(store.get('basic.name.ko'), '홍길동');
  assert.equal(store.get('basic.gender'), '남');
  assert.equal(p.remaining(), 0);
});

test('프로필 편집기: 이미 있는 값은 Enter 로 유지, - 로 비우기', async () => {
  const store = freshProfile();
  store.set('basic.email', 'a@b.co');
  store.set('basic.phone', '010-1111-2222');
  await new ProfileEditor(store, scripted([pick('이메일'), '', pick('휴대폰'), '-', pick('◀ 뒤로')]), quiet).run('basic');
  assert.equal(store.get('basic.email'), 'a@b.co');
  assert.equal(store.get('basic.phone'), '');
});

test('프로필 편집기: 형식이 틀린 입력은 받지 않는다', async () => {
  const store = freshProfile();
  const p = scripted([pick('생년월일'), '1999-03-02']);
  await assert.rejects(new ProfileEditor(store, p, quiet).run('basic'), /검증 실패.*YYYY\.MM\.DD/);
});

test('프로필 편집기: 목록에 항목을 추가하고, 빈 항목은 버린다', async () => {
  const store = freshProfile();
  const skip = pick('(건너뛰기)');
  const p = scripted([
    pick('대학교 (0개)'),
    pick('+ 대학교 추가'),
    // 학교명, 본교/분교, 학위, 전공, 복수전공, 부전공, 입학, 졸업, 학적, 입학구분, 학점, 만점, 전공학점, 소재지, 논문
    'A대학교', skip, '학사', '컴퓨터공학', '', '', '2019.03', '', '졸업예정', skip, '3.85', '4.5', '', '', '',
    pick('+ 대학교 추가'),
    '', skip, skip, '', '', '', '', '', skip, skip, '', skip, '', '', '',
    pick('◀ 뒤로'),
    pick('◀ 뒤로'),
  ]);
  await new ProfileEditor(store, p, quiet).run('education');
  assert.equal(store.length('education.universities'), 1);
  assert.equal(store.get('education.universities.0.major'), '컴퓨터공학');
  assert.equal(store.get('education.universities.0.gpa_max'), '4.5');
  assert.equal(p.remaining(), 0);
});

test('프로필 편집기: 목록 항목 삭제', async () => {
  const store = freshProfile();
  store.addItem('extras.certificates', { name: '정보처리기사' });
  store.addItem('extras.certificates', { name: 'SQLD' });
  await new ProfileEditor(store, scripted([pick('자격증 (2개)'), pick('#1'), pick('삭제'), true, pick('◀ 뒤로'), pick('◀ 뒤로')]), quiet).run('extras');
  assert.deepEqual((store.get('extras.certificates') as { name: string }[]).map((c) => c.name), ['SQLD']);
});

test('설정 편집기: 키워드 추가, 기업 구분, Notion DB', async () => {
  const store = new SettingsStore(freshSettingsFile());
  const p = scripted([
    pick('검색 키워드'),
    pick('추가'),
    '백엔드, Spring Boot',
    pick('◀ 뒤로'),
    pick('기업 구분'),
    ['대기업', '유명IT', '중견'],
    ['대기업'],
    pick('Notion'),
    pick('DB 링크로 직접 지정'),
    'https://app.notion.com/p/0123abcd4567ef890123abcd4567ef89?pvs=204',
    pick('◀ 뒤로'),
    pick('◀ 종료'),
  ]);
  await new SettingsEditor(store, p, quiet).run();
  const s = store.settings;
  assert.deepEqual(s.collect.keywords, ['백엔드', 'Spring Boot']);
  assert.deepEqual(
    Object.entries(s.company_types).filter(([, v]) => v.include).map(([k]) => k),
    ['대기업', '유명IT', '중견'],
  );
  assert.deepEqual(
    Object.entries(s.company_types).filter(([, v]) => v.priority).map(([k]) => k),
    ['대기업'],
  );
  assert.equal(s.notion.database_id, '0123abcd-4567-ef89-0123-abcd4567ef89');
  assert.equal(p.remaining(), 0);
});

test('설정 편집기: 수집 사이트와 고용형태', async () => {
  const store = new SettingsStore(freshSettingsFile());
  const p = scripted([
    pick('수집 사이트'),
    ['wanted', 'saramin'],
    pick('고용형태'),
    ['신입', '인턴'],
    '전환형 인턴',
    true,
    pick('◀ 종료'),
  ]);
  await new SettingsEditor(store, p, quiet).run();
  const s = store.settings;
  assert.deepEqual(Object.entries(s.collect.sources).filter(([, v]) => v).map(([k]) => k), ['saramin', 'wanted']);
  assert.deepEqual(s.collect.employment_types, ['신입', '인턴', '전환형 인턴']);
});
