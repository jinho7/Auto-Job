// 수집용 HTTP. 원칙:
//  - 정직한 User-Agent 를 쓴다 (브라우저로 위장하지 않는다)
//  - 요청 전에 robots.txt 를 확인하고, 막힌 경로는 요청하지 않는다
//  - 같은 사이트에는 설정한 간격을 두고 요청한다
//  - 봇 차단(403, Cloudflare 등)을 우회하지 않는다
import pkg from '../package.json' with { type: 'json' };

export const USER_AGENT = `AutoJob/${pkg.version} (personal job search tool)`;
const ROBOTS_AGENT = 'autojob';

export class RobotsBlockedError extends Error {
  constructor(readonly url: string) {
    super(`robots.txt 가 이 주소의 자동 접근을 막고 있어 요청하지 않았습니다: ${url}`);
    this.name = 'RobotsBlockedError';
  }
}

export type HttpResponse = { status: number; url: string; text: string };

type Rule = { allow: boolean; path: string };

/** robots.txt 해석 (구글 방식: 가장 긴 규칙이 이기고, 길이가 같으면 허용이 이긴다) */
export function parseRobots(text: string, agent = ROBOTS_AGENT): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let cur: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (key === 'allow' || key === 'disallow') cur.rules.push({ allow: key === 'allow', path: value });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.toLowerCase().includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

function ruleMatches(pattern: string, path: string): boolean {
  if (!pattern) return false;
  const re = '^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*').replace(/\\\$$/, '$');
  return new RegExp(re).test(path);
}

export function isAllowed(rules: Rule[], pathWithQuery: string): boolean {
  let best: Rule | null = null;
  for (const r of rules) {
    if (!r.path && !r.allow) continue; // "Disallow:" (빈 값) 은 전부 허용
    if (!ruleMatches(r.path, pathWithQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

export class PoliteHttp {
  private readonly last = new Map<string, number>();
  private readonly robots = new Map<string, Promise<Rule[]>>();

  constructor(
    private readonly delayMs = 1500,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async throttle(host: string): Promise<void> {
    const wait = (this.last.get(host) ?? 0) + this.delayMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.last.set(host, Date.now());
  }

  /** robots.txt 규칙 (사이트당 한 번 읽는다). 읽지 못하면(404 등) 제한 없음으로 본다. */
  private rulesFor(origin: string): Promise<Rule[]> {
    let p = this.robots.get(origin);
    if (!p) {
      p = this.raw(`${origin}/robots.txt`, {})
        .then((r) => (r.status === 200 ? parseRobots(r.text) : r.status >= 500 || r.status === 403 || r.status === 401 ? [{ allow: false, path: '/' }] : []))
        .catch(() => [{ allow: false, path: '/' }]); // 확인할 수 없으면 조심스럽게 막힌 것으로
      this.robots.set(origin, p);
    }
    return p;
  }

  async allowed(url: string): Promise<boolean> {
    const u = new URL(url);
    return isAllowed(await this.rulesFor(u.origin), u.pathname + u.search);
  }

  private async raw(url: string, init: RequestInit): Promise<HttpResponse> {
    const host = new URL(url).host;
    for (let attempt = 0; ; attempt++) {
      await this.throttle(host);
      const res = await this.fetchImpl(url, {
        ...init,
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ko-KR,ko;q=0.9', ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(20_000),
        redirect: 'follow',
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await this.sleep(this.delayMs * (attempt + 2) * 2);
        continue;
      }
      return { status: res.status, url: res.url || url, text: await res.text() };
    }
  }

  async request(url: string, init: RequestInit = {}): Promise<HttpResponse> {
    if (!(await this.allowed(url))) throw new RobotsBlockedError(url);
    return this.raw(url, init);
  }
}
