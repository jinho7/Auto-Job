// 웹 UI 가 부르는 API. 저장소 로직은 CLI 와 같은 ProfileStore / SettingsStore 를 쓴다.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BrowserSession } from '../browser/session';
import { browserSelfTest } from '../browser/selftest';
import { loadSettings } from '../config';
import { NotionClient } from '../notion/client';
import { FIELD_SPEC } from '../notion/mapping';
import { applySuggestions, checkCurrent, INTEGRATIONS_URL, listDatabases, notionClient, selectDatabase, SETUP_STEPS } from '../notion/setup';
import { paths } from '../paths';
import { checkProfile } from '../profile/check';
import { loadSchema } from '../profile/schema';
import { ProfileStore } from '../profile/store';
import { SECRET_KEYS, secretStatus, setSecret, type SecretKey } from '../secrets';
import { SOURCE_LABELS, STANDARD_EMPLOYMENT } from '../settings/editor';
import { SettingsStore } from '../settings/store';

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
