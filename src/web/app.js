// Auto-Job 설정 화면. 프레임워크 없이 DOM 을 직접 만든다 (값은 항상 textContent / value 로 넣는다).
'use strict';

// ─── 토큰과 API ─────────────────────────────────────────
const TOKEN = (() => {
  const m = location.hash.match(/t=([0-9a-f]+)/);
  if (m) {
    sessionStorage.setItem('autojob-token', m[1]);
    history.replaceState(null, '', location.pathname);
  }
  return sessionStorage.getItem('autojob-token') || '';
})();

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-AutoJob-Token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `요청 실패 (${res.status})`);
  return json;
}

// ─── DOM 도우미 ─────────────────────────────────────────
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), bad ? 5000 : 2200);
}

async function run(fn, okMsg) {
  try {
    const r = await fn();
    if (r && r.schema) state = r;
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    renderChrome();
    return r;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

// ─── 상태와 화면 전환 ───────────────────────────────────
let state = null;
let view = (() => {
  try { return JSON.parse(localStorage.getItem('autojob-view')) || { type: 'settings', id: 'start' }; } catch { return { type: 'settings', id: 'start' }; }
})();

const SETTINGS_PAGES = [
  ['실행', [['start', '시작하기'], ['collect', '공고 수집'], ['applies', '지원서 작성']]],
  ['검색 조건', [['keywords', '검색 키워드'], ['sources', '수집 사이트'], ['employment', '고용형태'], ['roles', '직무 태그 규칙'], ['ai', 'AI 보강']]],
  ['기업 필터', [['companies', '기업 구분'], ['overrides', '회사 직접 지정']]],
  ['작성', [['apply', '지원서 입력 규칙'], ['essay', '자기소개서 문체']]],
  ['연결', [['notion', 'Notion'], ['browser', '브라우저'], ['llm', 'AI 연결'], ['guard', '제출 차단 문구']]],
];

function go(type, id) {
  view = { type, id };
  try { localStorage.setItem('autojob-view', JSON.stringify(view)); } catch {}
  render();
}

const sectionIssues = (name) => ({
  missing: state.check.missing.filter((m) => m.path === name || m.path.startsWith(`${name}.`)).length,
  errors: state.check.errors.filter((m) => m.path.startsWith(`${name}.`)).length,
});

function renderChrome() {
  if (!state) return;
  const nav = document.getElementById('nav');
  nav.replaceChildren(
    h('h3', null, '내 정보'),
    h('button', { class: view.type === 'profile' && view.id === '__import' ? 'active' : '', onclick: () => go('profile', '__import') }, h('span', null, '📋 붙여넣어 채우기')),
    ...Object.entries(state.schema.sections).map(([name, sec]) => {
      const { missing, errors } = sectionIssues(name);
      const badge = errors ? h('span', { class: 'badge bad' }, `오류 ${errors}`) : missing ? h('span', { class: 'badge warn' }, `필수 ${missing}`) : null;
      return h('button', { class: view.type === 'profile' && view.id === name ? 'active' : '', onclick: () => go('profile', name) }, h('span', null, sec.label), badge);
    }),
    ...SETTINGS_PAGES.flatMap(([group, pages]) => [
      h('h3', null, group),
      ...pages.map(([id, label]) => h('button', { class: view.type === 'settings' && view.id === id ? 'active' : '', onclick: () => go('settings', id) }, h('span', null, label), settingsBadge(id))),
    ]),
  );

  const s = state.settings;
  const c = state.check;
  document.getElementById('summary').replaceChildren(
    h('span', { class: `badge ${c.missing.length || c.errors.length ? 'warn' : 'ok'}` }, `내 정보 ${c.filled}/${c.total}`),
    h('span', { class: `badge ${s.collect.keywords.length ? 'ok' : 'warn'}` }, `키워드 ${s.collect.keywords.length}개`),
    h('span', { class: `badge ${state.secrets.NOTION_TOKEN.set && s.notion.data_source_id ? 'ok' : 'warn'}` }, state.secrets.NOTION_TOKEN.set ? (s.notion.data_source_id ? 'Notion 연결됨' : 'Notion DB 미선택') : 'Notion 미연결'),
    h('span', { class: 'badge ok' }, `브라우저 ${s.browser.driver}`),
  );
}

function settingsBadge(id) {
  const s = state.settings;
  if (id === 'keywords' && !s.collect.keywords.length) return h('span', { class: 'badge warn' }, '비어 있음');
  if (id === 'notion' && !(state.secrets.NOTION_TOKEN.set && s.notion.data_source_id)) return h('span', { class: 'badge warn' }, '설정 필요');
  if (id === 'applies') {
    const waiting = applyState.jobs.filter((j) => j.status === 'waiting').length;
    const active = applyState.jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
    if (waiting) return h('span', { class: 'badge bad' }, `확인 ${waiting}`);
    if (active) return h('span', { class: 'badge ok' }, `진행 ${active}`);
  }
  return null;
}

function render() {
  renderChrome();
  const main = document.getElementById('main');
  main.replaceChildren(...(view.type === 'profile' ? profilePage(view.id) : settingsPage(view.id)).filter(Boolean));
  main.scrollTop = 0;
}

// ─── 내 정보 ────────────────────────────────────────────
const getIn = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
const isEmpty = (v) => v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
const FMT = { date: 'YYYY.MM.DD', month: 'YYYY.MM', number: '숫자' };

function profilePage(name) {
  if (name === '__import') return importPage();
  const sec = state.schema.sections[name];
  if (!sec) return [h('p', null, '없는 섹션입니다.')];
  const issues = [...state.check.missing, ...state.check.errors].filter((m) => m.path === name || m.path.startsWith(`${name}.`));
  return [
    h('h1', null, sec.label),
    h('p', { class: 'lead' }, '입력하면 바로 저장됩니다. 값이 없는 칸은 비워 두세요. AI는 빈 칸을 추정해서 채우지 않습니다.'),
    issues.length
      ? h('div', { class: 'notice', id: 'issues' }, `확인이 필요한 항목 ${issues.length}개`, h('ul', null, issues.map((i) => h('li', null, `${i.where}: ${i.message}`))))
      : h('div', { class: 'notice ok', id: 'issues' }, '이 섹션은 문제가 없습니다.'),
    name === 'stories' ? storiesFolderCard() : null,
    name === 'stories'
      ? card('직접 적은 소재 (선택)', h('p', { class: 'muted small', style: 'margin-top:0' }, '폴더에 없는 경험을 따로 적어 두고 싶을 때만 씁니다.'), renderFields(Object.fromEntries(Object.entries(sec.fields).filter(([k]) => k !== 'folders')), [name]))
      : h('div', { class: 'card' }, renderFields(sec.fields, [name])),
  ];
}

// ─── 자기소개서 소재 폴더 ───────────────────────────────
function storiesFolderCard() {
  const list = h('div', null, h('p', { class: 'muted small' }, '폴더를 살펴보는 중…'));
  const input = h('input', { placeholder: '폴더 위치 (예: ~/Documents/취업/경험정리)', style: 'flex:1;min-width:0' });
  const add = async (p) => {
    if (!p?.trim()) return toast('폴더 위치를 적어 주세요', true);
    await run(() => api('POST', '/api/stories/folders/add', { path: p }), (r) => `연결했습니다 — 파일 ${r.folder.total}개`);
    input.value = '';
    render();
  };
  const draw = async () => {
    const folders = state.profile.stories?.folders || [];
    if (!folders.length) return list.replaceChildren(h('p', { class: 'muted small' }, '아직 연결한 폴더가 없습니다.'));
    const { folders: scanned } = await api('GET', '/api/stories/folders');
    list.replaceChildren(...folders.map((f, i) => {
      const sc = scanned[i] || {};
      const counts = Object.entries(sc.counts || {}).map(([k, v]) => `${k} ${v}`).join(' · ');
      return h('div', { class: 'item', style: 'padding:10px 12px;margin-bottom:8px' },
        h('div', { class: 'row', style: 'justify-content:space-between;align-items:flex-start;gap:8px' },
          h('div', { style: 'min-width:0' },
            h('div', { style: 'font-weight:600;word-break:break-all' }, `📂 ${f.path}`),
            h('div', { class: 'small', style: `color:var(${sc.ok ? '--muted' : '--danger'})` }, sc.ok ? `읽을 파일 ${sc.total}개${counts ? ` (${counts})` : ''}${sc.truncated ? ' · 너무 많아 일부만' : ''}` : sc.error || '확인 중')),
          h('button', { class: 'btn danger', type: 'button', onclick: async () => {
            if (!confirm('이 폴더 연결을 끊을까요? (폴더와 파일은 그대로입니다)')) return;
            await run(() => api('POST', '/api/profile/remove', { path: `stories.folders.${i}` }), '연결을 끊었습니다');
            render();
          } }, '연결 끊기')),
        renderScalar(state.schema.sections.stories.fields.folders.item.note, ['stories', 'folders', i, 'note']),
        sc.sample?.length ? h('details', null, h('summary', { class: 'small muted' }, '파일 보기'), h('ul', { class: 'small muted', style: 'margin:6px 0 0;padding-left:18px' }, sc.sample.map((x) => h('li', null, x)), sc.total > sc.sample.length ? h('li', null, `… 외 ${sc.total - sc.sample.length}개`) : null)) : null,
      );
    }));
  };
  draw().catch((e) => list.replaceChildren(h('div', { class: 'notice bad' }, e.message)));
  const isMac = /Mac/.test(navigator.platform || navigator.userAgent);
  return card('소재 폴더 연결',
    h('p', { class: 'muted small', style: 'margin-top:0' }, '경험을 정리해 둔 폴더(프로젝트 회고, 활동 정리, 이력서, 포트폴리오 …)를 연결하면, 자기소개서를 쓸 때 AI 가 이 폴더의 md · txt · pdf 파일을 읽고 문항에 맞는 소재를 찾습니다. 파일을 옮기거나 복사하지 않고, 폴더 밖의 파일은 읽지 않습니다. 소재를 찾는 동안에는 웹을 쓰지 않아 파일 내용이 밖으로 나가지 않습니다.'),
    state.settings.llm.backend !== 'claude-cli' ? h('div', { class: 'notice' }, '지금 AI 연결 방식에서는 PDF 를 읽지 못합니다 (md, txt 만). PDF 까지 읽으려면 AI 연결을 Claude Code 로 두세요.') : null,
    list,
    h('div', { class: 'row', style: 'margin-top:8px' },
      isMac ? h('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
        e.target.disabled = true;
        try {
          const r = await api('POST', '/api/fs/pick-folder');
          if (r.path) await add(r.path);
        } catch (err) {
          toast(err.message, true);
        } finally {
          e.target.disabled = false;
        }
      } }, '폴더 고르기…') : null,
      input,
      h('button', { class: 'btn', type: 'button', onclick: () => add(input.value) }, '추가')),
  );
}

function renderFields(fields, base) {
  return Object.entries(fields).map(([key, f]) => {
    const path = [...base, key];
    if (f.type === 'group') return h('fieldset', { class: 'group' }, h('legend', null, f.label), renderFields(f.fields, path));
    if (f.type === 'list') return renderList(f, path);
    return renderScalar(f, path);
  });
}

function itemTitle(item, f) {
  const parts = Object.entries(f.item)
    .filter(([k, sub]) => !['group', 'list', 'longtext'].includes(sub.type) && !isEmpty(item?.[k]))
    .slice(0, 3)
    .map(([k]) => (Array.isArray(item[k]) ? item[k].join(', ') : item[k]));
  return parts.join(' / ') || '(비어 있음)';
}

function renderList(f, path) {
  const items = getIn(state.profile, path) || [];
  const wrap = h('div', { class: 'list' },
    h('h2', { style: 'font-size:15px;margin:18px 0 4px' }, f.label, ' ', h('span', { class: 'muted small' }, `${items.length}개`)),
    f.hint ? h('p', { class: 'muted small', style: 'margin:0 0 10px' }, f.hint) : null,
  );
  items.forEach((item, i) => {
    const p = [...path, i];
    wrap.append(
      h('details', { class: 'item', open: item && Object.values(item).every(isEmpty) ? true : null },
        h('summary', null,
          h('span', { class: 'title' }, `#${i + 1} ${itemTitle(item, f)}`),
          h('button', {
            class: 'btn danger', type: 'button',
            onclick: async (e) => {
              e.preventDefault();
              if (!confirm(`${f.label} #${i + 1}을(를) 삭제할까요?`)) return;
              await run(() => api('POST', '/api/profile/remove', { path: p.join('.') }), '삭제했습니다');
              render();
            },
          }, '삭제'),
        ),
        h('div', { class: 'body' }, renderFields(f.item, p)),
      ),
    );
  });
  wrap.append(h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      await run(() => api('POST', '/api/profile/add', { path: path.join('.') }));
      render();
    },
  }, `+ ${f.label} 추가`));
  return wrap;
}

