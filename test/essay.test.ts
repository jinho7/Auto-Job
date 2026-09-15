import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeQuestions } from '../src/apply/run';
import { parseSettings, type Settings } from '../src/config';
import { blindTermsFromProfile, checkEssay, countChars, parseLimit, parseQuestionsText, targetRange } from '../src/essay/checks';
import { formatEssays, styleRules, writeEssays } from '../src/essay/pipeline';
import type { EssayQuestion } from '../src/essay/types';
import { extractJson, type AgentRun } from '../src/llm/claude-cli';
import { paths } from '../src/paths';
import { freshProfile, tempDir } from './helpers';

const base = parseSettings(readFileSync(paths.settingsExample, 'utf8'));
const essay = (over: Partial<Settings['essay']> = {}): Settings['essay'] => ({ ...base.essay, ...over });

test('글자수: 공백 포함 / 공백 제외 / 바이트', () => {
  assert.equal(countChars('가나 다', 'chars'), 4);
  assert.equal(countChars('가나 다', 'chars_no_space'), 3);
  assert.equal(countChars('가a 1', 'bytes'), 5);
  assert.equal(countChars('😀가', 'chars'), 2); // 이모지도 한 글자
});

test('문항 글에서 글자수 제한 읽기', () => {
  assert.deepEqual(parseLimit('지원 동기를 쓰세요 (700자 이내)'), { maxChars: 700, unit: 'chars' });
  assert.deepEqual(parseLimit('최소 300자, 최대 1,000자 (공백 포함)'), { maxChars: 1000, minChars: 300, unit: 'chars' });
  assert.deepEqual(parseLimit('500 ~ 800자'), { minChars: 500, maxChars: 800, unit: 'chars' });
  assert.deepEqual(parseLimit('공백 제외 500자'), { maxChars: 500, unit: 'chars_no_space' });
  assert.deepEqual(parseLimit('1000byte 이내'), { maxChars: 1000, unit: 'bytes' });
  assert.deepEqual(parseLimit('자유롭게 쓰세요'), { unit: 'chars' });
  const qs = parseQuestionsText('1. 지원 동기 (700자 이내)\n\n2. 협업 경험을 쓰세요.\n최대 500자\n3. 입사 후 포부 (300자)');
  assert.deepEqual(qs.map((q) => [q.id, q.maxChars]), [[1, 700], [2, 500], [3, 300]]);
  assert.deepEqual(targetRange({ id: 1, question: '', unit: 'chars', maxChars: 1000 }), { min: 900, max: 1000 });
});

const q = (over: Partial<EssayQuestion> = {}): EssayQuestion => ({ id: 1, question: '지원 동기', unit: 'chars', maxChars: 100, ...over });
const long = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);

test('기계 검사: 글자수, 금지 표현, 가운뎃점, 소제목, 끝맺음, 블라인드, 반복', () => {
  const body = `[측정으로 찾은 병목]\n${long('저는 부하를 측정해 원인을 찾았습니다. ', 70)}`;
  const ok = checkEssay(q(), { id: 1, text: body.slice(0, 95) }, essay({ subtitle: true }), []);
  assert.deepEqual(ok.issues, []);

  const over = checkEssay(q(), { id: 1, text: `[제목]\n${long('가', 120)}` }, essay(), []);
  assert.match(over.issues.join(), /글자수 초과/);

  const short = checkEssay(q(), { id: 1, text: '[제목]\n짧습니다.' }, essay(), []);
  assert.match(short.warnings.join(), /분량이 적습니다/);

  const bad = checkEssay(
    q({ maxChars: 500 }),
    { id: 1, text: '단순한 개발자가 아닌 사람입니다. 기획·개발을 했다. 가나다대학교에서 배웠습니다. ○○○○○○' },
    essay({ subtitle: true, forbid_middle_dot: true, banned_phrases: ['단순한 ~가 아닌'] }),
    ['가나다대학교'],
  );
  const all = bad.issues.join(' | ');
  assert.match(all, /쓰지 않을 표현/);
  assert.match(all, /가운뎃점/);
  assert.match(all, /소제목/);
  assert.match(all, /블라인드.*가나다대학교/);
  assert.match(all, /같은 글자 반복/);
  assert.match(bad.warnings.join(), /습니다/);
});

