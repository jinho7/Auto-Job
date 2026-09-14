import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BridgeClient, startBridge, type BridgeEvent } from '../src/apply/bridge';
import { renderProfileForAgent } from '../src/apply/profile-doc';
import { buildPrompt, buildSystemPrompt, formatApplyReport, resolveTarget, type ApplyReport } from '../src/apply/run';
import { DATA_LOSS } from '../src/apply/tools';
import { parseSettings } from '../src/config';
import { paths } from '../src/paths';
import { freshProfile, tempDir } from './helpers';

const settings = parseSettings(readFileSync(paths.settingsExample, 'utf8'));

test('AI 에게 주는 내 정보: 한글 라벨, 형식, 빈 값 표시, 목록', () => {
  const store = freshProfile();
  store.set('basic.name.ko', '홍길동');
  store.set('basic.birth', '1999.03.02');
  store.addItem('education.universities', { name: '가나다대학교', admitted: '2018.03' });
  const doc = renderProfileForAgent(store.toJSON(), store.schema, { sections: ['basic', 'education'] });
  assert.match(doc, /### 기본정보/);
  assert.match(doc, /- 이름\(한글\): 홍길동/);
  assert.match(doc, /- 이름\(영문\): \(비어 있음\)/);
  assert.match(doc, /- 생년월일: 1999\.03\.02 \[형식 YYYY\.MM\.DD\]/);
  assert.match(doc, /- 대학교: 1개\n\s+- 대학교 #1\n\s+- 학교명: 가나다대학교/);
  assert.match(doc, /- 논문 \/ 연구: \(없음\)/);
  assert.doesNotMatch(doc, /자기소개서 소재/);
});

test('지시문: 기본 규칙 + 사용자가 추가한 규칙, 작업 지시에 회사와 파일', () => {
  const sys = buildSystemPrompt({ ...settings, apply: { extra_rules: ['주소는 도로명으로', ' '], model: '' } });
  assert.match(sys, /이미 입력된 값은 수정하거나 삭제하지 마세요/);
  assert.match(sys, /## 사용자가 추가한 규칙\n- 주소는 도로명으로$/);
  const prompt = buildPrompt({ company: '가사', link: 'https://x/apply' }, '### 기본정보\n- 이름: 홍길동', ['photo.jpg']);
  assert.match(prompt, /지원 회사: 가사/);
  assert.match(prompt, /- photo\.jpg/);
});

test('지원 대상: 주소, 로컬 파일, 잘못된 입력', async () => {
  assert.deepEqual(await resolveTarget('https://careers.example.com/1', settings), { company: '', link: 'https://careers.example.com/1' });
  const f = path.join(tempDir(), 'form.html');
  writeFileSync(f, '<html></html>');
  assert.match((await resolveTarget(f, settings)).link, /^file:\/\/.*form\.html$/);
  await assert.rejects(resolveTarget('아무거나', settings), /주소/);
  await assert.rejects(resolveTarget('https://www.notion.so/abc-0123abcd4567ef890123abcd4567ef89', settings), /Notion 토큰이 없습니다/);
});

test('브리지: 토큰이 맞아야 하고, 질문은 사용자 답을 기다려 돌려준다', async () => {
  const events: BridgeEvent[] = [];
  const b = await startBridge({ ask: async (q) => `답: ${q}`, event: (e) => events.push(e) });
  try {
    const c = new BridgeClient(b.url, b.token);
    assert.equal(await c.ask('인증했나요?'), '답: 인증했나요?');
    await c.event({ type: 'blank', field: '영문 이름', reason: '내 정보에 없음' });
    await c.event({ type: 'finish', summary: '끝' });
    assert.deepEqual(events.map((e) => e.type), ['blank', 'finish']);
    const bad = await fetch(`${b.url}/ask`, { method: 'POST', body: '{}', headers: { 'X-AutoJob-Token': 'wrong' } });
    assert.equal(bad.status, 401);
  } finally {
    b.server.close();
  }
});

test('데이터를 잃게 만드는 버튼 문구', () => {
  for (const l of ['로그아웃', '삭제', '작성 취소', '지원취소', '초기화', '회원탈퇴']) assert.ok(DATA_LOSS.test(l), l);
  for (const l of ['임시저장', '+ 학력 추가', '주소검색', '다음']) assert.ok(!DATA_LOSS.test(l), l);
});

test('리포트: 비워둔 값, 참고사항, 막힌 동작', () => {
  const r: ApplyReport = {
    company: '가사',
    link: 'https://x',
    startedAt: '',
    finishedAt: '',
    steps: ['basic'],
    summary: '기본정보와 학력을 입력함',
    blanks: [{ field: '성명(영문)', reason: '내 정보에 없음' }],
    notes: ['증명사진 업로드 필요'],
    actions: [
      { type: 'action', tool: 'fill', ok: true, message: '입력함' },
      { type: 'action', tool: 'click', ok: false, message: '"최종 제출" 은(는) 제출 계열 버튼이라 누르지 않습니다' },
    ],
    agent: { text: '', isError: false, costUsd: 0.12 },
    completed: true,
    dir: '/tmp/x',
  };
  const md = formatApplyReport(r);
  assert.match(md, /입력한 칸: 1개/);
  assert.match(md, /## 비워둔 Value 값 \(1\)\n- 성명\(영문\): 내 정보에 없음/);
  assert.match(md, /## 참고사항 \(1\)\n- 증명사진 업로드 필요/);
  assert.match(md, /## 막히거나 건너뛴 동작 \(1\)/);
  assert.match(md, /제출은 하지 않았습니다/);
  assert.doesNotMatch(md, /끝까지 마치지 못했습니다/);
  assert.match(formatApplyReport({ ...r, completed: false }), /⚠️ AI 가 인적사항 입력을 끝까지 마치지 못했습니다/);
});