function renderScalar(f, path) {
  const value = getIn(state.profile, path);
  const id = `f-${path.join('-')}`;
  const err = h('div', { class: 'err' });
  const box = h('div', { class: 'field' });
  const hintParts = [FMT[f.type], f.hint, f.example && `예: ${f.example}`].filter(Boolean);

  async function save(v) {
    try {
      state = await api('POST', '/api/profile/set', { path: path.join('.'), value: v });
      box.classList.remove('invalid');
      box.classList.add('saved');
      err.textContent = '';
      setTimeout(() => box.classList.remove('saved'), 1200);
      renderChrome();
      refreshIssues();
    } catch (e) {
      box.classList.add('invalid');
      err.textContent = e.message;
    }
  }

  let control;
  if (f.type === 'longtext') {
    control = h('textarea', { id, value: value || '', onchange: (e) => save(e.target.value) });
  } else if (f.type === 'select') {
    if (f.allow_other) {
      const listId = `${id}-opts`;
      control = h('span', null,
        h('input', { id, list: listId, value: value || '', placeholder: '고르거나 직접 입력', onchange: (e) => save(e.target.value) }),
        h('datalist', { id: listId }, (f.options || []).map((o) => h('option', { value: o }))),
      );
    } else {
      control = h('select', { id, onchange: (e) => save(e.target.value) },
        h('option', { value: '' }, '— 선택 안 함 —'),
        (f.options || []).map((o) => h('option', { value: o, selected: o === value ? true : null }, o)),
      );
    }
  } else if (f.type === 'tags') {
    control = h('input', { id, value: (value || []).join(', '), placeholder: '쉼표로 구분', onchange: (e) => save(e.target.value.split(',').map((s) => s.trim()).filter(Boolean)) });
  } else if (f.type === 'file') {
    const upload = h('input', { type: 'file', accept: 'image/*,.pdf' });
    const preview = h('img', { alt: '', style: 'display:none;max-width:120px;max-height:160px;border-radius:6px;border:1px solid var(--line);object-fit:cover' });
    if (value) api('POST', '/api/profile/file', { name: value }).then((r) => { if (r.base64) { preview.src = `data:${r.mime};base64,${r.base64}`; preview.style.display = 'block'; } }).catch(() => {});
    const sendFile = async (file) => {
      const base64 = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1]);
        r.readAsDataURL(file);
      });
      await run(() => api('POST', '/api/profile/upload', { name: file.name, base64, path: path.join('.') }), '파일을 올렸습니다');
      render();
    };
    upload.onchange = (e) => e.target.files[0] && sendFile(e.target.files[0]);
    control = h('div', {
      class: 'drop', style: 'display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;padding:10px;border:1px dashed var(--line);border-radius:8px',
      ondragover: (e) => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--accent)'; },
      ondragleave: (e) => { e.currentTarget.style.borderColor = ''; },
      ondrop: (e) => { e.preventDefault(); e.currentTarget.style.borderColor = ''; const file = e.dataTransfer.files[0]; if (file) sendFile(file); },
    },
      preview,
      h('div', { style: 'display:flex;flex-direction:column;gap:6px;min-width:0;flex:1' },
        h('select', { id, onchange: (e) => save(e.target.value).then(render) },
          h('option', { value: '' }, '— 선택 안 함 —'),
          state.files.map((n) => h('option', { value: n, selected: n === value ? true : null }, n)),
        ),
        upload,
        h('span', { class: 'muted small' }, '파일을 여기로 끌어다 놓아도 됩니다')),
    );
  } else {
    control = h('input', { id, value: value || '', placeholder: FMT[f.type] || f.example || '', onchange: (e) => save(e.target.value.trim()) });
  }

  box.append(
    ...[
      h('label', { for: id }, f.label, f.required ? h('span', { class: 'req', title: '필수' }, '*') : null),
      control,
      hintParts.length ? h('div', { class: 'hint' }, hintParts.join(' · ')) : null,
      err,
    ].filter(Boolean),
  );
  return box;
}

function refreshIssues() {
  if (view.type !== 'profile') return;
  const old = document.getElementById('issues');
  const fresh = profilePage(view.id)[2];
  if (old && fresh) old.replaceWith(fresh);
}

// ─── 붙여넣어 채우기 ─────────────────────────────────────
let importDraft = '';
let importPreview = null;

function importPage() {
  const text = h('textarea', { rows: '16', placeholder: '이력서, 지원서에 쓰던 메모, 노션 정리 등을 그대로 붙여넣으세요.\n예)\n* 이름: 홍길동\n* 생년월일: 2000.01.01\n* 자격증명: 정보처리기사 / 취득일: 2024.09.10 …', style: 'width:100%;font:inherit;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text)', oninput: (e) => (importDraft = e.target.value) });
  text.value = importDraft;
  const out = h('div');
  if (importPreview) drawImport(out, importPreview);
  const analyze = async (e) => {
    if (!text.value.trim()) return toast('붙여넣은 글이 없습니다', true);
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'AI 가 정리하는 중… (1~2분)';
    try {
      importPreview = await run(() => api('POST', '/api/profile/import/preview', { text: text.value }));
      drawImport(out, importPreview);
    } finally {
      btn.disabled = false;
      btn.textContent = 'AI 로 정리하기';
    }
  };
  return [
    h('h1', null, '붙여넣어 채우기'),
    h('p', { class: 'lead' }, '가지고 있는 글을 통째로 붙여넣으면 AI 가 항목별로 나눕니다. 바로 저장하지 않고, 미리보기에서 확인한 뒤 적용합니다. 글에 없는 내용은 만들지 않습니다.'),
    card(null, text, h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn primary', type: 'button', onclick: analyze }, 'AI 로 정리하기'))),
    state.schema.sections.basic?.fields.photo ? card('증명사진', h('p', { class: 'muted small', style: 'margin-top:0' }, '사진은 글로 붙여넣을 수 없어서 여기서 올립니다. 지원서에 사진 칸이 있으면 AI 가 이 파일을 올립니다.'), renderScalar(state.schema.sections.basic.fields.photo, ['basic', 'photo'])) : null,
    out,
  ];
}

function drawImport(box, pv) {
  const KIND = { new: ['ok', '새로'], changed: ['warn', '바뀜'], same: ['', '같음'] };
  const sections = [...new Set(pv.changes.map((c) => c.section))];
  const picks = new Map(sections.map((s) => [s, h('input', { type: 'checkbox', checked: true, 'aria-label': `${state.schema.sections[s]?.label} 적용` })]));
  const rulePicks = pv.rules.map((r) => [r, h('input', { type: 'checkbox', checked: true })]);
  const counts = { new: pv.changes.filter((c) => c.kind === 'new').length, changed: pv.changes.filter((c) => c.kind === 'changed').length, bad: pv.changes.filter((c) => c.error).length };
  const apply = async (e) => {
    const chosen = sections.filter((s) => picks.get(s).checked);
    const rules = rulePicks.filter(([, cb]) => cb.checked).map(([r]) => r);
    if (!chosen.length && !rules.length) return toast('적용할 것을 골라 주세요', true);
    if (counts.changed && !confirm(`이미 있는 값 ${counts.changed}개가 바뀝니다. 적용할까요?`)) return;
    e.target.disabled = true;
    let r;
    try {
      r = await run(() => api('POST', '/api/profile/import/apply', { data: pv.data, sections: chosen, rules }), (x) => `${x.result.written}개 칸을 채웠습니다${x.result.rules ? `, 규칙 ${x.result.rules}개 추가` : ''}`);
    } finally {
      e.target.disabled = false;
    }
    if (r?.result?.skipped?.length) alert(`형식이 맞지 않아 넣지 않은 값:\n${r.result.skipped.join('\n')}`);
    importPreview = null;
    importDraft = '';
    go('profile', chosen[0] || 'basic');
  };
  box.replaceChildren(...[
    h('div', { class: 'notice ok' }, `새로 채울 칸 ${counts.new}개 · 바뀌는 칸 ${counts.changed}개${counts.bad ? ` · 형식 문제 ${counts.bad}개 (넣지 않음)` : ''}. 적용할 섹션을 고르세요.`),
    ...sections.map((s) => card(null,
      h('label', { style: 'display:flex;gap:8px;align-items:center;font-weight:600;margin-bottom:8px' }, picks.get(s), state.schema.sections[s]?.label || s),
      h('div', { style: 'overflow-x:auto' }, h('table', { class: 'grid' },
        h('thead', null, h('tr', null, ...['항목', '지금', '넣을 값', ''].map((t) => h('th', { style: 'white-space:nowrap' }, t)))),
        h('tbody', null, pv.changes.filter((c) => c.section === s).map((c) => h('tr', null,
          h('td', { class: 'small' }, c.where.split(' > ').slice(1).join(' > ') || c.where),
          h('td', { class: 'small muted' }, c.before || '—'),
          h('td', { class: 'small' }, c.after, c.error ? h('div', { style: 'color:var(--danger)' }, c.error) : null),
          h('td', null, h('span', { class: `badge ${KIND[c.kind][0]}` }, KIND[c.kind][1])),
        ))))),
    )),
    rulePicks.length ? card('지원서 입력 규칙에 추가',
      h('p', { class: 'muted small', style: 'margin-top:0' }, '글에서 찾은 입력 지시 중 기본 규칙에 없는 것입니다. 작성 → 지원서 입력 규칙에 들어갑니다.'),
      ...rulePicks.map(([r, cb]) => h('label', { style: 'display:flex;gap:8px;margin:4px 0' }, cb, r))) : null,
    pv.unknown.length ? h('div', { class: 'notice' }, `항목에 없어 뺀 것: ${pv.unknown.join(', ')}`) : null,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: apply }, '적용하기'), h('button', { class: 'btn', type: 'button', onclick: () => { importPreview = null; box.replaceChildren(); } }, '취소')),
  ].filter(Boolean));
}

// ─── 설정 공용 컴포넌트 ─────────────────────────────────
const setSetting = (path, value, msg = '저장했습니다') => run(() => api('POST', '/api/settings/set', { path, value }), msg);
const sget = (path) => getIn(state.settings, path.split('.'));

function chipEditor(path, { placeholder = '추가할 값 (쉼표로 여러 개)', emptyText = '(없음)' } = {}) {
  const box = h('div');
  const draw = () => {
    const values = sget(path) || [];
    // 한글 조합 중(isComposing)의 Enter 는 글자 확정용이므로 무시하고, 확정 후 Enter 에서 추가한다
    const input = h('input', {
      placeholder,
      onkeydown: (e) => {
        if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        add();
      },
    });
    const add = async () => {
      const vals = input.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (!vals.length) return;
      await run(() => api('POST', '/api/settings/list', { path, add: vals }), '추가했습니다');
      draw();
      box.querySelector('input').focus();
    };
    box.replaceChildren(
      h('div', { class: 'chips' },
        values.length
          ? values.map((v) => h('span', { class: 'chip' }, v, h('button', {
            type: 'button', title: '삭제', 'aria-label': `${v} 삭제`,
            onclick: async () => { await run(() => api('POST', '/api/settings/list', { path, remove: [v] })); draw(); },
          }, '×')))
          : h('span', { class: 'muted' }, emptyText),
      ),
      // form 제출을 쓰면 한글 조합 중 Enter 가 두 번 처리되거나 씹히는 문제가 없다
      h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); add(); } }, input, h('button', { class: 'btn', type: 'submit' }, '추가')),
    );
  };
  draw();
  return box;
}

function toggle(label, path) {
  return h('label', { class: 'row', style: 'cursor:pointer;padding:4px 0' },
    h('input', { type: 'checkbox', checked: sget(path), onchange: (e) => setSetting(path, e.target.checked) }),
    label,
  );
}

function textSetting(label, path, { type = 'text', hint } = {}) {
  const id = `s-${path.replace(/\./g, '-')}`;
  return h('div', { class: 'field' },
    h('label', { for: id }, label),
    h('input', { id, type, value: sget(path) ?? '', onchange: (e) => setSetting(path, type === 'number' ? Number(e.target.value) : e.target.value) }),
    hint ? h('div', { class: 'hint' }, hint) : null,
  );
}

