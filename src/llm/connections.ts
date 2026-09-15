// AI 연결 목록 편집 (설정 화면, CLI 공용). 계정 폴더를 따로 두면 같은 Claude Code / Codex 를 여러 계정으로 쓸 수 있다.
import { execFile } from 'node:child_process';
import { accessSync, constants, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../config';
import { expandHome } from '../paths';
import { connectionKeyName, getSecret, maskSecret, setSecret } from '../secrets';
import type { SettingsStore } from '../settings/store';
import { connectionLabel, connectionsOf, readConnStates, TYPE_LABEL, type Connection, type LlmType } from './pool';

const isCli = (t: LlmType) => t === 'claude-cli' || t === 'codex-cli';

/** 목록이 비어 있으면 예전 설정(backend) 을 첫 연결로 옮겨 적는다 */
function materialize(store: SettingsStore): Connection[] {
  const s = store.settings;
  if (s.llm.connections.length) return s.llm.connections;
  const first = { ...connectionsOf(s)[0], id: 'c1' };
  store.set('llm.connections', [first]);
  return [first];
}

export function addConnection(store: SettingsStore, type: LlmType): Connection {
  const list = materialize(store);
  let n = list.length + 1;
  while (list.some((c) => c.id === `c${n}`)) n++;
  const id = `c${n}`;
  // 같은 종류가 이미 기본 로그인을 쓰면, 새 연결은 따로 로그인할 계정 폴더를 준다
  const needsOwnAccount = isCli(type) && list.some((c) => c.type === type && !c.account_dir);
  const c: Connection = { id, type, label: '', model: '', effort: '', account_dir: needsOwnAccount ? path.join('~/.autojob/accounts', `${type.replace('-cli', '')}-${id}`) : '', enabled: true };
  store.set('llm.connections', [...list, c]);
  if (c.account_dir) mkdirSync(expandHome(c.account_dir), { recursive: true });
  return c;
}

export function updateConnection(store: SettingsStore, id: string, patch: Partial<Pick<Connection, 'label' | 'model' | 'account_dir' | 'enabled' | 'effort'>>): void {
  const list = materialize(store);
  if (!list.some((c) => c.id === id)) throw new Error('없는 연결입니다');
  store.set('llm.connections', list.map((c) => (c.id === id ? { ...c, ...patch } : c)));
}

export function moveConnection(store: SettingsStore, id: string, dir: -1 | 1): void {
  const list = [...materialize(store)];
  const i = list.findIndex((c) => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  store.set('llm.connections', list);
}

export function removeConnection(store: SettingsStore, id: string): void {
  const list = materialize(store);
  if (list.length <= 1) throw new Error('연결이 하나는 있어야 합니다');
  store.set('llm.connections', list.filter((c) => c.id !== id));
  if (getSecret(connectionKeyName(id))) setSecret(connectionKeyName(id), '');
}

/** 로그인할 때 칠 명령 */
export function loginCommand(c: Connection): string | null {
  if (!isCli(c.type)) return null;
  const dir = c.account_dir ? `'${path.resolve(expandHome(c.account_dir)).replace(/'/g, `'\\''`)}'` : '';
  if (c.type === 'claude-cli') return `${dir ? `CLAUDE_CONFIG_DIR=${dir} ` : ''}claude   # 열리면 /login 을 입력`;
  return `${dir ? `CODEX_HOME=${dir} ` : ''}codex login`;
}

/** macOS: 터미널 창을 열어 로그인 명령을 실행한다 (비밀번호는 사용자가 그 창에서 직접) */
export function openLoginTerminal(c: Connection): Promise<string> {
  const cmd = loginCommand(c);
  if (!cmd) throw new Error('API 연결은 로그인 대신 API 키를 넣습니다');
  if (c.account_dir) mkdirSync(expandHome(c.account_dir), { recursive: true });
  const run = cmd.replace(/\s+#.*$/, '');
  if (process.platform !== 'darwin') return Promise.resolve(cmd);
  const script = `tell application "Terminal"\nactivate\ndo script "${run.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
  return new Promise((resolve, reject) => execFile('osascript', ['-e', script], (err) => (err ? reject(new Error(`터미널을 열지 못했습니다. 직접 실행해 주세요: ${cmd}`)) : resolve(cmd))));
}

/** PATH 에 명령이 있는지 */
export function commandExists(bin: string): boolean {
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => {
    try {
      accessSync(path.join(d, bin), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** 설정 화면에 보여 줄 연결 목록 (쉬는 상태, API 키 여부 포함) */
export function describeConnections(settings: Settings) {
  const states = readConnStates();
  const now = Date.now();
  return connectionsOf(settings).map((c) => {
    const st = states[c.id] && new Date(states[c.id].until).getTime() > now ? states[c.id] : null;
    const key = c.type === 'anthropic-api' || c.type === 'openai-api' ? getSecret(connectionKeyName(c.id)) ?? getSecret(c.type === 'anthropic-api' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY') : undefined;
    return {
      ...c,
      display: connectionLabel(c),
      typeLabel: TYPE_LABEL[c.type],
      resting: st,
      key: c.type.endsWith('-api') ? { set: !!key, masked: maskSecret(key), own: !!getSecret(connectionKeyName(c.id)) } : null,
      login: loginCommand(c),
      installed: c.type === 'claude-cli' ? commandExists('claude') : c.type === 'codex-cli' ? commandExists('codex') : true,
    };
  });
}
