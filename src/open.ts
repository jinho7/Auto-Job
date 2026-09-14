import { execFile } from 'node:child_process';

/** 기본 브라우저로 주소를 연다 */
export function openUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(cmd, [url], () => {});
}