function radios(name, path, options) {
  return h('div', { class: 'checks' }, options.map(([value, label]) =>
    h('label', null, h('input', { type: 'radio', name, value, checked: sget(path) === value, onchange: () => setSetting(path, value).then(render) }), label)));
}

// 모델 이름 추천 (직접 적어도 됨)
const MODEL_SUGGEST = [['claude-opus-5', 'Opus 5 — 똑똑함, 보통 속도'], ['claude-sonnet-5', 'Sonnet 5 — 빠르고 저렴'], ['claude-haiku-4-5', 'Haiku 4.5 — 가장 빠름 (추론 성능 설정 없음)'], ['claude-fable-5-1', 'Fable 5.1 — 가장 똑똑함, 비쌈'], ['gpt-5', 'GPT-5 (Codex, OpenAI)'], ['gpt-5-mini', 'GPT-5 mini (Codex, OpenAI)']];
const EFFORT_OPTS = [['', '기본'], ['low', '낮음 — 빠르고 적게 씀'], ['medium', '중간'], ['high', '높음'], ['xhigh', '매우 높음'], ['max', '최대 — 느리고 많이 씀']];

/** 모델(추천 목록 + 직접 입력)과 추론 성능 한 줄. modelPath/effortPath 는 설정 경로 */
function modelEffortRow(label, modelPath, effortPath, hint) {
  const listId = `dl-${modelPath.replace(/\./g, '-')}`;
  return h('div', { class: 'field' },
    h('label', null, label),
    h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
      h('input', { list: listId, value: sget(modelPath) || '', placeholder: '모델 (비우면 기본)', style: 'flex:1;min-width:150px', onchange: (e) => setSetting(modelPath, e.target.value.trim()) }),
      h('datalist', { id: listId }, MODEL_SUGGEST.map(([v, t]) => h('option', { value: v }, t))),
      h('select', { title: '추론 성능', onchange: (e) => setSetting(effortPath, e.target.value) }, EFFORT_OPTS.map(([v, t]) => h('option', { value: v, selected: (sget(effortPath) || '') === v ? true : null }, `추론 ${t}`)))),
    hint ? h('div', { class: 'hint' }, hint) : null);
}

const page = (title, lead, ...cards) => [h('h1', null, title), lead ? h('p', { class: 'lead' }, lead) : null, ...cards];
const card = (title, ...children) => h('div', { class: 'card' }, title ? h('h2', null, title) : null, ...children);

// ─── 설정 화면들 ────────────────────────────────────────
function settingsPage(id) {
  const s = state.settings;
  switch (id) {
    case 'keywords':
      return page('검색 키워드', '채용 사이트에서 이 키워드로 공고를 검색합니다.', card(null, chipEditor('collect.keywords', { emptyText: '아직 키워드가 없습니다' })));

    case 'sources':
      return sourcesPage();

    case 'roles':
      return rolesPage();

    case 'ai':
      return aiPage();

    case 'collect':
      return collectPage();

    case 'start':
      return startPage();

    case 'applies':
      return appliesPage();

    case 'employment': {
      const cur = s.collect.employment_types;
      const all = [...new Set([...state.meta.employment, ...cur])];
      return page('고용형태', '모을 공고의 고용형태를 고릅니다.',
        card(null,
          h('div', { class: 'checks' }, all.map((v) => h('label', null,
            h('input', { type: 'checkbox', checked: cur.includes(v), onchange: (e) => {
              const now = state.settings.collect.employment_types;
              setSetting('collect.employment_types', e.target.checked ? [...now, v] : now.filter((x) => x !== v));
            } }), v))),
          h('div', { style: 'margin-top:12px' }, h('p', { class: 'muted small', style: 'margin:0 0 6px' }, '목록에 없는 고용형태 추가'), chipEditor('collect.employment_types', { placeholder: '예: 전환형 인턴' })),
        ),
        card(null, toggle('경력직 공고 제외 ([신입 및 경력]은 포함)', 'collect.exclude_experienced')),
      );
    }

    case 'companies': {
      const types = s.company_types;
      const setType = (name, key, val) => setSetting(`company_types.${name}.${key}`, val);
      return page('기업 구분', `자소설닷컴 달력 필터처럼 켜고 끕니다. "작성중 표시"를 켠 구분은 Notion에 "${s.notion.status_options.priority}" 상태로 등록됩니다.`,
        card(null, h('table', { class: 'grid' },
          h('thead', null, h('tr', null, h('th', null, '구분'), h('th', { class: 'center' }, '공고 모으기'), h('th', { class: 'center' }, '작성중 표시'), h('th', null, '판정 기준'))),
          h('tbody', null, Object.entries(types).map(([name, t]) => h('tr', null,
            h('td', null, name),
            h('td', { class: 'center' }, h('input', { type: 'checkbox', 'aria-label': `${name} 모으기`, checked: t.include, onchange: (e) => setType(name, 'include', e.target.checked) })),
            h('td', { class: 'center' }, h('input', { type: 'checkbox', 'aria-label': `${name} 작성중`, checked: t.priority, onchange: (e) => setType(name, 'priority', e.target.checked) })),
            h('td', { class: 'muted small' }, `회사 ${t.companies.length}개 · 단어 ${t.name_keywords.length}개`),
          ))),
        )),
        h('div', { class: 'notice' }, '어떤 구분인지는 ① 회사 직접 지정 ② 아래 구분별 회사 목록 ③ 회사명에 들어간 단어 ④ 사이트가 알려준 기업 규모(자소설 기업분류, 사람인 기업형태) 순서로 봅니다. 여러 구분에 걸리면 하나라도 "모으기"면 모으고, 하나라도 "작성중"이면 작성중으로 둡니다. 어느 구분인지 알 수 없는 회사는 모읍니다.'),
        ...Object.keys(types).map((name) => card(name,
          h('p', { class: 'muted small', style: 'margin-top:0' }, '이 구분으로 볼 회사'),
          chipEditor(`company_types.${name}.companies`, { placeholder: '회사명', emptyText: '(없음)' }),
          h('p', { class: 'muted small' }, '회사명에 이 단어가 들어가면 이 구분 (영문 약어는 단어 단위로 찾습니다)'),
          chipEditor(`company_types.${name}.name_keywords`, { placeholder: '예: 은행, 증권', emptyText: '(없음)' }),
        )),
      );
    }

    case 'overrides':
      return page('회사 직접 지정', '기업 구분보다 우선합니다.',
        card('항상 포함할 회사', chipEditor('overrides.always_include', { placeholder: '회사명' })),
        card('항상 제외할 회사', chipEditor('overrides.always_exclude', { placeholder: '회사명' })),
        card(`"${s.notion.status_options.priority}"으로 등록할 회사`, chipEditor('overrides.priority', { placeholder: '회사명' })),
      );

    case 'essay':
      return page('자기소개서 문체', 'AI가 자기소개서를 쓸 때 지킬 규칙입니다.',
        card(null,
          textSetting('문장 끝맺음', 'essay.tone', { hint: '예: 습니다' }),
          toggle('문단마다 내용이 드러나는 [소제목] 달기', 'essay.subtitle'),
          toggle('단어 나열에 가운뎃점(·) 쓰지 않기', 'essay.forbid_middle_dot'),
          toggle('블라인드 규정 지키기 (실명, 학교명, 특정 단체명 쓰지 않기)', 'essay.blind'),
        ),
        card('쓰지 않을 표현',
          h('p', { class: 'muted small', style: 'margin-top:0' }, '~ 자리는 아무 말이나 들어가는 자리입니다. 띄어쓰기는 무시하고, ~ 바로 뒤의 조사는 짝(을/를, 이/가 …)도 같이 찾습니다.'),
          chipEditor('essay.banned_phrases', { placeholder: '예: 단순한 ~가 아닌' })),
        card('작성 방식',
          modelEffortRow('AI 모델 · 추론 성능', 'essay.model', 'essay.effort', '비우면 AI 연결의 기본. 자기소개서는 추론 성능을 높게 두면 더 꼼꼼하게 씁니다.'),
          textSetting('검토 후 고쳐 쓰기 횟수', 'essay.max_revisions', { type: 'number', hint: '0~3. 검토 AI 가 지적한 내용(지어낸 내용, 질문 의도 등)을 반영해 고쳐 쓰는 횟수' }),
          h('p', { class: 'muted small' }, '순서: 회사·직무 조사 → 문항 전체 전략 → 작성 → 기계 검사(글자수, 금지 표현, 블라인드 등) → 검토 → 고쳐 쓰기. 사실은 내 정보와 자소서 소재에 있는 것만 씁니다.'),
          h('pre', { style: 'margin:8px 0 0;white-space:pre-wrap' }, 'autojob essay --company 회사명 --role 직무 --questions 문항.txt   (브라우저 없이 자소서만)\nautojob apply <공고>                                         (지원서에 바로 입력)')),
      );

    case 'apply':
      return page('지원서 입력 규칙', '"autojob apply" 로 지원서의 인적사항(자기소개서 전까지)을 채울 때 AI 가 따르는 규칙입니다.',
        card('기본 규칙 (항상 적용)', h('ul', { style: 'margin:0;padding-left:18px' },
          ['이미 입력된 값은 수정하거나 삭제하지 않는다', '내 정보에 없는 값은 추정하지 않고 빈칸으로 두고, 비운 칸을 기록한다', '자기소개서와 자유 서술형 칸은 채우지 않는다',
            '제출·작성완료 버튼은 누르지 않는다 (코드로도 막음). 임시저장은 괜찮다', '삭제·로그아웃·작성취소는 누르지 않는다 (코드로도 막음)', '날짜는 칸의 형식에 맞추고, 주소는 팝업에서 검색해 고른다',
            '로그인·본인인증·CAPTCHA·약관 동의는 사용자에게 맡긴다'].map((r) => h('li', null, r))),
          h('p', { class: 'muted small' }, '전체 내용: prompts/fill-basic-info.md')),
        card('추가 규칙', chipEditor('apply.extra_rules', { placeholder: '예: 희망 연봉은 "회사 내규에 따름"을 고른다', emptyText: '(없음)' })),
        card('다 쓰고 나서',
          toggle('임시저장 버튼 누르기 (최종 제출은 절대 누르지 않음)', 'apply.save_draft'),
          h('p', { class: 'muted small' }, '임시저장 버튼 문구 (앞에 있는 것부터 찾습니다. 제출 차단 가드도 그대로 적용됩니다)'),
          chipEditor('apply.save_buttons', { placeholder: '예: 중간저장' }),
          toggle('Notion 공고 페이지 본문 채우고 제출 상태 바꾸기', 'apply.update_notion'),
          h('p', { class: 'muted small' }, '본문 제목과 바꿀 상태는 연결 → Notion 에서 정합니다. 이미 내용이 있는 섹션은 건드리지 않습니다.')),
        card('AI 모델 · 동시 진행',
          modelEffortRow('모델 · 추론 성능', 'apply.model', 'apply.effort', '비우면 AI 연결의 기본. 인적사항 입력은 Sonnet 5 · 중간 정도로도 충분한 경우가 많습니다.'),
          textSetting('동시에 진행할 지원서 수', 'apply.max_parallel', { type: 'number', hint: '설정 화면에서 여러 개를 맡길 때 한꺼번에 진행할 개수 (1~8). 나머지는 차례를 기다립니다. 많을수록 AI 사용량이 빨리 닳습니다.' })),
        card('실행 방법', h('pre', { style: 'margin:0;white-space:pre-wrap' }, 'autojob apply <Notion 공고 페이지 주소 또는 지원 페이지 주소>'),
          h('p', { class: 'muted small' }, '브라우저가 열리면 로그인·본인인증을 직접 하고 인적사항 입력 화면까지 간 뒤 터미널에서 Enter 를 누르세요. 끝나면 비워둔 값과 참고사항을 알려줍니다. 제출은 하지 않습니다.')),
      );

    case 'notion':
      return notionPage();

    case 'browser':
      return browserPage();

    case 'llm':
      return llmPage();

    case 'guard':
      return page('제출 차단 문구', '버튼 문구에 이 단어가 들어가면 누르지 않습니다 (공백 무시, 대소문자 무시).',
        card('항상 차단', chipEditor('browser.guard.always_block')),
        card('지원서 입력 단계부터 차단', h('p', { class: 'muted small', style: 'margin-top:0' }, '공고 페이지의 "지원하기"처럼 지원을 시작할 때는 눌러야 하는 버튼'), chipEditor('browser.guard.block_when_armed')),
        card('예외로 허용 (문구가 정확히 일치할 때)', chipEditor('browser.guard.allow_exact')),
      );
  }
  return [h('p', null, '없는 화면입니다.')];
}

