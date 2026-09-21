// A real, disposable Chrome profile and a synthetic localhost form. No AI or corporate sites.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const home=mkdtempSync(path.join(tmpdir(),'autojob-recovery-'));process.env.AUTOJOB_HOME=home;
for(const k of ['NOTION_TOKEN','ANTHROPIC_API_KEY','OPENAI_API_KEY'])delete process.env[k];
const {parseSettings}=await import('../src/config');
const {paths}=await import('../src/paths');
const {BrowserSession,MissingApplicationTab}=await import('../src/browser/session');
const {connectCdp}=await import('../src/browser/cdp');
const settings=parseSettings(readFileSync(paths.settingsExample,'utf8'));
const reserve=createServer();await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));
const port=(reserve.address() as {port:number}).port;await new Promise<void>(r=>reserve.close(()=>r()));
const wrapper=path.join(home,'test-chrome');
writeFileSync(wrapper,'#!/bin/sh\nexec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new "$@"\n',{mode:0o700});
settings.browser.driver='chrome';settings.browser.chrome={app:wrapper,cdp_port:port,profile_dir:path.join(home,'profile')};
const web=createServer((_req,res)=>res.end('<html><title>Synthetic recovery</title><label>Name<input id=name></label></html>'));
await new Promise<void>(r=>web.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${(web.address() as {port:number}).port}/form`;
const stopBrowser=async()=>{
  const {chromium}=await import('playwright-core');
  const b=await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(()=>null);if(!b)return;
  const cdp=await b.newBrowserCDPSession();await cdp.send('Browser.close').catch(()=>{});
  for(let i=0;i<30;i++){if(!await fetch(`http://127.0.0.1:${port}/json/version`).then(()=>true).catch(()=>false))return;await new Promise(r=>setTimeout(r,100));}
  throw new Error('Test browser did not stop');
};
try{
  const first=await BrowserSession.open(settings,{newWindow:true,url});await first.goto(url);
  await first.fill('#name','synthetic-preserved');const ref=await first.reference();
  // Another tab at the same URL is not this task's tab.
  const other=await first.context.newPage();await other.goto(url);await other.locator('#name').fill('other-task');
  await first.detach();
  const direct=await BrowserSession.attach(settings,ref);assert.equal(await direct.page.locator('#name').inputValue(),'synthetic-preserved');await direct.detach();
  await stopBrowser();
  const inspect=await connectCdp(settings.browser.chrome);
  // Chrome may discard unsaved input on restart; reconnect must preserve what is present now.
  const candidates=inspect.contexts()[0].pages().filter(p=>p.url()===url);
  for(const p of candidates) {
    const owned=await p.evaluate(()=>sessionStorage.getItem('__autojob_owned_tab_v1'))===ref.tabKey;
    await p.locator('#name').fill(owned?'current-restored-value':'other-restored-value');
  }
  await inspect.close();
  const restored=await BrowserSession.attach(settings,ref);const fresh=await restored.reference();
  assert.notEqual(fresh.targetId,ref.targetId);assert.equal(fresh.tabKey,ref.tabKey);
  assert.equal(await restored.page.locator('#name').inputValue(),'current-restored-value');
  const untouched=restored.context.pages().filter(p=>p!==restored.page&&p.url()===url);
  assert.equal(untouched.length,1);assert.equal(await untouched[0].locator('#name').inputValue(),'other-restored-value');
  await restored.page.close();await restored.detach();
  await stopBrowser();
  await assert.rejects(BrowserSession.attach(settings,fresh),MissingApplicationTab);
  const b=await connectCdp(settings.browser.chrome);assert.equal(b.contexts()[0].pages().filter(p=>p.url()===url).length,1);await b.close();
  console.log('PASS: cold launch, exact-tab reconnect, browser restart with ownership marker, current form value preservation, same-URL tab isolation, missing-tab rejection');
}finally{await stopBrowser();await new Promise<void>(r=>web.close(()=>r()));rmSync(home,{recursive:true,force:true});}
