// CDP 기반 드라이버 (Aside, Chrome 공통).
// 브라우저를 자동화 전용 프로필 + 원격 디버깅 포트로 띄우고 connectOverCDP로 붙는다.
// 브라우저는 별도 프로세스로 떠 있으므로 autojob이 끝나도 창은 그대로 남는다 (사용자 검토용).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import type { CdpBrowserConfig } from '../config';

async function cdpVersion(port: number): Promise<{ Browser: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? ((await res.json()) as { Browser: string }) : null;
  } catch {
    return null;
  }
}

function launch(cfg: CdpBrowserConfig): void {
  if (!existsSync(cfg.app)) throw new Error(`브라우저 앱을 찾을 수 없습니다: ${cfg.app}`);
  mkdirSync(cfg.profile_dir, { recursive: true });
  const flags = [
    `--remote-debugging-port=${cfg.cdp_port}`,
    `--user-data-dir=${cfg.profile_dir}`,
    '--no-first-run',
    // 창이 다른 창에 가려지거나 뒤에 있어도 화면을 계속 그리게 한다 (캡처·입력이 멈추지 않도록)
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ];
  const child =
    process.platform === 'darwin' && cfg.app.endsWith('.app')
      ? // -n: 평소 쓰는 창과 별개의 인스턴스로 실행
        spawn('open', ['-na', cfg.app, '--args', ...flags], { detached: true, stdio: 'ignore' })
      : spawn(cfg.app, flags, { detached: true, stdio: 'ignore' });
  child.unref();
}

/** 이미 떠 있으면 붙고, 없으면 띄운 뒤 붙는다. */
export async function connectCdp(cfg: CdpBrowserConfig, timeoutMs = 20_000): Promise<Browser> {
  if (!(await cdpVersion(cfg.cdp_port))) {
    console.log(`🚀 ${path.basename(cfg.app)} 실행 (프로필: ${cfg.profile_dir}, 포트: ${cfg.cdp_port})`);
    launch(cfg);
    const deadline = Date.now() + timeoutMs;
    while (!(await cdpVersion(cfg.cdp_port))) {
      if (Date.now() > deadline) throw new Error(`브라우저 원격 디버깅 포트(${cfg.cdp_port})가 열리지 않습니다`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  await ensureWindow(cfg.cdp_port);
  return chromium.connectOverCDP(`http://127.0.0.1:${cfg.cdp_port}`);
}

/**
 * macOS 에서는 탭을 모두 닫아도 앱이 떠 있다. 창이 하나도 없으면 기본 컨텍스트가 없어 붙을 수 없으므로
 * 빈 탭을 하나 연다 (Aside 는 새 브라우저 컨텍스트 만들기를 지원하지 않는다).
 */
async function ensureWindow(port: number): Promise<void> {
  const list = (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.json())
    .catch(() => [])) as { type: string }[];
  if (list.some((t) => t.type === 'page')) return;
  await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) }).catch(() => {});
  for (let i = 0; i < 20; i++) {
    const again = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => [])) as { type: string }[];
    if (again.some((t) => t.type === 'page')) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}
