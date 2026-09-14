import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 개인 데이터 위치. 기본은 저장소 폴더, AUTOJOB_HOME 으로 바꿀 수 있다 (여러 프로필, 테스트용). */
const HOME = process.env.AUTOJOB_HOME ? path.resolve(process.env.AUTOJOB_HOME) : ROOT;

export const paths = {
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
