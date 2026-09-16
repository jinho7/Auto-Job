import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 개인 데이터(설정, 내 정보, 실행 기록)를 둘 곳.
 * 1. `AUTOJOB_HOME` 이 있으면 그곳 (여러 벌로 쓰거나 테스트할 때)
 * 2. 내려받은 저장소 안에서 쓰는 경우(.git 이 있거나 이미 settings.yaml 을 만든 경우)에는 저장소 폴더
 * 3. 그 밖에(예: `npm i -g` 로 설치) 에는 `~/.autojob` — 설치 폴더에 개인 데이터를 쓰지 않는다
 */
export function resolveHome(root = ROOT, env = process.env.AUTOJOB_HOME, home = homedir(), exists: (p: string) => boolean = existsSync): string {
  if (env) return path.resolve(env);
  if (exists(path.join(root, '.git')) || exists(path.join(root, 'settings.yaml'))) return root;
  return path.join(home, '.autojob');
}

const HOME = resolveHome();

export const DATA_HOME = HOME;

export const paths = {
  prompts: path.join(ROOT, 'prompts'),
  settings: path.join(HOME, 'settings.yaml'),
  env: path.join(HOME, '.env'),
  settingsExample: path.join(ROOT, 'settings.example.yaml'),
  profileSchema: path.join(ROOT, 'profile', 'schema.yaml'),
  profileMe: path.join(HOME, 'profile', 'me'),
  data: path.join(HOME, 'data'),
  runs: path.join(HOME, 'data', 'runs'),
  fixtures: path.join(ROOT, 'test', 'fixtures'),
};

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(homedir(), p.slice(1)) : p;
}

/** data/runs/<YYYYMMDD-HHmmss>_<name> */
export function runDir(name: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return path.join(paths.runs, `${stamp}_${name}`);
}
