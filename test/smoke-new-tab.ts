// Real official MCP + disposable headless Chrome, synthetic localhost pages only.
// 로그인·본인인증 뒤 사이트가 지원서를 새 탭으로 여는 경우: 에이전트가 그 탭을 보고 이어서 작업해야 한다.
// 전에는 (1) 인증 팝업이 새 탭을 열고 스스로 닫거나 (2) 에이전트가 사람을 기다리는 동안(연결이 끊긴 사이) 열린 탭을
// 작업 탭 묶음으로 보지 못해 "로그인해 주세요 → 새 탭 → 못 봄" 이 반복됐다.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const home = mkdtempSync(path.join(tmpdir(), 'autojob-newtab-'));
process.env.AUTOJOB_HOME = home;
for (const key of ['NOTION_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[key];
const { parseSettings } = await import('../src/config');
const { paths } = await import('../src/paths');
const { PlaywrightMcp } = await import('../src/apply/playwright-mcp');
const { targetIdOf } = await import('../src/browser/target');
const settings = parseSettings(readFileSync(paths.settingsExample, 'utf8'));

const site = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  const u = new URL(req.url!, 'http://x');
  if (u.pathname === '/main') return res.end(`<title>합성 채용 메인</title>
    <button onclick="window.open('/auth?to=' + encodeURIComponent('/form?n=' + this.dataset.n), 'auth', 'width=400,height=400')" data-n=1>본인인증 1</button>
    <button onclick="window.open('/auth?to=' + encodeURIComponent('/form?n=2'), 'auth', 'width=400,height=400')">본인인증 2</button>
    <a href="/form?n=link" target=_blank>지원서 새 탭</a>`);
  if (u.pathname === '/auth') return res.end(`<title>합성 인증</title><script>setTimeout(() => { window.open(${JSON.stringify(u.searchParams.get('to'))}); window.close(); }, 200)</script>`);
  if (u.pathname === '/form') return res.end(`<title>합성 지원서 ${u.searchParams.get('n')}</title><label>이름<input id=name></label>`);
  res.end(`<title>다른 사이트</title>`);
});
await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
const free = createServer(); await new Promise<void>(r => free.listen(0, '127.0.0.1', r));
const port = (free.address() as { port: number }).port; await new Promise<void>(r => free.close(() => r()));
const context = await chromium.launchPersistentContext(path.join(home, 'chrome'), { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: [`--remote-debugging-port=${port}`] });
context.on('dialog', () => {});
const main = context.pages()[0];
await main.goto(`${base}/main`);
const other = await context.newPage(); await other.goto(`${base}/elsewhere`); // 사람의 다른 탭: 보이면 안 된다
mkdirSync(path.join(home, 'files'));
const connect = async () => PlaywrightMcp.connect(settings, port, await targetIdOf(context, main), path.join(home, 'files'), path.join(home, 'output'));
const txt = (r: any): string => r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
const tabs = async (mcp: Awaited<ReturnType<typeof connect>>) => txt(await mcp.call('browser_tabs', { action: 'list' }));
const until = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 40; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } assert.fail('시간 안에 나타나지 않음'); };
const passed: string[] = [];
let mcp: Awaited<ReturnType<typeof connect>> | undefined;
try {
  // 1. 에이전트가 연결된 동안: 인증 팝업이 지원서 탭을 열고 스스로 닫는다
  mcp = await connect();
  await main.getByText('본인인증 1').click();
  await until(async () => (await tabs(mcp!)).includes('합성 지원서 1'));
  assert.doesNotMatch(await tabs(mcp), /다른 사이트/);
  passed.push('연결 중 인증 팝업이 연 새 탭');

  // 2. 사람을 기다리는 동안(연결 끊김) 로그인해서 새 탭이 열리고, 다시 연결한다
  await mcp.close(); mcp = undefined;
  await main.getByText('본인인증 2').click();
  await main.getByText('지원서 새 탭').click();
  await until(async () => context.pages().some(p => p.url().includes('n=2')) && context.pages().some(p => p.url().includes('n=link')));
  mcp = await connect();
  const list = await tabs(mcp);
  assert.match(list, /합성 지원서 2/);
  assert.match(list, /합성 지원서 link/);
  assert.doesNotMatch(list, /다른 사이트/);
  passed.push('기다리는 동안 열린 새 탭 (다시 연결 후)', 'noopener 새 탭');

  // 3. 그 탭을 골라 입력할 수 있다
  const index = list.split('\n').filter(l => /^- \d+:/.test(l)).findIndex(l => l.includes('합성 지원서 2'));
  assert.ok(index >= 0, list);
  await mcp.call('browser_tabs', { action: 'select', index });
  const snap = txt(await mcp.call('browser_snapshot', {}));
  const ref = snap.split('\n').find(l => l.includes('이름') && /ref=/.test(l))!.match(/ref=(\w+)/)![1];
  assert.ok(!(await mcp.call('browser_type', { target: ref, element: '이름', text: '합성 이름' })).isError);
  const form = context.pages().find(p => p.url().includes('n=2'))!;
  assert.equal(await form.locator('#name').inputValue(), '합성 이름');
  passed.push('새 탭에서 입력');
  console.log('PASS:', passed.join(', '));
} finally {
  await mcp?.close().catch(() => {});
  await context.close();
  site.close();
  rmSync(home, { recursive: true, force: true });
}
