import './setup-env';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { applicationToolset, type AgentTaskState } from '../src/apply/agent-tools';
import type { ApplicationBrowser } from '../src/apply/agent-tools';
import { parseSettings } from '../src/config';
import { paths } from '../src/paths';
import { tempDir } from './helpers';

function harness(profile: Record<string, unknown> = {}, request = '', notionRequired = false) {
  const settings = parseSettings(readFileSync(paths.settingsExample, 'utf8'));
  const state: AgentTaskState = { questions: [], answers: [], filled: [] };
  let visible = '임시저장', missing: string[] = [];
  let savedBefore: string | undefined, changed = '';
  const values: Record<string, string> = { 'f0-1': '', 'f0-2': '기존 답변' };
  const writes: unknown[] = [];
  const controller = new AbortController();
  const tools = {
    isOwnEdit: async() => false,
    isAnswerField: async(ref: string) => ref === 'f0-1' || ref === 'f0-2',
    missingRequired: async() => missing,
    pageText: async() => visible,
    saveObservation: async() => savedBefore === undefined ? undefined : ({ label: '임시저장', before: savedBefore, visible, changed, dialogs: [] }),
    invalidateSave: async() => { savedBefore = undefined; },
    fill: async(ref: string,text: string,options: {replace?:boolean}) => { writes.push({ref,text,options}); if (!values[ref] || options?.replace) values[ref] = text; return '입력 결과'; },
    valueOf: async(ref: string) => values[ref],
  } as unknown as ApplicationBrowser;
  const api = applicationToolset({ settings, state, tools, profile, notionRequired, context: { latest_request: request, profile }, request, signal: controller.signal,
    browser: {list:()=>[],call:async(name)=>{ if (name === 'browser_click') { savedBefore = visible; changed = ''; } return {content:[]}; }} });
  return { api, state, writes, controller, setVisible:(v:string)=>{visible=v;}, setChanged:(v:string)=>{changed=v;}, setMissing:(v:string[])=>{missing=v;}, values };
}

test('같은 에이전트 도구로 문맥과 자료를 읽고 임의 경로는 읽지 않는다', async()=>{
  const folder=tempDir();writeFileSync(path.join(folder,'경험.md'),'회계 결산 검토 경험');
  const h=harness({stories:{folders:[{path:folder,note:'본인 경험만 있음'}]}},'자료로 작성해');
  const list=await h.api.call('sources',{});assert.match(JSON.stringify(list),/경험.md/);
  assert.match(JSON.stringify(await h.api.call('read_source',{id:0})),/회계 결산/);
  await assert.rejects(h.api.call('read_source',{id:999}),/없는 자료/);
  assert.match(JSON.stringify(await h.api.call('context',{})),/자료로 작성해/);
  assert.ok(!h.api.list().some(t=>t.name==='run_application'));
  h.controller.abort();await assert.rejects(h.api.call('read_source',{id:0}));
});

test('답변 수정은 서술형 입력칸에서 진행하고 재작성 요청을 도구 인용 절차로 막지 않는다', async()=>{
  const h=harness({},'2번 문항만 다시 써 줘');
  await assert.rejects(h.api.call('set_questions',{questions:[{id:1,ref:'name-field',question:'이름'}]}),/서술형/);
  await h.api.call('set_questions',{questions:[{id:1,ref:'f0-1',question:'경험'},{id:2,ref:'f0-2',question:'동기'}]});
  await h.api.call('write_answer',{id:2,text:'새 답변',replace:true});
  assert.equal(h.values['f0-2'],'새 답변');assert.equal(h.values['f0-1'],'');assert.equal(h.writes.length,1);
});

