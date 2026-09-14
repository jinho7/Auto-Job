// 제출 차단 가드.
// 1차: 페이지 안 스크립트(pageGuardScript)가 금지 버튼의 클릭과 폼 submit을 캡처 단계에서 막는다.
// 2차: BrowserSession.click()이 누르기 전에 checkLabel()로 문구를 검사해 거부한다.
// 3차: BrowserSession은 뒤로가기/새로고침/탭 닫기 API를 노출하지 않고, beforeunload 대화상자는 머무르기로 처리한다.
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

/** 모든 문서와 프레임에 주입하는 1차 가드. window.__autojobArmed가 true면 block_when_armed까지 적용한다. */
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
  const forbidden = (el) => {
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
  window.addEventListener('submit', (e) => {
    const s = e.submitter;
    const kw = s ? forbidden(s) : (window.__autojobArmed ? 'submitter 없음' : null);
    if (kw) block(e, s || e.target, kw);
  }, true);
})();`;
}

export const ARM_SCRIPT = 'window.__autojobArmed = true;';
