import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { preResearch, preResearchContent, preResearchDoc } from '../src/apply/research';
import { parseSettings } from '../src/config';
import type { AgentRun } from '../src/llm/claude-cli';
import { sectionBlocks } from '../src/notion/page-fill';
import { paths } from '../src/paths';
import { tempDir } from './helpers';

const settings = parseSettings(readFileSync(paths.settingsExample, 'utf8'));

test('지원 전 정리: 페이지 글과 희망 직무로 AI 에게 묻고, 지원 직무·절차·회사 소개를 Notion 내용으로 바꾼다', async () => {
  const calls: AgentRun[] = [];
  const res = await preResearch({
    settings,
    company: '가나다',
    link: 'https://careers.example/1',
    notionRoles: '백엔드',
    pageText: '모집 부문: 백엔드 개발 / 데이터 엔지니어\n전형 절차: 서류 → 코딩테스트 → 면접',
    profileDoc: '- 희망 직무: 백엔드',
    cwd: tempDir(),
    runAgent: async (o) => {
      calls.push(o);
      return {
        isError: false,
        text: '```json\n' + JSON.stringify({
          roles: [{ title: '백엔드 개발', description: '결제 서버' }, { title: '데이터 엔지니어' }],
          chosen: { title: '백엔드 개발', description: '결제 서버', reason: '희망 직무가 백엔드' },
          procedure: ['서류', '코딩테스트', '면접'],
          procedure_source: 'page',
          company: { summary: '결제 회사', values: ['도전'], sources: ['https://example.com'] },
        }) + '\n```',
      };
    },
  });
  assert.deepEqual(calls[0].tools, ['WebSearch', 'WebFetch']); // 브라우저·파일 도구 없음
  assert.match(calls[0].prompt, /## 지원 페이지에 보이는 글 \(자료\)\n모집 부문/);
  assert.match(calls[0].prompt, /희망 직무: 백엔드/);
  const content = preResearchContent(res);
  assert.deepEqual(content.procedure, ['서류', '코딩테스트', '면접']);
  assert.equal(content.role?.title, '백엔드 개발');
  assert.match(content.role?.description ?? '', /고른 이유: 희망 직무가 백엔드\n다른 모집 직무: 데이터 엔지니어/);
  assert.equal(sectionBlocks('role', content).length > 0, true);
  assert.match(preResearchDoc(res), /지원 직무: 백엔드 개발 — 결제 서버\n전형 절차: 서류 → 코딩테스트 → 면접/);
});

test('지원 전 정리: 직무를 못 고르면 지원 직무 섹션은 비우고, 절차가 없으면 절차도 비운다', () => {
  const content = preResearchContent({ roles: [], chosen: null, procedure: [], company: { summary: '회사' } });
  assert.deepEqual([content.role, content.procedure, content.company?.summary], [undefined, undefined, '회사']);
});
