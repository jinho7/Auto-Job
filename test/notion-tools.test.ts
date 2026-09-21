import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSettings } from '../src/config';
import { paths } from '../src/paths';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { notionToolset, type NotionProgress } from '../src/apply/notion-tools';
import { blockText } from '../src/notion/client';
import { notionFixture } from './fixtures/notion-api';

function harness() {
  const controller = new AbortController(), f = notionFixture(controller.signal);
  const state: NotionProgress = { available: true, verified: false };
  const api = notionToolset({ client: f.client, pageId: f.pageId, state, signal: controller.signal });
  return { ...f, state, api, controller, call: async (name: string, args = {}) => JSON.parse((await api.call(name, args)).content.filter(c => c.type === 'text').map(c => c.text).join('')) };
}
test('기존 템플릿에 답변을 넣고 재조회하며 재시도 중복과 사용자 메모 손상을 막는다', async () => {
  const h = harness(); await h.call('notion_read_page');
  const args = { after_block_id: h.headingId, blocks: [{ type: 'paragraph', text: '1. 문항\n작성한 답변' }, { type: 'paragraph', text: '4번: 가정한 초안. 사이트 임시저장 미완료.' }] };
  const added = await h.call('notion_append_blocks', args); assert.equal(added.verified, true);
  assert.equal(h.state.verified, false);
  const count = h.requests.filter(r => r.method === 'PATCH').length;
  assert.equal((await h.call('notion_append_blocks', args)).already_present, true);
  assert.equal(h.requests.filter(r => r.method === 'PATCH').length, count);
  await h.call('notion_verify', { block_ids: added.blocks.map((b: any) => b.id), summary: '답변과 저장 대기 상태를 정리했습니다' });
  assert.equal(h.state.verified, true); assert.equal(h.state.blocks, 2);
  assert.equal(blockText(h.tree.get(h.pageId)![0]), '사용자가 직접 적은 메모');
  assert.ok(h.requests.some(r => r.method === 'GET' && r.path.includes('/children')));
});
test('이미 내용이 있는 답변은 동시 변경을 확인하고 갱신할 수 있다', async () => {
  const h = harness(); await h.call('notion_read_page');
  const added = await h.call('notion_append_blocks', { blocks: [{ type: 'paragraph', text: '이전 답변' }] });
  const blockId = added.blocks[0].id;
  await assert.rejects(h.call('notion_update_block', { block_id: blockId, expected_text: '틀린 이전값', text: '새 답변' }), /본문이 바뀌/);
  await h.call('notion_update_block', { block_id: blockId, expected_text: '이전 답변', text: '새 답변' });
  assert.equal(blockText(h.tree.get(h.pageId)!.at(-1)!), '새 답변');
  // An external edit after write must be noticed by final verification.
  h.tree.get(h.pageId)!.at(-1)!.paragraph = { rich_text: [{ plain_text: '사용자가 다시 수정' }] };
  await assert.rejects(h.call('notion_verify', { block_ids: [blockId], summary: '완료' }), /변경/);
  assert.equal(h.state.verified, false);
});
test('다른 공고·옮겨진 블록·하위 페이지로 넘어가지 않고 중지 토큰은 요청을 보내지 않는다', async () => {
  const h = harness(); await h.call('notion_read_page');
  await assert.rejects(h.call('notion_read_page', { parent_id: randomUUID() }), /먼저 읽은/);
  h.tree.set(h.pageId, h.tree.get(h.pageId)!.filter(b => b.id !== h.memoId));
  await assert.rejects(h.call('notion_update_block', { block_id: h.memoId, expected_text: '사용자가 직접 적은 메모', text: '삭제' }), /이동/);
  const child = h.block(randomUUID(), 'child_page', '다른 페이지'); h.tree.get(h.pageId)!.push(child);
  await h.call('notion_read_page'); await assert.rejects(h.call('notion_read_page', { parent_id: child.id }), /편집 범위/);
  h.controller.abort(); const count = h.requests.length;
  await assert.rejects(h.call('notion_append_blocks', { blocks: [{ type: 'paragraph', text: '중지 뒤 쓰기' }] }));
  assert.equal(h.requests.length, count);
});
test('403과 반영되지 않은 쓰기를 성공으로 보고하지 않고 응답만 유실된 쓰기는 복구한다', async () => {
  const h = harness(); const args = { blocks: [{ type: 'paragraph', text: '답변 내용' }] };
  h.setFailure('forbidden'); await assert.rejects(h.call('notion_append_blocks', args), /권한/); assert.equal(h.state.verified, false);
  h.setFailure('ignore'); await assert.rejects(h.call('notion_append_blocks', args), /확인하지 못/); assert.equal(h.state.verified, false);
  h.setFailure('lost-response'); const result = await h.call('notion_append_blocks', args); assert.equal(result.verified, true);
  assert.equal(h.tree.get(h.pageId)!.filter(b => blockText(b) === '답변 내용').length, 1);
  assert.ok(!JSON.stringify(h.state).includes('synthetic-notion-token'));
});
test('접힌 섹션도 같은 페이지 안에서 읽고 정리한다', async () => {
  const h = harness(); const parent = randomUUID();
  h.tree.get(h.pageId)!.push({ ...h.block(parent, 'toggle', '작성 기록'), has_children: true }); h.tree.set(parent, []);
  await h.call('notion_read_page'); await h.call('notion_read_page', { parent_id: parent });
  const result = await h.call('notion_append_blocks', { parent_id: parent, blocks: [{ type: 'paragraph', text: '저장은 사용자 인증 대기' }] });
  await h.call('notion_verify', { block_ids: [result.blocks[0].id], summary: '노션 기록 완료, 사이트 인증 대기' });
  assert.equal(h.state.verified, true);
});

test('작성 상태 변경도 실제 반영을 확인하며 사이트 저장을 주장하지 않는다', async () => {
  const f = notionFixture(), settings = parseSettings(readFileSync(paths.settingsExample, 'utf8'));
  const state: NotionProgress = { available: true, verified: false };
  const api = notionToolset({ client: f.client, pageId: f.pageId, settings, state });
  f.setFailure('ignore'); await assert.rejects(api.call('notion_mark_drafting', {}));
  assert.equal(state.verified, false);
  f.setFailure('none'); await api.call('notion_mark_drafting', {});
  assert.equal(state.status, '작성중'); assert.equal(state.verified, false);
});
