// AI와 파이프라인이 브라우저를 다루는 유일한 통로.
// 뒤로가기, 새로고침, 탭 닫기, 강제 덮어쓰기 같은 위험한 조작은 의도적으로 제공하지 않는다.
import type { Browser, BrowserContext, Dialog, Locator, Page } from 'playwright-core';
import type { GuardConfig, Settings } from '../config';
import { connectCdp } from './cdp';
import { checkLabel, GuardBlockedError, installGuard, markAgentAction, normalizeLabel } from './guard';

export type FillResult = 'filled' | 'skipped-prefilled';

export class BrowserSession {
  private armed = false;
  /** 코드가 마지막으로 무언가 누른 시각 (이 직후에 뜬 대화상자만 대신 처리한다) */
  private actedAt = 0;
  readonly events: string[] = [];

  private constructor(
    private readonly browser: Browser,
    readonly context: BrowserContext,
    private readonly guard: GuardConfig,
    public page: Page,
    private readonly tabGuard: Awaited<ReturnType<typeof installGuard>>,
    /** 창 제목 앞에 붙는 표시 (창이 여러 개일 때 "이 창"을 집어내려고) */
    readonly mark: string = '',
    /** 뒤에서 도는 지원서인가 (그렇다면 스스로 창을 앞으로 올리지 않는다) */
    private readonly background = false,
  ) {}

  static async open(settings: Settings, opts: { newWindow?: boolean; background?: boolean; url?: string } = {}): Promise<BrowserSession> {
    const { driver, guard } = settings.browser;
    if (driver === 'handoff') throw new Error('handoff 드라이버는 브라우저를 직접 조종하지 않습니다');
    const browser = await connectCdp(settings.browser[driver]);
    const context = browser.contexts()[0] ?? (await browser.newContext());

    // 가드는 이 세션이 연 탭(과 그 팝업)에만 건다. 같은 브라우저의 다른 탭에는 영향이 없다.
    const n = opts.newWindow ? ++windows : 0;
    const page = opts.newWindow ? await openWindow(browser, context, { background: !!opts.background, url: opts.url, n }) : await context.newPage();
    const mark = n ? `[지원 ${n}]` : '';
    if (mark) await markTitle(page, mark);
    const tabGuard = await installGuard(page, guard);
    const session = new BrowserSession(browser, context, guard, page, tabGuard, mark, !!opts.background);
    // 컨텍스트에 리스너가 있으면 Playwright 가 다른 탭의 대화상자를 자동으로 닫지 않는다. 내 탭 것만 처리한다.
    context.on('dialog', (d) => {
      if (tabGuard.owns(d.page())) void session.onDialog(d);
    });
    page.on('popup', (p) => session.events.push(`새 창: ${p.url() || '(로딩 중)'}`));
    return session;
  }

  /** 지원서 입력 단계 진입. 이후로는 block_when_armed(지원하기 등)도 차단한다. */
  async arm(): Promise<void> {
    this.armed = true;
    await this.tabGuard.arm();
  }

