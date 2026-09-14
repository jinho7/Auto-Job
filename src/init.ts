import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { paths } from './paths';
import { loadSchema } from './profile/schema';
import { ProfileStore } from './profile/store';
import { SettingsStore } from './settings/store';

/** 이 컴퓨터에 설치된 브라우저 (운영체제별 기본 설치 위치) */
export function detectBrowserApps(platform = process.platform, exists: (p: string) => boolean = existsSync, env = process.env): { aside?: string; chrome?: string } {
  const first = (xs: string[]) => xs.find((x) => exists(x));
  if (platform === 'darwin') return { aside: first(['/Applications/Aside.app']), chrome: first(['/Applications/Google Chrome.app', '/Applications/Chromium.app']) };
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES ?? 'C:\\Program Files', env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', env.LOCALAPPDATA].filter((x): x is string => !!x);
    return { chrome: first(roots.map((r) => path.win32.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'))) };
  }
  return { chrome: first(['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']) };
}

/** settings.yaml 과 profile/me/ 가 없으면 만든다. 있는 파일은 건드리지 않는다.
 *  새로 만들 때만 설치된 브라우저를 찾아 브라우저 설정을 맞춘다 (Aside 가 없고 Chrome 이 있으면 Chrome). */
export function ensureInitialized(detect = detectBrowserApps): { settingsCreated: boolean; profileCreated: string[]; browser?: string } {
  const settingsCreated = !existsSync(paths.settings);
  let browser: string | undefined;
  if (settingsCreated) {
    cpSync(paths.settingsExample, paths.settings);
    const found = detect();
    const store = new SettingsStore(paths.settings);
    if (found.chrome) store.set('browser.chrome.app', found.chrome);
    if (!found.aside && found.chrome) store.set('browser.driver', 'chrome');
    browser = found.aside ? 'Aside' : found.chrome ? path.basename(found.chrome) : undefined;
  }
  const profileCreated = new ProfileStore(paths.profileMe, loadSchema(paths.profileSchema)).initFiles();
  mkdirSync(paths.runs, { recursive: true });
  return { settingsCreated, profileCreated, browser };
}
