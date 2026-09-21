// The browser implementation is Microsoft's Playwright MCP. This adapter owns
// its lifetime and task scope; it does not assign DOM refs or implement clicks.
import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { chromium, type Browser, type BrowserContext, type Dialog, type Locator, type Page } from 'playwright-core';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Settings } from '../config';
import { checkLabel, installGuard, markAgentAction } from '../browser/guard';
import type { BridgeTool, BridgeTools, BridgeToolResult } from './bridge';
import { targetIdOf } from '../browser/target';

const ALLOWED = new Set(['browser_snapshot', 'browser_take_screenshot', 'browser_click', 'browser_hover', 'browser_drag', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_handle_dialog', 'browser_file_upload', 'browser_tabs', 'browser_navigate', 'browser_navigate_back', 'browser_wait_for', 'browser_mouse_move_xy', 'browser_mouse_click_xy', 'browser_mouse_wheel', 'browser_mouse_drag_xy']);
const EDITING = new Set(['browser_type', 'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_file_upload']);
const text = (r: BridgeToolResult) => r.content.flatMap(c => c.type === 'text' ? [c.text] : []).join('\n');

// autocomplete is an autofill hint, not a declaration that a field is a secret.
// Some application portals put one-time-code on ordinary career/license fields.
function fieldInfo(el: Element) {
  const h = el as HTMLInputElement;
  const labels = 'labels' in h ? [...(h.labels ?? [])].map(l => l.textContent ?? '').join(' ') : '';
  const semantic = [h.id, h.name, labels, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title')].join(' ');
  const auth = /password|passwd|(?:^|\W)(?:pwd|otp|totp)(?:\W|$)|one.?time.?code|verification.?code|auth(?:entication)?.?code|비밀번호|인증\s*(?:번호|코드)|일회용\s*(?:번호|코드)/i;
  const secret = h.type === 'password' || /^(?:current|new)-password$/.test(h.autocomplete ?? '') || auth.test(semantic);
  return { secret, value: secret ? '' : h.isContentEditable ? h.innerText : h.value ?? '', tag: el.tagName.toLowerCase(), editable: h.isContentEditable, query: h.type === 'search' || !!el.closest('[role="search"],.ui-datepicker'), type: h.type };
}
const SECRET_SCAN = `(() => { const __name = f => f; const info = (${fieldInfo.toString()}); return [...document.querySelectorAll('input')].flatMap((el, index) => info(el).secret ? [{ index, value: el.value }] : []); })()`;

export class PlaywrightMcp implements BridgeTools {
  private client = new Client({ name: 'autojob-playwright', version: '1.0.0' }, { capabilities: { roots: {} } });
  private server?: Awaited<ReturnType<typeof createConnection>>;
  private descriptors: BridgeTool[] = [];
  private active: Page;
  private closed = false;
  private pages = new Set<Page>();
  private proxies = new Map<Page, Page>();
  private cleanup: (() => void)[] = [];
  private edits = new WeakMap<Page, Map<string, string>>();
  private secrets = new Set<string>();
  private dialogs = new Map<Page, Dialog>();
  private arm?: () => Promise<void>;
  private observation?: { page: Page; before: string; label: string; dialogs: string[]; changed: string };

  private constructor(private browser: Browser, readonly main: Page, private settings: Settings, private filesDir: string, private signal?: AbortSignal) { this.active = main; }

  static async connect(settings: Settings, port: number, targetId: string, filesDir: string, outputDir: string, signal?: AbortSignal): Promise<PlaywrightMcp> {
    signal?.throwIfAborted();
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    try {
      const context = browser.contexts()[0];
      let main: Page | undefined;
      for (const p of context.pages()) if (await targetIdOf(context, p) === targetId) main = p;
      if (!main) throw new Error('이 작업의 지원서 탭을 찾지 못했습니다.');
      const instance = new PlaywrightMcp(browser, main, settings, filesDir, signal);
      const fields = await main.locator('input:not([type=hidden]):not([type=search]),textarea,select').count();
      const guard = await installGuard(main, settings.browser.guard, { armed: fields >= 3 });
      instance.arm = guard.arm;
      instance.pages = guard.pages;
      const scoped = instance.scopedContext(context);
      instance.server = await createConnection({ capabilities: ['core', 'vision'], browser: {}, outputDir, saveSession: false, codegen: 'none', snapshot: { mode: 'full' }, timeouts: { action: 5000, navigation: 30000 } }, async () => scoped);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await instance.server.connect(serverSide);
      instance.client.setRequestHandler((await import('@modelcontextprotocol/sdk/types.js')).ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(filesDir).href, name: '지원서 첨부파일' }] }));
      await instance.client.connect(clientSide);
      instance.descriptors = (await instance.client.listTools()).tools.filter(t => ALLOWED.has(t.name)).map(t => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema as BridgeTool['inputSchema'] }));
      return instance;
    } catch (e) { await browser.close(); throw e; }
  }

  private current(): Page {
    if (this.active.isClosed()) this.active = [...this.pages].find(p => !p.isClosed()) ?? this.main;
    if (this.active.isClosed()) throw new Error('작업 탭이 닫혔습니다.');
    return this.active;
  }

  private scopedContext(context: BrowserContext): BrowserContext {
    const listeners = new Map<Function, (p: Page) => void>();
    return new Proxy(context, { get: (target, key) => {
      if (key === 'pages') return () => [...this.pages].filter(p => !p.isClosed()).map(p => this.scopedPage(p));
      if (key === 'newPage') return async () => { throw new Error('지원서 탭과 그 팝업 안에서 작업하세요.'); };
      if (key === 'close') return async () => {}; // Disconnecting MCP must leave the user's form open.
      if (key === 'on' || key === 'addListener') return (event: string, listener: (p: Page) => void) => {
        if (event === 'page') {
          const wrapped = (p: Page) => { void (async () => {
            const opener = await p.opener();
            if (!this.pages.has(p) && (!opener || !this.pages.has(opener))) return;
            this.pages.add(p); listener(this.scopedPage(p));
          })().catch(() => {}); };
          listeners.set(listener, wrapped); target.on('page', wrapped);
          this.cleanup.push(() => target.off('page', wrapped));
        } else target.on(event as any, listener);
        return target;
      };
      if (key === 'off' || key === 'removeListener') return (event: string, listener: (p: Page) => void) => target.off(event as any, listeners.get(listener) ?? listener);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }

  private scopedPage(page: Page): Page {
    const existing = this.proxies.get(page); if (existing) return existing;
    const onDialog = (d: Dialog) => { this.dialogs.set(page, d); if (this.observation?.page === page) this.observation.dialogs.push(d.message()); };
    const onDialogClosed = () => this.dialogs.delete(page);
    page.on('dialog', onDialog); page.on('dialogclosed', onDialogClosed);
    this.cleanup.push(() => { page.off('dialog', onDialog); page.off('dialogclosed', onDialogClosed); });
    const proxy = new Proxy(page, { get: (target, key) => {
      if (key === 'bringToFront') return async () => { this.active = page; }; // Selecting a task popup need not steal user focus.
      if (key === 'locator') return (selector: string, options?: any) => this.protectLocator(page, target.locator(selector, options), selector);
      if (key === 'screenshot') return async (options?: any) => target.screenshot({ ...options, mask: await this.secretLocators(page) });
      if (key === 'ariaSnapshot') return async (...args: any[]) => { await this.readSecrets(page); return this.redact(await (target as any).ariaSnapshot(...args)); };
      if (key === 'consoleMessages' || key === 'pageErrors' || key === 'requests') return async () => [];
      // Console/network records are unnecessary for filling applications and can contain secrets.
      if (key === 'on' || key === 'addListener') return (event: string, listener: any) => {
        if (!['console', 'pageerror', 'request', 'response', 'requestfailed'].includes(event)) { target.on(event as any, listener); this.cleanup.push(() => target.off(event as any, listener)); }
        return proxy;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    this.proxies.set(page, proxy); return proxy;
  }

  private protectLocator(page: Page, loc: Locator, identity: string): Locator {
    return new Proxy(loc, { get: (target, key) => {
      if (key === 'describe') return (label: string) => this.protectLocator(page, target.describe(label), identity);
      if (key === 'screenshot') return async (options?: any) => target.screenshot({ ...options, mask: await this.secretLocators(page) });
      if (key === 'ariaSnapshot') return async (...args: any[]) => { await this.readSecrets(page); return this.redact(await (target as any).ariaSnapshot(...args)); };
      if (['fill', 'pressSequentially', 'selectOption', 'setChecked', 'press'].includes(String(key))) return async (...args: any[]) => {
        this.signal?.throwIfAborted();
        const info = await target.evaluate(fieldInfo) as ReturnType<typeof fieldInfo>;
        if (info.secret) throw new Error('비밀번호·인증코드는 실제 사이트에서 직접 입력해 주세요.');
        const popupQuery = page !== this.main && await page.locator('input:visible:not([type=hidden]),textarea:visible,select:visible').count() <= 2;
        // A non-empty value can be a site default, sample, or a truncated AI edit.
        // The agent follows the user's correction scope; native MCP must permit repair.
        if (!info.query && !popupQuery) await this.arm?.();
        const result = await (target as any)[key](...args);
        if (['fill', 'pressSequentially', 'selectOption', 'setChecked'].includes(String(key))) {
          const edits = this.edits.get(page) ?? new Map(); edits.set(identity, (await target.evaluate(fieldInfo) as ReturnType<typeof fieldInfo>).value); this.edits.set(page, edits);
        }
        return result;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }

  private async secretLocators(page: Page): Promise<Locator[]> {
    const out: Locator[] = [];
    for (const frame of page.frames()) for (const item of await frame.evaluate(SECRET_SCAN) as { index: number; value: string }[]) { out.push(frame.locator('input').nth(item.index)); if (item.value) this.secrets.add(item.value); }
    return out;
  }
  private async readSecrets(page: Page) { await this.secretLocators(page); }
  private redact(s: string) { for (const value of this.secrets) s = s.replaceAll(value, '[비공개]'); return s; }
  list() { return this.descriptors; }

  async call(name: string, args: Record<string, unknown>): Promise<BridgeToolResult> {
    this.signal?.throwIfAborted(); if (this.closed) throw new Error('종료된 작업입니다.');
    if (!ALLOWED.has(name)) throw new Error(`사용할 수 없는 도구: ${name}`);
    const page = this.current();
    const dialog = this.dialogs.get(page);
    if (name === 'browser_handle_dialog' && args.accept === true && dialog && (dialog.type() === 'prompt' || dialog.type() === 'beforeunload' || checkLabel(dialog.message(), this.settings.browser.guard, true).blocked || /최종|수정\s*불가/.test(dialog.message()))) throw new Error('최종 제출·인증 대화상자는 직접 처리해 주세요.');
    if (name === 'browser_tabs' && (args.action === 'new' || args.action === 'close' && (!Number.isInteger(args.index) || [...this.pages].filter(p => !p.isClosed())[Number(args.index)] === this.main))) throw new Error('지원서 창은 유지하고 해당 팝업만 선택하거나 닫으세요.');
    if (name === 'browser_file_upload') for (const f of (args.paths as string[] ?? [])) {
      const relative = path.relative(realpathSync(this.filesDir), realpathSync(f));
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('연결한 첨부파일 폴더의 파일을 선택하세요.');
    }
    if (name === 'browser_press_key') {
      for (const frame of page.frames()) { const active = frame.locator(':focus'); if (await active.count() && (await active.evaluate(fieldInfo) as ReturnType<typeof fieldInfo>).secret) throw new Error('인증 입력칸은 직접 조작해 주세요.'); }
    }
    if (EDITING.has(name)) await this.invalidateSave();
    if (['browser_click', 'browser_mouse_click_xy'].includes(name) && !dialog) {
      await this.invalidateSave();
      this.observation = { page, before: await this.pageText(), label: String(args.element ?? args.target ?? '브라우저 클릭'), dialogs: [], changed: '' };
      for (const frame of page.frames()) await frame.evaluate(() => {
        const watch = { texts: [] as string[], observer: undefined as MutationObserver | undefined };
        watch.observer = new MutationObserver(records => { for (const r of records) for (const n of r.type === 'characterData' ? [r.target] : [...r.addedNodes]) { const el = n instanceof Element ? n : n.parentElement; if (el && !el.closest('script,style,input,textarea')) watch.texts.push((el.textContent ?? '').slice(0, 4000)); } watch.texts = watch.texts.slice(-50); });
        watch.observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        (window as any).__autojobMcpSaveWatch = watch;
      });
    }
    if (!dialog) await this.readSecrets(page);
    const acting = !['browser_snapshot', 'browser_take_screenshot', 'browser_wait_for'].includes(name) && !(name === 'browser_tabs' && args.action === 'list');
    let marking = false;
    const mark = async () => {
      if (marking || !acting) return;
      marking = true;
      try { for (const p of this.pages) if (!p.isClosed() && !this.dialogs.has(p)) await markAgentAction(p); }
      finally { marking = false; }
    };
    await mark();
    // Keep the existing final-submit guard active while Playwright auto-waits.
    const heartbeat = acting ? setInterval(() => { void mark().catch(() => {}); }, 500) : undefined;
    let result: BridgeToolResult;
    try { result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 60000 }) as BridgeToolResult; }
    finally { if (heartbeat) clearInterval(heartbeat); }
    for (const p of this.pages) if (!p.isClosed() && !this.dialogs.has(p)) await this.readSecrets(p);
    for (const c of result.content) if (c.type === 'text') c.text = this.redact(c.text);
    this.signal?.throwIfAborted();
    return result;
  }

  private locator(ref: string) {
    if (!/^(f\d+)?e\d+$/.test(ref)) throw new Error('browser_snapshot의 현재 요소 ref를 사용하세요.');
    return this.current().locator(`aria-ref=${ref}`);
  }
  async valueOf(ref: string) { return (await this.locator(ref).evaluate(fieldInfo) as ReturnType<typeof fieldInfo>).value; }
  async isAnswerField(ref: string) { const d = await this.locator(ref).evaluate(fieldInfo) as ReturnType<typeof fieldInfo>; return !d.secret && (d.tag === 'textarea' || d.editable); }
  async isOwnEdit(ref: string) { return this.edits.get(this.current())?.get(`aria-ref=${ref}`) === await this.valueOf(ref); }
  async fill(ref: string, value: string, options: { replace?: boolean } = {}) {
    if (options.replace && !await this.isAnswerField(ref)) throw new Error('서술형 답변만 교체할 수 있습니다.');
    const r = await this.call('browser_type', { target: ref, text: value });
    if (r.isError) throw new Error(text(r));
    return '공식 Playwright MCP로 입력했습니다.';
  }
  async pageText() { return this.redact((await Promise.all(this.current().frames().map(f => f.locator('body').innerText().catch(() => '')))).join('\n')); }
  async missingRequired() {
    const out: string[] = [];
    for (const p of this.pages) if (!p.isClosed()) for (const f of p.frames()) out.push(...await f.locator('input:visible:required,select:visible:required,textarea:visible:required').evaluateAll(els => els.filter(el => !(el as HTMLInputElement).disabled && (el as HTMLInputElement).validity.valueMissing).map(el => el.getAttribute('aria-label') || (el as HTMLInputElement).labels?.[0]?.textContent || (el as HTMLInputElement).name || '필수 항목')));
    return [...new Set(out)];
  }
  async invalidateSave() {
    const p = this.observation?.page;
    if (p && !p.isClosed() && !this.dialogs.has(p)) for (const f of p.frames()) await f.evaluate(() => { (window as any).__autojobMcpSaveWatch?.observer.disconnect(); delete (window as any).__autojobMcpSaveWatch; }).catch(() => {});
    this.observation = undefined;
  }
  async saveObservation() {
    const o = this.observation; if (!o || o.page.isClosed() || o.page !== this.current()) return;
    const modal = this.dialogs.has(o.page);
    const changed = modal ? '' : (await Promise.all(o.page.frames().map(f => f.evaluate(() => (window as any).__autojobMcpSaveWatch?.texts.join('\n') ?? '').catch(() => '')))).join('\n');
    return { label: o.label, before: o.before, visible: modal ? '' : await this.pageText(), changed: this.redact(changed), dialogs: o.dialogs.map(d => this.redact(d)) };
  }
  async screenshot() { return this.current().screenshot({ mask: await this.secretLocators(this.current()) }); }
  async close() {
    this.closed = true;
    await this.invalidateSave();
    await this.client.close(); await this.server?.close();
    this.cleanup.forEach(fn => fn());
    await this.browser.close();
  }
}
