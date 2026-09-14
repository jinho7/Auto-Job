// autojob apply: ① 준비 → ② 로그인 대기(사람) → ③ 인적사항 입력(AI) → 리포트
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserSession } from '../browser/session';
import { loadSettings, type Settings } from '../config';
import { runClaudeAgent } from '../llm/claude-cli';
import { propText } from '../notion/client';
import { notionClient } from '../notion/setup';
import { notify } from '../notify';
import { DATA_HOME, paths, ROOT, runDir } from '../paths';
import { checkProfile } from '../profile/check';
import { loadSchema } from '../profile/schema';
import { ProfileStore } from '../profile/store';
import { parseNotionId } from '../settings/store';
import { startBridge, type BridgeEvent } from './bridge';
import { renderProfileForAgent } from './profile-doc';
import { targetIdOf } from './tools';

export type ApplyTarget = { company: string; link: string; notionPageId?: string; notionUrl?: string };

export async function resolveTarget(input: string, settings: Settings): Promise<ApplyTarget> {
  const t = input.trim();
  if (/notion\.(so|site|com)/.test(t) || /^[0-9a-f]{32}$|^[0-9a-f-]{36}$/i.test(t)) {
    const id = parseNotionId(t);
    if (!id) throw new Error('Notion 주소에서 페이지 ID 를 찾지 못했습니다');
    const page = await notionClient().getPage(id);
    const f = settings.notion.fields;
    const link = propText(page.properties[f.link]);
    if (!link) throw new Error(`이 Notion 페이지에 "${f.link}" 값이 없습니다. 지원 링크를 먼저 넣어 주세요.`);
    return { company: propText(page.properties[f.company]), link, notionPageId: page.id, notionUrl: page.url };
  }
  if (/^https?:\/\//.test(t)) return { company: '', link: t };
  if (existsSync(t)) return { company: '', link: pathToFileURL(path.resolve(t)).href };
  throw new Error('Notion 페이지 주소, 지원 페이지 주소(https://…), 또는 HTML 파일 경로를 주세요');
}

export type ApplyReport = {
  company: string;
  link: string;
  notionUrl?: string;
  startedAt: string;
  finishedAt: string;
  summary: string;
  blanks: { field: string; reason: string }[];
  notes: string[];
  actions: Extract<BridgeEvent, { type: 'action' }>[];
  agent: { text: string; isError: boolean; costUsd?: number };
  /** AI 가 finish 까지 마쳤는지 */
  completed: boolean;
  dir: string;
  screenshot?: string;
};

export type ApplyOptions = {
  target: string;
  /** 이미 입력 화면이면 로그인 대기를 건너뛴다 */
  skipLoginWait?: boolean;
  ask: (question: string) => Promise<string>;
  log?: (m: string) => void;
};

const TOOL_ICON: Record<string, string> = { fill: '✏️ ', select: '🔽', check: '☑️ ', click: '👆', press: '⌨️ ', upload: '📎', dialog: '💬' };

export function buildPrompt(target: ApplyTarget, profileDoc: string, files: string[]): string {
  return [
    `지원 회사: ${target.company || '(모름)'}`,
    `지원 페이지: ${target.link}`,
    '',
    '지금 브라우저에 지원서 입력 화면이 열려 있습니다. 규칙에 따라 자기소개서 전까지의 인적사항을 채워 주세요.',
    '먼저 snapshot 으로 화면을 보고 시작하세요. 끝나면 finish 를 호출하세요.',
    '',
    '## 내 정보',
    profileDoc,
    '',
    '## 올릴 수 있는 파일 (profile/me/files)',
    files.length ? files.map((f) => `- ${f}`).join('\n') : '(없음)',
  ].join('\n');
}

export function buildSystemPrompt(settings: Settings): string {
  const base = readFileSync(path.join(paths.prompts, 'fill-basic-info.md'), 'utf8');
  const extra = settings.apply.extra_rules.filter((r) => r.trim());
  return extra.length ? `${base}\n\n## 사용자가 추가한 규칙\n${extra.map((r) => `- ${r}`).join('\n')}` : base;
}

export async function applyNow(o: ApplyOptions): Promise<ApplyReport> {
  const log = o.log ?? console.log;
  const settings = loadSettings();
  if (settings.llm.backend !== 'claude-cli') throw new Error(`지원서 입력은 지금 claude-cli 연결만 지원합니다 (현재: ${settings.llm.backend}). 설정 → AI 연결에서 바꿔 주세요.`);
  if (settings.browser.driver === 'handoff') throw new Error('handoff 브라우저 설정에서는 자동 입력을 할 수 없습니다. 설정 → 브라우저에서 Aside 나 Chrome 을 골라 주세요.');

  // 내 정보
  const store = new ProfileStore(paths.profileMe, loadSchema(paths.profileSchema));
  const check = checkProfile(store.toJSON(), store.schema, store.filesDir);
  if (check.missing.length) log(`⚠️  내 정보에 비어 있는 필수 항목 ${check.missing.length}개 — 해당 칸은 비워 둡니다: ${check.missing.map((m) => m.where).join(', ')}`);
  const files = existsSync(store.filesDir) ? readdirSync(store.filesDir).filter((f) => !f.startsWith('.')) : [];
  const profileDoc = renderProfileForAgent(store.toJSON(), store.schema, { sections: ['basic', 'education', 'career', 'extras', 'target'] });

  // ① 준비
  const target = await resolveTarget(o.target, settings);
  log(`① ${target.company || '지원 페이지'} — ${target.link}`);
  const session = await BrowserSession.open(settings);
  const startedAt = new Date().toISOString();
  const dir = runDir(`apply-${(target.company || 'site').replace(/[^0-9A-Za-z가-힣]+/g, '_').slice(0, 30)}`);
  mkdirSync(dir, { recursive: true });
  const blanks: ApplyReport['blanks'] = [];
  const notes: string[] = [];
  const actions: ApplyReport['actions'] = [];
  let summary = '';
  let bridge: Awaited<ReturnType<typeof startBridge>> | null = null;
  try {
    await session.goto(target.link);
    await session.bringToFront();
    const targetId = await targetIdOf(session.context, session.page);

    // ② 로그인 대기 — 사람만 하는 일
    if (!o.skipLoginWait) {
      notify('Auto-Job 지원서', '브라우저에서 로그인/본인인증을 마치고 지원서 입력 화면으로 이동해 주세요');
      const a = await o.ask('② 브라우저에서 직접 해 주세요: 회원가입·로그인·본인인증·약관 동의 → 지원서의 인적사항 입력 화면까지 이동.\n   다 되면 Enter (그만두려면 q)');
      if (a.trim().toLowerCase() === 'q') throw new Error('사용자가 중단했습니다');
    }

    // ③ 인적사항 입력 — AI
    bridge = await startBridge({
      ask: async (q) => {
        notify('Auto-Job 지원서', '확인이 필요합니다 — 터미널을 봐 주세요');
        return o.ask(`❓ ${q}`);
      },
      event: (e) => {
        if (e.type === 'blank') {
          blanks.push({ field: e.field, reason: e.reason });
          log(`   ⬜ 비움: ${e.field} — ${e.reason}`);
        } else if (e.type === 'note') {
          notes.push(e.text);
          log(`   📝 ${e.text}`);
        } else if (e.type === 'action') {
          actions.push(e);
          log(`   ${TOOL_ICON[e.tool] ?? '•'} ${e.value ? `${e.value} — ` : ''}${e.message}`);
        } else if (e.type === 'finish') {
          summary = e.summary;
        }
      },
    });
    const mcpConfig = path.join(dir, 'mcp.json');
    writeFileSync(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          autojob: {
            // --mcp-config 서버는 기본적으로 뒤에서 연결되어 첫 턴에 도구가 없을 수 있다. alwaysLoad 는 연결을 기다린 뒤 시작한다.
            alwaysLoad: true,
            command: path.join(ROOT, 'node_modules', '.bin', 'tsx'),
            args: [path.join(ROOT, 'src', 'mcp', 'browser-server.ts')],
            env: { AUTOJOB_HOME: DATA_HOME, AUTOJOB_TARGET_ID: targetId, AUTOJOB_BRIDGE_URL: bridge.url, AUTOJOB_BRIDGE_TOKEN: bridge.token },
          },
        },
      }),
      { mode: 0o600 },
    );
    log('③ AI 가 인적사항을 입력합니다 (자기소개서 전까지, 제출 버튼은 막혀 있음)');
    const agent = await runClaudeAgent({
      prompt: buildPrompt(target, profileDoc, files),
      systemAppend: buildSystemPrompt(settings),
      mcpConfigPath: mcpConfig,
      mcpServer: 'autojob',
      model: settings.apply.model || undefined,
      cwd: dir,
      onEvent: (e) => {
        if (e.type === 'text') log(`   💭 ${e.text.replace(/\s+/g, ' ').slice(0, 200)}`);
      },
    });

    // 결과
    let screenshot: string | undefined = path.join(dir, 'screenshot.png');
    await session.screenshot(screenshot).catch(() => (screenshot = undefined));
    const report: ApplyReport = {
      company: target.company,
      link: target.link,
      notionUrl: target.notionUrl,
      startedAt,
      finishedAt: new Date().toISOString(),
      summary: summary || (agent.isError ? `AI 가 끝까지 마치지 못했습니다: ${agent.text}` : agent.text),
      completed: !!summary && !agent.isError,
      blanks,
      notes,
      actions,
      agent,
      dir,
      screenshot,
    };
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1));
    writeFileSync(path.join(dir, 'report.md'), formatApplyReport(report));
    notify('Auto-Job 지원서', report.completed ? '인적사항 입력을 마쳤습니다 — 검토해 주세요' : '입력을 끝까지 마치지 못했습니다 — 리포트를 확인해 주세요');
    return report;
  } finally {
    bridge?.server.close();
    await session.detach(); // 창은 사용자가 검토하도록 그대로 둔다
  }
}

