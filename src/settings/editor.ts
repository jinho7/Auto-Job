// `autojob settings`: 설정 대화형 편집기
import { bootstrapDatabase } from '../notion/bootstrap';
import { NotionClient } from '../notion/client';
import { suggestedFixes, type MappingReport } from '../notion/mapping';
import { applySuggestions, checkCurrent, INTEGRATIONS_URL, listDatabases, notionClient, selectDatabase, SETUP_STEPS } from '../notion/setup';
import { openUrl } from '../open';
import { secretStatus, setSecret } from '../secrets';
import type { Choice, Prompter } from '../ui/prompter';
import { parseNotionId, type SettingsStore } from './store';

const BACK = '__back';

export const SOURCE_LABELS: Record<string, string> = {
  saramin: '사람인',
  jobkorea: '잡코리아',
  wanted: '원티드',
  incruit: '인크루트',
  catch: '캐치',
  jasoseol: '자소설닷컴',
};

export const STANDARD_EMPLOYMENT = ['신입', '인턴', '채용연계형 인턴', '체험형 인턴', '계약직', '정규직'];

export class SettingsEditor {
  constructor(
    private readonly store: SettingsStore,
    private readonly p: Prompter,
    private readonly log = console.log,
    /** 새 DB 의 직무 태그로 쓸 값 (내 정보의 희망 직무) */
    private readonly rolesForBootstrap: () => string[] = () => [],
  ) {}

  private ok(msg: string) {
    this.log(`  ✅ ${msg}`);
  }

  private async attempt(fn: () => void | Promise<void>) {
    try {
      await fn();
    } catch (e) {
      this.log(`  ❌ ${(e as Error).message}`);
    }
  }

  async run(): Promise<void> {
    const menu: [string, () => Promise<void>][] = [
      ['검색 키워드', () => this.list('collect.keywords', '검색 키워드')],
      ['수집 사이트', () => this.sources()],
      ['고용형태', () => this.employment()],
      ['기업 구분 (포함 / 작성중 표시)', () => this.companyTypes()],
      ['회사 직접 지정 (항상 포함 / 항상 제외 / 작성중)', () => this.overrides()],
      ['Notion', () => this.notion()],
      ['자기소개서 문체', () => this.essay()],
      ['브라우저', () => this.browser()],
      ['제출 차단 문구', () => this.guard()],
      ['AI 연결', () => this.llm()],
    ];
    for (;;) {
      const s = this.store.settings;
      const status: Record<string, string> = {
        '검색 키워드': `${s.collect.keywords.length}개`,
        '수집 사이트': Object.entries(s.collect.sources).filter(([, v]) => v).map(([k]) => SOURCE_LABELS[k] ?? k).join(', ') || '없음',
        고용형태: s.collect.employment_types.join(', ') || '없음',
        Notion: s.notion.database_id ? '연결할 DB 지정됨' : 'DB 미지정',
        브라우저: s.browser.driver,
        'AI 연결': s.llm.backend,
      };
      const choices: Choice<number>[] = menu.map(([name], i) => ({ name: status[name] ? `${name}  (${status[name]})` : name, value: i }));
      choices.push({ name: '◀ 종료 (바꾼 내용은 바로 저장됩니다)', value: -1 });
      const pick = await this.p.select({ message: '무엇을 설정할까요?', choices });
      if (pick === -1) return;
      await menu[pick][1]();
    }
  }