test('블라인드 단어는 내 정보의 이름, 학교, 동아리에서', () => {
  const store = freshProfile();
  store.set('basic.name.ko', '홍길동');
  store.set('education.high_school.name', '가나다고등학교');
  store.addItem('education.universities', { name: '라마바대학교' });
  store.addItem('extras.activities', { type: '동아리', name: '코딩클럽', organization: '사아자' });
  assert.deepEqual(blindTermsFromProfile(store.toJSON()).sort(), ['가나다고등학교', '라마바대학교', '사아자', '코딩클럽', '홍길동'].sort());
  const rules = styleRules(essay({ blind: true, forbid_middle_dot: true, banned_phrases: ['~를 넘어'] }), ['홍길동']);
  assert.match(rules, /습니다/);
  assert.match(rules, /가운뎃점/);
  assert.match(rules, /홍길동/);
  assert.match(rules, /"~를 넘어"/);
});

test('JSON 꺼내기와 문항 정리', () => {
  assert.deepEqual(extractJson('설명\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('앞 {"b":2} 뒤'), { b: 2 });
  assert.throws(() => extractJson('없음'), /JSON/);
  const qs = normalizeQuestions([
    { question: '지원 동기 (700자 이내)', ref: 'f0-3' },
    { question: '협업 경험', ref: 'f0-5', maxChars: '500', unit: 'chars_no_space' },
    { question: '' },
  ]);
  assert.deepEqual(qs, [
    { id: 1, question: '지원 동기 (700자 이내)', unit: 'chars', maxChars: 700, ref: 'f0-3' },
    { id: 2, question: '협업 경험', unit: 'chars_no_space', maxChars: 500, ref: 'f0-5' },
  ]);
});

test('작성 흐름: 초안 → 검토(고칠 것 있음) → 고쳐 쓰기 → 글자수 문제 고치기', async () => {
  const store = freshProfile();
  store.addItem('stories.items', { title: '부하 테스트', action: '측정했다' });
  const questions: EssayQuestion[] = [q({ id: 1, maxChars: 60 }), q({ id: 2, question: '협업', maxChars: 60 })];
  const calls: AgentRun[] = [];
  const replies = [
    // 1. 초안: 2번이 너무 김
    '```json\n{"research":{"company_summary":"가짜 회사","values":["도전"],"recent":[],"role":"백엔드","sources":["https://x"]},"strategy":[{"id":1,"intent":"동기","stories":["부하 테스트"],"angle":"측정"}],"answers":[{"id":1,"text":"[측정] 저는 측정해 원인을 찾았습니다. 그 과정을 좋아합니다. 그래서 지원했습니다."},{"id":2,"text":"[협업] ' + '가'.repeat(80) + '"}]}\n```',
    // 2. 검토: 1번에 근거 없는 내용
    '```json\n{"reviews":[{"id":1,"verdict":"revise","unsupported_claims":["수상 경력"],"problems":[],"suggestions":[]},{"id":2,"verdict":"ok"}]}\n```',
    // 3. 고쳐 쓰기: 2번은 여전히 김
    '```json\n{"answers":[{"id":1,"text":"[측정으로 찾은 원인] 저는 부하를 측정해 원인을 찾았습니다. 그래서 지원했습니다."},{"id":2,"text":"[협업] ' + '나'.repeat(70) + '"}]}\n```',
    // 4. 형식 고치기: 2번만
    '```json\n{"answers":[{"id":2,"text":"[함께 정한 기준] 저는 팀원과 기준을 정해 갈등을 풀었습니다. 결과를 공유했습니다."}]}\n```',
  ];
  const fake = async (o: AgentRun) => {
    calls.push(o);
    return { text: replies.shift() ?? '{}', isError: false, costUsd: 0.01 };
  };
  const r = await writeEssays(
    { company: '가짜회사', role: '백엔드', questions },
    { settings: { ...base, essay: essay({ subtitle: true, max_revisions: 1 }) }, profile: store.toJSON(), schema: store.schema, cwd: tempDir(), runAgent: fake },
  );
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].tools, ['WebSearch', 'WebFetch']); // 조사·작성은 웹 검색만
  assert.deepEqual(calls[3].tools, []); // 형식 고치기는 도구 없음
  assert.match(calls[0].prompt, /부하 테스트/); // 자소서 소재가 들어간다
  assert.match(calls[2].prompt, /수상 경력/); // 검토 의견이 고쳐 쓰기에 들어간다
  assert.equal(r.rounds, 1);
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.ok(r.answers.every((a) => countChars(a.text, 'chars') <= 60));
  assert.equal(r.costUsd.toFixed(2), '0.04');
  const md = formatEssays(r);
  assert.match(md, /## 회사 조사/);
  assert.match(md, /## 1\. 지원 동기/);
  assert.match(md, /근거 없다고 지적되어 고쳐 쓴 내용.*\n- 1번: 수상 경력/);
  assert.equal(r.reviewedBeforeLastRevision, true);
});

test('작성 흐름: AI 가 오류로 끝나면 알려준다', async () => {
  const store = freshProfile();
  await assert.rejects(
    writeEssays({ company: 'x', role: '', questions: [q()] }, { settings: base, profile: store.toJSON(), schema: store.schema, cwd: tempDir(), runAgent: async () => ({ text: '사용량 한도', isError: true }) }),
    /사용량 한도/,
  );
});

test('소재 폴더: md·txt·pdf 만, 숨김·node_modules 제외, 없는 폴더는 이유', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const path = (await import('node:path')).default;
  const { scanFolder, sourceIndex, inlineSources } = await import('../src/essay/sources');
  const dir = tempDir();
  mkdirSync(path.join(dir, '프로젝트'), { recursive: true });
  mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  writeFileSync(path.join(dir, '프로젝트', '회고.md'), '# 채팅 서버\n동시 접속 500명 처리');
  writeFileSync(path.join(dir, '이력서.pdf'), '%PDF-1.4');
  writeFileSync(path.join(dir, '메모.txt'), '동아리 활동');
  writeFileSync(path.join(dir, '사진.png'), 'x');
  writeFileSync(path.join(dir, 'node_modules', 'x', 'README.md'), 'no');
  writeFileSync(path.join(dir, '.git', 'HEAD.md'), 'no');
  const f = scanFolder(dir, '경험 정리');
  assert.equal(f.ok, true);
  assert.deepEqual(f.files.map((x) => x.rel).sort(), ['메모.txt', '이력서.pdf', path.join('프로젝트', '회고.md')].sort());
  assert.match(sourceIndex([f]), /회고\.md \(md/);
  const inline = inlineSources([f]);
  assert.match(inline.text, /동시 접속 500명/);
  assert.match(inline.skipped.join(), /이력서\.pdf/);
  assert.deepEqual([scanFolder(path.join(dir, '없음')).ok, scanFolder(path.join(dir, '메모.txt')).error], [false, '폴더가 아닙니다']);
});

test('작성 흐름: 소재 폴더가 있으면 먼저 폴더만 읽어 소재를 찾고(웹 없음), 찾은 소재로 쓴다', async () => {
  const { writeFileSync } = await import('node:fs');
  const path = (await import('node:path')).default;
  const dir = tempDir();
  writeFileSync(path.join(dir, '회고.md'), '채팅 서버');
  const store = freshProfile();
  store.addItem('stories.folders', { path: dir });
  const calls: AgentRun[] = [];
  const fake = async (o: AgentRun) => {
    calls.push(o);
    if (/소재 찾기/.test(o.systemAppend)) return { text: '```json\n{"materials":[{"title":"채팅 서버 개발","source":"회고.md","facts":"동시 접속 500명","fits":[1]}],"read":["회고.md"]}\n```', isError: false };
    return { text: '```json\n{"answers":[{"id":1,"text":"[채팅] 동시 접속 500명을 처리했습니다."}]}\n```', isError: false };
  };
  const r = await writeEssays({ company: 'A', role: '백엔드', questions: [q({ maxChars: 0 })] }, { settings: { ...base, essay: essay({ subtitle: true, max_revisions: 0 }) }, profile: store.toJSON(), schema: store.schema, cwd: tempDir(), runAgent: fake });
  const gather = calls[0];
  assert.deepEqual(gather.tools, ['Read', 'Glob', 'Grep']); // 웹 도구 없음
  assert.deepEqual(gather.readDirs, [dir]);
  assert.match(gather.prompt, /회고\.md/);
  assert.ok(!calls[1].readDirs && calls[1].tools?.includes('WebSearch')); // 글쓰기는 웹만, 파일은 못 읽음
  assert.match(calls[1].prompt, /소재 폴더에서 찾은 소재[\s\S]*동시 접속 500명/);
  assert.equal(r.materials?.items[0].title, '채팅 서버 개발');
  assert.match(formatEssays(r), /## 소재 폴더에서 찾은 소재/);

  // 파일을 직접 못 읽는 AI 연결 방식: 글 파일 내용을 붙여 주고 파일 도구는 주지 않는다
  calls.length = 0;
  await writeEssays({ company: 'A', role: '', questions: [q({ maxChars: 0 })] }, { settings: { ...base, llm: { ...base.llm, backend: 'anthropic-api' }, essay: essay({ max_revisions: 0 }) }, profile: store.toJSON(), schema: store.schema, cwd: tempDir(), runAgent: fake });
  assert.deepEqual([calls[0].tools, calls[0].readDirs], [[], undefined]);
  assert.match(calls[0].prompt, /=== 회고\.md ===\n채팅 서버/);
});
