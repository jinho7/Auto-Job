import type { BrowserContext, Page } from 'playwright-core';

export async function targetIdOf(context: BrowserContext, page: Page): Promise<string> {
  const cdp = await context.newCDPSession(page);
  try { return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; }
  finally { await cdp.detach(); }
}