  /** 문자열 목록 편집 (추가 / 삭제) */
  async list(p: string, label: string): Promise<void> {
    for (;;) {
      const items = (this.store.get(p) as string[]) ?? [];
      this.log(`\n  ${label}: ${items.length ? items.join(', ') : '(없음)'}`);
      const action = await this.p.select({
        message: label,
        choices: [
          { name: '추가', value: 'add' },
          ...(items.length ? [{ name: '삭제', value: 'remove' }] : []),
          { name: '◀ 뒤로', value: BACK },
        ],
      });
      if (action === BACK) return;
      if (action === 'add') {
        const text = await this.p.input({ message: `추가할 ${label} (쉼표로 여러 개)` });
        await this.attempt(() => {
          const added = this.store.addToList(p, text.split(','));
          this.ok(added.length ? `추가: ${added.join(', ')}` : '새로 추가된 항목이 없습니다');
        });
      }
      if (action === 'remove') {
        const picked = await this.p.checkbox({ message: `삭제할 ${label}`, choices: items.map((v) => ({ name: v, value: v })) });
        await this.attempt(() => {
          const removed = this.store.removeFromList(p, picked);
          if (removed.length) this.ok(`삭제: ${removed.join(', ')}`);
        });
      }
    }
  }

  private async sources(): Promise<void> {
    const sources = this.store.settings.collect.sources;
    const picked = await this.p.checkbox({
      message: '공고를 모을 사이트 (스페이스로 선택)',
      choices: Object.entries(sources).map(([k, on]) => ({ name: SOURCE_LABELS[k] ?? k, value: k, checked: on })),
    });
    await this.attempt(() => {
      this.store.set('collect.sources', Object.fromEntries(Object.keys(sources).map((k) => [k, picked.includes(k)])));
      this.ok('저장');
    });
  }

  private async employment(): Promise<void> {
    const cur = this.store.settings.collect.employment_types;
    const all = [...new Set([...STANDARD_EMPLOYMENT, ...cur])];
    const picked = await this.p.checkbox({
      message: '모을 고용형태 (스페이스로 선택)',
      choices: all.map((v) => ({ name: v, value: v, checked: cur.includes(v) })),
    });
    const extra = await this.p.input({ message: '목록에 없는 고용형태 추가 (쉼표로 여러 개, 없으면 Enter)' });
    const next = [...new Set([...picked, ...extra.split(',').map((v) => v.trim()).filter(Boolean)])];
    await this.attempt(() => {
      this.store.set('collect.employment_types', next);
      this.ok(`고용형태: ${next.join(', ') || '(없음)'}`);
    });
    const exp = await this.p.confirm({ message: '경력직 공고는 뺄까요? ([신입 및 경력]은 포함)', default: this.store.settings.collect.exclude_experienced });
    await this.attempt(() => this.store.set('collect.exclude_experienced', exp));
  }

  private async companyTypes(): Promise<void> {
    const types = this.store.settings.company_types;
    const names = Object.keys(types);
    const include = await this.p.checkbox({
      message: '공고를 모을 기업 구분 (스페이스로 선택)',
      choices: names.map((n) => ({ name: n, value: n, checked: types[n].include })),
    });
    const priority = include.length
      ? await this.p.checkbox({
          message: `Notion에 "${this.store.settings.notion.status_options.priority}" 상태로 등록할 기업 구분`,
          choices: include.map((n) => ({ name: n, value: n, checked: types[n].priority })),
        })
      : [];
    await this.attempt(() => {
      this.store.set(
        'company_types',
        Object.fromEntries(names.map((n) => [n, { include: include.includes(n), priority: priority.includes(n) }])),
      );
      this.ok(`포함: ${include.join(', ') || '(없음)'} / 작성중: ${priority.join(', ') || '(없음)'}`);
    });
  }

  private async overrides(): Promise<void> {
    const pick = await this.p.select({
      message: '회사 직접 지정',
      choices: [
        { name: '항상 포함할 회사', value: 'overrides.always_include' },
        { name: '항상 제외할 회사', value: 'overrides.always_exclude' },
        { name: '"작성중"으로 등록할 회사', value: 'overrides.priority' },
        { name: '◀ 뒤로', value: BACK },
      ],
    });
    if (pick !== BACK) await this.list(pick, '회사명');
  }

