// Real Codex + an owned disposable Aside profile. Synthetic local application only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const home = mkdtempSync(path.join(tmpdir(), 'autojob-agent-smoke-'));
process.env.AUTOJOB_HOME = home;
for (const key of ['NOTION_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[key];
const { parseSettings } = await import('../src/config');
const { paths, ROOT } = await import('../src/paths');
const { targetIdOf } = await import('../src/browser/target');
const { PlaywrightMcp } = await import('../src/apply/playwright-mcp');
const { applicationToolset } = await import('../src/apply/agent-tools');
const { conversationTools } = await import('../src/apply/conversation-tools');
const { startBridge } = await import('../src/apply/bridge');
const { runCodexAgent } = await import('../src/llm/codex-cli');
const settings = parseSettings(readFileSync(paths.settingsExample, 'utf8'));
settings.essay.subtitle = false; settings.essay.blind = false; settings.essay.banned_phrases = [];
const form = `<!doctype html><meta charset=utf-8><title>합성회사 지원서</title><style>body{font:16px sans-serif;padding:25px}label{display:block;margin:14px}input{padding:8px}textarea{width:650px;height:120px}button,td{padding:12px;cursor:pointer}.ui-datepicker{border:1px solid;padding:15px;width:250px}</style>
<h1>합성회사 지원서 (검증용, 외부 조사 불필요)</h1>
<label>이름 <input id=name required></label><label>이메일 <input id=email value=kept@example.test></label>
<label>학교 <input id=school readonly required><button type=button onclick="window.open('/school','school','width=600,height=400')">학교검색</button></label>
<label>자격증 <input id=license readonly required><button type=button onclick="window.open('/license','license','width=600,height=400')">자격증 검색</button></label>
<label>입대일 <input id=date readonly required><button type=button onclick="document.getElementById('calendar').hidden=false">달력</button></label>
<div id=calendar class=ui-datepicker hidden><select class=ui-datepicker-year aria-label=연도><option>2026</option><option>2021</option></select><select class=ui-datepicker-month aria-label=월><option value=9>9월</option><option value=1>1월</option></select><a data-handler=selectDay onclick="document.getElementById('date').value=document.querySelector('.ui-datepicker-year').value+'-'+document.querySelector('.ui-datepicker-month').value.padStart(2,'0')+'-15';document.getElementById('calendar').hidden=true">15</a></div>
<label>지원 분야 <input id=customValue readonly required></label><div id=custom style="cursor:pointer;background:#ddd;padding:12px;width:180px">데이터 운영 선택</div>
<h2>1. 문제를 해결한 경험을 작성하세요 (100~200자, 공백 포함)</h2><textarea id=essay required maxlength=200></textarea>
<p id=status></p><button type=button id=save onclick="const bad=[...document.querySelectorAll('[required]')].some(e=>!e.value.trim());document.getElementById('status').textContent=bad?'필수 항목을 입력해 주세요':'임시저장이 완료되었습니다';document.body.dataset.saved=bad?'no':'yes'">임시저장</button>
<button type=button id=submit onclick="document.body.dataset.submitted='yes'">최종 제출</button>
<script>window.jQuery={datepicker:{_curInst:{input:[document.getElementById('date')]}}};document.getElementById('custom').addEventListener('click',()=>document.getElementById('customValue').value='데이터 운영');</script>`;
const server = createServer((req,res) => {
  res.setHeader('Content-Type','text/html;charset=utf-8');
  if (req.url === '/school') res.end(`<meta charset=utf-8><h1>학교 검색</h1><input type=search aria-label="학교 검색어"><button type=button>검색</button><table><tr onclick="opener.document.getElementById('school').value='합성대학교';window.close()"><td>합성대학교</td></tr></table>`);
  else if (req.url === '/license') res.end(`<meta charset=utf-8><h1>자격증 검색</h1><input type=search aria-label="자격 검색어"><button type=button>검색</button><table><tr><td onclick="opener.document.getElementById('license').value='합성자격';window.close()">합성자격</td></tr></table>`);
  else res.end(form);
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/form`;
const free=createServer();await new Promise<void>(r=>free.listen(0,'127.0.0.1',r));const port=(free.address() as {port:number}).port;await new Promise<void>(r=>free.close(()=>r()));
const executablePath = process.argv.includes('--chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/Applications/Aside.app/Contents/MacOS/Aside';
const browser=await chromium.launchPersistentContext(path.join(home,'browser'),{executablePath,headless:true,viewport:{width:1200,height:1000},args:[`--remote-debugging-port=${port}`]});
const page=browser.pages()[0];await page.goto(url);
const other=await browser.newPage();await other.setContent('<input value="other-task">');
const controller=new AbortController();
const tools=await PlaywrightMcp.connect(settings,port,await targetIdOf(browser,page),home,path.join(home,'mcp-output'),controller.signal);
const folder=path.join(home,'materials');mkdirSync(folder);writeFileSync(path.join(folder,'경험.md'),'개인 경험: CSV 재고 내역에서 중복 행을 찾아 제거하는 스크립트를 작성하고 누락 여부를 원본과 대조했습니다. 데이터 운영 직무를 희망합니다. 팀 전체의 운영 성과나 정량적인 개선 수치는 제공되지 않았습니다.');
const state: import('../src/apply/agent-tools').AgentTaskState={questions:[],answers:[],filled:[]};
const calls:string[]=[];
const handlers={ask:async(q:string)=>{throw new Error('검증 자료로 진행 가능해야 합니다: '+q);},event:async()=>{}};
const base=applicationToolset({browser:conversationTools(tools,handlers),tools,settings,state,profile:{stories:{folders:[{path:folder}]}},request:'자료대로 기본정보와 자소서를 작성하고 임시저장해 줘. 최종 제출은 하지 마.',context:{latest_request:'합성 지원서를 자료대로 작성하고 임시저장해 줘. 최종 제출은 하지 마. 외부 조사는 필요 없어.',original_scope:['basic','essay'],profile:'이름: 테스트지원자\n학교: 합성대학교\n자격증: 합성자격\n입대일: 2021.01.15\n지원 분야: 데이터 운영\n이메일: 기존 값 유지'},signal:controller.signal});
const bridge=await startBridge({...handlers,signal:controller.signal,tools:{list:()=>base.list(),call:async(name,args)=>{calls.push(name);console.log('도구:',name);return base.call(name,args);}}});
try{
  console.log('실제 Codex와 '+(process.argv.includes('--chrome')?'Chrome':'Aside')+' 지원서 전체 작성 시작');
  const result=await runCodexAgent({prompt:'context를 읽고 사용자 요청을 수행하세요.',systemAppend:readFileSync(path.join(paths.prompts,'application-agent.md'),'utf8'),isolated:true,tools:[],cwd:home,signal:AbortSignal.timeout(300000),mcp:{server:'autojob',command:process.execPath,args:[path.join(ROOT,'node_modules/tsx/dist/cli.mjs'),path.join(ROOT,'src/mcp/browser-server.ts')],env:{AUTOJOB_BRIDGE_URL:bridge.url,AUTOJOB_BRIDGE_TOKEN:bridge.token}},onEvent:e=>{if(e.type==='text')console.log(e.text.slice(0,300));}});
  assert.equal(result.isError,false,result.text);
  assert.equal(await page.locator('#school').inputValue(),'합성대학교');assert.equal(await page.locator('#license').inputValue(),'합성자격');assert.equal(await page.locator('#date').inputValue(),'2021-01-15');assert.equal(await page.locator('#customValue').inputValue(),'데이터 운영');
  assert.equal(await page.locator('#email').inputValue(),'kept@example.test');assert.equal(await page.locator('body').getAttribute('data-saved'),'yes');assert.equal(await page.locator('body').getAttribute('data-submitted'),null);
  assert.equal(state.finish?.status,'completed',JSON.stringify(state.finish));assert.ok(state.save?.ok);assert.ok((await page.locator('#essay').inputValue()).length>=100);assert.ok(calls.includes('read_source'));
  assert.ok(!calls.includes('ask_user'), '제공된 자료로 끝낼 수 있는 작업에서 불필요한 사용자 대기가 발생했습니다');
  assert.equal(state.answers[0]?.text,await page.locator('#essay').inputValue());
  // The same agent and tools answer a follow-up, without restarting a writing pipeline.
  const count=calls.length;
  const questionTools=applicationToolset({browser:conversationTools(tools,handlers),tools,settings,state:{questions:[],answers:[],filled:[]},profile:{},request:'왜 데이터 운영으로 골랐어? 질문에만 답해 줘.',context:{latest_request:'왜 데이터 운영으로 골랐어? 질문에만 답해 줘.',last_result:state,profile:'CSV 재고 데이터 중복 제거 경험, 데이터 운영 희망'},signal:controller.signal});
  const follow=await startBridge({...handlers,signal:controller.signal,tools:{list:()=>questionTools.list(),call:async(n,a)=>{calls.push(n);return questionTools.call(n,a);}}});
  try {const r=await runCodexAgent({prompt:'context를 읽고 최신 요청에 답하세요.',systemAppend:readFileSync(path.join(paths.prompts,'application-agent.md'),'utf8'),isolated:true,tools:[],cwd:home,signal:AbortSignal.timeout(180000),mcp:{server:'autojob',command:process.execPath,args:[path.join(ROOT,'node_modules/tsx/dist/cli.mjs'),path.join(ROOT,'src/mcp/browser-server.ts')],env:{AUTOJOB_BRIDGE_URL:follow.url,AUTOJOB_BRIDGE_TOKEN:follow.token}}});assert.equal(r.isError,false);assert.match(r.text,/데이터|CSV/);assert.ok(!calls.slice(count).some(n=>['browser_type','browser_fill_form','write_answer','browser_click','browser_mouse_click_xy'].includes(n)));}finally{await follow.close();}
  // Regression: credentials never reach the AI, existing values and final submit remain guarded.
  await page.evaluate(()=>{const i=document.createElement('input');i.type='password';i.id='secret';i.value='SYNTHETIC-SECRET';document.body.append(i);});
  const snapshot=JSON.stringify(await tools.call('browser_snapshot',{}));assert.doesNotMatch(snapshot,/SYNTHETIC-SECRET/);
  assert.equal((await tools.call('browser_type',{target:'#secret',text:'new-secret'})).isError,true);
  await tools.call('browser_click',{target:'#submit'});assert.equal(await page.locator('body').getAttribute('data-submitted'),null);
  assert.equal((await tools.call('browser_tabs',{action:'select',index:99})).isError,true);assert.equal(await other.locator('input').inputValue(),'other-task');
  controller.abort();await assert.rejects(base.call('browser_type',{target:'#name',text:'late'}));
  const out=path.join(ROOT,'data/verification');mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'application-agent.png'),fullPage:true});
  writeFileSync(path.join(out,'application-agent.json'),JSON.stringify({testedAt:new Date().toISOString(),browser:executablePath,synthetic:true,actualCodex:true,officialMcp:true,calls,state,finalText:result.text},null,2),{mode:0o600});
  console.log('전체 작성·질문 답변·보호 경계 검증 통과');
}finally{await bridge.close();await tools.close();await browser.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(home,{recursive:true,force:true});}
