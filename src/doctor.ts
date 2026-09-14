// 준비 상태 점검 (autojob doctor, 설정 화면 "시작하기"): 무엇이 되어 있고 다음에 무엇을 하면 되는지.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { COLLECTORS } from './collectors';
import { loadSettings, type Settings } from './config';
import { BACKEND_LABEL } from './llm';
import { paths } from './paths';
import { checkProfile } from './profile/check';
import { loadSchema } from './profile/schema';
import { ProfileStore } from './profile/store';
import { getSecret } from './secrets';

export type CheckStatus = 'ok' | 'warn' | 'bad';
export type Check = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** 고치는 곳: 설정 화면 페이지 [종류, id] 와 터미널 명령 */
  page?: [string, string];
  cmd?: string;
};

function version(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 15_000 }, (err, stdout) => resolve(err ? null : String(stdout).trim().split('\n')[0]));
  });
}

async function cdpUp(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

export type DoctorDeps = { version?: (bin: string) => Promise<string | null>; cdpUp?: (port: number) => Promise<boolean>; nodeVersion?: string };

export async function runDoctor(d: DoctorDeps = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const ver = d.version ?? version;

  const node = d.nodeVersion ?? process.versions.node;
  add({ id: 'node', label: 'Node.js', status: Number(node.split('.')[0]) >= 22 ? 'ok' : 'bad', detail: `v${node}${Number(node.split('.')[0]) >= 22 ? '' : ' — 22 이상이 필요합니다'}` });

  let s: Settings;
  try {
    if (!existsSync(paths.settings)) {
      add({ id: 'settings', label: '설정 파일', status: 'bad', detail: 'settings.yaml 이 없습니다', cmd: 'autojob init' });
      return checks;
    }
    s = loadSettings();
    add({ id: 'settings', label: '설정 파일', status: 'ok', detail: paths.settings });
  } catch (e) {
    add({ id: 'settings', label: '설정 파일', status: 'bad', detail: (e as Error).message.split('\n').slice(0, 3).join(' '), cmd: 'autojob settings' });
    return checks;
  }

  // 내 정보
  try {
    const store = new ProfileStore(paths.profileMe, loadSchema(paths.profileSchema));
    const r = checkProfile(store.toJSON(), store.schema, store.filesDir);
    const status: CheckStatus = r.errors.length ? 'bad' : r.missing.length ? 'warn' : 'ok';
    add({
      id: 'profile',
      label: '내 정보',
      status,
      detail: `${r.filled}/${r.total}개 입력${r.missing.length ? `, 필수 ${r.missing.length}개 비어 있음 (${r.missing.slice(0, 3).map((m) => m.where).join(', ')}${r.missing.length > 3 ? ' …' : ''})` : ''}${r.errors.length ? `, 형식 오류 ${r.errors.length}개` : ''}`,
      page: ['profile', 'basic'],
      cmd: 'autojob profile edit',
    });
  } catch (e) {
    add({ id: 'profile', label: '내 정보', status: 'bad', detail: (e as Error).message, cmd: 'autojob init' });
  }

  // 공고 수집
  const c = s.collect;
  const hasQuery = c.keywords.length || c.jasoseol.duty_groups.length || c.jobkorea.duty_categories.length || c.wanted.job_group_ids.length;
  add({ id: 'keywords', label: '검색 키워드', status: hasQuery ? 'ok' : 'warn', detail: !hasQuery
      ? '없음 — 공고를 모으려면 필요합니다'
      : [c.keywords.length ? `${c.keywords.length}개: ${c.keywords.slice(0, 5).join(', ')}` : '키워드 없음', c.jasoseol.duty_groups.length || c.jobkorea.duty_categories.length || c.wanted.job_group_ids.length ? '사이트 직무 분류로도 검색' : ''].filter(Boolean).join(' · '), page: ['settings', 'keywords'], cmd: 'autojob settings add collect.keywords <키워드>' });
  const on = COLLECTORS.filter((x) => c.sources[x.id]);
  const usable = on.filter((x) => x.status === 'ok');
  const skipped = on.filter((x) => x.status !== 'ok');
  add({
    id: 'sources',
    label: '수집 사이트',
    status: usable.length ? 'ok' : 'warn',
    detail: `${usable.length ? usable.map((x) => x.label).join(', ') : '켜진 사이트가 없습니다'}${skipped.length ? ` (${skipped.map((x) => x.label).join(', ')}: 수집 안 함)` : ''}`,
    page: ['settings', 'sources'],
  });
  const included = Object.entries(s.company_types).filter(([, t]) => t.include).map(([k]) => k);
  add({ id: 'companies', label: '기업 구분', status: included.length ? 'ok' : 'warn', detail: included.length ? `모으기: ${included.join(', ')}` : '모을 기업 구분이 없습니다', page: ['settings', 'companies'] });

  // Notion
  const token = !!getSecret('NOTION_TOKEN');
  const db = !!(s.notion.data_source_id || s.notion.database_id);
  add({
    id: 'notion',
    label: 'Notion',
    status: token && db ? 'ok' : 'warn',
    detail: !token ? '연결 토큰이 없습니다 (없으면 미리보기만 됩니다)' : !db ? '공고를 정리할 DB를 고르지 않았습니다' : 'DB 연결됨',
    page: ['settings', 'notion'],
    cmd: 'autojob settings  (→ Notion)',
  });

  // 브라우저
  const drv = s.browser.driver;
  if (drv === 'handoff') {
    add({ id: 'browser', label: '브라우저', status: 'bad', detail: 'handoff 는 지원하지 않습니다. Aside 나 Chrome 을 골라 주세요', page: ['settings', 'browser'] });
  } else {
    const b = s.browser[drv];
    const appOk = existsSync(b.app);
    const up = await (d.cdpUp ?? cdpUp)(b.cdp_port);
    add({
      id: 'browser',
      label: '브라우저',
      status: appOk || up ? 'ok' : 'bad',
      detail: `${drv} — ${appOk ? path.basename(b.app) : `${b.app} 를 찾지 못했습니다`}${up ? ' (자동화 창 켜져 있음)' : ' (필요할 때 자동으로 켭니다)'}`,
      page: ['settings', 'browser'],
      cmd: 'autojob browser test',
    });
  }

  // AI
  const be = s.llm.backend;
  if (be === 'claude-cli' || be === 'codex-cli') {
    const bin = be === 'claude-cli' ? 'claude' : 'codex';
    const v = await ver(bin);
    add({
      id: 'ai',
      label: 'AI 연결',
      status: v ? 'ok' : 'bad',
      detail: v ? `${BACKEND_LABEL[be]} ${v} — 로그인은 "연결 확인"으로 확인` : `${bin} 명령을 찾지 못했습니다. ${be === 'claude-cli' ? 'Claude Code 를 설치하고 로그인하세요 (https://claude.com/claude-code)' : 'Codex CLI 를 설치하고 로그인하세요 (npm i -g @openai/codex, codex login)'}`,
      page: ['settings', 'llm'],
      cmd: 'autojob doctor --ai',
    });
  } else {
    const key = be === 'anthropic-api' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    const set = !!getSecret(key);
    add({ id: 'ai', label: 'AI 연결', status: set ? 'ok' : 'bad', detail: set ? `${BACKEND_LABEL[be]} (키 있음)` : `${key} 가 없습니다`, page: ['settings', 'llm'] });
  }
  return checks;
}

export function formatDoctor(checks: Check[]): string {
  const mark = { ok: '✅', warn: '⚠️ ', bad: '❌' } as const;
  const width = (t: string) => [...t].reduce((n, ch) => n + (/[\u1100-\uFFDC]/.test(ch) ? 2 : 1), 0);
  const lines = checks.map((c) => `${mark[c.status]} ${c.label}${' '.repeat(Math.max(1, 13 - width(c.label)))}${c.detail}`);
  const todo = checks.filter((c) => c.status !== 'ok');
  if (todo.length) {
    lines.push('', '다음 할 일');
    for (const c of todo) lines.push(`  · ${c.label}: ${c.cmd ? c.cmd : '설정 화면(autojob ui)'}`);
  } else lines.push('', '모두 준비됐습니다. `autojob collect --dry-run --limit 5` 로 시작해 보세요.');
  return lines.join('\n');
}
