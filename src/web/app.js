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
  try { return JSON.parse(localStorage.getItem('autojob-view')) || { type: 'profile', id: 'basic' }; } catch { return { type: 'profile', id: 'basic' }; }
})();

const SETTINGS_PAGES = [
  ['검색 조건', [['keywords', '검색 키워드'], ['sources', '수집 사이트'], ['employment', '고용형태']]],
  ['기업 필터', [['companies', '기업 구분'], ['overrides', '회사 직접 지정']]],
  ['작성', [['essay', '자기소개서 문체']]],
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
  const sec = state.schema.sections[name];
  if (!sec) return [h('p', null, '없는 섹션입니다.')];
  const issues = [...state.check.missing, ...state.check.errors].filter((m) => m.path === name || m.path.startsWith(`${name}.`));
  return [
    h('h1', null, sec.label),
    h('p', { class: 'lead' }, '입력하면 바로 저장됩니다. 값이 없는 칸은 비워 두세요. AI는 빈 칸을 추정해서 채우지 않습니다.'),
    issues.length
      ? h('div', { class: 'notice', id: 'issues' }, `확인이 필요한 항목 ${issues.length}개`, h('ul', null, issues.map((i) => h('li', null, `${i.where}: ${i.message}`))))
      : h('div', { class: 'notice ok', id: 'issues' }, '이 섹션은 문제가 없습니다.'),
    h('div', { class: 'card' }, renderFields(sec.fields, [name])),
  ];
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
    const upload = h('input', {
      type: 'file', accept: 'image/*,.pdf',
      onchange: async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const base64 = await new Promise((res) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result).split(',')[1]);
          r.readAsDataURL(file);
        });
        await run(() => api('POST', '/api/profile/upload', { name: file.name, base64, path: path.join('.') }), '파일을 올렸습니다');
        render();
      },
    });
    control = h('div', { class: 'row' },
      h('select', { id, onchange: (e) => save(e.target.value) },
        h('option', { value: '' }, '— 선택 안 함 —'),
        state.files.map((n) => h('option', { value: n, selected: n === value ? true : null }, n)),
      ),
      upload,
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

const page = (title, lead, ...cards) => [h('h1', null, title), lead ? h('p', { class: 'lead' }, lead) : null, ...cards];
const card = (title, ...children) => h('div', { class: 'card' }, title ? h('h2', null, title) : null, ...children);

// ─── 설정 화면들 ────────────────────────────────────────
function settingsPage(id) {
  const s = state.settings;
  switch (id) {
    case 'keywords':
      return page('검색 키워드', '채용 사이트에서 이 키워드로 공고를 검색합니다.', card(null, chipEditor('collect.keywords', { emptyText: '아직 키워드가 없습니다' })));

    case 'sources':
      return page('수집 사이트', '공고를 모을 사이트를 고릅니다.', card(null, h('div', { class: 'checks' },
        Object.entries(s.collect.sources).map(([k, on]) => h('label', null,
          h('input', { type: 'checkbox', checked: on, onchange: (e) => setSetting('collect.sources', { ...state.settings.collect.sources, [k]: e.target.checked }) }),
          state.meta.sources[k] || k)))));

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
      const setType = (name, key, val) => setSetting('company_types', { ...state.settings.company_types, [name]: { ...state.settings.company_types[name], [key]: val } });
      return page('기업 구분', `자소설닷컴 달력 필터처럼 켜고 끕니다. "작성중 표시"를 켠 구분은 Notion에 "${s.notion.status_options.priority}" 상태로 등록됩니다.`,
        card(null, h('table', { class: 'grid' },
          h('thead', null, h('tr', null, h('th', null, '구분'), h('th', { class: 'center' }, '공고 모으기'), h('th', { class: 'center' }, '작성중 표시'))),
          h('tbody', null, Object.entries(types).map(([name, t]) => h('tr', null,
            h('td', null, name),
            h('td', { class: 'center' }, h('input', { type: 'checkbox', 'aria-label': `${name} 모으기`, checked: t.include, onchange: (e) => setType(name, 'include', e.target.checked) })),
            h('td', { class: 'center' }, h('input', { type: 'checkbox', 'aria-label': `${name} 작성중`, checked: t.priority, onchange: (e) => setType(name, 'priority', e.target.checked) })),
          ))),
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
        card('쓰지 않을 표현', chipEditor('essay.banned_phrases', { placeholder: '예: 단순한 ~가 아닌' })),
      );

    case 'notion':
      return notionPage();

    case 'browser':
      return browserPage();

    case 'llm': {
      const keyFor = { 'anthropic-api': 'ANTHROPIC_API_KEY', 'openai-api': 'OPENAI_API_KEY' }[s.llm.backend];
      return page('AI 연결', '공고 판단, 지원서 입력, 자기소개서 작성에 쓸 AI입니다.',
        card(null, radios('llm', 'llm.backend', [
          ['claude-cli', 'Claude Code (claude -p, 구독 사용)'],
          ['codex-cli', 'Codex CLI (codex exec, ChatGPT 구독 사용)'],
          ['anthropic-api', 'Anthropic API 키'],
          ['openai-api', 'OpenAI API 키'],
        ])),
        keyFor ? card(state.secrets[keyFor].label, secretInput(keyFor)) : null,
      );
    }

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

  return page('Notion', '모은 공고를 정리할 Notion DB를 연결합니다.',
    card('1. 연결 토큰',
      h('ol', { class: 'steps' }, state.meta.setupSteps.map((step, i) => h('li', null, i === 0 ? h('span', null, h('a', { href: state.meta.integrationsUrl, target: '_blank', rel: 'noopener' }, 'Notion 통합 페이지'), '에서 "새 API 통합"을 만듭니다 (유형: 내부).') : step))),
      secretInput('NOTION_TOKEN', { onSaved: () => { notionReport = null; } }),
      connected ? h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn', type: 'button', onclick: () => run(() => api('POST', '/api/notion/test'), (x) => x.info) }, '연결 확인')) : null,
    ),
    dbCard, fields, options,
  );
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
  return page('브라우저', '지원서를 입력할 때 조종할 브라우저입니다. 평소 쓰는 프로필과 분리된 자동화 전용 프로필을 씁니다.',
    card('종류', radios('driver', 'browser.driver', [
      ['aside', 'Aside (원격 조종)'],
      ['chrome', 'Chrome (원격 조종)'],
      ['handoff', 'handoff (지시문을 만들어 Aside agent에 붙여넣기)'],
    ])),
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
  } catch (e) {
    document.getElementById('main').replaceChildren(h('div', { class: 'notice bad' }, e.message));
  }
})();