  get isArmed(): boolean {
    return this.armed;
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  /** 2차 가드: 문구를 검사한 뒤에만 클릭한다. */
  async click(target: string | Locator): Promise<void> {
    const loc = typeof target === 'string' ? this.page.locator(target) : target;
    const label = await loc.evaluate(
      (el) => (el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute('aria-label') || el.getAttribute('title') || '',
    );
    const verdict = checkLabel(label, this.guard, this.armed);
    if (verdict.blocked) {
      this.events.push(`차단: ${label.trim()} (${verdict.keyword})`);
      throw new GuardBlockedError(label.trim(), verdict.keyword);
    }
    this.actedAt = Date.now();
    await markAgentAction(this.page);
    await loc.click();
  }

  /** 이미 값이 있으면 건드리지 않는다 ("이미 입력된 값은 수정 및 삭제하지 마세요"). */
  async fill(target: string | Locator, value: string): Promise<FillResult> {
    const loc = typeof target === 'string' ? this.page.locator(target) : target;
    const current = await loc.inputValue();
    if (current.trim() !== '') return 'skipped-prefilled';
    await loc.fill(value);
    return 'filled';
  }

  /** 캡처. 뒤에서 도는 지원서는 창을 앞으로 끌어오지 않는다 (창을 계속 그리도록 띄웠으므로 가려져도 찍힌다) */
  async screenshot(file: string): Promise<void> {
    if (!this.background) await this.page.bringToFront().catch(() => {});
    await this.page
      .screenshot({ path: file, fullPage: true, timeout: 15_000, animations: 'disabled' })
      .catch(() => this.page.screenshot({ path: file, timeout: 15_000, animations: 'disabled' }));
  }

  async bringToFront(): Promise<void> {
    await this.page.bringToFront();
  }

  /** 이 지원서 창의 화면 위치 (창을 맨 앞으로 올릴 때 어느 창인지 가리키는 데 쓴다) */
  async windowBounds(): Promise<{ left: number; top: number } | null> {
    const cdp = await this.context.newCDPSession(this.page).catch(() => null);
    if (!cdp) return null;
    try {
      const { bounds } = (await cdp.send('Browser.getWindowForTarget')) as { bounds: { left?: number; top?: number } };
      return bounds.left === undefined || bounds.top === undefined ? null : { left: bounds.left, top: bounds.top };
    } catch {
      return null;
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  /** 창 제목 (위치로 못 찾을 때 제목으로 찾기) */
  async title(): Promise<string> {
    return this.page.title().catch(() => '');
  }

  /** 검토하도록 창을 보여준다: 최소화되어 있으면 되돌리고 이 탭을 앞으로 */
  async show(): Promise<void> {
    const cdp = await this.context.newCDPSession(this.page).catch(() => null);
    if (cdp) {
      try {
        const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      } catch {
        /* 창 조작을 지원하지 않는 브라우저는 앞으로 가져오기만 */
      } finally {
        await cdp.detach().catch(() => {});
      }
    }
    await this.page.bringToFront().catch(() => {});
  }

  /** CDP 연결만 끊는다. 브라우저 창은 사용자가 검토할 수 있게 남겨둔다. */
  async detach(opts: { closeTab?: boolean } = {}): Promise<void> {
    if (opts.closeTab) await this.page.close().catch(() => {});
    await this.browser.close(); // connectOverCDP 에서는 연결 해제만 한다
  }

  private async onDialog(d: Dialog): Promise<void> {
    await this.handleDialog(d).catch(() => {}); // 다른 연결이 먼저 처리했으면 "No dialog is showing" — 무시
  }

  private async handleDialog(d: Dialog): Promise<void> {
    const msg = d.message();
    if (Date.now() - this.actedAt > 5000) {
      // 사람이 누르다 뜬 창이다. 대신 닫지 않고 그대로 둔다 (사람이 읽고 고르도록)
      this.events.push(`사람이 띄운 창 — 그대로 둠: ${msg}`);
      return;
    }
    // 페이지 나가기 확인창은 항상 "머무르기"
    if (d.type() === 'beforeunload') {
      this.events.push('페이지 나가기 차단');
      return d.dismiss();
    }
    const verdict = checkLabel(msg, this.guard, true);
    if (verdict.blocked || /최종|수정불가/.test(normalizeLabel(msg))) {
      this.events.push(`대화상자 거절: ${msg}`);
      return d.dismiss();
    }
    this.events.push(`대화상자 확인: ${msg}`);
    return d.type() === 'prompt' ? d.dismiss() : d.accept();
  }
}

/** 브라우저를 갓 띄웠을 때 떠 있는 빈 화면 (빈 탭, 새 탭, 브라우저 홈 화면) */
const BLANK_PAGE = /^about:blank$|^chrome:\/\/(newtab|new-tab-page)|\/newtab\.html/;

/** 이미 이 세션이 가져간 페이지 (지원서 여러 개가 같은 창을 잡지 않도록) */
const claimed = new Set<string>();

/** 아직 아무도 안 쓰는 빈 화면이 있으면 그 창을 쓴다 (브라우저 홈 화면만 덩그러니 남는 것을 막는다) */
async function takeBlankPage(context: BrowserContext): Promise<Page | null> {
  for (const p of context.pages()) {
    if (p.isClosed() || !BLANK_PAGE.test(p.url())) continue;
    const s = await context.newCDPSession(p).catch(() => null);
    if (!s) continue;
    const info = (await s.send('Target.getTargetInfo').catch(() => null)) as { targetInfo?: { targetId: string } } | null;
    await s.detach().catch(() => {});
    const id = info?.targetInfo?.targetId;
    if (!id || claimed.has(id)) continue;
    claimed.add(id);
    return p;
  }
  return null;
}

/** 이 프로그램이 연 창 수 (창 표시와 놓는 자리에 쓴다) */
let windows = 0;

/**
 * 창 제목 앞에 [지원 n] 을 붙인다. 창이 여러 개일 때 어느 창이 어느 지원서인지 보이고,
 * "창 보기"에서 그 창을 정확히 집어 맨 앞으로 올릴 수 있다. 사이트가 제목을 바꿔도 다시 붙인다.
 */
async function markTitle(page: Page, mark: string): Promise<void> {
  // 가드와 마찬가지로 글(문자열)로 넣는다. 함수로 넣으면 빌드 도구가 붙인 도우미(__name) 때문에 페이지에서 터진다
  const script = `(function () {
  var m = ${JSON.stringify(mark)};
  function set() { if (document.title.indexOf(m) !== 0) document.title = (m + ' ' + document.title).trim(); }
  function start() { set(); new MutationObserver(set).observe(document.head || document.documentElement, { subtree: true, childList: true, characterData: true }); }
  if (document.head) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})();`;
  await page.addInitScript(script).catch(() => {});
  await page.evaluate(script).catch(() => {});
}

/**
 * 새 창은 모두 같은 자리에 겹쳐 열려서 한 창만 열린 것처럼 보인다.
 * 두 번째 창부터는 조금씩 어긋나게 놓아 창이 여러 개인 게 보이게 한다 (화면이 꽉 차면 조금 줄여서라도).
 */
async function cascade(context: BrowserContext, page: Page, n: number): Promise<void> {
  if (n <= 1) return; // 첫 창은 그대로
  const cdp = await context.newCDPSession(page).catch(() => null);
  if (!cdp) return;
  try {
    const { windowId, bounds } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number; bounds: { left?: number; top?: number; width?: number; height?: number } };
    const screen = await page.evaluate(() => ({ w: window.screen.availWidth, h: window.screen.availHeight })).catch(() => null);
    if (!screen || bounds.left === undefined || bounds.top === undefined) return;
    const step = 46;
    const slots = 4; // 4칸씩 돌려 쓴다 (지원서가 많아도 화면 밖으로 나가지 않게)
    const width = Math.min(bounds.width ?? screen.w, screen.w - step * slots);
    const height = Math.min(bounds.height ?? screen.h, screen.h - step * slots);
    const k = ((n - 2) % slots) + 1;
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: bounds.left + step * k, top: bounds.top + step * k, width, height, windowState: 'normal' },
    });
  } catch {
    /* 창 조작을 지원하지 않는 브라우저는 그대로 둔다 */
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** 새 창을 연다 (지원서를 여러 개 함께 진행할 때 창마다 따로). background 면 지금 창을 가리지 않게 뒤에 연다 */
async function openWindow(browser: Browser, context: BrowserContext, o: { background: boolean; url?: string; n: number }): Promise<Page> {
  const spare = await takeBlankPage(context);
  if (spare) {
    await cascade(context, spare, o.n);
    return spare;
  }
  const cdp = await browser.newBrowserCDPSession();
  try {
    // 여러 지원서가 동시에 창을 열 수 있어서, "새 페이지가 생겼다"가 아니라 내가 만든 대상(targetId)의 페이지를 찾는다.
    // 주소를 처음부터 넣어 열어야 빈 창이 잠깐 떴다가 바뀌지 않는다.
    const { targetId } = (await cdp.send('Target.createTarget', { url: o.url || 'about:blank', newWindow: true, background: o.background })) as { targetId: string };
    claimed.add(targetId);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      for (const p of context.pages()) {
        const s = await context.newCDPSession(p).catch(() => null);
        if (!s) continue;
        const info = (await s.send('Target.getTargetInfo').catch(() => null)) as { targetInfo?: { targetId: string } } | null;
        await s.detach().catch(() => {});
        if (info?.targetInfo?.targetId === targetId) {
          await cascade(context, p, o.n);
          return p;
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('새 창을 찾지 못했습니다');
  } catch {
    return context.newPage(); // 새 창을 지원하지 않으면 새 탭으로
  } finally {
    await cdp.detach().catch(() => {});
  }
}
