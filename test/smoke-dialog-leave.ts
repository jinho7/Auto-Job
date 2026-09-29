// Real disposable headless Chrome. A second connection (like the settings UI server) must not auto-dismiss
// dialogs on tabs it does not own: that closed the user's confirm boxes and crashed the server with
// "Protocol error (Page.handleJavaScriptDialog): No dialog is showing".
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { leaveDialogsAlone } from '../src/browser/cdp';

const home = mkdtempSync(path.join(tmpdir(), 'autojob-dialog-'));
const free = createServer(); await new Promise<void>(r => free.listen(0, '127.0.0.1', r));
const port = (free.address() as { port: number }).port; await new Promise<void>(r => free.close(() => r()));
const chrome = await chromium.launchPersistentContext(path.join(home, 'chrome'), { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: [`--remote-debugging-port=${port}`] });

const unhandled: string[] = [];
process.on('unhandledRejection', e => unhandled.push(e instanceof Error ? e.message : String(e)));

/** 사람(또는 작업)이 대화상자를 처리하는 동안, 다른 연결이 끼어드는지 본다 */
async function run(withFix: boolean) {
  const other: Browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); // 설정 화면 서버 같은 연결
  if (withFix) leaveDialogsAlone(other);
  const page = chrome.pages()[0];
  let seen = '';
  page.once('dialog', async d => { seen = d.message(); await new Promise(r => setTimeout(r, 300)); await d.accept(); });
  await page.evaluate(() => { setTimeout(() => alert('사람이 보는 확인창'), 0); });
  await new Promise(r => setTimeout(r, 1200));
  await other.close();
  return seen;
}

try {
  unhandled.length = 0;
  const seen = await run(true);
  assert.equal(seen, '사람이 보는 확인창'); // 대화상자는 원래 주인에게 그대로 간다
  assert.deepEqual(unhandled, []); // 다른 연결이 닫으려다 터지지 않는다
  console.log('PASS: 다른 연결이 사람/작업의 대화상자를 닫지 않고, 오류도 나지 않음');
} finally {
  await chrome.close();
  rmSync(home, { recursive: true, force: true });
}