function secretInput(key, { onSaved } = {}) {
  const st = state.secrets[key];
  const input = h('input', { type: 'password', autocomplete: 'off', placeholder: st.set ? `저장됨 ${st.masked} — 바꾸려면 새로 붙여넣기` : '붙여넣기' });
  const status = h('div', { class: 'muted small', style: 'margin-top:6px' },
    st.fromEnv ? '환경 변수로 지정되어 있어 그 값이 우선합니다.' : st.set ? `저장됨: ${st.masked}` : '아직 없습니다.');
  const save = async () => {
    if (!input.value.trim()) return;
    const r = await run(() => api('POST', '/api/secrets/set', { key, value: input.value }), (x) => x.info || '저장했습니다');
    input.value = '';
    if (onSaved) onSaved(r);
    render();
  };
  return h('div', null,
    h('div', { class: 'row' }, input, h('button', { class: 'btn primary', type: 'button', onclick: save }, key === 'NOTION_TOKEN' ? '저장하고 연결 확인' : '저장'),
      st.set && !st.fromEnv ? h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (confirm('삭제할까요?')) { await run(() => api('POST', '/api/secrets/set', { key, value: '' }), '삭제했습니다'); render(); } } }, '삭제') : null),
    status,
  );
}

// ─── 수집 사이트 ────────────────────────────────────────
const STATUS_BADGE = { ok: ['ok', '사용 가능'], planned: ['warn', '준비 중'], blocked: ['bad', '수집 안 함'] };

function sourcesPage() {
  const s = state.settings;
  const rows = state.meta.collectors.map((c) => {
    const [cls, label] = STATUS_BADGE[c.status];
    return h('tr', null,
      h('td', { class: 'center' }, h('input', {
        type: 'checkbox', 'aria-label': `${c.label} 사용`, checked: c.status === 'ok' && !!s.collect.sources[c.id], disabled: c.status !== 'ok' ? true : null,
        onchange: (e) => setSetting(`collect.sources.${c.id}`, e.target.checked),
      })),
      h('td', null, c.label, c.method === 'browser' ? h('span', { class: 'muted small' }, ' · 자동화 브라우저') : null),
      h('td', null, h('span', { class: `badge ${cls}` }, label)),
      h('td', { class: 'muted small' }, c.note),
    );
  });

  const dutyBox = h('div');
  const drawDuty = () => dutyBox.replaceChildren(
    chipEditor('collect.jasoseol.duty_groups', { placeholder: '직무 분류 이름', emptyText: '(비어 있음 — 검색 키워드로 직무명을 거릅니다)' }),
    h('button', { class: 'btn', type: 'button', style: 'margin-top:8px', onclick: async (e) => {
      e.target.disabled = true;
      e.target.textContent = '자동화 브라우저로 불러오는 중…';
      try {
        const { groups } = await run(() => api('GET', '/api/collect/jasoseol-duty-groups'));
        const cur = new Set(state.settings.collect.jasoseol.duty_groups);
        const byParent = (pid) => groups.filter((g) => g.parent === pid);
        const tree = (g, depth) => [
          h('label', { style: `display:flex;gap:6px;padding:2px 0 2px ${depth * 18}px;cursor:pointer` }, h('input', { type: 'checkbox', value: g.name, checked: cur.has(g.name) }), g.name),
          ...byParent(g.id).flatMap((c) => tree(c, depth + 1)),
        ];
        const list = h('div', { style: 'max-height:360px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-top:8px' }, byParent(null).flatMap((g) => tree(g, 0)));
        dutyBox.replaceChildren(
          h('p', { class: 'muted small', style: 'margin:0' }, '상위 분류를 고르면 하위 분류도 포함됩니다.'),
          list,
          h('div', { class: 'row', style: 'margin-top:8px' },
            h('button', { class: 'btn primary', type: 'button', onclick: async () => {
              const picked = [...list.querySelectorAll('input:checked')].map((i) => i.value);
              await setSetting('collect.jasoseol.duty_groups', picked, `직무 분류 ${picked.length}개 저장`);
              drawDuty();
            } }, '저장'),
            h('button', { class: 'btn', type: 'button', onclick: drawDuty }, '취소')),
        );
      } catch {
        drawDuty();
      }
    } }, '자소설닷컴 직무 분류 목록에서 고르기'),
  );
  drawDuty();

  const jobkoreaBox = h('div');
  const drawJobkorea = () => jobkoreaBox.replaceChildren(
    chipEditor('collect.jobkorea.duty_categories', { placeholder: '직무 대분류 이름', emptyText: '(비어 있음 — 전체 직무)' }),
    h('button', { class: 'btn', type: 'button', style: 'margin-top:8px', onclick: async (e) => {
      e.target.disabled = true;
      e.target.textContent = '불러오는 중…';
      try {
        const { categories } = await run(() => api('GET', '/api/collect/jobkorea-duty-categories'));
        const cur = new Set(state.settings.collect.jobkorea.duty_categories);
        const list = h('div', { class: 'checks', style: 'margin-top:8px' }, categories.map((c) => h('label', null, h('input', { type: 'checkbox', value: c.name, checked: cur.has(c.name) }), c.name)));
        jobkoreaBox.replaceChildren(list, h('div', { class: 'row', style: 'margin-top:8px' },
          h('button', { class: 'btn primary', type: 'button', onclick: async () => {
            const picked = [...list.querySelectorAll('input:checked')].map((i) => i.value);
            await setSetting('collect.jobkorea.duty_categories', picked, `직무 분류 ${picked.length}개 저장`);
            drawJobkorea();
          } }, '저장'),
          h('button', { class: 'btn', type: 'button', onclick: drawJobkorea }, '취소')));
      } catch {
        drawJobkorea();
      }
    } }, '잡코리아 직무 분류 목록에서 고르기'),
  );
  drawJobkorea();

  return page('수집 사이트', '공고를 모을 사이트와 수집 방식을 정합니다. 모든 사이트는 robots.txt 가 허용하는 범위에서, 정직한 이름으로, 요청 사이에 간격을 두고 가져옵니다.',
    card(null, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', { class: 'center' }, '사용'), h('th', null, '사이트'), h('th', null, '상태'), h('th', null, '설명'))),
      h('tbody', null, rows))),
    card('수집 범위',
      textSetting('마감 기간 (일)', 'collect.lookahead_days', { type: 'number', hint: '마감이 오늘부터 이 기간 안인 공고만 모읍니다. 상시 채용은 포함' }),
      textSetting('키워드당 최대 공고 수', 'collect.max_per_keyword', { type: 'number', hint: '사이트마다 검색 결과를 키워드당 이만큼까지 봅니다' }),
      textSetting('요청 간격 (ms)', 'collect.request_delay_ms', { type: 'number', hint: '같은 사이트에 보내는 요청 사이 간격. 사이트에 부담을 주지 않도록 1500 이상을 권장합니다' }),
    ),
    card('자소설닷컴 직무 분류', h('p', { class: 'muted small', style: 'margin-top:0' }, '자소설닷컴 채용 달력에서 이 직무 분류의 공고만 가져옵니다.'), dutyBox),
    card('잡코리아 직무 분류', h('p', { class: 'muted small', style: 'margin-top:0' }, '잡코리아 채용정보에서 이 직무 대분류의 공고만 가져옵니다. 비우면 전체 직무에서 검색 키워드로 찾습니다.'), jobkoreaBox),
    card('원티드 직군',
      h('p', { class: 'muted small', style: 'margin-top:0' }, '원티드 채용 목록 주소의 직군 번호입니다 (wanted.co.kr/wdlist/번호). 비우면 전체 직군에서 공고 제목에 검색 키워드가 있는 것만 모읍니다.'),
      chipEditor('collect.wanted.job_group_ids', { placeholder: '직군 번호', emptyText: '(비어 있음)' })),
  );
}

// ─── AI 보강 ────────────────────────────────────────────
function aiPage() {
  return page('AI 보강', '수집한 공고에서 코드로 채우지 못한 부분을 AI(Claude Code)가 웹 검색으로 채웁니다. AI 를 쓰면 시간과 사용량이 듭니다.',
    card('지원 페이지 찾기',
      h('p', { class: 'muted small', style: 'margin-top:0' }, '공고에 지원 링크가 없거나 링크가 열리지 않으면, AI 가 회사 채용 사이트에서 같은 공고를 찾습니다. 찾은 주소는 코드가 다시 열어 확인하고, 그래도 못 찾으면 등록하지 않습니다.'),
      toggle('AI 로 지원 페이지 찾기', 'collect.link_search.enabled'),
      textSetting('한 번에 찾을 최대 공고 수', 'collect.link_search.max_per_run', { type: 'number', hint: '수집 한 번에 AI 로 찾을 공고 수 상한 (사용량 제한)' }),
      textSetting('AI 한 번에 맡길 공고 수', 'collect.link_search.batch_size', { type: 'number', hint: '1~10' }),
      modelEffortRow('AI 모델 · 추론 성능', 'collect.link_search.model', 'collect.link_search.effort', '비우면 AI 연결의 기본'),
      h('p', { class: 'muted small' }, '지원 페이지로 인정하지 않을 사이트'),
      chipEditor('collect.link_search.reject_domains', { placeholder: '예: cafe.naver.com' }),
    ),
    card('직무 태그',
      h('p', { class: 'muted small', style: 'margin-top:0' }, '직무 태그 규칙으로 먼저 달고, 아래 설정에 따라 AI 가 Notion DB에 있는 태그 중에서만 고릅니다.'),
      radios('ai-roles', 'collect.ai_roles.mode', [['off', '규칙만 쓰기'], ['fill_empty', '규칙으로 못 단 공고만 AI'], ['review', '모든 공고를 AI 가 다시 보기']]),
      modelEffortRow('AI 모델 · 추론 성능', 'collect.ai_roles.model', 'collect.ai_roles.effort', '비우면 AI 연결의 기본. 태그 달기는 낮음으로도 충분합니다.'),
      toggle('직무 태그를 하나도 달지 못한 공고는 등록하지 않기', 'collect.require_role'),
    ),
  );
}

// ─── 직무 태그 규칙 ─────────────────────────────────────
function rolesPage() {
  const box = h('div', null, h('p', { class: 'muted' }, 'Notion DB의 직무 태그를 불러오는 중…'));
  const tokens = (tag) => tag.split(/[\s/(),·|]+/).map((t) => t.trim()).filter((t) => t.length >= 2 && !['개발자', '개발', '엔지니어', '담당', '담당자', '직무', '기타', '분야'].includes(t));
  if (state.secrets.NOTION_TOKEN.set && state.settings.notion.data_source_id) {
    api('GET', '/api/notion/options').then((o) => {
      box.replaceChildren(...(o.roles.length ? o.roles.map((tag) => {
        const def = tokens(tag);
        return h('div', { class: 'field' },
          h('label', null, tag),
          chipEditor(`notion.role_rules.${tag}`, { placeholder: '단어 추가', emptyText: def.length ? `(기본: ${def.join(', ')})` : '(기본 단어 없음 — 자동으로 달리지 않습니다)' }),
        );
      }) : [h('p', { class: 'muted' }, 'DB에 직무 태그가 없습니다.')]));
    }).catch((e) => box.replaceChildren(h('div', { class: 'notice bad' }, e.message)));
  } else {
    box.replaceChildren(h('div', { class: 'notice' }, '먼저 Notion 을 연결하고 DB를 골라 주세요 (연결 → Notion).'));
  }
  return page('직무 태그 규칙', '공고 제목과 사이트의 직무명에 이 단어가 있으면 Notion 직무 태그를 답니다. 단어를 적지 않은 태그는 태그 이름의 단어로 판단합니다. 새 태그는 만들지 않습니다.',
    card(null, box));
}

// ─── AI 연결 (여러 개, 돌려쓰기) ────────────────────────
const LLM_TYPES = [['claude-cli', 'Claude Code', 'Claude 구독 (Pro/Max). 계정마다 따로 로그인'], ['codex-cli', 'Codex CLI', 'ChatGPT 구독 (실험적). 계정마다 따로 로그인'], ['anthropic-api', 'Anthropic API', 'API 키, 쓴 만큼 요금'], ['openai-api', 'OpenAI API', 'API 키, 쓴 만큼 요금']];

