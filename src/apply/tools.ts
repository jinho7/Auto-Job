// 지원서 입력 중 AI 가 쓸 수 있는 브라우저 조작. 모든 안전 규칙은 여기서 코드로 지킨다.
//  - 이미 값이 있는 칸은 바꾸지 않는다 ("이미 입력된 값은 수정 및 삭제하지 마세요")
//  - 제출/작성완료 등 금지 문구 버튼, 삭제/로그아웃/작성취소 버튼은 누르지 않는다
//  - 다른 사이트로 떠나는 링크는 누르지 않는다. 뒤로가기/새로고침/주소 이동 기능은 아예 없다
//  - 파일 올리기는 profile/me/files 안의 파일만
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import type { Settings } from '../config';
import { checkLabel, installGuard } from '../browser/guard';
import { formatControls, snapshotFrames } from '../browser/snapshot';

/** 값을 지우거나 페이지를 떠나게 만드는 버튼 */
export const DATA_LOSS = /로그아웃|삭제|작성\s*취소|지원\s*취소|초기화|탈퇴/;

export type ToolLog = { tool: string; ref?: string; label?: string; value?: string; ok: boolean; message: string };

export class ToolError extends Error {}

export async function targetIdOf(context: BrowserContext, page: Page): Promise<string> {
  const cdp = await context.newCDPSession(page);
  try {
    const { targetInfo } = (await cdp.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } };
    return targetInfo.targetId;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

const toNativeDate = (type: string, v: string) => {
  const m = v.match(/^(\d{4})[.\-/](\d{1,2})(?:[.\-/](\d{1,2}))?$/);
  if (!m) return v;
  const [, y, mo, d] = m;
  if (type === 'date' && d) return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  if (type === 'month') return `${y}-${mo.padStart(2, '0')}`;
  return v;
};

const PLACEHOLDER_OPTION = /^(선택|--|-|select|choose|전체)/i;

export class ApplyTools {
  readonly log: ToolLog[] = [];
  private active: Page;

  private constructor(
    private readonly browser: Browser,
    readonly context: BrowserContext,
    readonly main: Page,
    private readonly settings: Settings,
    private readonly filesDir: string,
    /** 지원서 탭과, 거기서 열린 팝업들 (열린 순서) */
    private readonly owned: Set<Page>,
    /** 뒤에서 도는 지원서인가 (그렇다면 창을 앞으로 끌어오지 않는다) */
    private readonly background = false,
  ) {
    this.active = main;
  }

  /** 자동화 브라우저에 붙고, 지정한 탭(targetId)을 찾아 그 탭(과 팝업)에만 제출 차단을 켠다 */
  static async connect(settings: Settings, cdpPort: number, targetId: string, filesDir: string, opts: { background?: boolean } = {}): Promise<ApplyTools> {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const context = browser.contexts()[0];
    let main: Page | undefined;
    for (const p of context.pages()) if ((await targetIdOf(context, p).catch(() => '')) === targetId) main = p;
    if (!main) throw new Error('지원서 탭을 찾지 못했습니다. 탭을 닫았다면 다시 시작해 주세요.');
    const guard = await installGuard(main, settings.browser.guard, { armed: true });
    const tools = new ApplyTools(browser, context, main, settings, filesDir, guard.pages, !!opts.background);
    // 내 탭의 대화상자만 처리 (컨텍스트 리스너가 있으면 다른 탭 대화상자는 자동으로 닫히지 않는다)
    context.on('dialog', (d) => {
      if (guard.owns(d.page())) void tools.onDialog(d);
    });
    return tools;
  }

  async close(): Promise<void> {
    await this.browser.close(); // CDP 연결만 끊는다
  }

  private record(entry: ToolLog): string {
    this.log.push(entry);
    return entry.message;
  }

  private async onDialog(d: import('playwright-core').Dialog): Promise<void> {
    const msg = d.message();
    const bad = checkLabel(msg, this.settings.browser.guard, true).blocked || DATA_LOSS.test(msg) || /최종|수정\s*불가|페이지를\s*나가/.test(msg) || d.type() === 'beforeunload';
    this.record({ tool: 'dialog', ok: !bad, message: `${bad ? '거절' : '확인'}: ${msg}` });
    await (bad || d.type() === 'prompt' ? d.dismiss() : d.accept()).catch(() => {});
  }

  // ─── 창 ───
  private openPages(): Page[] {
    return [...this.owned].filter((p) => !p.isClosed());
  }

  pages(): string {
    const open = this.openPages();
    if (!open.includes(this.active)) this.active = this.main;
    return open.map((p, i) => `${i}: ${p === this.active ? '(현재) ' : ''}${p.url()}`).join('\n');
  }

  usePage(index: number): string {
    const open = this.openPages();
    if (!open[index]) throw new ToolError(`${index}번 창이 없습니다. pages 로 확인하세요.`);
    this.active = open[index];
    return `이제 ${index}번 창을 봅니다: ${this.active.url()}`;
  }

  private page(): Page {
    if (this.active.isClosed()) this.active = this.main;
    return this.active;
  }

  // ─── 읽기 ───
  async snapshot(): Promise<string> {
    const page = this.page();
    const frames = await snapshotFrames(page);
    const open = this.openPages().length;
    const head = `창: ${page === this.main ? '지원서' : '팝업'} — ${await page.title().catch(() => '')} (${page.url()})${open > 1 ? `\n열린 창 ${open}개 (pages 로 확인)` : ''}`;
    const body = frames.map(({ controls }) => formatControls(controls)).join('\n');
    const text = `${head}\n${body || '(입력칸이나 버튼을 찾지 못했습니다)'}`;
    return text.length > 60_000 ? `${text.slice(0, 60_000)}\n…(너무 길어 잘랐습니다)` : text;
  }

  /** 보이는 글 전체 (문항 글, 글자수 안내처럼 입력칸 라벨이 아닌 글을 읽을 때) */
  async pageText(): Promise<string> {
    const parts: string[] = [];
    for (const f of this.page().frames()) {
      const t = await f.evaluate('document.body ? document.body.innerText : ""').catch(() => '');
      if (typeof t === 'string' && t.trim()) parts.push(t.trim());
    }
    const text = parts.join('\n\n---\n\n').replace(/\n{3,}/g, '\n\n');
    return text.length > 30_000 ? `${text.slice(0, 30_000)}\n…(너무 길어 잘랐습니다)` : text;
  }

  /** 입력칸에 이미 들어 있는 값 (넣은 뒤 확인용) */
  async valueOf(ref: string): Promise<string> {
    return (await this.describe(await this.locate(ref))).value;
  }

  async screenshot(): Promise<Buffer> {
    // 뒤에서 도는 지원서는 창을 앞으로 끌어오지 않는다 (사람 일을 방해하지 않게).
    // 창을 계속 그리도록 띄웠기 때문에 가려져 있어도 화면은 찍힌다.
    if (!this.background) await this.page().bringToFront().catch(() => {});
    return this.page().screenshot({ type: 'jpeg', quality: 60, timeout: 15_000, animations: 'disabled' });
  }

  private async locate(ref: string): Promise<Locator> {
    const page = this.page();
    const m = ref.match(/^f(\d+)-\d+$/);
    const sel = `[data-autojob-ref="${ref}"]`;
    const frames = page.frames();
    const first = m ? frames[Number(m[1])] : undefined;
    for (const f of first ? [first, ...frames.filter((x) => x !== first)] : frames) {
      const loc = f.locator(sel);
      if (await loc.count().catch(() => 0)) return loc.first();
    }
    throw new ToolError(`${ref} 를 찾지 못했습니다. 화면이 바뀌었을 수 있으니 snapshot 을 다시 보세요.`);
  }

  private async describe(loc: Locator): Promise<{ label: string; tag: string; type: string; value: string; readonly: boolean; disabled: boolean; checked: boolean; href: string; target: string }> {
    return loc.evaluate((el) => {
      const h = el as HTMLInputElement;
      const tag = el.tagName.toLowerCase();
      return {
        label: ((el as HTMLElement).innerText || h.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim(),
        tag,
        type: (h.getAttribute('type') || tag).toLowerCase(),
        value: tag === 'select' ? ((el as unknown as HTMLSelectElement).selectedOptions[0]?.text ?? '').trim() : (h.value ?? ''),
        readonly: !!h.readOnly,
        disabled: !!h.disabled,
        checked: !!h.checked,
        href: el.getAttribute('href') ?? '',
        target: el.getAttribute('target') ?? '',
      };
    });
  }

  // ─── 입력 ───
  async fill(ref: string, value: string, opts: { typeSlowly?: boolean } = {}): Promise<string> {
    const loc = await this.locate(ref);
    const d = await this.describe(loc);
    if (d.disabled) throw new ToolError('비활성화된 칸입니다.');
    if (d.readonly) throw new ToolError('읽기 전용 칸입니다. 옆의 버튼(예: 주소검색)이나 팝업으로 입력하는 칸일 수 있습니다.');
    if (d.value.trim() && d.value.trim() !== value.trim()) {
      return this.record({ tool: 'fill', ref, value, ok: false, message: `이미 "${d.value}" 값이 있어 건드리지 않았습니다 (이미 입력된 값은 수정하지 않음).` });
    }
    const v = toNativeDate(d.type, value);
    if (opts.typeSlowly) {
      await loc.click();
      await loc.pressSequentially(v, { delay: 40 });
    } else {
      await loc.fill(v);
    }
    await loc.dispatchEvent('change').catch(() => {});
    await loc.evaluate((el) => (el as HTMLElement).blur()).catch(() => {});
    const after = (await this.describe(loc)).value;
    return this.record({ tool: 'fill', ref, value, ok: true, message: `입력함: "${after}"${after !== v ? ` (사이트가 "${v}"를 "${after}"로 바꿨습니다)` : ''}` });
  }

  async select(ref: string, option: string): Promise<string> {
    const loc = await this.locate(ref);
    const d = await this.describe(loc);
    if (d.tag !== 'select') throw new ToolError('select 가 아닙니다. 라디오/체크박스는 check 를 쓰세요.');
    const options = await loc.evaluate((el) => [...(el as HTMLSelectElement).options].map((o, i) => ({ i, text: o.text.trim(), value: o.value })));
    const cur = d.value;
    const currentIsPlaceholder = !cur || PLACEHOLDER_OPTION.test(cur) || options[0]?.text === cur && options[0].value === '';
    const pick = options.find((o) => o.text === option) ?? options.find((o) => o.value === option) ?? options.find((o) => o.text.replace(/\s/g, '').includes(option.replace(/\s/g, '')));
    if (!pick) throw new ToolError(`"${option}" 선택지가 없습니다. 선택지: ${options.map((o) => o.text).join(' | ')}`);
    if (!currentIsPlaceholder && cur !== pick.text) {
      return this.record({ tool: 'select', ref, value: option, ok: false, message: `이미 "${cur}" 이(가) 선택되어 있어 건드리지 않았습니다.` });
    }
    await loc.selectOption({ index: pick.i });
    return this.record({ tool: 'select', ref, value: pick.text, ok: true, message: `선택함: "${pick.text}"` });
  }

  async check(ref: string, checked = true): Promise<string> {
    const loc = await this.locate(ref);
    const d = await this.describe(loc);
    if (d.type !== 'checkbox' && d.type !== 'radio') throw new ToolError('체크박스/라디오가 아닙니다.');
    if (d.checked === checked) return this.record({ tool: 'check', ref, ok: true, message: '이미 그 상태입니다.' });
    if (!checked) return this.record({ tool: 'check', ref, ok: false, message: '이미 선택된 항목은 해제하지 않습니다 (이미 입력된 값은 수정하지 않음).' });
    if (d.type === 'radio') {
      const groupChecked = await loc.evaluate((el) => {
        const r = el as HTMLInputElement;
        return !!r.name && !!document.querySelector(`input[type=radio][name="${CSS.escape(r.name)}"]:checked`);
      });
      if (groupChecked) return this.record({ tool: 'check', ref, ok: false, message: '같은 그룹에서 이미 다른 항목이 선택되어 있어 바꾸지 않았습니다.' });
    }
    // 디자인 때문에 숨겨진 라디오도 있어, 요소 자체의 click 으로 선택한다 (라벨/버튼 문구 검사는 click 과 같다)
    await loc.check({ timeout: 2000 }).catch(() => loc.evaluate((el) => (el as HTMLElement).click()));
    const ok = (await this.describe(loc)).checked;
    return this.record({ tool: 'check', ref, ok, message: ok ? '선택함' : '선택되지 않았습니다. 라벨 버튼을 click 해 보세요.' });
  }

  async click(ref: string): Promise<string> {
    const loc = await this.locate(ref);
    const d = await this.describe(loc);
    const verdict = checkLabel(d.label, this.settings.browser.guard, true);
    if (verdict.blocked) return this.record({ tool: 'click', ref, label: d.label, ok: false, message: `"${d.label}" 은(는) 제출 계열 버튼이라 누르지 않습니다 (금지어: ${verdict.keyword}).` });
    if (DATA_LOSS.test(d.label)) return this.record({ tool: 'click', ref, label: d.label, ok: false, message: `"${d.label}" 은(는) 입력한 내용을 지우거나 페이지를 떠날 수 있어 누르지 않습니다.` });
    if (d.tag === 'a' && d.href && !/^(#|javascript:)/i.test(d.href) && d.target !== '_blank') {
      const here = new URL(this.page().url());
      const to = new URL(d.href, here);
      if (to.origin !== here.origin || to.pathname !== here.pathname) {
        return this.record({ tool: 'click', ref, label: d.label, ok: false, message: `"${d.label}" 링크는 지원서 페이지를 떠나서 누르지 않습니다.` });
      }
    }
    const before = this.owned.size;
    await loc.click({ timeout: 5000 });
    await this.page().waitForTimeout(700);
    const opened = this.owned.size > before ? ` 새 창이 열렸습니다 → pages / use_page ${this.openPages().length - 1}` : '';
    return this.record({ tool: 'click', ref, label: d.label, ok: true, message: `눌렀습니다: "${d.label}".${opened}` });
  }

  async press(ref: string, key: string): Promise<string> {
    if (!/^(Enter|Tab|Escape|ArrowDown|ArrowUp|ArrowLeft|ArrowRight|Space)$/.test(key)) throw new ToolError('Enter, Tab, Escape, 방향키, Space 만 누를 수 있습니다.');
    const loc = await this.locate(ref);
    await loc.press(key === 'Space' ? ' ' : key);
    await this.page().waitForTimeout(500);
    return this.record({ tool: 'press', ref, value: key, ok: true, message: `${key} 를 눌렀습니다.` });
  }

  async upload(ref: string, fileName: string): Promise<string> {
    const file = path.join(this.filesDir, path.basename(fileName));
    if (!existsSync(file)) throw new ToolError(`profile/me/files/${path.basename(fileName)} 파일이 없습니다.`);
    const loc = await this.locate(ref);
    await loc.setInputFiles(file);
    return this.record({ tool: 'upload', ref, value: path.basename(file), ok: true, message: `올렸습니다: ${path.basename(file)}` });
  }

  /**
   * 임시저장: 지원서 창에서 설정의 저장 버튼 문구(앞에 있는 것부터)와 같은 버튼을 찾아 누른다.
   * 누를 때 click 과 같은 가드를 거치므로 "저장 후 제출" 같은 버튼은 막힌다. 뜬 알림창 글도 돌려준다.
   */
  async saveDraft(labels: string[]): Promise<{ ok: boolean; label?: string; message: string; dialogs: string[] }> {
    this.active = this.main;
    const n = (s: string) => s.replace(/\s+/g, '').toLowerCase();
    const buttons = (await snapshotFrames(this.main)).flatMap(({ controls }) => controls).filter((c) => c.kind === 'button' || c.kind === 'link');
    for (const want of labels) {
      const b = buttons.find((c) => n(c.label) === n(want));
      if (!b) continue;
      const before = this.log.length;
      const message = await this.click(b.ref);
      await this.main.waitForTimeout(1500);
      const dialogs = this.log.slice(before).filter((l) => l.tool === 'dialog').map((l) => l.message);
      const ok = this.log.slice(before).some((l) => l.tool === 'click' && l.ok);
      return { ok, label: b.label, message, dialogs };
    }
    return { ok: false, message: `임시저장 버튼을 찾지 못했습니다 (찾은 문구: ${labels.join(', ')}). 직접 저장해 주세요.`, dialogs: [] };
  }

  async wait(ms: number): Promise<string> {
    await this.page().waitForTimeout(Math.min(Math.max(ms, 100), 5000));
    return '기다렸습니다.';
  }
}
