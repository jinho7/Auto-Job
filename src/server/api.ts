// 웹 UI 가 부르는 API. 저장소 로직은 CLI 와 같은 ProfileStore / SettingsStore 를 쓴다.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BrowserSession } from '../browser/session';
import { browserSelfTest } from '../browser/selftest';
import { loadSettings } from '../config';
import { NotionClient } from '../notion/client';
import { COLLECTORS } from '../collectors';
import { loadDutyGroups } from '../collectors/jasoseol';
import { loadDutyCategories } from '../collectors/jobkorea';
import { PoliteHttp } from '../http';
import { runDoctor } from '../doctor';
import { testAi } from '../llm';
import { parseDeadline, type JobPosting } from '../jobs/model';
import { OUTCOME_LABEL } from '../pipeline/collect';
import { collectNow } from '../pipeline/run';
import { bootstrapDatabase } from '../notion/bootstrap';
import { FIELD_SPEC, optionsOf } from '../notion/mapping';
import { applySuggestions, checkCurrent, INTEGRATIONS_URL, jobWriter, listDatabases, notionClient, selectDatabase, SETUP_STEPS } from '../notion/setup';
import { paths } from '../paths';
import { checkProfile } from '../profile/check';
import { loadSchema } from '../profile/schema';
import { ProfileStore } from '../profile/store';
import { SECRET_KEYS, secretStatus, setSecret, type SecretKey } from '../secrets';
import { SOURCE_LABELS, STANDARD_EMPLOYMENT } from '../settings/editor';
import { parseNotionId, SettingsStore } from '../settings/store';

let collectRunning = false;

const profileStore = () => new ProfileStore(paths.profileMe, loadSchema(paths.profileSchema));
const settingsStore = () => new SettingsStore(paths.settings);

export function state() {
  const profile = profileStore();
  const settings = settingsStore();
  return {
    schema: profile.schema,
    profile: profile.toJSON(),
    check: checkProfile(profile.toJSON(), profile.schema, profile.filesDir),
    files: existsSync(profile.filesDir) ? readdirSync(profile.filesDir).filter((f) => !f.startsWith('.')) : [],
    settings: settings.settings,
    secrets: secretStatus(),
    meta: {
      sources: SOURCE_LABELS,
      employment: STANDARD_EMPLOYMENT,
      notionFields: FIELD_SPEC,
      collectors: COLLECTORS.map((c) => ({ id: c.id, label: c.label, status: c.status, note: c.note, method: c.method })),
      integrationsUrl: INTEGRATIONS_URL,
      setupSteps: SETUP_STEPS,
      paths: { settings: paths.settings, profile: paths.profileMe, files: profile.filesDir },
    },
  };
}

type Body = Record<string, unknown>;
const str = (b: Body, k: string): string => {
  if (typeof b[k] !== 'string') throw new Error(`${k} 가 필요합니다`);
  return b[k] as string;
};

