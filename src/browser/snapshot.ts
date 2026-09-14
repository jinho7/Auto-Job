// 지원서 페이지를 AI 가 읽을 수 있는 목록으로 만든다.
// 각 프레임 안에서 실행해 입력칸/버튼마다 data-autojob-ref 를 붙이고, 사람이 보는 라벨을 최대한 찾아 붙인다.
import type { Frame, Page } from 'playwright-core';

export type Control = {
  ref: string;
  kind: 'input' | 'select' | 'textarea' | 'button' | 'link' | 'editable';
  type: string;
  label: string;
  section: string;
  value: string;
  checked?: boolean;
  options?: string[];
  placeholder?: string;
  required?: boolean;
  readonly?: boolean;
  disabled?: boolean;
  name?: string;
  maxlength?: number;
};

/** 프레임 안에서 실행되는 함수 (브라우저 쪽 코드) */
function collect(frameIndex: number): Control[] {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const textOf = (el: Element | null) => clean((el as HTMLElement | null)?.innerText ?? el?.textContent);

  function labelFor(el: HTMLElement): string {
    const id = el.getAttribute('id');
    if (id) {
      const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (l && textOf(l)) return textOf(l);
    }
    const wrap = el.closest('label');
    if (wrap) {
      const t = clean(wrap.textContent?.replace((el as HTMLInputElement).value ?? '', ''));
      if (t) return t;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((i) => textOf(document.getElementById(i))).join(' ');
      if (clean(t)) return clean(t);
    }
    const cell = el.closest('td, dd');
    if (cell) {
      // 같은 행의 제목 칸(th/dt). 옆 칸이 입력칸(td)이면 그 글자는 라벨이 아니다
      let prev = cell.previousElementSibling;
      while (prev && !['TH', 'DT'].includes(prev.tagName)) prev = prev.previousElementSibling;
      if (prev && textOf(prev) && textOf(prev).length < 40) return textOf(prev);
      // 표의 열 제목 (여러 행 입력표)
      const td = el.closest('td');
      const table = el.closest('table');
      if (td && table) {
        const idx = [...td.parentElement!.children].indexOf(td);
        const th = table.querySelector('thead tr')?.children[idx] ?? table.querySelector('tr')?.children[idx];
        if (th && th !== td && textOf(th)) return textOf(th);
      }
    }
    const title = el.getAttribute('title') || el.getAttribute('placeholder');
    if (title) return clean(title);
    // 바로 앞의 짧은 글자
    let p: Element | null = el;
    for (let i = 0; i < 3 && p; i++) {
      const prev = p.previousElementSibling;
      if (prev && textOf(prev) && textOf(prev).length < 30) return textOf(prev);
      p = p.parentElement;
    }
    return clean(el.getAttribute('name'));
  }

  function sectionOf(el: Element): string {
    let n: Element | null = el;
    while (n && n !== document.body) {
      const legend = n.tagName === 'FIELDSET' ? n.querySelector('legend') : null;
      if (legend) return textOf(legend);
      let prev = n.previousElementSibling;
      while (prev) {
        if (/^H[1-4]$/.test(prev.tagName) || /tit|title|header|heading/i.test(prev.className)) {
          const t = textOf(prev);
          if (t && t.length < 50) return t;
        }
        prev = prev.previousElementSibling;
      }
      n = n.parentElement;
    }
    return '';
  }

  let n = 0;
  const refOf = (el: Element) => {
    let r = el.getAttribute('data-autojob-ref');
    if (!r) {
      while (document.querySelector(`[data-autojob-ref="f${frameIndex}-${n}"]`)) n++;
      r = `f${frameIndex}-${n++}`;
      el.setAttribute('data-autojob-ref', r);
    }
    return r;
  };

  const out: Control[] = [];
  const CLICKABLE = 'button, a[href], [role="button"], [role="tab"], input[type="button"], input[type="submit"]';
  // 입력칸과 버튼을 화면 순서대로 (주소검색 버튼이 주소 칸 옆에 오도록)
  const all = document.querySelectorAll(`input, select, textarea, [contenteditable="true"], ${CLICKABLE}`);
  for (const el of all) {
    if (el.matches(CLICKABLE)) {
      if (!visible(el)) continue;
      const t = clean((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute('aria-label') || el.getAttribute('title'));
      if (!t || t.length > 40) continue;
      const href = el.getAttribute('href') ?? '';
      if (el.tagName === 'A' && (href.startsWith('mailto:') || href.startsWith('tel:'))) continue;
      out.push({ ref: refOf(el), kind: el.tagName === 'A' ? 'link' : 'button', type: el.getAttribute('role') ?? el.tagName.toLowerCase(), label: t, section: sectionOf(el), value: '' });
      continue;
    }
    const h = el as HTMLInputElement;
    const type = (h.getAttribute('type') || h.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
    // 숨긴 체크박스/라디오는 라벨이 보이면 포함 (디자인된 선택지)
    const lab = el.closest('label') ?? (h.id ? document.querySelector(`label[for="${CSS.escape(h.id)}"]`) : null);
    if (!visible(el) && !((type === 'checkbox' || type === 'radio') && lab && visible(lab))) continue;
    const c: Control = {
      ref: refOf(el),
      kind: el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : el.hasAttribute('contenteditable') ? 'editable' : 'input',
      type,
      label: labelFor(h),
      section: sectionOf(el),
      value: el.tagName === 'SELECT' ? clean((h as unknown as HTMLSelectElement).selectedOptions[0]?.text) : el.hasAttribute('contenteditable') ? textOf(el) : h.value ?? '',
    };
    if (type === 'checkbox' || type === 'radio') {
      c.checked = h.checked;
      c.name = h.name;
      c.label = labelFor(h) || clean(h.value);
    }
    if (el.tagName === 'SELECT') c.options = [...(h as unknown as HTMLSelectElement).options].slice(0, 60).map((o) => clean(o.text));
    if (h.placeholder) c.placeholder = clean(h.placeholder);
    if (h.required || h.getAttribute('aria-required') === 'true') c.required = true;
    if (h.readOnly) c.readonly = true;
    if (h.disabled) c.disabled = true;
    if (h.maxLength > 0 && h.maxLength < 100000) c.maxlength = h.maxLength;
    out.push(c);
  }
  return out;
}

// tsx(esbuild) 가 함수에 넣는 __name 도우미는 페이지 안에 없으므로, 문자열로 감싸 넣어 준다
const COLLECT_SRC = `(function(){ const __name = (f) => f; return (${collect.toString()}); })()`;

export async function snapshotFrames(page: Page): Promise<{ frame: Frame; controls: Control[] }[]> {
  const out: { frame: Frame; controls: Control[] }[] = [];
  const frames = page.frames();
  for (let i = 0; i < frames.length; i++) {
    const controls = await frames[i].evaluate(`${COLLECT_SRC}(${i})`).then((r) => r as Control[]).catch(() => [] as Control[]);
    if (controls.length) out.push({ frame: frames[i], controls });
  }
  return out;
}

/** AI 에게 보여줄 한 줄 요약들 */
export function formatControls(controls: Control[]): string {
  const lines: string[] = [];
  let section = '';
  for (const c of controls) {
    if (c.section && c.section !== section) {
      section = c.section;
      lines.push(`## ${section}`);
    }
    const flags = [c.required && '필수', c.readonly && '읽기전용', c.disabled && '비활성', c.maxlength && `최대 ${c.maxlength}자`].filter(Boolean).join(', ');
    if (c.kind === 'button' || c.kind === 'link') {
      lines.push(`[${c.ref}] ${c.kind === 'link' ? '링크' : '버튼'} "${c.label}"`);
      continue;
    }
    const val = c.type === 'checkbox' || c.type === 'radio' ? (c.checked ? '선택됨' : '선택 안 됨') : `값="${c.value.slice(0, 80)}"`;
    const opts = c.options ? ` 선택지=[${c.options.join(' | ')}]` : '';
    const ph = c.placeholder && c.placeholder !== c.label ? ` placeholder="${c.placeholder}"` : '';
    const nm = c.name && (c.type === 'radio' || c.type === 'checkbox') ? ` 그룹=${c.name}` : '';
    lines.push(`[${c.ref}] ${c.kind === 'select' ? 'select' : c.type} "${c.label}" ${val}${ph}${opts}${nm}${flags ? ` (${flags})` : ''}`);
  }
  return lines.join('\n');
}
