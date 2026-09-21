// Real official MCP, disposable Chrome profile, synthetic localhost form only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const home = mkdtempSync(path.join(tmpdir(), 'autojob-official-mcp-'));
process.env.AUTOJOB_HOME = home;
for (const key of ['NOTION_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[key];
const { parseSettings } = await import('../src/config');
const { paths, ROOT } = await import('../src/paths');
const { PlaywrightMcp } = await import('../src/apply/playwright-mcp');
const { targetIdOf } = await import('../src/browser/target');
const { applicationToolset } = await import('../src/apply/agent-tools');
const settings = parseSettings(readFileSync(paths.settingsExample, 'utf8'));
const free = createServer(); await new Promise<void>(r => free.listen(0, '127.0.0.1', r));
const port = (free.address() as { port: number }).port; await new Promise<void>(r => free.close(() => r()));
const context = await chromium.launchPersistentContext(path.join(home, 'chrome'), { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: [`--remote-debugging-port=${port}`] });
// The app's BrowserSession also leaves dialogs to the connected task agent/user.
context.on('dialog', () => {});
const page = context.pages()[0];
await page.setContent(`<title>합성 지원서</title>
<label>이메일<input id=email value="kept@example.test"></label>
<label>OPIc 등록번호<input id=Ftest7Number autocomplete=one-time-code></label>
<label>비밀번호<input id=PWD type=password value="SECRET_PASSWORD_123"></label>
<label>인증번호<input id=otp autocomplete=one-time-code value="654321"></label>
<label>근무부서<input id=CareerDep autocomplete=one-time-code></label>
<label>회사명<input id=CareerCom autocomplete=one-time-code></label><label>담당업무<input id=CareerWork autocomplete=one-time-code></label><label>직책<input id=CareerPos autocomplete=one-time-code></label><label>경력시작일<input id=CareerSDate autocomplete=one-time-code></label><label>경력종료일<input id=CareerEDate autocomplete=one-time-code></label><label>취득일<input id=LicenseDate autocomplete=one-time-code></label>
<div id=rows><div class=row><label>자격증명<input name=License readonly onclick="window.open('about:blank?elemid='+this.closest('.row').dataset.row)" data-autojob-ref=f0-172></label><label>등록번호<input name=LicenseNumber autocomplete=one-time-code data-autojob-ref=f0-173></label></div></div>
<button id=add onclick="const copy=document.querySelector('.row').cloneNode(true);document.querySelector('#rows').append(copy);document.querySelectorAll('.row').forEach((e,i)=>e.dataset.row=i)">행 추가</button>
<label>경험<textarea id=essay></textarea></label>
<label>교육 기타사항<textarea id=training oninput="this.value=this.value.slice(0,20)"></textarea></label>
<label>병역<select id=military><option value=non>비대상</option><option value=done>복무완료</option></select></label>
<label>기본 선택<input type=checkbox id=defaultCheck checked></label>
<button id=save onclick="document.querySelector('#status').textContent='임시저장 성공';">입사지원서 임시저장</button><p id=status></p>
<button id=submit onclick="document.body.dataset.submitted='yes'">최종 제출</button>`);
const unrelated = await context.newPage(); await unrelated.setContent('<title>다른 회사</title><input id=other value=UNRELATED_TASK>');
const ctl = new AbortController();
mkdirSync(path.join(home, 'files'));
const mcp = await PlaywrightMcp.connect(settings, port, await targetIdOf(context, page), path.join(home, 'files'), path.join(home, 'output'), ctl.signal);
const txt = (r: any): string => r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
const call = async (name: string, args: Record<string, unknown> = {}) => { const r = await mcp.call(name, args); assert.ok(!r.isError, txt(r)); return txt(r); };
const ref = (s: string, label: string) => { const line = s.split('\n').find(l => l.includes(`"${label}"`) && /ref=/.test(l)); assert.ok(line, `Missing ${label}: ${s}`); return line.match(/ref=(\w+)/)![1]; };
try {
  assert.ok(mcp.list().some(t => t.name === 'browser_fill_form'));
  assert.ok(!mcp.list().some(t => /evaluate|run_code|network|storage/.test(t.name)));
  let snap = await call('browser_snapshot');
  assert.ok(!snap.includes('SECRET_PASSWORD_123')); assert.ok(!snap.includes('654321')); assert.ok(!snap.includes('UNRELATED_TASK'));
  const opic = ref(snap, 'OPIc 등록번호'), department = ref(snap, '근무부서');
  await call('browser_fill_form', { fields: [{ name: 'OPIc 등록번호', type: 'textbox', target: opic, value: 'SYNTHETIC-OPIC' }, { name: '근무부서', type: 'textbox', target: department, value: '개발팀' }] });
  assert.equal(await page.locator('#Ftest7Number').inputValue(), 'SYNTHETIC-OPIC');
  assert.equal(await page.locator('#CareerDep').inputValue(), '개발팀');
  await call('browser_fill_form', { fields: ['회사명', '담당업무', '직책', '경력시작일', '경력종료일', '취득일'].map(name => ({ name, target: ref(snap, name), type: 'textbox', value: 'SYNTHETIC' })) });
  for (const id of ['CareerCom', 'CareerWork', 'CareerPos', 'CareerSDate', 'CareerEDate', 'LicenseDate']) assert.equal(await page.locator(`#${id}`).inputValue(), 'SYNTHETIC');
  // Merely reading keeps existing values. A requested correction must use native MCP without a blanket lock.
  assert.equal(await page.locator('#email').inputValue(), 'kept@example.test');
  await call('browser_type', { target: ref(snap, '이메일'), text: 'corrected@example.test' });
  assert.equal(await page.locator('#email').inputValue(), 'corrected@example.test');
  await call('browser_select_option', { target: ref(snap, '병역'), values: ['done'] });
  assert.equal(await page.locator('#military').inputValue(), 'done');
  await call('browser_fill_form', { fields: [{ name: '기본 선택', type: 'checkbox', target: ref(snap, '기본 선택'), value: 'false' }] });
  assert.equal(await page.locator('#defaultCheck').isChecked(), false);
  await call('browser_type', { target: ref(snap, '교육 기타사항'), text: 'This training description exceeds the site limit' });
  assert.equal((await page.locator('#training').inputValue()).length, 20);
  // Simulate a framework rerender: the new native ref must still permit correcting the truncated value.
  await page.locator('#training').evaluate(el => { const next = el.cloneNode(true) as HTMLTextAreaElement; next.value = (el as HTMLTextAreaElement).value; el.replaceWith(next); });
  snap = await call('browser_snapshot');
  await call('browser_type', { target: ref(snap, '교육 기타사항'), text: '개발 실습 과정 수료' });
  assert.equal(await page.locator('#training').inputValue(), '개발 실습 과정 수료');
  const authResult = await mcp.call('browser_type', { target: ref(snap, '인증번호'), text: '123456' });
  assert.ok(authResult.isError); assert.equal(await page.locator('#otp').inputValue(), '654321');
  await call('browser_click', { target: ref(snap, '행 추가') });
  snap = await call('browser_snapshot');
  const licenses = snap.split('\n').filter(l => l.includes('textbox "자격증명"')).map(l => l.match(/ref=(\w+)/)![1]);
  assert.equal(licenses.length, 2); assert.notEqual(licenses[0], licenses[1]);
  await call('browser_click', { target: licenses[1] });
  const list = await call('browser_tabs', { action: 'list' });
  assert.match(list, /elemid=1/); assert.ok(!list.includes('다른 회사'));
  await call('browser_tabs', { action: 'select', index: 1 });
  assert.match(await call('browser_snapshot'), /elemid=1/);
  await call('browser_tabs', { action: 'close', index: 1 });
  await call('browser_tabs', { action: 'select', index: 0 });
  // Native coordinate clicks must hit the second cloned row, never resolve a copied attribute.
  await page.locator('.row').nth(1).locator('input[name=License]').scrollIntoViewIfNeeded();
  const box = await page.locator('.row').nth(1).locator('input[name=License]').boundingBox(); assert.ok(box);
  await call('browser_mouse_click_xy', { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  assert.match(await call('browser_tabs', { action: 'list' }), /elemid=1/);
  await call('browser_tabs', { action: 'close', index: 1 });
  await call('browser_tabs', { action: 'select', index: 0 });
  snap = await call('browser_snapshot');
  await call('browser_click', { target: ref(snap, '최종 제출') });
  assert.equal(await page.locator('body').getAttribute('data-submitted'), null);
  await page.locator('#submit').evaluate(el => { (el as HTMLElement).style.visibility = 'hidden'; setTimeout(() => { (el as HTMLElement).style.visibility = ''; }, 3400); });
  await call('browser_click', { target: ref(snap, '최종 제출') });
  assert.equal(await page.locator('body').getAttribute('data-submitted'), null, 'Playwright auto-wait must not outlive the submission guard');
  await call('browser_click', { target: ref(snap, '입사지원서 임시저장') });
  assert.equal(await page.locator('#status').innerText(), '임시저장 성공');
  assert.match((await mcp.saveObservation())!.visible, /임시저장 성공/);
  const state: import('../src/apply/agent-tools').AgentTaskState = { questions: [], answers: [], filled: [] };
  const app = applicationToolset({ browser: mcp, tools: mcp, settings, state, profile: {}, context: {}, request: '' });
  await app.call('confirm_saved', { evidence: '임시저장 성공' }); assert.equal(state.save?.ok, true);
  await page.locator('#save').evaluate(el => el.setAttribute('onclick', 'void 0'));
  await call('browser_click', { target: ref(snap, '입사지원서 임시저장') });
  await call('browser_snapshot');
  await assert.rejects(app.call('confirm_saved', { evidence: '임시저장 성공' }), /새로 나타난/);
  await page.locator('#save').evaluate(el => el.setAttribute('onclick', "alert('새 임시저장 성공')"));
  assert.match(await call('browser_click', { target: ref(snap, '입사지원서 임시저장') }), /dialog/);
  await call('browser_handle_dialog', { accept: true });
  await app.call('confirm_saved', { evidence: '새 임시저장 성공' });
  await page.locator('.row').first().evaluate(el => el.remove());
  assert.equal((await mcp.call('browser_click', { target: licenses[0] })).isError, true);
  await assert.rejects(mcp.call('browser_tabs', { action: 'close', index: 0 }));
  assert.equal(await unrelated.locator('#other').inputValue(), 'UNRELATED_TASK');
  ctl.abort(); await assert.rejects(mcp.call('browser_type', { target: opic, text: 'stale' }));
  const output = { testedAt: new Date().toISOString(), synthetic: true, officialMcp: true, checks: ['stock MCP schemas and tools', 'non-secret one-time-code fields', 'batch fill', 'cloned row refs', 'second-row native coordinate click', 'owned popup selection and closure', 'other task isolation', 'secret redaction and input rejection', 'snapshot preserves values; native MCP permits requested corrections', 'default selections corrected', 'truncated text repaired after rerender', 'final submit blocked', 'save button independent of fixed labels', 'revoked execution'] };
  const dir = path.join(ROOT, 'data/verification'); mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'playwright-mcp.json'), JSON.stringify(output, null, 2), { mode: 0o600 });
  console.log(output);
} finally { await mcp.close(); assert.equal(page.isClosed(), false); await context.close(); rmSync(home, { recursive: true, force: true }); }
