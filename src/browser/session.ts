// AI와 파이프라인이 브라우저를 다루는 유일한 통로.
// 뒤로가기, 새로고침, 탭 닫기, 강제 덮어쓰기 같은 위험한 조작은 의도적으로 제공하지 않는다.
import type { Browser, BrowserContext, Dialog, Locator, Page } from 'playwright-core';
import type { GuardConfig, Settings } from '../config';
import { connectCdp } from './cdp';
import { checkLabel, GuardBlockedError, installGuard, normalizeLabel } from './guard';

export type FillResult = 'filled' | 'skipped-prefilled';

export class BrowserSession {
  private armed = false;
  readonly events: string[] = [];

  private constructor(
    private readonly browser: Browser,
    readonly context: BrowserContext,
    private readonly guard: GuardConfig,
    public page: Page,
    private readonly tabGuard: Awaited<ReturnType<typeof installGuard>>,
  ) {}

  static async open(settings: Settings): Promise<BrowserSession> {
    const { driver, guard } = settings.browser;
    if (driver === 'handoff') throw new Error('handoff 드라이버는 브라우저를 직접 조종하지 않습니다');
    const browser = await connectCdp(settings.browser[driver]);
    const context = browser.contexts()[0] ?? (await browser.newContext());

    // 가드는 이 세션이 연 탭(과 그 팝업)에만 건다. 같은 브라우저의 다른 탭에는 영향이 없다.
    const page = await context.newPage();
    const tabGuard = await installGuard(page, guard);
    const session = new BrowserSession(browser, context, guard, page, tabGuard);
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

  /** 뒤에 가려진 탭은 화면을 그리지 않아 캡처가 멈출 수 있어, 앞으로 가져온 뒤 찍는다. 전체 페이지가 안 되면 보이는 부분만. */
  async screenshot(file: string): Promise<void> {
    await this.page.bringToFront().catch(() => {});
    await this.page
      .screenshot({ path: file, fullPage: true, timeout: 15_000, animations: 'disabled' })
      .catch(() => this.page.screenshot({ path: file, timeout: 15_000, animations: 'disabled' }));
  }

  async bringToFront(): Promise<void> {
    await this.page.bringToFront();
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
