// 자동화 브라우저 창을 맨 앞으로 (다른 앱 위로). 사람이 해야 할 일이 생겼을 때 그 지원서 창을 띄운다.
import { execFile } from 'node:child_process';
import type { Settings } from '../config';
import type { BrowserSession } from './session';

const run = (cmd: string, args: string[]) => new Promise<string>((resolve) => execFile(cmd, args, { timeout: 5000 }, (err, out) => resolve(err ? '' : String(out))));

/** macOS: 자동화 프로필로 띄운 브라우저 프로세스를 앞으로 (평소 쓰는 창이 아니라). 안 되면 조용히 넘어간다 */
export async function activateAutomationApp(settings: Settings): Promise<void> {
  const pid = await automationPid(settings);
  if (!pid) return;
  await run('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`]);
}

/**
 * 자동화 브라우저의 **본체** 프로세스 번호 (평소 쓰는 창이 아니라 자동화 프로필로 띄운 것).
 * 브라우저는 탭마다 도우미(Helper) 프로세스를 두는데, 프로세스 번호가 한 바퀴 돌면 도우미가 더 작은 번호를 받기도 한다.
 * 번호가 작은 것을 고르면 도우미를 집어 창을 못 찾으므로, 앱 본체(Contents/MacOS/…)를 고른다.
 */
async function automationPid(settings: Settings): Promise<number | null> {
  if (process.platform !== 'darwin' || settings.browser.driver === 'handoff') return null;
  const profile = settings.browser[settings.browser.driver].profile_dir;
  const pids = (await run('pgrep', ['-f', '--', `--user-data-dir=${profile}`])).split('\n').map(Number).filter(Boolean);
  if (!pids.length) return null;
  return pickMainPid(await run('ps', ['-o', 'pid=,comm=', '-p', pids.join(',')]), pids);
}

/** `ps -o pid=,comm=` 결과에서 앱 본체를 고른다 (도우미 프로세스 경로에도 Contents/MacOS 가 있어서 Helper 를 빼야 한다) */
export function pickMainPid(ps: string, fallback: number[]): number | null {
  for (const line of ps.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m && m[2].includes('/Contents/MacOS/') && !m[2].includes('Helper')) return Number(m[1]);
  }
  return fallback.length ? Math.min(...fallback) : null;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * 같은 앱의 여러 창 중 **이 창**을 올린다.
 * 브라우저의 "탭 앞으로"는 창 안에서만 통하고, 앱을 앞으로 보내면 브라우저가 제 홈 화면 창을 올려 버려서
 * 지원서 창이 떴다가 바로 가려진다. 그래서 창 위치(겹치지 않게 어긋나 있음)로, 안 되면 제목으로 그 창을 집어 올린다.
 */
async function raiseWindow(pid: number, at: { left: number; top: number } | null, title: string): Promise<string> {
  const find = [
    title ? `set ws to (every window whose name contains "${esc(title.slice(0, 40))}")` : 'set ws to {}',
    at ? `if ws is {} then set ws to (every window whose position is {${at.left}, ${at.top}})` : '',
    'if ws is {} then return "no-window"',
    'perform action "AXRaise" of item 1 of ws',
    'return name of item 1 of ws',
  ]
    .filter(Boolean)
    .join('\n');
  return run('osascript', ['-e', `tell application "System Events" to tell (first process whose unix id is ${pid})\n${find}\nend tell`]);
}

/**
 * 그 지원서의 창을 맨 앞으로.
 * 순서가 중요하다: 앱을 먼저 앞으로 보낸 **다음에** 이 지원서 창을 그 위로 올린다 (반대로 하면 홈 화면 창에 가린다).
 */
export async function bringSessionToFront(settings: Settings, s: BrowserSession): Promise<void> {
  const at = await s.windowBounds().catch(() => null);
  const name = s.mark || (await s.title().catch(() => ''));
  await s.show().catch(() => {}); // 창 안에서 이 탭을 활성 탭으로
  await activateAutomationApp(settings);
  const pid = await automationPid(settings);
  if (pid) await raiseWindow(pid, at, name);
}
