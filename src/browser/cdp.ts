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
  const flags = [`--remote-debugging-port=${cfg.cdp_port}`, `--user-data-dir=${cfg.profile_dir}`, '--no-first-run'];
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
  return chromium.connectOverCDP(`http://127.0.0.1:${cfg.cdp_port}`);
}
