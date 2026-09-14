// 지원 페이지 확인: 실제로 열리는지 본다. 봇 차단(401/403/429)이나 robots.txt 로 요청할 수 없으면
// 자동화 브라우저에서 한 번 열어 확인한다 (사람이 링크를 한 번 눌러 보는 것과 같다).
import type { Page } from 'playwright-core';
import { RobotsBlockedError, type PoliteHttp } from '../http';

export type LinkCheck = { ok: boolean; url: string; via: 'http' | 'browser' | 'none'; reason?: string };

/** 추적용 파라미터 제거 */
export function cleanLink(url: string): string {
  try {
    const u = new URL(url.trim());
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url.trim();
  }
}

export async function verifyLink(url: string, http: PoliteHttp, browserPage?: () => Promise<Page>): Promise<LinkCheck> {
  let clean: string;
  try {
    clean = cleanLink(url);
    if (!/^https?:$/.test(new URL(clean).protocol)) return { ok: false, url, via: 'none', reason: 'http(s) 주소가 아님' };
  } catch {
    return { ok: false, url, via: 'none', reason: '주소 형식이 아님' };
  }
  let reason = '';
  try {
    const r = await http.request(clean);
    if (r.status < 400) return { ok: true, url: clean, via: 'http' };
    if (![401, 403, 405, 429, 503].includes(r.status)) return { ok: false, url: clean, via: 'http', reason: `페이지가 열리지 않음 (${r.status})` };
    reason = `HTTP ${r.status}`;
  } catch (e) {
    reason = e instanceof RobotsBlockedError ? 'robots.txt' : (e as Error).message;
  }
  if (!browserPage) return { ok: false, url: clean, via: 'none', reason: `직접 확인할 수 없음 (${reason})` };
  const page = await browserPage();
  const res = await page.goto(clean, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null);
  const status = res?.status() ?? 0;
  return status > 0 && status < 400 ? { ok: true, url: clean, via: 'browser' } : { ok: false, url: clean, via: 'browser', reason: `브라우저에서도 열리지 않음 (${status || '오류'})` };
}