test('저장 클릭만으로 완료하지 않고 새로 관찰한 성공 근거와 필수 입력을 확인한다', async()=>{
  const h=harness();
  await h.api.call('browser_click',{});assert.equal(h.state.save?.ok,undefined);
  await assert.rejects(h.api.call('confirm_saved',{evidence:'임시저장'}),/새로 나타난/);
  await assert.rejects(h.api.call('confirm_saved',{evidence:'없는 성공 안내'}),/새로 나타난/);
  await h.api.call('finish',{status:'completed',summary:'작성함',remaining:[]});assert.equal(h.state.finish?.status,'incomplete');
  h.setVisible('임시저장\n임시저장이 완료되었습니다');await h.api.call('confirm_saved',{evidence:'임시저장이 완료되었습니다'});
  h.setMissing(['비밀번호']);await h.api.call('finish',{status:'completed',summary:'작성함',remaining:[]});assert.equal(h.state.finish?.status,'incomplete');assert.match(h.state.finish!.remaining.join(),/비밀번호/);
  h.setMissing([]);await h.api.call('finish',{status:'completed',summary:'작성함',remaining:[]});assert.equal(h.state.finish?.status,'completed');
  await h.api.call('browser_click',{});
  await assert.rejects(h.api.call('confirm_saved',{evidence:'임시저장이 완료되었습니다'}),/새로 나타난/);
  h.setChanged('임시저장이 완료되었습니다');
  await h.api.call('confirm_saved',{evidence:'임시저장이 완료되었습니다'});assert.equal(h.state.save?.ok,true);
  await h.api.call('fill',{});assert.equal(h.state.save?.ok,false);assert.equal(h.state.finish,undefined);
});

test('단순 질문 답변은 저장하거나 필수항목을 채우도록 강제하지 않는다', async()=>{
  const h=harness({},'왜 이 직무야?');h.setMissing(['학교']);
  await h.api.call('finish',{status:'answered',summary:'경험을 근거로 골랐습니다',remaining:[]});
  assert.equal(h.state.finish?.status,'answered');assert.equal(h.state.save,undefined);assert.equal(h.writes.length,0);
});

test('일부 항목만 작성하고 저장하지 말라는 요청은 전체 지원서 작성으로 확대하지 않는다', async()=>{
  const h=harness({},'답변 한 개만 작성하고 저장하지 마');h.setMissing(['학교']);
  await h.api.call('finish',{status:'completed',summary:'요청한 답변을 작성했습니다',remaining:[],whole_application:false,save_required:false});
  assert.equal(h.state.finish?.status,'completed');assert.equal(h.state.save,undefined);
});


test('Notion 정리를 요청한 완료는 반영 확인이 필요하고 사이트 저장과 구별한다', async () => {
  const h = harness({}, '노션에 정리해', true);
  const finish = { status: 'completed', summary: '노션 정리', remaining: [], whole_application: false, save_required: false };
  await h.api.call('finish', finish); assert.equal(h.state.finish?.status, 'incomplete');
  assert.match(h.state.finish!.remaining.join(), /Notion/);
  h.state.notion = { available: true, verified: true, summary: '초안과 저장 대기 상태 반영' };
  await h.api.call('finish', finish); assert.equal(h.state.finish?.status, 'completed');
  assert.equal(h.state.save, undefined);
  await h.api.call('browser_fill_form', {}); assert.equal(h.state.notion.verified, false);
  await h.api.call('finish', { status: 'answered', summary: '정리 상태를 설명함', remaining: [] });
  assert.equal(h.state.finish?.status, 'answered');
});


test('안내 확인칸은 자소서 문체 검사 없이 기록하고 미입력 사유를 finish에서 보존한다', async () => {
  const h = harness({}, '지원서 작성');
  await h.api.call('set_questions', { questions: [{ id: 1, ref: 'f0-1', question: '본 항목에는 .만 입력해도 무방합니다.', kind: 'notice', maxChars: 10 }] });
  const result = await h.api.call('write_answer', { id: 1, text: '.' });
  assert.doesNotMatch(JSON.stringify(result), /소제목|분량이 적습니다/);
  assert.equal(h.state.questions[0].kind, 'notice');
  await h.api.call('finish', { status: 'incomplete', summary: '확인 필요', remaining: ['자료 없는 항목'], blanks: [{ field: '학년별 학점', reason: '자료 없음' }] });
  assert.deepEqual(h.state.blanks, [{ field: '학년별 학점', reason: '자료 없음' }]);
});
