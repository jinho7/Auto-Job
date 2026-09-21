import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseSettings } from '../src/config';
import { prepareSearch } from '../src/jobs/search-plan';
import { SeenStore } from '../src/jobs/seen';
import { PoliteHttp } from '../src/http';
import type { RunAgent } from '../src/llm';
import { paths } from '../src/paths';
import { formatReport, runCollect } from '../src/pipeline/collect';
import { hasSearchProfile, readSearchCorpus, searchBatches, searchProfile } from '../src/profile/search-sources';
import { tempDir } from './helpers';

const settings = () => parseSettings(readFileSync(paths.settingsExample, 'utf8'));
const folderProfile = (dir: string) => ({ stories: { folders: [{ path: dir }] } });
function planner(keyword: string, quote: string, prompts: string[] = []): RunAgent {
  return async (o) => {
    prompts.push(o.prompt);
    assert.deepEqual(o.tools, []);
    assert.equal(o.isolated, true);
    assert.equal(o.readDirs, undefined);
    const input = JSON.parse(o.prompt);
    if (input.documents) {
      const doc = input.documents.find((d: { text: string }) => d.text.includes(quote));
      return { isError: false, text: JSON.stringify({ evidence: doc ? [{ source: doc.source, quote, fact: quote }] : [] }), costUsd: 0.01 };
    }
    return { isError: false, text: JSON.stringify({ directions: [{ role: keyword, keywords: [keyword, keyword.toUpperCase()], reason: `${quote} 경험으로 탐색`, evidence_ids: [input.evidence[0].id] }], warnings: [] }), costUsd: 0.02 };
  };
}

test('검색 자료: 연락처만 있는 프로필은 근거가 아니며 직무 정보만 전달한다', () => {
  const personal = { basic: { name: '개인 이름', email: 'secret@example.test' }, extras: { certificates: [{ name: '합성 자격', number: 'SECRET-ID' }] } };
  assert.equal(hasSearchProfile({ basic: personal.basic }), false);
  const text = JSON.stringify(searchProfile(personal));
  assert.match(text, /합성 자격/);
  assert.doesNotMatch(text, /secret|SECRET-ID|개인 이름/);
  assert.equal(hasSearchProfile({ target: { job_roles: ['회계'] } }), true);
});

test('폴더 자료: 긴 파일 끝까지 분석하고 수정된 파일도 다음 수집에 반영한다', async () => {
  const folder = tempDir(), cwd = tempDir();
  const file = path.join(folder, '경험.md');
  writeFileSync(file, '문서 앞부분\n'.repeat(6500) + '\n결산 자동화 경험');
  const calls: string[] = [];
  const first = await prepareSearch(settings(), folderProfile(folder), { cwd, runAgent: planner('회계', '결산 자동화 경험', calls) });
  assert.deepEqual(first.keywords, ['회계']);
  assert.equal(first.filesRead, 1);
  assert.ok(calls.length > 2); // Multiple complete reading batches, then synthesis.
  assert.equal(first.evidence[0].source, file);
  assert.deepEqual(readdirSync(cwd), []); // No raw agent transcript remains.
  writeFileSync(file, '브랜드 디자인 경험');
  const second = await prepareSearch(settings(), folderProfile(folder), { cwd, runAgent: planner('디자인', '브랜드 디자인 경험') });
  assert.deepEqual(second.keywords, ['디자인']);
  assert.doesNotMatch(JSON.stringify(second.evidence), /결산/);
});

test('파일 읽기: 중복 폴더와 외부 symlink 제외, PDF 추출 실패를 명시한다', async () => {
  const dir = tempDir(), outside = tempDir();
  writeFileSync(path.join(dir, '경험.md'), '물류 경험');
  writeFileSync(path.join(dir, '이력서.pdf'), 'synthetic-pdf');
  writeFileSync(path.join(outside, 'private.md'), 'OUTSIDE');
  symlinkSync(path.join(outside, 'private.md'), path.join(dir, 'link.md'));
  const profile = { stories: { folders: [{ path: dir }, { path: dir }, { path: path.join(dir, 'missing') }] } };
  const corpus = await readSearchCorpus(profile, async () => { throw new Error('PDF 읽기 실패'); });
  assert.equal(corpus.filesRead, 1);
  assert.match(corpus.warnings.join(), /PDF 읽기 실패/);
  assert.match(corpus.warnings.join(), /폴더가 없습니다/);
  assert.doesNotMatch(JSON.stringify(corpus.documents), /OUTSIDE/);
  const pdf = await readSearchCorpus(folderProfile(dir), async () => '추출된 PDF의 자재 관리 경험');
  assert.equal(pdf.filesRead, 2);
  assert.ok(pdf.documents.some(d => d.text.includes('자재 관리')));
});