function llmPage() {
  const box = h('div', null, h('p', { class: 'muted' }, '불러오는 중…'));
  const draw = (conns) => {
    box.replaceChildren(...conns.map((c, i) => {
      const result = h('div', { class: 'small', style: 'margin-top:6px' });
      const upd = (patch, msg) => run(() => api('POST', '/api/llm/connections/update', { id: c.id, patch }), msg).then((r) => draw(r.connections));
      const status = !c.enabled ? h('span', { class: 'badge' }, '꺼짐')
        : !c.installed ? h('span', { class: 'badge bad' }, c.type === 'codex-cli' ? '설치 필요 (npm i -g @openai/codex)' : '설치 필요 (Claude Code)')
        : c.resting ? h('span', { class: 'badge warn' }, `${{ limit: '한도', auth: '로그인 필요', unavailable: '쓸 수 없음' }[c.resting.kind]} — ${new Date(c.resting.until).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}까지 쉼`)
        : c.key && !c.key.set ? h('span', { class: 'badge warn' }, 'API 키 없음')
        : h('span', { class: 'badge ok' }, i === 0 ? '먼저 씀' : '대기');
      return card(null,
        h('div', { class: 'row', style: 'justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap' },
          h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, h('strong', null, `${i + 1}. ${c.display}`), h('span', { class: 'muted small' }, c.typeLabel), status),
          h('div', { class: 'row', style: 'gap:4px' },
            h('button', { class: 'btn', type: 'button', disabled: i === 0 ? true : null, title: '위로', onclick: () => run(() => api('POST', '/api/llm/connections/move', { id: c.id, dir: -1 })).then((r) => draw(r.connections)) }, '↑'),
            h('button', { class: 'btn', type: 'button', disabled: i === conns.length - 1 ? true : null, title: '아래로', onclick: () => run(() => api('POST', '/api/llm/connections/move', { id: c.id, dir: 1 })).then((r) => draw(r.connections)) }, '↓'),
            conns.length > 1 ? h('button', { class: 'btn danger', type: 'button', onclick: () => confirm(`${c.display} 연결을 지울까요?`) && run(() => api('POST', '/api/llm/connections/remove', { id: c.id }), '지웠습니다').then((r) => draw(r.connections)) }, '삭제') : null)),
        h('div', { class: 'row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap' },
          h('label', { class: 'small', style: 'display:flex;gap:6px;align-items:center' }, h('input', { type: 'checkbox', checked: c.enabled, onchange: (e) => upd({ enabled: e.target.checked }) }), '사용'),
          h('input', { value: c.label, placeholder: '이름 (예: 내 Claude, 친구 계정)', style: 'flex:1;min-width:140px', onchange: (e) => upd({ label: e.target.value.trim() }, '저장했습니다') }),
          h('input', { value: c.model, list: 'dl-conn-models', placeholder: c.type === 'anthropic-api' ? '모델 (비우면 claude-opus-5)' : c.type === 'openai-api' ? '모델 (비우면 gpt-5)' : '모델 (비우면 기본)', style: 'flex:1;min-width:140px', onchange: (e) => upd({ model: e.target.value.trim() }, '저장했습니다') }),
          h('select', { title: '추론 성능', onchange: (e) => upd({ effort: e.target.value }, '저장했습니다') }, EFFORT_OPTS.map(([v, t]) => h('option', { value: v, selected: (c.effort || '') === v ? true : null }, `추론 ${t}`)))),
        c.login ? h('div', { style: 'margin-top:8px' },
          h('div', { class: 'small muted' }, c.account_dir ? `계정 폴더: ${c.account_dir} (이 연결만의 로그인)` : '이 컴퓨터의 기본 로그인'),
          h('div', { class: 'row', style: 'gap:6px;margin-top:4px' },
            h('button', { class: 'btn', type: 'button', onclick: async () => {
              const r = await run(() => api('POST', '/api/llm/connections/login', { id: c.id }));
              result.textContent = r.opened ? `터미널 창을 열었습니다. ${c.type === 'claude-cli' ? '/login 을 입력해 로그인하고' : '안내대로 로그인하고'} 창을 닫은 뒤 "연결 확인"을 누르세요.` : `터미널에서 실행하세요: ${r.command}`;
            } }, '로그인하기'),
            h('code', { class: 'small', style: 'word-break:break-all' }, c.login))) : null,
        c.key ? h('div', { class: 'row', style: 'gap:6px;margin-top:8px' },
          (() => {
            const inp = h('input', { type: 'password', autocomplete: 'off', placeholder: c.key.set ? `저장됨 ${c.key.masked}${c.key.own ? '' : ' (공용 키)'} — 바꾸려면 붙여넣기` : 'API 키 붙여넣기', style: 'flex:1' });
            return [inp, h('button', { class: 'btn', type: 'button', onclick: () => inp.value.trim() && run(() => api('POST', '/api/llm/connections/key', { id: c.id, value: inp.value.trim() }), '키를 저장했습니다').then((r) => draw(r.connections)) }, '저장')];
          })()) : null,
        h('div', { class: 'row', style: 'gap:6px;margin-top:8px' },
          h('button', { class: 'btn', type: 'button', onclick: async (e) => {
            e.target.disabled = true;
            result.textContent = '확인 중… (길면 30초)';
            try {
              const r = await api('POST', '/api/llm/connections/test', { id: c.id });
              result.textContent = `${r.ok ? '✅' : '❌'} ${r.message} (${(r.ms / 1000).toFixed(1)}초)`;
              if (r.ok) draw(r.connections);
            } catch (err) {
              result.textContent = `❌ ${err.message}`;
            } finally {
              e.target.disabled = false;
            }
          } }, '연결 확인'),
          c.resting ? h('button', { class: 'btn', type: 'button', onclick: () => run(() => api('POST', '/api/llm/connections/reset', { id: c.id }), '다시 쓰도록 했습니다').then((r) => draw(r.connections)) }, '쉬는 중 해제') : null),
        result,
      );
    }));
  };
  api('GET', '/api/llm/connections').then((r) => draw(r.connections)).catch((e) => box.replaceChildren(h('div', { class: 'notice bad' }, e.message)));
  const typeSel = h('select', null, LLM_TYPES.map(([v, label, note]) => h('option', { value: v }, `${label} — ${note}`)));
  return page('AI 연결', '공고 판단, 지원서 입력, 자기소개서 작성에 쓸 AI 입니다. 여러 개를 연결해 두면 위에서부터 쓰고, 사용량 한도나 로그인 문제가 생기면 다음 연결로 넘어가 이어서 합니다. 한도에 걸린 연결은 풀리는 시각까지 쉬었다가 다시 씁니다. 어느 AI 를 써도 브라우저 도구와 제출 차단은 똑같이 코드로 적용됩니다.',
    box,
    card('연결 추가',
      h('div', { class: 'row', style: 'gap:6px' }, typeSel, h('button', { class: 'btn primary', type: 'button', onclick: () => run(() => api('POST', '/api/llm/connections/add', { type: typeSel.value }), '추가했습니다 — 로그인하거나 API 키를 넣으세요').then((r) => draw(r.connections)) }, '추가')),
      h('p', { class: 'muted small' }, '같은 Claude Code 를 한 번 더 추가하면 따로 로그인할 계정 폴더가 생깁니다 (다른 계정 돌려쓰기).')),
    h('datalist', { id: 'dl-conn-models' }, MODEL_SUGGEST.map(([v, t]) => h('option', { value: v }, t))),
    card('작업별 AI',
      h('p', { class: 'muted small', style: 'margin-top:0' }, '작업마다 모델과 추론 성능을 따로 정합니다. 비우면 위 연결의 설정 → 아래 기본값 순서로 씁니다. 다른 회사 모델 이름(예: Codex 연결에 claude-…)은 알아서 건너뜁니다. 추론 성능이 높을수록 꼼꼼하지만 느리고 사용량이 많이 듭니다.'),
      modelEffortRow('지원서 입력 (인적사항)', 'apply.model', 'apply.effort'),
      modelEffortRow('자기소개서', 'essay.model', 'essay.effort'),
      modelEffortRow('지원 페이지 찾기 (수집)', 'collect.link_search.model', 'collect.link_search.effort'),
      modelEffortRow('직무 태그 (수집)', 'collect.ai_roles.model', 'collect.ai_roles.effort')),
    card('기본 설정',
      modelEffortRow('기본 모델 · 추론 성능', 'llm.model', 'llm.effort', '연결과 작업에 아무것도 적지 않았을 때 씁니다.'),
      textSetting('한도에 걸리면 쉬는 시간 (분)', 'llm.cooldown_minutes', { type: 'number', hint: '한도가 풀리는 시각을 AI 가 알려 주지 않을 때만 씁니다' })),
  );
}

// ─── 지원서 작성: 여러 개를 함께, 지원서마다 대화방 ─────────
const applyState = { seq: 0, jobs: [], msgs: {}, active: null, prevStatus: {} };
const STATUS_TEXT = { queued: ['', '대기'], running: ['ok', '진행 중'], waiting: ['bad', '확인 필요'], done: ['ok', '완료'], error: ['bad', '오류'], stopped: ['', '중지'] };
let applyTimer = null;

let applyPolling = false;
async function pollApplies() {
  if (applyPolling) return; // 동시에 두 번 불러 말풍선이 겹치지 않게
  applyPolling = true;
  try {
    const r = await api('POST', '/api/apply/jobs', { since: applyState.seq });
    for (const m of r.messages) {
      const list = (applyState.msgs[m.job] ||= []);
      if (!list.length || list[list.length - 1].seq < m.seq) list.push(m);
    }
    applyState.seq = Math.max(applyState.seq, r.seq);
    for (const j of r.jobs) {
      if (j.status === 'waiting' && applyState.prevStatus[j.id] !== 'waiting') {
        toast(`${j.title}: 확인이 필요합니다`, true);
        try { if (window.Notification && Notification.permission === 'granted') new Notification(`Auto-Job — ${j.title}`, { body: j.waiting || '확인이 필요합니다' }); } catch {}
      }
      applyState.prevStatus[j.id] = j.status;
    }
    const changed = r.messages.length || JSON.stringify(r.jobs.map((j) => [j.id, j.status, j.activity])) !== JSON.stringify(applyState.jobs.map((j) => [j.id, j.status, j.activity]));
    applyState.jobs = r.jobs;
    if (changed) {
      renderChrome();
      if (view.type === 'settings' && view.id === 'applies') drawApplies?.();
    }
  } catch {}
  applyPolling = false;
  const busy = applyState.jobs.some((j) => ['queued', 'running', 'waiting'].includes(j.status));
  clearTimeout(applyTimer);
  applyTimer = setTimeout(pollApplies, view.id === 'applies' || busy ? 1000 : 5000);
}