/** 파일 이름에서 경로 문자를 없앤다 */
export function safeFileName(name: string): string {
  const base = path.basename(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  if (!base || base === '.' || base === '..' || base.startsWith('.')) throw new Error('파일 이름이 올바르지 않습니다');
  return base;
}

export const routes: Record<string, (body: Body) => unknown | Promise<unknown>> = {
  'GET /api/state': () => state(),
  'GET /api/doctor': async () => ({ checks: await runDoctor() }),
  'POST /api/llm/test': async () => testAi(loadSettings()),

  // ── 내 정보 ──
  'POST /api/profile/set': (b) => {
    const v = b.value;
    profileStore().set(str(b, 'path'), Array.isArray(v) ? v.map(String) : String(v ?? ''));
    return state();
  },
  'POST /api/profile/add': (b) => ({ index: profileStore().addItem(str(b, 'path')), ...state() }),
  'POST /api/profile/remove': (b) => (profileStore().removeItem(str(b, 'path')), state()),
  'POST /api/profile/upload': (b) => {
    const name = safeFileName(str(b, 'name'));
    const data = Buffer.from(str(b, 'base64'), 'base64');
    if (data.length > 10 * 1024 * 1024) throw new Error('10MB 이하 파일만 올릴 수 있습니다');
    const store = profileStore();
    store.initFiles();
    writeFileSync(path.join(store.filesDir, name), data);
    if (typeof b.path === 'string') store.set(b.path, name);
    return state();
  },

  // ── 설정 ──
  'POST /api/settings/set': (b) => (settingsStore().set(str(b, 'path'), b.value), state()),
  'POST /api/settings/list': (b) => {
    const store = settingsStore();
    const p = str(b, 'path');
    if (Array.isArray(b.add)) store.addToList(p, b.add.map(String));
    if (Array.isArray(b.remove)) store.removeFromList(p, b.remove.map(String));
    return state();
  },

  // ── 비밀값 ──
  'POST /api/secrets/set': async (b) => {
    const key = str(b, 'key') as SecretKey;
    if (!(key in SECRET_KEYS)) throw new Error('알 수 없는 키');
    const value = str(b, 'value').trim();
    let info: string | undefined;
    if (key === 'NOTION_TOKEN' && value) {
      const me = await new NotionClient(value).me(); // 틀린 토큰은 저장하지 않는다
      info = `연결됨: ${me.name}${me.workspace ? ` (워크스페이스: ${me.workspace})` : ''}`;
    }
    setSecret(key, value);
    return { info, ...state() };
  },

  // ── Notion ──
  'POST /api/notion/test': async () => {
    const me = await notionClient().me();
    return { info: `연결됨: ${me.name}${me.workspace ? ` (워크스페이스: ${me.workspace})` : ''}` };
  },
  'GET /api/notion/databases': async () => ({ databases: await listDatabases() }),
  'POST /api/notion/select': async (b) => {
    const { ds, report } = await selectDatabase(settingsStore(), str(b, 'id'));
    return { title: ds.title, report, ...state() };
  },
  'GET /api/notion/check': async () => {
    const { ds, report } = await checkCurrent(settingsStore());
    return { title: ds.title, report };
  },
  'POST /api/notion/apply-suggestions': async () => {
    const store = settingsStore();
    const { report } = await checkCurrent(store);
    const fixes = applySuggestions(store, report);
    const after = await checkCurrent(store);
    return { fixes, title: after.ds.title, report: after.report, ...state() };
  },

  /** 테스트 공고 입력칸에 쓸 DB 옵션 (직무, 채용 분류) */
  'GET /api/notion/options': async () => {
    const store = settingsStore();
    const { ds } = await jobWriter(store);
    const n = store.settings.notion;
    const opts = (key: string) => optionsOf(ds.properties[n.fields[key] ?? '']);
    return { title: ds.title, roles: opts('roles'), employment: Object.keys(n.employment_options), companyTypes: Object.keys(store.settings.company_types) };
  },
  'POST /api/notion/add': async (b) => {
    const p = (b.posting ?? {}) as Record<string, unknown>;
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    const link = String(p.link ?? '').trim();
    if (!link) throw new Error('실제 지원 페이지 링크가 필요합니다');
    const posting: JobPosting = {
      company: String(p.company ?? '').trim(),
      link,
      deadline: parseDeadline(String(p.deadline ?? '')),
      roles: list(p.roles),
      employment: list(p.employment),
      companyType: p.companyType ? String(p.companyType) : undefined,
      note: p.note ? String(p.note) : undefined,
    };
    const { writer } = await jobWriter(settingsStore());
    return writer.add(posting, { dryRun: b.dryRun === true });
  },
  'GET /api/notion/pages': async () => ({ pages: await notionClient().searchPages() }),
  'POST /api/notion/bootstrap': async (b) => {
    const parent = parseNotionId(str(b, 'parent'));
    if (!parent) throw new Error('페이지를 골라 주세요');
    const roles = (profileStore().get('target.job_roles') as string[] | undefined) ?? [];
    const created = await bootstrapDatabase(notionClient(), settingsStore(), parent, String(b.title || '서류 제출 자료'), roles);
    return { info: `DB를 만들고 연결했습니다`, url: created.url, roles, ...state() };
  },

  // ── 공고 수집 ──
  'GET /api/collect/jasoseol-duty-groups': async () => {
    const session = await BrowserSession.open(loadSettings());
    try {
      const groups = await loadDutyGroups(session.page);
      return { groups: groups.map((g) => ({ id: g.id, name: g.name, category: g.category, parent: g.group_id })) };
    } finally {
      await session.detach({ closeTab: true });
    }
  },
  'GET /api/collect/jobkorea-duty-categories': async () => {
    const categories = await loadDutyCategories(new PoliteHttp(loadSettings().collect.request_delay_ms));
    return { categories };
  },
  'POST /api/collect/run': async (b) => {
    if (collectRunning) throw new Error('이미 수집 중입니다. 끝날 때까지 기다려 주세요.');
    collectRunning = true;
    const log: string[] = [];
    try {
      const { report, dir } = await collectNow({
        dryRun: b.dryRun !== false,
        sources: Array.isArray(b.sources) && b.sources.length ? b.sources.map(String) : undefined,
        limit: typeof b.limit === 'number' && b.limit > 0 ? b.limit : undefined,
        log: (m) => log.push(m),
      });
      return { report, dir, log, labels: OUTCOME_LABEL };
    } finally {
      collectRunning = false;
    }
  },

  // ── 브라우저 ──
  'POST /api/browser/test': async () => browserSelfTest(loadSettings()),
  'POST /api/browser/open': async (b) => {
    const session = await BrowserSession.open(loadSettings());
    if (typeof b.url === 'string' && b.url) await session.goto(b.url);
    await session.bringToFront();
    await session.detach();
    return { info: '자동화 브라우저를 열었습니다. 채용 사이트에 로그인해 두면 유지됩니다.' };
  },
};
