// 제출 차단 가드.
// 1차: 페이지 안 스크립트(pageGuardScript)가 금지 버튼의 클릭과 폼 submit을 캡처 단계에서 막는다.
// 2차: BrowserSession.click()이 누르기 전에 checkLabel()로 문구를 검사해 거부한다.
// 3차: BrowserSession은 뒤로가기/새로고침/탭 닫기 API를 노출하지 않고, beforeunload 대화상자는 머무르기로 처리한다.
import type { Page } from 'playwright-core';
import type { GuardConfig } from '../config';

export class GuardBlockedError extends Error {
  constructor(readonly label: string, readonly keyword: string) {
    super(`제출 차단 가드: "${label}" 버튼은 누를 수 없습니다 (금지어: ${keyword})`);
    this.name = 'GuardBlockedError';
  }
}

export function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, '').toLowerCase();
}

export type GuardVerdict = { blocked: false } | { blocked: true; keyword: string };

export function checkLabel(label: string, cfg: GuardConfig, armed: boolean): GuardVerdict {
  const norm = normalizeLabel(label);
  if (!norm) return { blocked: false };
  if (cfg.allow_exact.some((a) => normalizeLabel(a) === norm)) return { blocked: false };
  const lists = armed ? [...cfg.always_block, ...cfg.block_when_armed] : cfg.always_block;
  const hit = lists.find((k) => norm.includes(normalizeLabel(k)));
  return hit ? { blocked: true, keyword: hit } : { blocked: false };
}

/**
 * 모든 문서와 프레임에 주입하는 1차 가드.
 * **사람이 직접 누르는 것은 막지 않는다.** AI 도구가 무언가 하기 직전에 window.__autojobAgentAt 에 시각을 찍는데,
 * 그 직후(3초 안)에 일어난 클릭·폼 제출만 막는다. 사람은 자기 지원서를 마음대로 눌러야 하고, 제출도 사람이 한다.
 * window.__autojobArmed 가 true 면 block_when_armed 까지 적용한다.
 */
export function pageGuardScript(cfg: GuardConfig): string {
  const norm = (xs: string[]) => JSON.stringify(xs.map(normalizeLabel));
  return `(() => {
  if (window.__autojobGuardInstalled) return;
  window.__autojobGuardInstalled = true;
  const ALWAYS = ${norm(cfg.always_block)};
  const ARMED = ${norm(cfg.block_when_armed)};
  const ALLOW = ${norm(cfg.allow_exact)};
  const CLICKABLE = 'button, a, input[type=submit], input[type=button], input[type=image], [role=button], [onclick]';
  const labelOf = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '')
    .replace(/\\s+/g, '').toLowerCase();
  const AGENT_MS = 3000;
  const byAgent = () => typeof window.__autojobAgentAt === 'number' && Date.now() - window.__autojobAgentAt < AGENT_MS;
  const forbidden = (el) => {
    if (!byAgent()) return null; // 사람이 누른 것은 막지 않는다
    const l = labelOf(el);
    if (!l || ALLOW.includes(l)) return null;
    const lists = window.__autojobArmed ? ALWAYS.concat(ARMED) : ALWAYS;
    return lists.find((k) => l.includes(k)) || null;
  };
  const block = (e, el, kw) => {
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type === 'click') console.warn('[autojob-guard] blocked: ' + labelOf(el) + ' (' + kw + ')');
  };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    window.addEventListener(type, (e) => {
      const el = e.target instanceof Element ? e.target.closest(CLICKABLE) : null;
      const kw = el && forbidden(el);
      if (kw) block(e, el, kw);
    }, true);
  }
  // 엔터로 제출하면 브라우저가 폼의 첫 제출 버튼을 submitter 로 넘긴다. 그 버튼이 금지 문구면 막는다.
  // (제출 버튼이 없는 폼 — 주소 검색창 등 — 은 막지 않는다)
  window.addEventListener('submit', (e) => {
    const s = e.submitter || (e.target instanceof HTMLFormElement ? e.target.querySelector('button[type=submit], button:not([type]), input[type=submit]') : null);
    const kw = s && forbidden(s);
    if (kw) block(e, s, kw);
  }, true);
})();`;
}

export const ARM_SCRIPT = 'window.__autojobArmed = true;';

/** AI 도구가 무언가 하기 직전에 찍는 표시 (이 직후의 클릭·제출만 가드가 막는다) */
export const MARK_AGENT_SCRIPT = 'window.__autojobAgentAt = Date.now();';

/** 이 페이지의 모든 프레임에 "지금부터 AI 가 한다" 표시를 찍는다 */
export async function markAgentAction(page: Page): Promise<void> {
  for (const f of page.frames()) await f.evaluate(MARK_AGENT_SCRIPT).catch(() => {});
}

/**
 * 가드를 이 탭과, 이 탭에서 열린 팝업에만 건다 (같은 브라우저의 다른 탭에는 영향 없음).
 * 반환값의 arm() 은 이후 "지원하기" 계열까지 막는다. owns() 는 이 탭 묶음인지 확인한다.
 */
export async function installGuard(page: Page, cfg: GuardConfig, opts: { armed?: boolean } = {}): Promise<{ arm: () => Promise<void>; owns: (p: Page | null) => boolean; pages: Set<Page> }> {
  const pages = new Set<Page>();
  let armed = !!opts.armed;
  const script = pageGuardScript(cfg);
  const apply = async (p: Page) => {
    pages.add(p);
    await p.addInitScript(script);
    if (armed) await p.addInitScript(ARM_SCRIPT);
    for (const f of p.frames()) await f.evaluate(`${script};${armed ? ARM_SCRIPT : ''}`).catch(() => {});
    p.on('popup', (child) => void apply(child).catch(() => {}));
  };
  await apply(page);
  return {
    pages,
    owns: (p) => !!p && pages.has(p),
    arm: async () => {
      armed = true;
      for (const p of pages) {
        if (p.isClosed()) continue;
        await p.addInitScript(ARM_SCRIPT);
        for (const f of p.frames()) await f.evaluate(ARM_SCRIPT).catch(() => {});
      }
    },
  };
}