let drawApplies = null;
function appliesPage() {
  const list = h('div', { class: 'room-list' });
  const head = h('div', { class: 'chat-head' });
  const body = h('div', { class: 'chat-body' });
  const input = h('textarea', { placeholder: '여기에 답을 적으세요 (Enter 보내기, Shift+Enter 줄바꿈). 비밀번호는 적지 말고 브라우저 창에 직접 입력하세요.' });
  const sendBtn = h('button', { class: 'btn primary', type: 'button' }, '보내기');
  const send = async () => {
    const id = applyState.active;
    if (!id || !input.value.trim()) return;
    const text = input.value;
    input.value = '';
    try {
      await api('POST', '/api/apply/answer', { id, text });
    } catch (e) {
      toast(e.message, true);
      input.value = text;
    }
    pollApplies();
  };
  sendBtn.onclick = send;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  const foot = h('div', { class: 'chat-foot' }, input, h('div', { class: 'row', style: 'margin-top:6px;justify-content:flex-end' }, sendBtn));
  const chat = h('div', { class: 'chat' }, head, body, foot);
  let shownCount = -1;
  let shownJob = null;

  drawApplies = () => {
    const jobs = [...applyState.jobs].reverse();
    if (!applyState.active && jobs.length) applyState.active = (jobs.find((j) => j.status === 'waiting') || jobs[0]).id;
    list.replaceChildren(...(jobs.length ? jobs.map((j) => h('button', { class: `room${j.id === applyState.active ? ' active' : ''}`, type: 'button', onclick: () => { applyState.active = j.id; drawApplies(); } },
      j.status === 'waiting' ? h('span', { class: 'dot', title: '확인이 필요합니다' }) : null,
      h('div', { class: 't' }, h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, j.title), h('span', { class: `badge ${STATUS_TEXT[j.status][0]}` }, STATUS_TEXT[j.status][1])),
      h('div', { class: 'a' }, j.status === 'waiting' ? `🙋 ${j.waiting || '확인이 필요합니다'}` : j.activity))) : [h('p', { class: 'muted small' }, '아직 맡긴 지원서가 없습니다. "+ 새 지원서"를 눌러 Notion 공고를 고르세요.')]));
    const job = applyState.jobs.find((j) => j.id === applyState.active);
    chat.style.display = job ? '' : 'none';
    if (!job) return;
    head.replaceChildren(
      h('div', null, h('strong', null, job.title), ' ', h('span', { class: `badge ${STATUS_TEXT[job.status][0]}` }, STATUS_TEXT[job.status][1])),
      h('div', { class: 'row', style: 'gap:6px' },
        ['running', 'waiting', 'done'].includes(job.status) || job.status === 'error' ? h('button', { class: 'btn', type: 'button', onclick: async () => { const r = await api('POST', '/api/apply/focus', { id: job.id }).catch((e) => toast(e.message, true)); if (r && !r.focused) toast('이 지원서의 창은 이미 끝나 연결이 없습니다. 브라우저에서 직접 확인해 주세요.'); } }, '창 보기') : null,
        ['queued', 'running', 'waiting'].includes(job.status) ? h('button', { class: 'btn danger', type: 'button', onclick: () => confirm(`${job.title} 지원서를 중지할까요? (입력한 칸과 창은 그대로 둡니다)`) && api('POST', '/api/apply/stop', { id: job.id }).then(pollApplies).catch((e) => toast(e.message, true)) }, '중지') : null,
        ['done', 'error', 'stopped'].includes(job.status) ? h('button', { class: 'btn', type: 'button', onclick: () => api('POST', '/api/apply/remove', { id: job.id }).then(() => { delete applyState.msgs[job.id]; applyState.active = null; pollApplies(); }).catch((e) => toast(e.message, true)) }, '방 지우기') : null),
    );
    const msgs = applyState.msgs[job.id] || [];
    if (shownJob !== job.id || shownCount !== msgs.length) {
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60 || shownJob !== job.id;
      body.replaceChildren(...msgs.map((m) => h('div', { class: `msg ${m.kind}` }, m.kind === 'ask' ? `🙋 확인이 필요해요\n${m.text}` : m.kind === 'ai' ? `🤖 ${m.text}` : m.text)));
      if (atBottom) body.scrollTop = body.scrollHeight;
      shownJob = job.id;
      shownCount = msgs.length;
    }
    input.disabled = ['done', 'error', 'stopped'].includes(job.status);
    input.placeholder = job.status === 'waiting' ? '여기에 답을 적으세요 (Enter 보내기). 비밀번호는 적지 말고 브라우저 창에 직접 입력하세요.' : input.disabled ? '끝난 지원서입니다' : '지금은 묻는 것이 없습니다. 적으면 기록만 합니다.';
  };

  const newBtn = h('button', { class: 'btn primary', type: 'button', onclick: openPicker }, '+ 새 지원서');
  setTimeout(() => { drawApplies(); pollApplies(); }, 0);
  return page('지원서 작성', '고른 공고마다 대화방이 생기고, 브라우저에 지원서 창을 따로 열어 함께 진행합니다. 로그인·본인인증처럼 사람이 해야 할 일이 생기면 알림이 오고 그 창이 앞으로 뜨며, 대화방에 빨간 점이 생깁니다. 대화방에 답을 적으면 이어서 합니다. 제출은 하지 않습니다.',
    h('div', { class: 'row', style: 'margin-bottom:12px;gap:12px;flex-wrap:wrap;align-items:center' }, newBtn,
      h('span', { class: 'muted small' }, `동시에 ${state.settings.apply.max_parallel}개까지 진행 (설정 → 작성 → 지원서 입력 규칙)`)),
    h('div', { class: 'rooms' }, list, chat),
  );
}

async function openPicker() {
  try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch {}
  const MAX = 8;
  const back = h('div', { class: 'modal-back', onclick: (e) => e.target === back && back.remove() });
  const box = h('div', { class: 'modal' }, h('p', { class: 'muted' }, 'Notion 에서 공고를 불러오는 중…'));
  back.append(box);
  document.body.append(back);
  let postings = [];
  let opts = {};
  let loadError = '';
  try {
    const r = await api('POST', '/api/apply/postings');
    postings = r.postings;
    opts = r.statusOptions;
  } catch (e) {
    loadError = e.message;
  }
  const picked = new Set();
  const extra = [];
  const q = h('input', { placeholder: '회사 이름으로 찾기', style: 'flex:1;min-width:160px' });
  const statusSel = h('select', null, h('option', { value: 'open' }, `${opts.default || '제출전'} · ${opts.priority || '작성중'}만`), h('option', { value: '' }, '전체'));
  const count = h('span', { class: 'small' });
  const rows = h('tbody');
  const urlIn = h('input', { placeholder: '또는 지원 페이지 주소 직접 넣기 (https://…)', style: 'flex:1;min-width:200px' });
  const extraBox = h('div', { class: 'chips', style: 'margin-top:6px' });
  const stepBasic = h('input', { type: 'checkbox', checked: true });
  const stepEssay = h('input', { type: 'checkbox', checked: true });
  const total = () => picked.size + extra.length;
  const draw = () => {
    const words = q.value.trim().toLowerCase();
    const shown = postings.filter((p) => (!statusSel.value || [opts.default, opts.priority].includes(p.status) || !p.status) && (!words || p.company.toLowerCase().includes(words)));
    rows.replaceChildren(...shown.map((p) => h('tr', null,
      h('td', { class: 'center' }, h('input', { type: 'checkbox', checked: picked.has(p.id), disabled: !picked.has(p.id) && total() >= MAX ? true : null, onchange: (e) => { e.target.checked ? picked.add(p.id) : picked.delete(p.id); draw(); } })),
      h('td', null, h('strong', null, p.company), p.roles ? h('div', { class: 'muted small' }, p.roles) : null),
      h('td', { class: 'small', style: 'white-space:nowrap' }, p.deadline ? p.deadline.slice(0, 16).replace('T', ' ') : '상시'),
      h('td', { class: 'small' }, p.status || '—'),
      h('td', { class: 'small' }, p.link ? h('a', { href: p.link, target: '_blank', rel: 'noopener' }, '지원 페이지') : h('span', { style: 'color:var(--danger)' }, '링크 없음')))));
    count.textContent = `${total()} / ${MAX}개 골랐습니다${extra.length ? ` (직접 넣은 주소 ${extra.length}개 포함)` : ''}`;
    extraBox.replaceChildren(...extra.map((u, i) => h('span', { class: 'chip' }, u, h('button', { type: 'button', title: '빼기', onclick: () => { extra.splice(i, 1); draw(); } }, '×'))));
    startBtn.disabled = !total();
  };
  const startBtn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    const steps = [stepBasic.checked && 'basic', stepEssay.checked && 'essay'].filter(Boolean);
    if (!steps.length) return toast('할 단계를 골라 주세요', true);
    const targets = [...postings.filter((p) => picked.has(p.id)).map((p) => ({ target: p.url, title: p.company })), ...extra.map((u) => ({ target: u, title: u.replace(/^https?:\/\//, '').split('/')[0] }))];
    startBtn.disabled = true;
    try {
      const r = await api('POST', '/api/apply/start', { targets, steps });
      back.remove();
      applyState.active = r.started[0];
      toast(`${r.started.length}개 지원서를 시작했습니다`);
      go('settings', 'applies');
      pollApplies();
    } catch (e) {
      toast(e.message, true);
      startBtn.disabled = false;
    }
  } }, '시작');
  q.oninput = draw;
  statusSel.onchange = draw;
  box.replaceChildren(
    h('h2', { style: 'margin-top:0' }, '지원할 공고 고르기'),
    h('p', { class: 'muted small', style: 'margin-top:0' }, `최대 ${MAX}개. 마감이 가까운 순서입니다 (마감 지난 공고는 뺐습니다).`),
    loadError ? h('div', { class: 'notice' }, `Notion 공고를 불러오지 못했습니다: ${loadError} — 아래에 지원 페이지 주소를 직접 넣어도 됩니다.`) : null,
    h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, q, statusSel),
    h('div', { style: 'max-height:50vh;overflow:auto;margin-top:8px' }, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, ''), h('th', null, '회사'), h('th', null, '마감'), h('th', null, '상태'), h('th', null, ''))), rows)),
    extraBox,
    h('div', { class: 'row', style: 'gap:6px;margin-top:10px' }, urlIn, h('button', { class: 'btn', type: 'button', onclick: () => { const u = urlIn.value.trim(); if (!/^https?:\/\//.test(u)) return toast('https:// 로 시작하는 주소를 넣어 주세요', true); if (total() >= MAX) return toast(`최대 ${MAX}개입니다`, true); extra.push(u); urlIn.value = ''; draw(); } }, '넣기')),
    h('div', { class: 'row', style: 'gap:14px;margin-top:10px;flex-wrap:wrap;align-items:center' },
      h('label', { class: 'small' }, stepBasic, ' 인적사항'), h('label', { class: 'small' }, stepEssay, ' 자기소개서'), count),
    h('div', { class: 'row', style: 'gap:6px;margin-top:12px;justify-content:flex-end' }, h('button', { class: 'btn', type: 'button', onclick: () => back.remove() }, '취소'), startBtn),
  );
  draw();
}

// ─── 시작하기 ───────────────────────────────────────────
function startPage() {
  const box = h('div', null, h('p', { class: 'muted' }, '점검하는 중…'));
  const MARK = { ok: ['ok', '완료'], warn: ['warn', '할 일'], bad: ['bad', '문제'] };
  api('GET', '/api/doctor').then(({ checks }) => {
    const todo = checks.filter((c) => c.status !== 'ok').length;
    box.replaceChildren(
      h('div', { class: `notice${todo ? '' : ' ok'}` }, todo ? `아래 ${todo}가지를 마치면 공고 수집과 지원서 작성을 쓸 수 있습니다.` : '모두 준비됐습니다. 실행 → 공고 수집에서 "미리보기"로 시작해 보세요.'),
      card(null, h('table', { class: 'grid' },
        h('tbody', null, checks.map((c) => h('tr', null,
          h('td', { style: 'white-space:nowrap' }, h('span', { class: `badge ${MARK[c.status][0]}` }, MARK[c.status][1])),
          h('td', null, h('strong', null, c.label), h('div', { class: 'muted small' }, c.detail)),
          h('td', { style: 'white-space:nowrap' }, c.page && c.status !== 'ok' ? h('button', { class: 'btn', type: 'button', onclick: () => go(c.page[0], c.page[1]) }, '설정하러 가기') : null),
        ))))),
    );
  }).catch((e) => box.replaceChildren(h('div', { class: 'notice bad' }, e.message)));
  return page('시작하기', '처음 쓰는 순서: ① AI 연결 ② 내 정보 ③ 검색 키워드와 기업 구분 ④ Notion 연결 ⑤ 브라우저에서 채용 사이트 로그인 ⑥ 공고 수집 미리보기 → 등록 ⑦ 지원서 작성(autojob apply).',
    box,
    card('지원서 작성',
      h('p', { class: 'muted small', style: 'margin-top:0' }, '실행 → 지원서 작성에서 Notion 공고를 골라 여러 개를 함께 맡길 수 있습니다. 터미널에서 하나씩 하려면:'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => go('settings', 'applies') }, '지원서 작성으로 가기')),
      h('pre', { class: 'code', style: 'margin-top:8px' }, 'autojob apply "https://www.notion.so/…공고 페이지…"')),
  );
}

// ─── 공고 수집 실행 ─────────────────────────────────────
let lastCollect = null;

function collectPage() {
  const s = state.settings;
  const usable = state.meta.collectors.filter((c) => c.status === 'ok');
  const picks = h('div', { class: 'checks' }, usable.map((c) => h('label', null, h('input', { type: 'checkbox', value: c.id, checked: !!s.collect.sources[c.id] }), c.label)));
  const limit = h('input', { type: 'number', min: '1', placeholder: '제한 없음', style: 'max-width:140px' });
  const out = h('div');
  if (lastCollect) drawCollect(out, lastCollect);

  const start = async (dryRun, btn) => {
    const sources = [...picks.querySelectorAll('input:checked')].map((i) => i.value);
    if (!sources.length) return toast('수집할 사이트를 골라 주세요', true);
    if (!dryRun && !confirm('수집한 공고를 Notion 에 등록할까요? (중복은 넣지 않습니다)')) return;
    const buttons = btn.parentElement.querySelectorAll('button');
    buttons.forEach((b) => (b.disabled = true));
    const label = btn.textContent;
    btn.textContent = '수집 중… (사이트 수에 따라 몇 분 걸릴 수 있습니다)';
    try {
      lastCollect = await run(() => api('POST', '/api/collect/run', { dryRun, sources, limit: Number(limit.value) || undefined }));
      drawCollect(out, lastCollect);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
      btn.textContent = label;
    }
  };

  const warn = [];
  if (!s.collect.keywords.length && !s.collect.jasoseol.duty_groups.length && !s.collect.jobkorea.duty_categories.length && !s.collect.wanted.job_group_ids.length) warn.push('검색 키워드가 없습니다 (검색 조건 → 검색 키워드).');
  if (!(state.secrets.NOTION_TOKEN.set && s.notion.data_source_id)) warn.push('Notion 이 연결되지 않아 미리보기만 할 수 있습니다.');

  return page('공고 수집', '켜 둔 사이트에서 공고를 모아 경력직, 고용형태, 마감, 기업 구분으로 거르고, 실제 지원 페이지를 확인한 뒤 Notion 에 등록합니다. 중복은 넣지 않습니다.',
    warn.length ? h('div', { class: 'notice' }, h('ul', { style: 'margin:0' }, warn.map((w) => h('li', null, w)))) : null,
    card(null,
      h('div', { class: 'field' }, h('label', null, '사이트'), picks),
      h('div', { class: 'field' }, h('label', null, '최대 건수'), limit, h('div', { class: 'hint' }, '처음에는 5건 정도로 시험해 보세요')),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'btn', type: 'button', onclick: (e) => start(true, e.target) }, '미리보기 (Notion 에 쓰지 않음)'),
        h('button', { class: 'btn primary', type: 'button', onclick: (e) => start(false, e.target) }, '수집하고 Notion 에 등록')),
    ),
    out,
  );
}

