// macOS 알림.
// osascript 로 그냥 알림을 띄우면 macOS 가 그것을 "스크립트 편집기"가 보낸 것으로 보고,
// 알림을 누르면 스크립트 편집기가 열린다. 그래서 알림을 **자동화 브라우저 이름으로** 보낸다.
// 그러면 알림을 눌렀을 때 그 브라우저가 앞으로 온다 (지원서 창이 있는 앱).
import { execFile, execFileSync } from 'node:child_process';
import type { Settings } from './config';

/** 브라우저별 앱 아이디 (알림을 이 앱 이름으로 보낸다) */
export const BUNDLE_ID: Record<'aside' | 'chrome', string> = { aside: 'at.studio.asidebrowser', chrome: 'com.google.chrome' };

let hasTerminalNotifier: boolean | null = null;
function terminalNotifier(): boolean {
  if (hasTerminalNotifier === null) {
    try {
      execFileSync('command', ['-v', 'terminal-notifier'], { shell: '/bin/sh', stdio: 'ignore' });
      hasTerminalNotifier = true;
    } catch {
      hasTerminalNotifier = false;
    }
  }
  return hasTerminalNotifier;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** 알림 스크립트: appId 가 있으면 그 앱 이름으로 보낸다 */
export function notifyScript(title: string, message: string, appId?: string): string {
  const body = `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`;
  return appId ? `tell application id "${esc(appId)}" to ${body}` : body;
}

/** macOS 알림 센터 알림. 다른 OS에서는 터미널 벨만 울린다. */
export function notify(title: string, message: string, opts: { appId?: string } = {}): void {
  process.stdout.write('\x07');
  if (process.platform !== 'darwin') return;
  if (opts.appId && terminalNotifier()) {
    // 있으면 가장 깔끔하다: 누르면 그 앱이 앞으로 온다
    execFile('terminal-notifier', ['-title', title, '-message', message, '-sound', 'Glass', '-activate', opts.appId], () => {});
    return;
  }
  execFile('osascript', ['-e', notifyScript(title, message, opts.appId)], (err) => {
    // 그 앱이 알림을 못 띄우면 그냥 띄운다 (누르면 스크립트 편집기가 열릴 수 있음)
    if (err && opts.appId) execFile('osascript', ['-e', notifyScript(title, message)], () => {});
  });
}

/** 지원서 창이 있는 브라우저 이름으로 알림 (누르면 그 브라우저가 앞으로 온다) */
export function notifyBrowser(settings: Settings, title: string, message: string): void {
  const driver = settings.browser.driver === 'chrome' ? 'chrome' : 'aside';
  notify(title, message, { appId: BUNDLE_ID[driver] });
}
