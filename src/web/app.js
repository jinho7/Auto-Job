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
  ['실행', [['start', '시작하기'], ['collect', '공고 수집']]],
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
      return sourcesPage();

    case 'roles':
      return rolesPage();

    case 'ai':
      return aiPage();

    case 'collect':
      return collectPage();

    case 'start':
      return startPage();

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
          textSetting('AI 모델', 'essay.model', { hint: '비우면 Claude Code 기본 모델. 예: claude-sonnet-5 (더 가볍고 빠름)' }),
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
        card('AI 모델', textSetting('모델', 'apply.model', { hint: '비우면 Claude Code 기본 모델. 예: claude-sonnet-5 (더 가볍고 빠름)' })),
        card('실행 방법', h('pre', { style: 'margin:0;white-space:pre-wrap' }, 'autojob apply <Notion 공고 페이지 주소 또는 지원 페이지 주소>'),
          h('p', { class: 'muted small' }, '브라우저가 열리면 로그인·본인인증을 직접 하고 인적사항 입력 화면까지 간 뒤 터미널에서 Enter 를 누르세요. 끝나면 비워둔 값과 참고사항을 알려줍니다. 제출은 하지 않습니다.')),
      );

    case 'notion':
      return notionPage();

    case 'browser':
      return browserPage();

    case 'llm': {
      const keyFor = { 'anthropic-api': 'ANTHROPIC_API_KEY', 'openai-api': 'OPENAI_API_KEY' }[s.llm.backend];
      const HOW = {
        'claude-cli': 'Claude Code 를 설치하고 터미널에서 claude 를 한 번 실행해 로그인하세요. Claude 구독(Pro/Max)을 씁니다.',
        'codex-cli': 'Codex CLI 를 설치(npm i -g @openai/codex)하고 codex login 으로 로그인하세요. ChatGPT 구독을 씁니다. (실험적)',
        'anthropic-api': 'console.anthropic.com 에서 API 키를 만들어 아래에 넣으세요. 쓴 만큼 요금이 나갑니다.',
        'openai-api': 'platform.openai.com 에서 API 키를 만들어 아래에 넣으세요. 쓴 만큼 요금이 나갑니다.',
      };
      const DEFAULT_MODEL = { 'claude-cli': 'Claude Code 기본 모델', 'codex-cli': 'Codex 기본 모델', 'anthropic-api': 'claude-sonnet-5', 'openai-api': 'gpt-5' };
      const result = h('div', { class: 'muted small', style: 'margin-top:8px' });
      return page('AI 연결', '공고 판단, 지원서 입력, 자기소개서 작성에 쓸 AI입니다. 브라우저를 다루는 도구와 제출 차단은 어느 AI 를 써도 똑같이 적용됩니다.',
        card(null, radios('llm', 'llm.backend', [
          ['claude-cli', 'Claude Code (claude -p, 구독 사용)'],
          ['codex-cli', 'Codex CLI (codex exec, ChatGPT 구독 사용)'],
          ['anthropic-api', 'Anthropic API 키'],
          ['openai-api', 'OpenAI API 키'],
        ]), h('p', { class: 'muted small' }, HOW[s.llm.backend])),
        keyFor ? card(state.secrets[keyFor].label, secretInput(keyFor)) : null,
        card('모델',
          textSetting('기본 모델', 'llm.model', { hint: `비우면 ${DEFAULT_MODEL[s.llm.backend]}. 기능별 모델(자기소개서, 지원서 입력, AI 보강)을 따로 적으면 그것을 먼저 씁니다. AI 연결 방식을 바꾸면 기능별 모델 이름도 그 방식에 맞게 바꿔 주세요.` })),
        card('연결 확인',
          h('p', { class: 'muted small', style: 'margin-top:0' }, 'AI 에게 짧은 질문을 보내 실제로 답하는지 봅니다 (로그인, API 키, 모델 이름 확인).'),
          h('button', { class: 'btn', type: 'button', onclick: async (e) => {
            e.target.disabled = true;
            result.textContent = '확인 중… (길면 30초)';
            try {
              const r = await api('POST', '/api/llm/test');
              result.textContent = `${r.ok ? '✅' : '❌'} ${r.message} (${(r.ms / 1000).toFixed(1)}초)`;
            } catch (err) {
              result.textContent = `❌ ${err.message}`;
            } finally {
              e.target.disabled = false;
            }
          } }, '연결 확인'),
          result),
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
      textSetting('AI 모델', 'collect.link_search.model', { hint: '비우면 AI 연결의 기본 모델' }),
      h('p', { class: 'muted small' }, '지원 페이지로 인정하지 않을 사이트'),
      chipEditor('collect.link_search.reject_domains', { placeholder: '예: cafe.naver.com' }),
    ),
    card('직무 태그',
      h('p', { class: 'muted small', style: 'margin-top:0' }, '직무 태그 규칙으로 먼저 달고, 아래 설정에 따라 AI 가 Notion DB에 있는 태그 중에서만 고릅니다.'),
      radios('ai-roles', 'collect.ai_roles.mode', [['off', '규칙만 쓰기'], ['fill_empty', '규칙으로 못 단 공고만 AI'], ['review', '모든 공고를 AI 가 다시 보기']]),
      textSetting('AI 모델', 'collect.ai_roles.model', { hint: '비우면 AI 연결의 기본 모델' }),
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
    card('지원서 작성은 터미널에서',
      h('p', { class: 'muted small', style: 'margin-top:0' }, '로그인·본인인증을 사람이 해야 해서 터미널에서 실행합니다. Notion 공고 페이지 주소를 넣으면 됩니다.'),
      h('pre', { class: 'code' }, 'autojob apply "https://www.notion.so/…공고 페이지…"')),
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
  return page('브라우저', '지원서를 입력할 때 조종할 브라우저입니다. 평소 쓰는 프로필과 분리된 자동화 전용 프로필을 씁니다.',
    card('종류', radios('driver', 'browser.driver', [
      ['aside', 'Aside (원격 조종)'],
      ['chrome', 'Chrome (원격 조종)'],
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
