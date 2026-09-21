import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BridgeClient, startBridge, type BridgeEvent } from '../src/apply/bridge';
import { renderProfileForAgent } from '../src/apply/profile-doc';
import { buildSystemPrompt, formatApplyReport, resolveTarget, type ApplyReport } from '../src/apply/run';
import { BUNDLE_ID, notifyScript } from '../src/notify';
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
  const sys = buildSystemPrompt({ ...settings, apply: { ...settings.apply, extra_rules: ['주소는 도로명으로', ' '] } });
  assert.match(sys, /기존 사용자 입력은 보존하세요/);
  assert.match(sys, /## 사용자가 추가한 규칙\n- 주소는 도로명으로$/);
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
  assert.match(md, /입력 작업: 1회/);
  assert.match(md, /## 미입력 항목 \(1\)\n- 성명\(영문\): 내 정보에 없음/);
  assert.match(md, /## 참고사항 \(1\)\n- 증명사진 업로드 필요/);
  assert.match(md, /## 막히거나 건너뛴 동작 \(1\)/);
  assert.match(md, /제출은 하지 않았습니다/);
  assert.doesNotMatch(md, /끝까지 마치지 못했습니다/);
  assert.match(formatApplyReport({ ...r, completed: false }), /⚠️ 요청한 작업이 미완료입니다/);
});

test('알림: 자동화 브라우저 이름으로 보낸다 (눌렀을 때 스크립트 편집기가 열리지 않게)', () => {
  assert.equal(
    notifyScript('제목', '내용', 'at.studio.asidebrowser'),
    'tell application id "at.studio.asidebrowser" to display notification "내용" with title "제목" sound name "Glass"',
  );
  assert.match(notifyScript('제목', '내용'), /^display notification "내용"/); // 앱을 모르면 그냥 알림
  const escaped = notifyScript('따옴표 "있음"', '역슬래시 \\ 있음', 'x');
  assert.ok(escaped.includes('with title "따옴표 \\"있음\\""'), escaped);
  assert.ok(escaped.includes('display notification "역슬래시 \\\\ 있음"'), escaped);
  assert.deepEqual(BUNDLE_ID, { aside: 'at.studio.asidebrowser', chrome: 'com.google.chrome' });
});


test('안내 확인칸을 자기소개서 완료로 세지 않고 미기록 빈칸을 없음으로 단정하지 않는다', () => {
  const base: ApplyReport = { company: '합성기업', link: 'https://example.test', startedAt: '', finishedAt: '', steps: ['basic', 'essay'], summary: '기본 지원서 저장, 상세 자소서는 다음 단계', blanks: [], notes: [], actions: [], agent: { text: '', isError: false }, completed: false, dir: '/tmp/synthetic', essay: { questions: [{ id: 1, question: '확인란', kind: 'notice', unit: 'chars' }], filled: [{ id: 1, ok: true, message: '입력됨' }] } };
  const report = formatApplyReport(base);
  assert.match(report, /자기소개서: 기록된 실제 자소서 문항 없음/);
  assert.match(report, /안내 확인·단답형: 1\/1항목 입력/);
  assert.match(report, /미입력 항목 목록이 기록되지 않았습니다/);
  assert.doesNotMatch(report, /자기소개서: 1\/1|비워둔 Value/);
  assert.match(formatApplyReport({ ...base, blanksReviewed: true }), /확인된 미입력 항목 없음/);
});