function drawCollect(box, r) {
  const rep = r.report;
  const section = (outcome, title) => {
    const xs = rep.items.filter((i) => i.outcome === outcome);
    if (!xs.length) return null;
    return card(`${title} (${xs.length})`, h('div', { style: 'overflow-x:auto' }, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, '마감'), h('th', null, '회사 / 공고'), h('th', null, '구분 · 직무 · 분류'), h('th', null, '링크'))),
      h('tbody', null, xs.map((i) => h('tr', null,
        h('td', { style: 'white-space:nowrap' }, i.deadline),
        h('td', null, h('strong', null, i.company), h('div', { class: 'muted small' }, i.title), i.found ? h('div', { class: 'small muted' }, `🔎 ${i.found}`) : null, i.reason ? h('div', { class: 'small', style: 'color:var(--warn)' }, i.reason) : null, ...(i.dropped || []).map((d) => h('div', { class: 'small', style: 'color:var(--warn)' }, d))),
        h('td', { class: 'small' }, [i.companyTypes?.join('/'), i.roles?.join(', '), i.employment?.join(', ')].filter(Boolean).join(' · ') || '—'),
        h('td', { class: 'small', style: 'white-space:nowrap' },
          i.notionUrl ? h('div', null, h('a', { href: i.notionUrl, target: '_blank', rel: 'noopener' }, 'Notion')) : null,
          i.applyUrl ? h('div', null, h('a', { href: i.applyUrl, target: '_blank', rel: 'noopener' }, '지원 페이지')) : null,
          h('div', null, h('a', { href: i.sourceUrl, target: '_blank', rel: 'noopener' }, '원문'))),
      ))))));
  };
  box.replaceChildren(...[
    card(rep.dryRun ? '미리보기 결과' : '수집 결과',
      h('ul', { class: 'result' }, rep.sources.map((s) => h('li', null, `${s.error ? '❌' : '✅'} ${s.label}: ${s.error || `${s.count}건`}`))),
      h('div', { class: 'chips', style: 'margin-top:10px' }, Object.entries(rep.counts).map(([k, v]) => h('span', { class: 'chip', style: 'padding-right:10px' }, `${r.labels[k] || k} ${v}`))),
      rep.ai && (rep.ai.linkSearched || rep.ai.rolesTagged || rep.ai.errors.length)
        ? h('p', { class: 'small' }, `AI: 지원 페이지 ${rep.ai.linkSearched}건 중 ${rep.ai.linkFound}건 찾음 · 직무 태그 ${rep.ai.rolesTagged}건 보정${rep.ai.costUsd ? ` · $${rep.ai.costUsd.toFixed(2)}` : ''}${rep.ai.errors.length ? ` · ⚠️ ${rep.ai.errors.join(' / ')}` : ''}`)
        : null,
      h('p', { class: 'muted small' }, `리포트 파일: ${r.dir}`)),
    section('registered', '✅ Notion 에 등록'),
    section('would_register', '📝 등록 대상'),
    section('no_link', '🔗 지원 페이지를 찾지 못해 뺀 공고'),
    section('error', '❌ 오류'),
    section('duplicate', '⏭️ 이미 Notion 에 있음'),
    section('company', '🏢 기업 구분으로 뺀 공고'),
    section('no_role', '🏷️ 직무 태그가 없어 뺀 공고'),
  ].filter(Boolean));
}

// ─── Notion ─────────────────────────────────────────────
let notionReport = null;

function notionPage() {
  const s = state.settings;
  const connected = state.secrets.NOTION_TOKEN.set;
  const reportBox = h('div');
  if (notionReport) drawReport(reportBox, notionReport);

  const dbCard = card('2. 공고를 정리할 DB',
    h('p', { class: 'muted small', style: 'margin-top:0' }, s.notion.data_source_id ? `현재: ${notionReport?.title || s.notion.data_source_id}` : '아직 고르지 않았습니다.'),
    connected
      ? h('div', null,
        h('div', { class: 'row', id: 'db-row' }, h('button', { class: 'btn', type: 'button', onclick: loadDatabases }, 'DB 목록 불러오기'),
          s.notion.data_source_id ? h('button', { class: 'btn', type: 'button', onclick: checkNow }, '속성 매칭 검사') : null),
        reportBox)
      : h('p', { class: 'muted' }, '먼저 토큰을 저장해 주세요.'),
  );

  async function loadDatabases() {
    const { databases } = await run(() => api('GET', '/api/notion/databases'));
    const row = document.getElementById('db-row');
    if (!databases.length) {
      row.after(h('div', { class: 'notice' }, '이 연결이 볼 수 있는 DB가 없습니다. DB가 있는 페이지의 ••• → 연결에서 통합을 추가해 주세요.'));
      return;
    }
    const select = h('select', null, databases.map((d) => h('option', { value: d.id, selected: d.id === s.notion.data_source_id ? true : null }, `${d.title} (속성 ${d.propertyCount}개)`)));
    row.replaceChildren(select, h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      const r = await run(() => api('POST', '/api/notion/select', { id: select.value }), (x) => `선택: ${x.title}`);
      notionReport = r;
      render();
    } }, '이 DB 사용'));
  }

  async function checkNow() {
    notionReport = await run(() => api('GET', '/api/notion/check'));
    render();
  }

  const fields = card('3. DB 속성 이름', h('p', { class: 'muted small', style: 'margin-top:0' }, '내 Notion DB의 속성 이름과 똑같이 맞춥니다. 매칭 검사에서 후보를 자동으로 적용할 수도 있습니다.'),
    Object.entries(state.meta.notionFields).map(([k, spec]) => textSetting(spec.label, `notion.fields.${k}`, { hint: `${spec.types.join(' / ')}${spec.required ? '' : ' · 선택'}` })));
  const options = card('4. 옵션 값',
    h('p', { class: 'muted small', style: 'margin-top:0' }, '채용 분류 (표준 이름 → 내 DB 옵션 이름)'),
    Object.keys(s.notion.employment_options).map((k) => textSetting(k, `notion.employment_options.${k}`)),
    h('p', { class: 'muted small' }, '제출 상태 / 합불 여부'),
    textSetting('등록 시 (우선 기업)', 'notion.status_options.priority'),
    textSetting('등록 시 (기본)', 'notion.status_options.default'),
    textSetting('지원서 작성 후', 'notion.status_options.after_apply'),
    textSetting('합불 여부 기본값', 'notion.result_default'),
  );

  const pageMode = card('5. 페이지 만들기',
    toggle('DB에 기본 템플릿이 있으면 그 템플릿으로 페이지 만들기', 'notion.use_db_template'),
    h('p', { class: 'muted small' }, '템플릿이 없을 때 페이지 본문에 넣을 제목 (지원서 작성 후 이 제목 아래에 내용을 채웁니다)'),
    chipEditor('notion.page_sections', { placeholder: '제목 추가' }),
    textSetting('마감 시간 시간대', 'notion.timezone_offset', { hint: '예: +09:00 (한국)' }),
  );

  const bootstrapBox = h('div');
  const bootstrapCard = connected
    ? card('새로 시작: DB 만들기',
      h('p', { class: 'muted small', style: 'margin-top:0' }, '공고를 정리할 DB가 아직 없다면, 고른 페이지 아래에 같은 구조의 DB를 새로 만들고 바로 연결합니다. 직무 태그는 내 정보의 "희망 직무"로 만듭니다.'),
      bootstrapBox)
    : null;
  const drawBootstrap = () => bootstrapBox.replaceChildren(h('button', { class: 'btn', type: 'button', onclick: async () => {
    const { pages } = await run(() => api('GET', '/api/notion/pages'));
    if (!pages.length) return bootstrapBox.replaceChildren(h('div', { class: 'notice' }, '이 연결이 볼 수 있는 페이지가 없습니다. DB를 만들 페이지의 ••• → 연결에서 통합을 추가해 주세요.'));
    const sel = h('select', null, pages.map((p) => h('option', { value: p.id }, p.title)));
    const title = h('input', { value: '서류 제출 자료', placeholder: 'DB 제목' });
    bootstrapBox.replaceChildren(
      h('div', { class: 'field' }, h('label', null, '만들 위치'), sel),
      h('div', { class: 'field' }, h('label', null, 'DB 제목'), title),
      h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        if (!confirm(`"${sel.selectedOptions[0].text}" 페이지 아래에 DB를 만들까요?`)) return;
        const r = await run(() => api('POST', '/api/notion/bootstrap', { parent: sel.value, title: title.value }), (x) => x.info);
        notionReport = null;
        render();
        window.open(r.url, '_blank', 'noopener');
      } }, 'DB 만들기'),
    );
  } }, '페이지 목록 불러오기'));
  if (bootstrapCard) drawBootstrap();

  const testCard = connected && s.notion.data_source_id ? card('6. 공고 1건 넣어보기', testPosting()) : null;

  const SECTION_LABEL = { procedure: '전형 절차', company: '회사/조직 소개', role: '지원 직무', essays: '자기소개서 문항과 답변', projects: '프로젝트·동아리 입력란', documents: '제출 서류' };
  const sectionCard = card('7. 지원서 작성 후 채울 본문 제목',
    h('p', { class: 'muted small', style: 'margin-top:0' }, `autojob apply 가 끝나면 공고 페이지 본문에서 아래 제목을 찾아 그 아래에 내용을 넣고, 제출 상태를 "${s.notion.status_options.after_apply}"(으)로 바꿉니다. 내 템플릿의 제목과 같게 맞춰 주세요. 이미 내용이 있는 섹션은 건드리지 않습니다.`),
    Object.entries(SECTION_LABEL).map(([k, label]) => textSetting(label, `notion.section_map.${k}`)),
  );

  return page('Notion', '모은 공고를 정리할 Notion DB를 연결합니다.',
    card('1. 연결 토큰',
      h('ol', { class: 'steps' }, state.meta.setupSteps.map((step, i) => h('li', null, i === 0 ? h('span', null, h('a', { href: state.meta.integrationsUrl, target: '_blank', rel: 'noopener' }, 'Notion 통합 페이지'), '에서 "새 API 통합"을 만듭니다 (유형: 내부).') : step))),
      secretInput('NOTION_TOKEN', { onSaved: () => { notionReport = null; } }),
      connected ? h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn', type: 'button', onclick: () => run(() => api('POST', '/api/notion/test'), (x) => x.info) }, '연결 확인')) : null,
    ),
    dbCard, bootstrapCard, fields, options, pageMode, testCard, sectionCard,
  );
}