  private async notion(): Promise<void> {
    for (;;) {
      const n = this.store.settings.notion;
      const token = secretStatus().NOTION_TOKEN;
      const pick = await this.p.select({
        message: 'Notion',
        choices: [
          { name: `연결 토큰  (${token.set ? token.masked : '미입력'})`, value: 'token' },
          { name: '연결 확인', value: 'test' },
          { name: `공고를 정리할 DB 고르기  (${n.data_source_id || n.database_id || '미지정'})`, value: 'pick' },
          { name: 'DB 링크로 직접 지정', value: 'db' },
          { name: 'DB 새로 만들기 (처음 쓰는 경우)', value: 'bootstrap' },
          { name: `페이지 만들기 방식  (${n.use_db_template ? 'DB 기본 템플릿 우선' : '설정의 제목들'})`, value: 'pagemode' },
          { name: 'DB 속성 매칭 검사', value: 'check' },
          { name: 'DB 속성 이름 직접 맞추기', value: 'fields' },
          { name: '채용 분류 옵션 이름 맞추기', value: 'employment' },
          { name: `제출 상태 값  (우선: ${n.status_options.priority}, 기본: ${n.status_options.default}, 작성 후: ${n.status_options.after_apply})`, value: 'status' },
          { name: `합불 여부 기본값  (${n.result_default})`, value: 'result' },
          { name: '◀ 뒤로', value: BACK },
        ],
      });
      if (pick === BACK) return;
      if (pick === 'token') await this.notionToken();
      if (pick === 'test') {
        await this.attempt(async () => {
          const me = await notionClient().me();
          this.ok(`연결됨: ${me.name}${me.workspace ? ` (워크스페이스: ${me.workspace})` : ''}`);
        });
      }
      if (pick === 'pick') await this.attempt(() => this.pickDatabase());
      if (pick === 'bootstrap') await this.attempt(() => this.bootstrap());
      if (pick === 'pagemode') {
        const use = await this.p.confirm({ message: 'DB에 기본 템플릿이 있으면 그 템플릿으로 페이지를 만들까요?', default: n.use_db_template });
        await this.attempt(() => this.store.set('notion.use_db_template', use));
        this.log(`  템플릿이 없을 때 넣을 제목: ${this.store.settings.notion.page_sections.join(', ')}`);
        if (await this.p.confirm({ message: '제목 목록을 편집할까요?', default: false })) await this.list('notion.page_sections', '페이지 제목');
      }
      if (pick === 'check') await this.attempt(() => this.checkNotion());
      if (pick === 'db') {
        const text = await this.p.input({
          message: '데이터베이스 URL 또는 ID (Notion에서 DB를 열고 "링크 복사")',
          validate: (v) => v === '' || parseNotionId(v) !== null || 'URL이나 ID에서 Notion ID를 찾지 못했습니다',
        });
        const id = text && parseNotionId(text);
        if (id) {
          await this.attempt(async () => {
            if (secretStatus().NOTION_TOKEN.set) {
              const { ds, report } = await selectDatabase(this.store, id);
              this.ok(`선택: ${ds.title}`);
              await this.showMapping(report);
            } else {
              this.store.set('notion.database_id', id);
              this.ok(`database_id = ${id} (토큰을 넣으면 연결을 확인할 수 있습니다)`);
            }
          });
        }
      }
      if (pick === 'fields') await this.mapping('notion.fields', 'DB 속성 이름');
      if (pick === 'employment') await this.mapping('notion.employment_options', '채용 분류 옵션 이름');
      if (pick === 'status') await this.mapping('notion.status_options', '제출 상태 값');
      if (pick === 'result') {
        const v = await this.p.input({ message: '합불 여부 기본값', default: n.result_default });
        await this.attempt(() => this.store.set('notion.result_default', v));
      }
    }
  }

