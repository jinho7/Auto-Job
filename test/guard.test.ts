import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkLabel } from '../src/browser/guard';
import { parseSettings } from '../src/config';
import { paths } from '../src/paths';

const guard = parseSettings(readFileSync(paths.settingsExample, 'utf8')).browser.guard;
const blocked = (label: string, armed = false) => checkLabel(label, guard, armed).blocked;

test('제출 계열 문구는 항상 차단', () => {
  for (const l of ['제출', '최종 제출', '지원서 제출하기', '작성 완료', '지원완료', '접수하기', 'Submit Application', '저장 후 제출']) {
    assert.equal(blocked(l), true, l);
  }
});

test('임시저장 계열은 허용', () => {
  for (const l of ['임시저장', '임시 저장', '저장하기', '중간 저장']) assert.equal(blocked(l, true), false, l);
});

test('지원하기는 armed 전에는 허용, 이후에는 차단', () => {
  assert.equal(blocked('지원하기'), false);
  assert.equal(blocked('지원하기', true), true);
  assert.equal(blocked('Apply now', true), true);
});

test('일반 버튼은 허용', () => {
  for (const l of ['다음', '이전', '주소 검색', '학력 추가', '파일 선택', '']) assert.equal(blocked(l, true), false, l);
});
