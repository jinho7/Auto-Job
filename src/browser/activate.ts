// 자동화 브라우저 창을 맨 앞으로 (다른 앱 위로). 사람이 해야 할 일이 생겼을 때 그 지원서 창을 띄운다.
import { execFile } from 'node:child_process';
import type { Settings } from '../config';
import type { BrowserSession } from './session';

const run = (cmd: string, args: string[]) => new Promise<string>((resolve) => execFile(cmd, args, { timeout: 5000 }, (err, out) => resolve(err ? '' : String(out))));

/** macOS: 자동화 프로필로 띄운 브라우저 프로세스를 앞으로 (평소 쓰는 창이 아니라). 안 되면 조용히 넘어간다 */
export async function activateAutomationApp(settings: Settings): Promise<void> {
  if (process.platform !== 'darwin' || settings.browser.driver === 'handoff') return;
  const profile = settings.browser[settings.browser.driver].profile_dir;
  const pids = (await run('pgrep', ['-f', '--', `--user-data-dir=${profile}`])).split('\n').map(Number).filter(Boolean).sort((a, b) => a - b);
  if (!pids.length) return;
  await run('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pids[0]}) to true`]);
}

/** 그 지원서의 탭/창을 보이게 하고 브라우저를 앞으로 */
export async function bringSessionToFront(settings: Settings, s: BrowserSession): Promise<void> {
  await s.show().catch(() => {});
  await activateAutomationApp(settings);
}