  private async notionToken(): Promise<void> {
    this.log('\n  Notion 연결 방법');
    SETUP_STEPS.forEach((s, i) => this.log(`   ${i + 1}. ${s}`));
    if (await this.p.confirm({ message: '통합 만들기 페이지를 브라우저로 열까요?', default: true })) openUrl(INTEGRATIONS_URL);
    const token = await this.p.password({ message: '토큰 붙여넣기 (비워두면 취소)' });
    if (!token.trim()) return;
    await this.attempt(async () => {
      const me = await new NotionClient(token.trim()).me();
      setSecret('NOTION_TOKEN', token);
      this.ok(`토큰 저장, 연결 확인: ${me.name}${me.workspace ? ` (워크스페이스: ${me.workspace})` : ''}`);
    });
    if (secretStatus().NOTION_TOKEN.set && (await this.p.confirm({ message: '이어서 공고를 정리할 DB를 고를까요?', default: true }))) {
      await this.attempt(() => this.pickDatabase());
    }
  }

  private async pickDatabase(): Promise<void> {
    const list = await listDatabases();
    if (!list.length) {
      this.log('  이 연결이 볼 수 있는 DB가 없습니다. DB가 있는 페이지의 ••• → 연결에서 통합을 추가해 주세요.');
      return;
    }
    const current = this.store.settings.notion.data_source_id;
    const id = await this.p.select({
      message: '공고를 정리할 DB',
      default: current || undefined,
      choices: [
        ...list.map((d) => ({ name: `${d.title}${d.id === current ? '  (현재)' : ''}  · 속성 ${d.propertyCount}개`, value: d.id })),
        { name: '◀ 취소', value: BACK },
      ],
    });
    if (id === BACK) return;
    const { ds, report } = await selectDatabase(this.store, id);
    this.ok(`선택: ${ds.title}`);
    await this.showMapping(report);
  }

  private async bootstrap(): Promise<void> {
    const client = notionClient();
    const pages = await client.searchPages();
    if (!pages.length) {
      this.log('  이 연결이 볼 수 있는 페이지가 없습니다. DB를 만들 페이지의 ••• → 연결에서 통합을 추가해 주세요.');
      return;
    }
    const parent = await this.p.select({ message: 'DB를 만들 페이지', choices: [...pages.map((p) => ({ name: p.title, value: p.id })), { name: '◀ 취소', value: BACK }] });
    if (parent === BACK) return;
    const title = await this.p.input({ message: 'DB 제목', default: '서류 제출 자료' });
    const roles = this.rolesForBootstrap();
    this.log(`  직무 태그: ${roles.length ? roles.join(', ') : '(없음 — 나중에 Notion에서 추가)'}`);
    if (!(await this.p.confirm({ message: '만들까요?', default: true }))) return;
    const created = await bootstrapDatabase(client, this.store, parent, title, roles);
    this.ok(`DB를 만들고 연결했습니다: ${created.url}`);
  }

  private async checkNotion(): Promise<void> {
    const { ds, report } = await checkCurrent(this.store);
    this.log(`\n  DB: ${ds.title}`);
    await this.showMapping(report);
  }

