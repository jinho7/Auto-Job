// 모든 테스트 파일의 첫 import. src/paths 가 읽히기 전에 개인 데이터 위치를 임시 폴더로 바꾸고,
// 실제 토큰/키가 테스트에 섞이지 않게 환경 변수를 지운다.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.AUTOJOB_HOME = mkdtempSync(path.join(tmpdir(), 'autojob-home-'));
for (const k of ['NOTION_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];