test('분할은 긴 문서와 여러 문서의 내용을 누락하지 않는다', () => {
  const documents = [{ source: 'a', text: '1234567890123' }, { source: 'b', text: 'abcdef' }];
  const batches = searchBatches(documents, 5);
  for (const doc of documents) assert.equal(batches.flat().filter(x => x.source === doc.source).map(x => x.text).join(''), doc.text);
});

test('검색어는 선택: 개인 자료 없을 때만 명시적인 수동 검색을 유지하고 부족하면 안내한다', async () => {
  const s = settings(), cwd = tempDir();
  const noAi: RunAgent = async () => { throw new Error('AI를 부르면 안 됨'); };
  await assert.rejects(prepareSearch(s, {}, { cwd, runAgent: noAi }), /자료가 없습니다/);
  s.collect.keywords = [' 품질관리 ', '품질관리'];
  const manual = await prepareSearch(s, {}, { cwd, runAgent: noAi });
  assert.equal(manual.mode, 'manual'); assert.deepEqual(manual.keywords, ['품질관리']);
  assert.match(manual.warnings.join(), /개인 자료가 없어/);
  await assert.rejects(prepareSearch(s, folderProfile(path.join(cwd, 'missing')), { cwd, runAgent: noAi }), /자료를 읽지 못했습니다/);
});

test('근거 위조나 AI 실패는 임의 직무 또는 수동 검색으로 조용히 대체하지 않는다', async () => {
  const s = settings(); s.collect.keywords = ['추가어'];
  const profile = { target: { job_roles: ['디자인'] } }, cwd = tempDir();
  await assert.rejects(prepareSearch(s, profile, { cwd, runAgent: async () => ({ isError: true, text: 'oops' }) }), /AI 분석에 실패/);
  await assert.rejects(prepareSearch(s, profile, { cwd, runAgent: async () => ({ isError: false, text: JSON.stringify({ evidence: [{ source: '내 정보', quote: '존재하지 않는 경험', fact: '허위' }] }) }) }), /확인 가능한/);
  let step = 0;
  await assert.rejects(prepareSearch(s, profile, { cwd, runAgent: async () => ({ isError: false, text: JSON.stringify(++step === 1
    ? { evidence: [{ source: '내 정보', quote: '디자인', fact: '디자인 희망' }] }
    : { directions: [{ role: '설계', keywords: ['설계'], reason: '추론', evidence_ids: ['does-not-exist'] }] }) }) }), /근거가 있는 검색 직무/);
  assert.deepEqual(readdirSync(cwd), []);
});

test('수집 통합: 개인 자료 검색어를 실제 수집기에 전달하고 수동 값과 설정은 보존한다', async () => {
  const s = settings(); s.collect.keywords = ['노무'];
  const original = structuredClone(s);
  let received: string[] = [];
  const cwd = tempDir();
  const report = await runCollect({ settings: s, profile: { target: { job_roles: ['회계'] } }, cwd,
    http: new PoliteHttp(), browserPage: async () => { throw new Error('브라우저 사용 없음'); }, seen: new SeenStore(path.join(cwd, 'seen.json')), notion: null, dryRun: true,
    collectors: [{ id: 'fake', label: '합성 수집기', status: 'ok', method: 'http', note: '', collect: async (ctx) => { received = ctx.settings.collect.keywords; return []; } }], sources: ['fake'],
    runAgent: planner('회계', '회계') });
  assert.deepEqual(received, ['회계', '노무']);
  assert.deepEqual(s, original);
  assert.equal(report.searchPlan?.mode, 'profile');
  assert.equal(report.ai.costUsd, 0.03);
  assert.match(formatReport(report), /내 자료 기반 검색/);
  assert.match(formatReport(report), /근거: 내 정보/);
});
