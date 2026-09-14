import { execFile } from 'node:child_process';

/** macOS 알림 센터 알림. 다른 OS에서는 터미널 벨만 울린다. */
export function notify(title: string, message: string): void {
  process.stdout.write('\x07');
  if (process.platform !== 'darwin') return;
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`], () => {});
}
