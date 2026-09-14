// AI와 파이프라인이 브라우저를 다루는 유일한 통로.
// 뒤로가기, 새로고침, 탭 닫기, 강제 덮어쓰기 같은 위험한 조작은 의도적으로 제공하지 않는다.
import type { Browser, BrowserContext, Dialog, Locator, Page } from 'playwright-core';
import type { GuardConfig, Settings } from '../config';
import { connectCdp } from './cdp';
import { ARM_SCRIPT, checkLabel, GuardBlockedError, normalizeLabel, pageGuardScript } from './guard';

export type FillResult = 'filled' | 'skipped-prefilled';

export class BrowserSession {
  private armed = false;
  readonly events: string[] = [];

  private constructor(
    private readonly browser: Browser,
    readonly context: BrowserContext,
    private readonly guard: GuardConfig,
    public page: Page,
  ) {}

  static async open(settings: Settings): Promise<BrowserSession> {
    const { driver, guard } = settings.browser;
    if (driver === 'handoff') throw new Error('handoff 드라이버는 브라우저를 직접 조종하지 않습니다');
    const browser = await connectCdp(settings.browser[driver]);
    const context = browser.contexts()[0] ?? (await browser.newContext());

    const script = pageGuardScript(guard);
    await context.addInitScript(script);
    // 이미 열려 있던 문서에도 즉시 적용
    for (const p of context.pages()) for (const f of p.frames()) await f.evaluate(script).catch(() => {});

    const page = await context.newPage();
    const session = new BrowserSession(browser, context, guard, page);
    context.on('dialog', (d) => session.onDialog(d));
    context.on('page', (p) => session.events.push(`새 창: ${p.url() || '(로딩 중)'}`));
    return session;
  }

  /** 지원서 입력 단계 진입. 이후로는 block_when_armed(지원하기 등)도 차단한다. */
  async arm(): Promise<void> {
    this.armed = true;
    await this.context.addInitScript(ARM_SCRIPT);
    for (const p of this.context.pages()) for (const f of p.frames()) await f.evaluate(ARM_SCRIPT).catch(() => {});
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

  async screenshot(file: string): Promise<void> {
    await this.page.screenshot({ path: file, fullPage: true });
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