export function formatApplyReport(r: ApplyReport): string {
  const filled = r.actions.filter((a) => a.ok && ['fill', 'select', 'check', 'upload'].includes(a.tool)).length;
  const refused = r.actions.filter((a) => !a.ok);
  const lines: (string | null)[] = [
    `# 지원서 인적사항 입력 — ${r.company || r.link}`,
    '',
    r.completed ? null : '> ⚠️ AI 가 입력을 끝까지 마치지 못했습니다. 아래 요약을 보고 빈 칸을 직접 확인해 주세요.',
    r.completed ? null : '',
    `- 지원 페이지: ${r.link}`,
    r.notionUrl ? `- Notion: ${r.notionUrl}` : null,
    `- 입력한 칸: ${filled}개`,
    r.agent.costUsd != null ? `- AI 사용량: $${r.agent.costUsd.toFixed(3)}` : null,
    r.screenshot ? `- 화면: ${r.screenshot}` : null,
    '',
    '## 요약',
    r.summary || '(없음)',
    '',
    `## 비워둔 Value 값 (${r.blanks.length})`,
    ...(r.blanks.length ? r.blanks.map((b) => `- ${b.field}: ${b.reason}`) : ['- 없음']),
    '',
    `## 참고사항 (${r.notes.length})`,
    ...(r.notes.length ? r.notes.map((n) => `- ${n}`) : ['- 없음']),
    ...(refused.length ? ['', `## 막히거나 건너뛴 동작 (${refused.length})`, ...refused.map((a) => `- ${a.tool}: ${a.message}`)] : []),
    '',
    '> 제출은 하지 않았습니다. 브라우저에서 내용을 확인한 뒤 직접 저장/제출해 주세요.',
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}
