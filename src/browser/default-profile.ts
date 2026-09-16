// 기본 브라우저와 기본 프로필.
// Chromium(Aside, Chrome 포함)은 보안 정책상 **기본 프로필 폴더에서는 원격 조종을 켤 수 없다** (쿠키를 훔치는 악성 프로그램 방지).
// 그래서 자동화는 전용 프로필에서 하고, 원하면 기본 프로필의 저장된 비밀번호만 자동화 프로필로 복사해 온다.
// 비밀번호는 암호화된 채로 복사되고(이 도구는 풀어 보지 않는다), 같은 브라우저 앱이 같은 키로 풀어서 자동 완성에 쓴다.
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Settings } from '../config';

export type Driver = 'aside' | 'chrome';

const BUNDLE_TO_DRIVER: Record<string, Driver> = { 'at.studio.asidebrowser': 'aside', 'com.google.chrome': 'chrome' };

/** macOS 기본 브라우저 (https 를 여는 앱) */
export function detectDefaultBrowser(): Promise<{ bundleId: string | null; driver: Driver | null }> {
  if (process.platform !== 'darwin') return Promise.resolve({ bundleId: null, driver: null });
  return new Promise((resolve) => {
    execFile('sh', ['-c', 'defaults export com.apple.LaunchServices/com.apple.launchservices.secure - | plutil -convert json -o - -'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ bundleId: null, driver: null });
      try {
        const handlers = (JSON.parse(String(stdout)) as { LSHandlers?: { LSHandlerURLScheme?: string; LSHandlerRoleAll?: string }[] }).LSHandlers ?? [];
        const id = handlers.find((h) => h.LSHandlerURLScheme === 'https')?.LSHandlerRoleAll?.toLowerCase() ?? null;
        resolve({ bundleId: id, driver: id ? (BUNDLE_TO_DRIVER[id] ?? null) : null });
      } catch {
        resolve({ bundleId: null, driver: null });
      }
    });
  });
}

/** 브라우저의 기본 데이터 폴더 (평소 쓰는 프로필들이 있는 곳) */
export function defaultDataDir(driver: Driver, platform = process.platform, home = homedir()): string | null {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', driver === 'aside' ? 'Aside' : path.join('Google', 'Chrome'));
  if (driver === 'chrome' && platform === 'linux') return path.join(home, '.config', 'google-chrome');
  if (driver === 'chrome' && platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  return null;
}

/** 기본 데이터 폴더의 프로필 목록 (Local State 의 이름) */
export function listProfiles(dataDir: string): { dir: string; name: string }[] {
  try {
    const st = JSON.parse(readFileSync(path.join(dataDir, 'Local State'), 'utf8')) as { profile?: { info_cache?: Record<string, { name?: string }> } };
    return Object.entries(st.profile?.info_cache ?? {}).map(([dir, v]) => ({ dir, name: v.name || dir }));
  } catch {
    return existsSync(path.join(dataDir, 'Default')) ? [{ dir: 'Default', name: 'Default' }] : [];
  }
}

/** 저장된 비밀번호 파일 (기기에 저장 / 계정에 저장) */
export const PASSWORD_FILES = ['Login Data', 'Login Data For Account'];

/** 로그인 상태(쿠키) 파일. 요즘 크로미움은 Network/Cookies, 예전에는 프로필 바로 아래 Cookies */
export const COOKIE_FILES = [path.join('Network', 'Cookies'), 'Cookies'];

/** 가져온 기록을 남기는 파일 (다음에 "아직 안 가져왔어요" 라고 알려 주려고) */
const MARK = '.autojob-import.json';

export type ImportMark = { at: string; profile: string; files: string[]; cookies: boolean };

/** 이 자동화 프로필로 마지막에 가져온 기록 */
export function lastImport(settings: Settings, driver: Driver): ImportMark | null {
  try {
    return JSON.parse(readFileSync(path.join(settings.browser[driver].profile_dir, 'Default', MARK), 'utf8')) as ImportMark;
  } catch {
    return null;
  }
}

/** SQLite 파일을 안전하게 복사 (브라우저가 쓰는 중이어도 일관된 사본). sqlite3 가 없으면 그냥 복사 */
function copyDb(src: string, dst: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('sqlite3', [src, `.backup "${dst.replace(/"/g, '""')}"`], { timeout: 30_000 }, (err) => {
      if (err) copyFileSync(src, dst);
      resolve();
    });
  });
}

/**
 * 기본 프로필의 저장된 비밀번호(원하면 로그인 상태인 쿠키까지)를 자동화 프로필로 복사한다.
 * 자동화 브라우저는 꺼져 있어야 한다. 기존 파일은 .bak 으로 남긴다.
 */
export async function importPasswords(o: { settings: Settings; driver: Driver; profile: string; cookies?: boolean; dataDir?: string; now?: Date }): Promise<{ copied: string[]; backups: string[] }> {
  const dataDir = o.dataDir ?? defaultDataDir(o.driver);
  if (!dataDir) throw new Error('이 운영체제에서는 기본 프로필 위치를 알 수 없습니다');
  if (!/^[\w .-]+$/.test(o.profile)) throw new Error('프로필 이름이 올바르지 않습니다');
  const srcDir = path.join(dataDir, o.profile);
  const dstDir = path.join(o.settings.browser[o.driver].profile_dir, 'Default');
  if (path.resolve(srcDir) === path.resolve(dstDir)) throw new Error('같은 프로필입니다');
  mkdirSync(dstDir, { recursive: true });
  const stamp = (o.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const copied: string[] = [];
  const backups: string[] = [];
  for (const f of [...PASSWORD_FILES, ...(o.cookies ? COOKIE_FILES : [])]) {
    const src = path.join(srcDir, f);
    if (!existsSync(src)) continue;
    const dst = path.join(dstDir, f);
    mkdirSync(path.dirname(dst), { recursive: true });
    if (existsSync(dst)) {
      renameSync(dst, `${dst}.bak-${stamp}`);
      backups.push(`${f}.bak-${stamp}`);
      for (const j of ['-journal', '-wal', '-shm']) if (existsSync(dst + j)) renameSync(dst + j, `${dst + j}.bak-${stamp}`);
    }
    await copyDb(src, dst);
    copied.push(f);
  }
  if (!copied.length) throw new Error(`${srcDir} 에 저장된 비밀번호 파일이 없습니다`);
  const mark: ImportMark = { at: (o.now ?? new Date()).toISOString(), profile: o.profile, files: copied, cookies: !!o.cookies };
  writeFileSync(path.join(dstDir, MARK), JSON.stringify(mark, null, 2));
  return { copied, backups };
}

/** 자동화 브라우저가 떠 있으면 닫는다 (비밀번호 파일을 바꾸기 전에) */
export async function closeAutomationBrowser(port: number): Promise<boolean> {
  try {
    const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).json()) as { webSocketDebuggerUrl?: string };
    if (!v.webSocketDebuggerUrl) return false;
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(v.webSocketDebuggerUrl!);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      ws.onmessage = () => (ws.close(), resolve());
      ws.onerror = () => resolve();
      ws.onclose = () => resolve();
      setTimeout(resolve, 3000);
    });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const up = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
      if (!up) return true;
    }
    return true;
  } catch {
    return false;
  }
}
