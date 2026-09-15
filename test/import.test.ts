import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseSettings } from '../src/config';
import type { AgentRun } from '../src/llm/claude-cli';
import { paths } from '../src/paths';
import { applyImport, cleanImport, importProfileText, normalizeValue, previewChanges, schemaTemplate } from '../src/profile/import';
import { validateScalar, type ScalarField } from '../src/profile/schema';
import { freshProfile, tempDir } from './helpers';

const settings = parseSettings(readFileSync(paths.settingsExample, 'utf8'));
const f = (o: Partial<ScalarField>): ScalarField => ({ label: 'x', type: 'text', ...o }) as ScalarField;

test('형식 맞추기: 날짜, 숫자, 전화번호, 선택지', () => {
  assert.equal(normalizeValue(f({ type: 'date' }), '2028.07.27.'), '2028.07.27');
  assert.equal(normalizeValue(f({ type: 'month' }), '2022.3'), '2022.03');
  assert.equal(normalizeValue(f({ type: 'month' }), '2019-03-02'), '2019.03.02');
  assert.equal(normalizeValue(f({ type: 'number' }), '130학점'), '130');
  assert.equal(normalizeValue(f({ type: 'number' }), '1,000시간'), '1000');
  assert.equal(normalizeValue(f({ pattern: '^0\\d{1,2}-\\d{3,4}-\\d{4}$' }), '01012345678'), '010-1234-5678');
  assert.equal(normalizeValue(f({ type: 'select', options: ['주간', '야간'] }), ' 주간 '), '주간');
  assert.equal(validateScalar(f({ type: 'month' }), '2019.03.02'), null); // 연월 칸에 일까지 적어도 됨
  assert.match(validateScalar(f({ type: 'month' }), '2019.3') ?? '', /YYYY\.MM/);
});