  /** 속성 매칭 결과를 보여주고, 제안값이 있으면 적용할지 묻는다 */
  private async showMapping(report: MappingReport): Promise<void> {
    for (const f of report.fields) {
      this.log(`  ${f.ok ? '✅' : '❌'} ${f.label} → ${f.configured || '(없음)'}${f.problem ? `  — ${f.problem}` : ''}${f.suggestion ? `  (후보: ${f.suggestion})` : ''}`);
    }
    for (const o of report.optionProblems) this.log(`  ⚠️  ${o}`);
    if (report.ok) return this.ok('DB 속성이 설정과 모두 맞습니다');
    const fixes = suggestedFixes(report);
    if (Object.keys(fixes).length && (await this.p.confirm({ message: '후보 이름을 설정에 적용할까요?', default: true }))) {
      applySuggestions(this.store, report);
      this.ok(`적용: ${Object.entries(fixes).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    if (report.optionProblems.length) this.log('  옵션 이름은 "채용 분류 옵션 이름 맞추기" / "제출 상태 값"에서 내 DB에 맞게 바꿔 주세요.');
  }

  /** key → 값 매핑을 차례로 묻는다 (Enter 는 유지) */
  private async mapping(p: string, label: string): Promise<void> {
    const cur = this.store.get(p) as Record<string, string>;
    this.log(`\n  ${label}: 내 Notion에 적힌 이름과 똑같이 맞춰주세요. Enter는 그대로 유지합니다.`);
    for (const [k, v] of Object.entries(cur)) {
      const next = await this.p.input({ message: k, default: v });
      if (next !== v) await this.attempt(() => this.store.set(`${p}.${k}`, next));
    }
  }

  private async essay(): Promise<void> {
    const e = this.store.settings.essay;
    const tone = await this.p.input({ message: '문장 끝맺음 (예: 습니다)', default: e.tone });
    const subtitle = await this.p.confirm({ message: '문단마다 [소제목]을 달까요?', default: e.subtitle });
    const dot = await this.p.confirm({ message: '단어 나열에 가운뎃점(·)을 쓰지 않을까요?', default: e.forbid_middle_dot });
    const blind = await this.p.confirm({ message: '블라인드 규정을 지킬까요? (실명, 학교명, 특정 단체명 금지)', default: e.blind });
    await this.attempt(() => {
      this.store.set('essay.tone', tone);
      this.store.set('essay.subtitle', subtitle);
      this.store.set('essay.forbid_middle_dot', dot);
      this.store.set('essay.blind', blind);
      this.ok('저장');
    });
    if (await this.p.confirm({ message: '쓰지 않을 표현 목록을 편집할까요?', default: false })) {
      await this.list('essay.banned_phrases', '쓰지 않을 표현');
    }
  }

  private async browser(): Promise<void> {
    const b = this.store.settings.browser;
    const driver = await this.p.select({
      message: '브라우저',
      default: b.driver,
      choices: [
        { name: 'Aside (원격 조종)', value: 'aside' as const },
        { name: 'Chrome (원격 조종)', value: 'chrome' as const },
        { name: 'handoff (지시문을 만들어 Aside agent에 붙여넣기)', value: 'handoff' as const },
      ],
    });
    await this.attempt(() => this.store.set('browser.driver', driver));
    if (driver === 'handoff') return this.ok('browser.driver = handoff');
    const app = await this.p.input({ message: `${driver} 앱 경로`, default: b[driver].app });
    await this.attempt(() => (this.store.set(`browser.${driver}.app`, app), this.ok(`browser.driver = ${driver}`)));
  }

  private async guard(): Promise<void> {
    const pick = await this.p.select({
      message: '제출 차단 문구 (버튼 문구에 포함되면 차단)',
      choices: [
        { name: '항상 차단', value: 'browser.guard.always_block' },
        { name: '지원서 입력 단계부터 차단', value: 'browser.guard.block_when_armed' },
        { name: '예외로 허용 (문구가 정확히 일치할 때)', value: 'browser.guard.allow_exact' },
        { name: '◀ 뒤로', value: BACK },
      ],
    });
    if (pick !== BACK) await this.list(pick, '문구');
  }

  private async llm(): Promise<void> {
    const backend = await this.p.select({
      message: 'AI 연결 방식',
      default: this.store.settings.llm.backend,
      choices: [
        { name: 'Claude Code (claude -p, 구독 사용)', value: 'claude-cli' as const },
        { name: 'Codex CLI (codex exec, ChatGPT 구독 사용)', value: 'codex-cli' as const },
        { name: 'Anthropic API 키', value: 'anthropic-api' as const },
        { name: 'OpenAI API 키', value: 'openai-api' as const },
      ],
    });
    await this.attempt(() => (this.store.set('llm.backend', backend), this.ok(`llm.backend = ${backend}`)));
    const keyName = backend === 'anthropic-api' ? 'ANTHROPIC_API_KEY' : backend === 'openai-api' ? 'OPENAI_API_KEY' : null;
    if (keyName) {
      const st = secretStatus()[keyName];
      const key = await this.p.password({ message: `${st.label}${st.set ? ` (현재 ${st.masked}, 비워두면 유지)` : ''}` });
      if (key.trim()) await this.attempt(() => (setSecret(keyName, key), this.ok(`${st.label} 저장`)));
    }
  }
}
