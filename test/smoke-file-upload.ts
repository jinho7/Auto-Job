// Real official MCP + disposable headless Chrome. Synthetic form and files only.
// 첨부파일: 등록한 파일(첨부파일 폴더)은 지원서의 파일 칸에 올라가고, 폴더 밖 파일은 거절된다.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const home = mkdtempSync(path.join(tmpdir(), 'autojob-upload-'));
process.env.AUTOJOB_HOME = home;
for (const key of ['NOTION_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[key];
const { parseSettings } = await import('../src/config');
const { paths } = await import('../src/paths');
const { PlaywrightMcp } = await import('../src/apply/playwright-mcp');
const { targetIdOf } = await import('../src/browser/target');
const settings = parseSettings(readFileSync(paths.settingsExample, 'utf8'));

const files = path.join(home, 'files'), outside = path.join(home, 'outside');
mkdirSync(files); mkdirSync(outside);
writeFileSync(path.join(files, '증명사진.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
writeFileSync(path.join(files, '성적증명서.pdf'), '%PDF-1.4 synthetic');
writeFileSync(path.join(outside, 'private.pdf'), '%PDF-1.4 outside');

const free = createServer(); await new Promise<void>(r => free.listen(0, '127.0.0.1', r));
const port = (free.address() as { port: number }).port; await new Promise<void>(r => free.close(() => r()));
const context = await chromium.launchPersistentContext(path.join(home, 'chrome'), { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: [`--remote-debugging-port=${port}`] });
context.on('dialog', () => {});
const page = context.pages()[0];
await page.setContent(`<title>합성 지원서 첨부</title>
<label>증명사진 <input type=file id=photo accept="image/*"></label>
<label>성적증명서 <input type=file id=transcript accept=".pdf"></label>`);

const mcp = await PlaywrightMcp.connect(settings, port, await targetIdOf(context, page), files, path.join(home, 'output'));
const txt = (r: any): string => r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
const ref = (s: string, label: string) => { const line = s.split('\n').find(l => l.includes(label) && /ref=/.test(l)); assert.ok(line, `Missing ${label}: ${s}`); return line.match(/ref=(\w+)/)![1]; };
const upload = async (label: string, file: string) => {
  const snap = txt(await mcp.call('browser_snapshot', {}));
  const click = await mcp.call('browser_click', { target: ref(snap, label), element: label });
  assert.ok(!click.isError, txt(click));
  return mcp.call('browser_file_upload', { paths: [file] });
};
const passed: string[] = [];
try {
  const a = await upload('증명사진', path.join(files, '증명사진.png'));
  assert.ok(!a.isError, txt(a));
  assert.equal(await page.locator('#photo').evaluate((el: HTMLInputElement) => el.files?.[0]?.name), '증명사진.png');
  passed.push('증명사진 업로드');

  const b = await upload('성적증명서', path.join(files, '성적증명서.pdf'));
  assert.ok(!b.isError, txt(b));
  assert.equal(await page.locator('#transcript').evaluate((el: HTMLInputElement) => el.files?.[0]?.name), '성적증명서.pdf');
  passed.push('성적증명서 업로드');

  // 첨부파일 폴더 밖 파일은 올리지 않는다
  const c = await upload('성적증명서', path.join(outside, 'private.pdf')).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
  assert.equal(c.isError, true);
  assert.match(txt(c), /첨부파일 폴더/);
  assert.equal(await page.locator('#transcript').evaluate((el: HTMLInputElement) => el.files?.[0]?.name), '성적증명서.pdf');
  passed.push('폴더 밖 파일 거절');
  console.log('PASS:', passed.join(', '));
} finally {
  await mcp.close().catch(() => {});
  await context.close();
  rmSync(home, { recursive: true, force: true });
}