test('정리: 항목에 없는 키는 모으고, 빈 목록 항목은 버린다', () => {
  const store = freshProfile();
  const { data, unknown } = cleanImport(store.schema, {
    basic: { name: { ko: '홍길동' }, phone: '01011112222', shoe_size: '270' },
    extras: { certificates: [{ name: '정보처리기사', date: '2024.9.10' }, { name: '' }] },
    target: { job_roles: '백엔드, 클라우드' },
    hobbies: ['등산'],
  });
  assert.deepEqual(data, {
    basic: { name: { ko: '홍길동' }, phone: '010-1111-2222' },
    extras: { certificates: [{ name: '정보처리기사', date: '2024.09.10' }] },
    target: { job_roles: ['백엔드', '클라우드'] },
  });
  assert.deepEqual(unknown.sort(), ['basic.shoe_size', 'hobbies']);
  assert.match(schemaTemplate(store.schema), /"emergency_relation": "비상연락처 관계/);
});

/** 가짜 AI: 붙여넣은 글과 상관없이 정해진 JSON 을 돌려준다 (예시 인물) */
const fakeAgent = (json: unknown) => {
  const calls: AgentRun[] = [];
  return {
    calls,
    run: async (o: AgentRun) => (calls.push(o), { text: `정리했습니다.\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``, isError: false }),
  };
};

test('붙여넣어 채우기: 미리보기(새로/바뀜/같음/형식 문제) → 고른 섹션만 적용, 빈 값은 기존 값을 지우지 않음', async () => {
  const store = freshProfile();
  store.set('basic.email', 'old@example.com');
  store.set('basic.nationality', '대한민국');
  store.addItem('extras.certificates', { name: '옛 자격증' });
  const ai = fakeAgent({
    profile: {
      basic: {
        name: { ko: '홍길동', en: 'HONG GIL DONG' },
        email: 'new@example.com',
        nationality: '대한민국',
        birth: '2000.13.40', // 틀린 날짜 → 넣지 않음
        military: { status: '군필', service_type: '보충역', start: '2021.01.15', end: '2022.10.14' },
        links: { github: 'https://github.com/example', more: [{ label: '포트폴리오(클라우드)', url: 'https://example.com/cloud', when: '클라우드/인프라 직무' }] },
      },
      education: { universities: [{ name: '예시대학교', degree: '학사', major: '컴퓨터공학', admitted: '2019.03.02', status: '졸업', credits: '130학점', rank: '26/102' }] },
      extras: { certificates: [{ name: '정보처리기사', date: '2024.09.10' }, { name: 'SQLD', date: '2024.06.21' }], computer_skills: [{ name: 'Java', category: '언어', level: '고급', years: '6년' }] },
      notes: { items: [{ subject: '비워 둘 칸', text: '지원분야, 추천인, 지원경로' }, { subject: '컴퓨터활용능력', text: '직무에 맞는 8~10개만' }] },
    },
    rules: ['증명사진은 직접 올리므로 사진 칸은 선택하지 않는다'],
  });
  const pv = await importProfileText('* 이름: 홍길동 …', { settings, store, cwd: tempDir(), runAgent: ai.run });
  assert.match(ai.calls[0].prompt, /## 붙여넣은 글\n\* 이름: 홍길동/);
  assert.match(ai.calls[0].prompt, /이미 입력된 값은 수정하거나 삭제하지 마세요/); // 기본 규칙을 보여 주고 중복은 빼게 함
  const by = Object.fromEntries(pv.changes.map((c) => [c.path, c]));
  assert.equal(by['basic.name.ko'].kind, 'new');
  assert.equal(by['basic.email'].kind, 'changed');
  assert.equal(by['basic.nationality'].kind, 'same');
  assert.match(by['basic.birth'].error ?? '', /YYYY\.MM\.DD/);
  assert.equal(by['extras.certificates'].kind, 'changed');
  assert.match(by['extras.certificates'].after, /2개 — 정보처리기사/);
  assert.deepEqual(pv.rules, ['증명사진은 직접 올리므로 사진 칸은 선택하지 않는다']);

  const r = applyImport(store, pv.data, ['basic', 'education', 'extras', 'notes']);
  assert.equal(store.get('basic.name.ko'), '홍길동');
  assert.equal(store.get('basic.email'), 'new@example.com');
  assert.equal(store.get('basic.birth'), ''); // 틀린 값은 넣지 않음
  assert.match(r.skipped.join(), /생년월일/);
  assert.equal(store.get('basic.links.more.0.when'), '클라우드/인프라 직무');
  assert.deepEqual((store.get('extras.certificates') as { name: string }[]).map((c) => c.name), ['정보처리기사', 'SQLD']); // 목록은 바꿈
  assert.equal(store.get('education.universities.0.credits'), '130');
  assert.equal(store.get('education.universities.0.admitted'), '2019.03.02');
  assert.equal(store.get('notes.items.1.subject'), '컴퓨터활용능력');

  // 고르지 않은 섹션은 그대로, 다시 가져와도 빈 값으로 지우지 않음
  applyImport(store, { basic: { name: { ko: '' }, email: 'again@example.com' } }, ['education']);
  assert.equal(store.get('basic.email'), 'new@example.com');
  applyImport(store, { basic: { name: { ko: '' }, gender: '남' } }, ['basic']);
  assert.equal(store.get('basic.name.ko'), '홍길동');
  assert.equal(store.get('basic.gender'), '남');

  const again = previewChanges(store.schema, pv.data, store.toJSON(), store.filesDir);
  assert.equal(again.find((c) => c.path === 'extras.certificates')!.kind, 'same');
});

test('붙여넣어 채우기: 빈 글이나 AI 오류는 바로 알려 준다', async () => {
  const store = freshProfile();
  await assert.rejects(importProfileText('   ', { settings, store, cwd: tempDir() }), /붙여넣은 글이 없습니다/);
  await assert.rejects(importProfileText('글', { settings, store, cwd: tempDir(), runAgent: async () => ({ text: '사용량 한도', isError: true }) }), /사용량 한도/);
});