/** 수동으로 공고 1건을 넣어 Notion 연동을 확인하는 입력칸 */
function testPosting() {
  const box = h('div', null,
    h('p', { class: 'muted small', style: 'margin-top:0' }, '중복이면 넣지 않습니다. 직무와 채용 분류는 DB에 이미 있는 옵션만 들어갑니다. 먼저 미리보기로 확인해 보세요.'),
  );
  const load = h('button', { class: 'btn', type: 'button', onclick: async () => {
    const o = await run(() => api('GET', '/api/notion/options'));
    const f = {
      company: h('input', { placeholder: '회사명' }),
      link: h('input', { placeholder: 'https://… 실제 지원 페이지' }),
      deadline: h('input', { placeholder: '2026-09-30 18:00 또는 상시' }),
      note: h('input', { placeholder: '특이 사항이 있을 때만' }),
      companyType: h('select', null, h('option', { value: '' }, '— 모름 —'), o.companyTypes.map((t) => h('option', { value: t }, t))),
    };
    const checks = (values) => {
      const wrap = h('div', { class: 'checks' }, values.map((v) => h('label', null, h('input', { type: 'checkbox', value: v }), v)));
      wrap.picked = () => [...wrap.querySelectorAll('input:checked')].map((i) => i.value);
      return wrap;
    };
    const roles = o.roles.length ? checks(o.roles) : h('span', { class: 'muted' }, 'DB에 직무 옵션이 없습니다');
    const emp = checks(o.employment);
    const out = h('div');
    const send = async (dryRun) => {
      const r = await run(() => api('POST', '/api/notion/add', {
        dryRun,
        posting: {
          company: f.company.value, link: f.link.value, deadline: f.deadline.value, note: f.note.value,
          companyType: f.companyType.value, roles: roles.picked ? roles.picked() : [], employment: emp.picked(),
        },
      }));
      const lines = [];
      if (r.status === 'duplicate') lines.push(h('div', { class: 'notice' }, `중복이라 넣지 않았습니다: ${r.duplicate.reason} — ${r.duplicate.existing.company}`, r.duplicate.existing.url ? h('div', null, h('a', { href: r.duplicate.existing.url, target: '_blank', rel: 'noopener' }, '기존 페이지 열기')) : null));
      if (r.status === 'created') lines.push(h('div', { class: 'notice ok' }, `추가했습니다${r.usedTemplate ? ' (DB 기본 템플릿 적용)' : ''} `, h('a', { href: r.url, target: '_blank', rel: 'noopener' }, 'Notion에서 열기')));
      if (r.status === 'dry-run') lines.push(h('div', { class: 'notice ok' }, `미리보기 — 본문: ${r.usedTemplate ? 'DB 기본 템플릿' : '설정의 제목들'}`), h('pre', { style: 'white-space:pre-wrap;font-size:12px;margin:8px 0 0' }, JSON.stringify(r.properties, null, 2)));
      if (r.dropped?.length) lines.push(h('div', { class: 'notice' }, '빠진 값', h('ul', null, r.dropped.map((d) => h('li', null, d)))));
      out.replaceChildren(...lines);
    };
    box.replaceChildren(
      h('p', { class: 'muted small', style: 'margin-top:0' }, `대상 DB: ${o.title}`),
      h('div', { class: 'field' }, h('label', null, '회사명'), f.company),
      h('div', { class: 'field' }, h('label', null, '지원 링크'), f.link),
      h('div', { class: 'field' }, h('label', null, '마감'), f.deadline),
      h('div', { class: 'field' }, h('label', null, '직무'), roles),
      h('div', { class: 'field' }, h('label', null, '채용 분류'), emp),
      h('div', { class: 'field' }, h('label', null, '기업 구분'), f.companyType),
      h('div', { class: 'field' }, h('label', null, '참고 키워드'), f.note),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn', type: 'button', onclick: () => send(true) }, '미리보기'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => confirm('Notion DB에 추가할까요?') && send(false) }, 'Notion에 추가')),
      out,
    );
  } }, '입력칸 열기');
  box.append(load);
  return box;
}

function drawReport(box, r) {
  const rep = r.report;
  const hasSuggest = rep.fields.some((f) => !f.ok && f.suggestion);
  box.replaceChildren(...[
    h('table', { class: 'grid', style: 'margin-top:12px' },
      h('thead', null, h('tr', null, h('th', null, '항목'), h('th', null, '설정된 속성'), h('th', null, '결과'))),
      h('tbody', null, rep.fields.map((f) => h('tr', null,
        h('td', null, f.label),
        h('td', null, f.configured || '—'),
        h('td', null, f.ok ? h('span', { class: 'badge ok' }, '맞음') : h('span', null, h('span', { class: 'badge bad' }, f.problem), f.suggestion ? h('span', { class: 'muted small' }, ` 후보: ${f.suggestion}`) : null)),
      )))),
    rep.optionProblems.length ? h('div', { class: 'notice', style: 'margin-top:10px' }, '옵션 이름이 DB와 다릅니다 (아래 4. 옵션 값에서 맞춰주세요)', h('ul', null, rep.optionProblems.map((o) => h('li', null, o)))) : null,
    rep.ok ? h('div', { class: 'notice ok', style: 'margin-top:10px' }, 'DB 속성이 설정과 모두 맞습니다.') : null,
    hasSuggest ? h('button', { class: 'btn primary', type: 'button', style: 'margin-top:10px', onclick: async () => {
      notionReport = await run(() => api('POST', '/api/notion/apply-suggestions'), '후보를 적용했습니다');
      render();
    } }, '후보 이름 적용') : null,
  ].filter(Boolean));
}

// ─── 브라우저 ───────────────────────────────────────────
function browserPage() {
  const s = state.settings;
  const result = h('div');
  const urlInput = h('input', { placeholder: '열 주소 (선택, 예: 채용 사이트 로그인 페이지)' });
  const defBox = h('div', { class: 'muted small' }, '기본 브라우저를 확인하는 중…');
  const pwBox = h('div');
  api('GET', '/api/browser/default').then((d) => {
    const name = { aside: 'Aside', chrome: 'Chrome' };
    defBox.replaceChildren(
      d.driver
        ? h('div', { class: 'row' }, h('span', null, `이 컴퓨터의 기본 브라우저: ${name[d.driver]}`), d.driver !== s.browser.driver ? h('button', { class: 'btn primary', type: 'button', onclick: () => setSetting('browser.driver', d.driver, `${name[d.driver]}로 바꿨습니다`).then(render) }, `${name[d.driver]}로 맞추기`) : h('span', { class: 'badge ok' }, '맞춰져 있음'))
        : h('span', null, d.bundleId ? `기본 브라우저(${d.bundleId})는 원격 조종을 지원하지 않습니다. Aside 나 Chrome 을 고르세요.` : '기본 브라우저를 알 수 없습니다.'),
    );
    const sel = h('select', null, d.profiles.map((p) => h('option', { value: p.dir }, `${p.name} (${p.dir})`)));
    pwBox.replaceChildren(
      d.profiles.length
        ? h('div', null,
          h('div', { class: 'row' }, h('span', { class: 'small' }, '가져올 프로필'), sel,
            h('button', { class: 'btn', type: 'button', onclick: async (e) => {
              if (!confirm(`평소 쓰는 ${name[d.current]}의 "${sel.selectedOptions[0]?.textContent}" 프로필에 저장된 비밀번호를 자동화 프로필로 복사합니다.\n\n· 자동화 브라우저 창이 열려 있으면 닫습니다.\n· 비밀번호는 암호화된 채로 복사되고, 이 도구는 내용을 보지 않습니다.\n· 자동화 프로필에 원래 있던 비밀번호 파일은 .bak 으로 남깁니다.\n\n계속할까요?`)) return;
              e.target.disabled = true;
              try {
                const r = await run(() => api('POST', '/api/browser/import-passwords', { profile: sel.value }), '비밀번호를 가져왔습니다');
                pwBox.append(h('div', { class: 'notice ok', style: 'margin-top:8px' }, `복사함: ${r.copied.join(', ')}${r.backups.length ? ` · 예전 파일: ${r.backups.join(', ')}` : ''}. 이제 "자동화 브라우저 열기"로 창을 열면 로그인 칸에 자동 완성이 됩니다.`));
              } finally {
                e.target.disabled = false;
              }
            } }, '비밀번호 가져오기')),
          h('p', { class: 'muted small' }, '브라우저가 처음 이 비밀번호를 쓸 때 macOS 가 "키체인 접근" 허용을 물을 수 있습니다. 평소 프로필에서 비밀번호를 바꾸면 여기서 다시 가져오면 됩니다.'))
        : h('p', { class: 'muted small' }, '평소 쓰는 프로필을 찾지 못했습니다.'),
    );
  }).catch((e) => defBox.replaceChildren(h('span', { style: 'color:var(--danger)' }, e.message)));
  return page('브라우저', '지원서를 입력할 때 조종할 브라우저입니다. 평소 쓰는 프로필과 분리된 자동화 전용 프로필을 씁니다.',
    card('종류', defBox, h('div', { style: 'margin-top:10px' }, radios('driver', 'browser.driver', [
      ['aside', 'Aside (원격 조종)'],
      ['chrome', 'Chrome (원격 조종)'],
    ]))),
    card('평소 쓰는 프로필의 비밀번호 쓰기',
      h('p', { class: 'muted small', style: 'margin-top:0' }, 'Aside 와 Chrome 은 보안 정책상 평소 쓰는 기본 프로필은 원격 조종을 켤 수 없습니다 (쿠키를 훔치는 악성 프로그램을 막기 위한 브라우저 정책). 그래서 자동화는 전용 프로필에서 하고, 대신 기본 프로필에 저장된 비밀번호를 자동화 프로필로 가져올 수 있습니다. 브라우저 계정 동기화를 쓴다면 자동화 브라우저 창에서 같은 계정으로 로그인해도 됩니다.'),
      pwBox),
    s.browser.driver !== 'handoff'
      ? card('앱 위치',
        textSetting('앱 경로', `browser.${s.browser.driver}.app`),
        textSetting('원격 조종 포트', `browser.${s.browser.driver}.cdp_port`, { type: 'number' }),
        textSetting('자동화 프로필 폴더', `browser.${s.browser.driver}.profile_dir`))
      : null,
    card('자동화 브라우저 열기',
      h('p', { class: 'muted small', style: 'margin-top:0' }, '채용 사이트에 미리 로그인해 두면 이 프로필에 유지됩니다.'),
      h('div', { class: 'row' }, urlInput, h('button', { class: 'btn', type: 'button', onclick: () => run(() => api('POST', '/api/browser/open', { url: urlInput.value.trim() }), (x) => x.info) }, '열기'))),
    card('연결 테스트',
      h('p', { class: 'muted small', style: 'margin-top:0' }, '가짜 지원서 페이지로 입력 기능과 제출 차단을 확인합니다.'),
      h('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
        e.target.disabled = true;
        e.target.textContent = '테스트 중…';
        try {
          const r = await run(() => api('POST', '/api/browser/test'));
          result.replaceChildren(
            h('div', { class: `notice ${r.passed ? 'ok' : 'bad'}`, style: 'margin-top:12px' }, r.passed ? `통과 (${r.checks.length}개 항목)` : '실패한 항목이 있습니다'),
            h('ul', { class: 'result' }, r.checks.map((c) => h('li', null, `${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`))),
          );
        } finally {
          e.target.disabled = false;
          e.target.textContent = '테스트 실행';
        }
      } }, '테스트 실행'),
      result),
  );
}

// ─── 시작 ───────────────────────────────────────────────
(async () => {
  if (!TOKEN) {
    document.getElementById('main').replaceChildren(h('div', { class: 'notice bad' }, '접속 토큰이 없습니다. 터미널에서 autojob ui 를 실행하고 나온 주소로 열어주세요.'));
    return;
  }
  try {
    state = await api('GET', '/api/state');
    render();
    pollApplies();
  } catch (e) {
    document.getElementById('main').replaceChildren(h('div', { class: 'notice bad' }, e.message));
  }
})();
