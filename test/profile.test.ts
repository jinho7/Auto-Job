import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { paths } from '../src/paths';
import { checkProfile } from '../src/profile/check';
import { loadSchema, parseSchema, resolveField, splitPath } from '../src/profile/schema';
import { ProfileStore } from '../src/profile/store';
import { freshProfile } from './helpers';

const schema = loadSchema(paths.profileSchema);

test('항목 정의 파일을 읽고 경로로 항목을 찾는다', () => {
  assert.equal(resolveField(schema, splitPath('basic.name.ko'))?.label, '이름(한글)');
  assert.equal(resolveField(schema, splitPath('education.universities.3.major'))?.label, '전공');
  assert.equal(resolveField(schema, splitPath('basic.nope')), undefined);
});

test('잘못된 항목 정의는 거부한다', () => {
  assert.throws(() => parseSchema('sections:\n  a:\n    label: A\n    fields:\n      x: { type: text }\n'), /label/);
  assert.throws(() => parseSchema('sections:\n  a:\n    label: A\n    fields:\n      x: { label: X, type: select }\n'), /options/);
  assert.throws(() => parseSchema('sections:\n  a:\n    label: A\n    fields:\n      x: { label: X, type: weird }\n'), /type/);
});

test('빈 프로필: 필수 항목만 비어 있고 오류와 오타는 없다', () => {
  const store = freshProfile();
  const r = checkProfile(store.toJSON(), schema, store.filesDir);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(
    r.missing.map((m) => m.path),
    ['basic.name.ko', 'basic.birth', 'basic.phone', 'basic.email', 'basic.address.road', 'education.universities'],
  );
});

test('set: 형식 검사 후 저장하고, 파일의 주석을 보존한다', () => {
  const store = freshProfile();
  store.set('basic.name.ko', '홍길동');
  assert.throws(() => store.set('basic.birth', '1999-03-02'), /YYYY\.MM\.DD/);
  assert.throws(() => store.set('basic.gender', '기타'), /다음 중 하나/);
  assert.throws(() => store.set('basic.phone', '01012345678'), /형식/);
  store.set('basic.birth', '1999.03.02');
  store.set('basic.military.branch', '카투사'); // allow_other
  assert.throws(() => store.set('basic.nope', 'x'), /항목 정의에 없는/);

  const text = readFileSync(path.join(store.dir, 'basic.yaml'), 'utf8');
  assert.match(text, /ko: "홍길동" # 이름\(한글\)/);
  assert.match(text, /birth: "1999\.03\.02" # 생년월일/);

  const reloaded = new ProfileStore(store.dir, schema);
  assert.equal(reloaded.get('basic.name.ko'), '홍길동');
  assert.equal(reloaded.get('basic.military.branch'), '카투사');
});

test('사용자가 직접 단 주석은 저장 후에도 남는다', () => {
  const store = freshProfile();
  const file = path.join(store.dir, 'basic.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('gender: ""', '# 내 메모\ngender: ""'));
  const s2 = new ProfileStore(store.dir, schema);
  s2.set('basic.gender', '남');
  assert.match(readFileSync(file, 'utf8'), /# 내 메모\ngender: "남"/);
});

test('숫자처럼 보이는 값도 문자열 그대로 보존 (앞자리 0, 4.0)', () => {
  const store = freshProfile();
  store.set('basic.address.zipcode', '03001');
  const i = store.addItem('education.universities', { name: 'A', gpa_max: '4.0', gpa: '3.50' });
  store.set('target.job_roles', '2024, 백엔드');
  const reloaded = new ProfileStore(store.dir, schema);
  assert.equal(reloaded.get('basic.address.zipcode'), '03001');
  assert.equal(reloaded.get(`education.universities.${i}.gpa_max`), '4.0');
  assert.equal(reloaded.get(`education.universities.${i}.gpa`), '3.50');
  assert.deepEqual(reloaded.get('target.job_roles'), ['2024', '백엔드']);
  assert.deepEqual(checkProfile(reloaded.toJSON(), schema, store.filesDir).errors, []);
});

test('tags 와 여러 줄 글', () => {
  const store = freshProfile();
  store.set('target.job_roles', '백엔드, 클라우드/인프라,  ');
  assert.deepEqual(store.get('target.job_roles'), ['백엔드', '클라우드/인프라']);
  const i = store.addItem('stories.items', { title: '소재 A' });
  store.set(`stories.items.${i}.action`, '첫 줄\n둘째 줄');
  const reloaded = new ProfileStore(store.dir, schema);
  assert.equal(reloaded.get(`stories.items.${i}.action`), '첫 줄\n둘째 줄');
  assert.match(readFileSync(path.join(store.dir, 'stories.yaml'), 'utf8'), /action: \|/);
});

test('목록 추가/삭제, 잘못된 값이면 추가를 되돌린다', () => {
  const store = freshProfile();
  const a = store.addItem('education.universities', { name: 'A대학교', degree: '학사', major: '컴퓨터공학', admitted: '2019.03', status: '졸업예정' });
  const b = store.addItem('education.universities', { name: 'B대학교' });
  assert.deepEqual([a, b], [0, 1]);
  assert.throws(() => store.addItem('education.universities', { name: 'C', admitted: '2019' }), /YYYY\.MM/);
  assert.equal(store.length('education.universities'), 2);
  assert.throws(() => store.addItem('education.universities', { nope: 'x' }), /항목이 없습니다/);

  store.removeItem('education.universities.1');
  assert.equal(store.length('education.universities'), 1);
  const r = checkProfile(store.toJSON(), schema, store.filesDir);
  assert.ok(!r.missing.some((m) => m.path.startsWith('education')));

  store.removeItem('education.universities.0');
  assert.match(readFileSync(path.join(store.dir, 'education.yaml'), 'utf8'), /universities: \[\]/);
});

test('검사: 직접 고친 파일의 형식 오류와 오타 키를 잡는다', () => {
  const store = freshProfile();
  const file = path.join(store.dir, 'basic.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('birth: ""', 'birth: "1999-3-2"\nemial: "x@y.z"'));
  const r = checkProfile(new ProfileStore(store.dir, schema).toJSON(), schema, store.filesDir);
  assert.deepEqual(r.errors.map((e) => e.path), ['basic.birth']);
  assert.deepEqual(r.unknown, ['basic.emial']);
});
