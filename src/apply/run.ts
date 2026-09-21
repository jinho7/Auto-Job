// One application agent owns the conversation, browser, source reading and writing.
// 제출은 하지 않는다. 브라우저 창은 사용자가 검토하도록 그대로 둔다.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { lastImport } from '../browser/default-profile';
import { BrowserSession } from '../browser/session';
import { loadSettings, type Settings } from '../config';
import { parseLimit, checkEssay, blindTermsFromProfile } from '../essay/checks';
import { applicationToolset, type AgentTaskState } from './agent-tools';
import { formatEssays, type EssayResult } from '../essay/pipeline';
import type { CountUnit, EssayQuestion } from '../essay/types';
import { agentFor, modelFor } from '../llm';
import type { AgentResult } from '../llm/claude-cli';
import { NotionClient, propText } from '../notion/client';
import { notionToolset, type NotionProgress } from './notion-tools';
import { type PageContent, type SectionResult } from '../notion/page-fill';
import { notionClient } from '../notion/setup';
import { getSecret } from '../secrets';
import { paths, ROOT, runDir } from '../paths';
import { loadSchema } from '../profile/schema';
import { ProfileStore } from '../profile/store';
import { parseNotionId } from '../settings/store';
import { startBridge, type BridgeEvent } from './bridge';
import { conversationTools } from './conversation-tools';
import { renderProfileForAgent } from './profile-doc';
import { PlaywrightMcp } from './playwright-mcp';

export type ApplyTarget = { company: string; link: string; role?: string; notionPageId?: string; notionUrl?: string };
export type ApplyStep = 'basic' | 'essay';

export async function resolveTarget(input: string, settings: Settings): Promise<ApplyTarget> {
  const t = input.trim();
  if (/notion\.(so|site|com)/.test(t) || /^[0-9a-f]{32}$|^[0-9a-f-]{36}$/i.test(t)) {
    const id = parseNotionId(t);
    if (!id) throw new Error('Notion 주소에서 페이지 ID 를 찾지 못했습니다');
    const page = await notionClient().getPage(id);
    const f = settings.notion.fields;
    const link = propText(page.properties[f.link]);
    if (!link) throw new Error(`이 Notion 페이지에 "${f.link}" 값이 없습니다. 지원 링크를 먼저 넣어 주세요.`);
    return { company: propText(page.properties[f.company]), link, role: propText(page.properties[f.roles]), notionPageId: page.id, notionUrl: page.url };
  }
  if (/^https?:\/\//.test(t)) return { company: '', link: t };
  if (existsSync(t)) return { company: '', link: pathToFileURL(path.resolve(t)).href };
  throw new Error('Notion 페이지 주소, 지원 페이지 주소(https://…), 또는 HTML 파일 경로를 주세요');
}

export type EssayStepReport = {
  questions: EssayQuestion[];
  result?: EssayResult;
  filled: { id: number; ok: boolean; message: string }[];
  error?: string;
  file?: string;
};

export type ApplyReport = {
  company: string;
  link: string;
  notionUrl?: string;
  startedAt: string;
  finishedAt: string;
  steps: ApplyStep[];
  summary: string;
  blanks: { field: string; reason: string }[];
  blanksReviewed?: boolean;
  notes: string[];
  actions: Extract<BridgeEvent, { type: 'action' }>[];
  agent: { text: string; isError: boolean; costUsd?: number };
  outcome?: 'completed' | 'incomplete' | 'answered';
  remaining?: string[];
  /** 이번 사용자 요청의 완료 여부 (단순 AI 종료와 구별) */
  completed: boolean;
  essay?: EssayStepReport;
  /** 문항 찾기 단계에서 기록한 지원서 구성, 직무명 (Notion 정리에 씀) */
  formInfo?: { projects: string[]; documents: string[]; procedure: string[] } | null;
  role?: string;
  /** ⑤ 임시저장 */
  save?: { ok: boolean; label?: string; message: string; dialogs: string[] };
  /** ⑥ Notion 정리 */
  notion?: Partial<NotionProgress> & { sections?: SectionResult[]; status?: string };
  dir: string;
  screenshot?: string;
};

export type ApplyOptions = {
  target: string;
  /** 이미 입력 화면이면 로그인 대기를 건너뛴다 */
  skipLoginWait?: boolean;
  /** 할 단계 (기본: 인적사항과 자기소개서 모두) */
  steps?: ApplyStep[];
  ask: (question: string) => Promise<string>;
  log?: (m: string) => void;
  /** 알림 (기본: macOS 알림). 설정 화면에서는 대화방 빨간 점과 창 띄우기까지 */
  notify?: (title: string, message: string) => void;
  /** 지원서마다 새 창으로 연다 (여러 개를 함께 진행할 때). background 면 뒤에 연다 */
  window?: { newWindow: boolean; background?: boolean };
  /** 브라우저 세션이 열리면 (창 앞으로 가져오기용) */
  onSession?: (s: BrowserSession) => void | Promise<void>;
  onNotion?: (state: NotionProgress) => void;
  onRole?: (role: { title: string; reason: string }) => void;
  role?: { title: string; reason: string };
  /** 이미 열려 있는 지원서 창에 이어서 한다 (다시 열지 않고, 로그인 대기와 사전 조사도 건너뛴다) */
  session?: BrowserSession;
  /** 끝나도 브라우저 연결을 끊지 않는다 (대화방에서 이어서 고칠 수 있게) */
  keepSession?: boolean;
  /** 사용자가 대화방에서 적은 요청 (예: "3번 문항 더 구체적으로 다시 써 줘") */
  request?: string;
  context?: Record<string, unknown>;
  /** 중지 */
  signal?: AbortSignal;
};

const TOOL_ICON: Record<string, string> = { fill: '✏️ ', select: '🔽', check: '☑️ ', click: '👆', press: '⌨️ ', upload: '📎', dialog: '💬' };
const readPrompt = (name: string) => readFileSync(path.join(paths.prompts, name), 'utf8');

export function buildSystemPrompt(settings: Settings): string {
  const base = readPrompt('application-agent.md');
  const extra = settings.apply.extra_rules.filter((r) => r.trim());
  return extra.length ? `${base}\n\n## 사용자가 추가한 규칙\n${extra.map((r) => `- ${r}`).join('\n')}` : base;
}

/** AI 가 기록한 문항을 정리한다: 번호 매기기, 단위 확인, 문항 글에서 제한 보충 */
export function normalizeQuestions(raw: unknown[]): EssayQuestion[] {
  const units: CountUnit[] = ['chars', 'chars_no_space', 'bytes'];
  return raw
    .map((r) => r as Record<string, unknown>)
    .filter((r) => typeof r.question === 'string' && r.question.trim())
    .map((r, i) => {
      const fromText = parseLimit(String(r.question));
      const num = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.round(v) : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
      const maxChars = num(r.maxChars) ?? fromText.maxChars;
      const minChars = num(r.minChars) ?? fromText.minChars;
      return {
        id: i + 1,
        question: String(r.question).trim(),
        ...(['essay', 'notice', 'short_answer'].includes(String(r.kind)) ? { kind: r.kind as EssayQuestion['kind'] } : {}),
        unit: units.includes(r.unit as CountUnit) ? (r.unit as CountUnit) : fromText.unit,
        ...(maxChars ? { maxChars } : {}),
        ...(minChars ? { minChars } : {}),
        ...(typeof r.ref === 'string' && r.ref ? { ref: r.ref } : {}),
        ...(typeof r.note === 'string' && r.note.trim() ? { note: r.note.trim() } : {}),
      };
    });
}

/** 지원서 작성 결과 → Notion 페이지 섹션 내용 */
export function buildPageContent(x: {
  essay?: EssayStepReport;
  formInfo: { projects: string[]; documents: string[]; procedure: string[] } | null;
  role?: string;
  uploads: string[];
}): PageContent {
  const r = x.essay?.result?.research;
  const procedure = x.formInfo?.procedure.length ? x.formInfo.procedure : (r?.procedure ?? []);
  const unit = (q: EssayQuestion) => (q.unit === 'bytes' ? '바이트' : q.unit === 'chars_no_space' ? '자, 공백 제외' : '자');
  return {
    procedure,
    company: r ? { summary: r.company_summary, values: r.values, recent: r.recent, sources: r.sources } : undefined,
    role: x.role || r?.role ? { title: x.role, description: r?.role && r.role !== x.role ? r.role : undefined } : undefined,
    essays: x.essay?.result
      ? x.essay.questions.map((q) => ({
          question: q.question,
          answer: x.essay!.result!.answers.find((a) => a.id === q.id)?.text ?? '',
          limit: q.maxChars ? `최대 ${q.maxChars}${unit(q)}` : undefined,
        }))
      : undefined,
    projects: x.formInfo?.projects,
    documents: [...(x.formInfo?.documents ?? []), ...x.uploads.map((u) => `올린 파일: ${u}`)],
  };
}

/** 자동화 프로필에 평소 프로필의 비밀번호를 아직 안 가져왔으면 로그인 대기 때 알려 준다 */
export function loginHelp(settings: Settings, mark = lastImport): string {
  const driver = settings.browser.driver === 'chrome' ? 'chrome' : 'aside';
  const m = mark(settings, driver);
  if (!m) return '   💡 이 창은 자동화 전용 프로필이라 평소 쓰는 프로필의 저장된 비밀번호가 없습니다. 설정 → 브라우저 → "비밀번호 가져오기"를 한 번 하면 다음부터 로그인 칸이 자동 완성됩니다 (로그인 상태까지 가져오면 로그인 자체를 건너뛸 수 있습니다).';
  if (!m.cookies) return '   💡 저장된 비밀번호는 가져와 둔 프로필입니다. 로그인 칸을 누르면 자동 완성이 뜹니다.';
  return '   💡 평소 프로필의 로그인 상태까지 가져와 둔 프로필입니다. 이미 로그인되어 있으면 바로 지원서 화면으로 가면 됩니다.';
}

export async function applyNow(o: ApplyOptions): Promise<ApplyReport> {
  const check = () => o.signal?.throwIfAborted();
  check();
  const settings = loadSettings();
  if (settings.browser.driver === 'handoff') throw new Error('Aside 또는 Chrome을 연결해 주세요.');
  const log = o.log ?? console.log;
  const store = new ProfileStore(paths.profileMe, loadSchema(paths.profileSchema));
  const profile = store.toJSON();
  const target = await resolveTarget(o.target, settings);
  if (o.role) target.role = o.role.title;
  const session = o.session ?? await BrowserSession.open(settings, { ...o.window, url: target.link });
  await o.onSession?.(session);
  check();
  const steps = o.steps?.length ? o.steps : ['basic', 'essay'] as ApplyStep[];
  const startedAt = new Date().toISOString();
  mkdirSync(paths.runs, { recursive: true });
  const dir = mkdtempSync(runDir(`apply-${(target.company || 'site').replace(/[^0-9A-Za-z가-힣]+/g, '_').slice(0, 30)}`) + '-');
  const aiDir = mkdtempSync(path.join(dir, '.agent-'));
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  let browser: PlaywrightMcp | undefined;
  const blanks: ApplyReport['blanks'] = [], notes: string[] = [], actions: ApplyReport['actions'] = [];
  let formInfo: ApplyReport['formInfo'];
  const state: AgentTaskState = { questions: [], answers: [], filled: [] };
  let agent: AgentResult = { text: '', isError: false };
  try {
    if (!o.session) await session.goto(target.link);
    check();
    const ref = await session.reference();
    browser = await PlaywrightMcp.connect(settings, ref.cdpPort, ref.targetId, store.filesDir, path.join(aiDir, 'browser'), o.signal);
    const handlers = {
      ask: async (question: string) => { check(); return o.ask(question); },
      event: async (e: BridgeEvent) => {
        check();
        if (e.type === 'blank') { blanks.push({ field: e.field, reason: e.reason }); log(`⬜ ${e.field} — ${e.reason}`); }
        if (e.type === 'note') { notes.push(e.text); log(`📝 ${e.text}`); }
        if (e.type === 'action') { actions.push(e); log(`${TOOL_ICON[e.tool] ?? '•'} ${e.message}`); }
        if (e.type === 'form_info') formInfo = { projects: e.projects, documents: e.documents, procedure: e.procedure };
      },
    };
    const token = target.notionPageId ? getSecret('NOTION_TOKEN') : undefined;
    state.notion = { available: !!(target.notionPageId && token), pageUrl: target.notionUrl, verified: false,
      ...(!target.notionPageId ? { error: '이 작업에 연결된 Notion 공고 페이지가 없습니다' } : !token ? { error: 'Notion 연결 토큰이 없습니다' } : {}) };
    const notion = target.notionPageId && token ? notionToolset({ client: new NotionClient(token, fetch, o.signal), pageId: target.notionPageId, pageUrl: target.notionUrl, state: state.notion, settings, signal: o.signal, onChange: o.onNotion }) : undefined;
    const tools = applicationToolset({ notion, notionRequired: settings.apply.update_notion && !!target.notionPageId, browser: conversationTools(browser, handlers), tools: browser, settings, profile, state, signal: o.signal, request: o.request ?? '', onRole: o.onRole,
      context: { ...o.context, target, role: o.role, original_scope: steps, latest_request: o.request || `이 지원서의 ${steps.includes('basic') && steps.includes('essay') ? '기본정보와 자기소개서' : steps.includes('essay') ? '자기소개서' : '기본정보'}를 작성해 주세요.`,
        profile: renderProfileForAgent(profile, store.schema), files: existsSync(store.filesDir) ? readdirSync(store.filesDir).filter(f => !f.startsWith('.')).map(f => path.join(store.filesDir, f)) : [] } });
    bridge = await startBridge({ ...handlers, tools, signal: o.signal });
    log('AI가 대화와 자료, 실제 화면을 확인해 작업합니다');
    try {
      agent = await agentFor(settings)({
        prompt: 'context를 읽고 최신 사용자 요청을 수행하세요. 화면과 자료를 확인하고 스스로 필요한 도구를 사용하세요.',
        systemAppend: buildSystemPrompt(settings), tools: ['WebSearch', 'WebFetch'], isolated: true,
        mcp: { server: 'autojob', command: process.execPath, args: [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'src/mcp/browser-server.ts')], env: { AUTOJOB_BRIDGE_URL: bridge.url, AUTOJOB_BRIDGE_TOKEN: bridge.token } },
        model: modelFor(settings, settings.apply.model), effort: settings.apply.effort || undefined,
        cwd: aiDir, signal: o.signal,
        onEvent: e => { if (e.type === 'text') log(`💭 ${e.text}`); if (e.type === 'tool') log(`도구: ${e.name}`); if (e.type === 'switch') log(`AI 연결 변경: ${e.from} — ${e.reason}`); },
      });
    } catch (e) { check(); agent = { text: (e as Error).message, isError: true }; }
    check();
    const completed = !agent.isError && state.finish?.status === 'completed';
    const outcome = agent.isError ? 'incomplete' : state.finish?.status ?? 'incomplete';
    const summary = state.finish?.summary || agent.text || '결과를 확인하지 못했습니다';
    const remaining = state.finish?.remaining ?? (agent.isError ? [agent.text] : ['AI가 완료 상태를 기록하지 않았습니다']);
    const essay: EssayStepReport | undefined = state.questions.length ? { questions: state.questions, filled: state.filled,
      result: { research: state.research, answers: state.answers, strategy: [], checks: state.questions.map(q => checkEssay(q, state.answers.find(a => a.id === q.id) ?? { id: q.id, text: '' }, settings.essay, blindTermsFromProfile(profile))), costUsd: 0, input: { company: target.company, role: state.role?.title || target.role || '', questions: state.questions }, reviews: [], rounds: 0, reviewedBeforeLastRevision: false, ok: state.filled.every(f => f.ok) } } : undefined;
    const report: ApplyReport = { company: target.company, link: target.link, notionUrl: target.notionUrl, startedAt, finishedAt: new Date().toISOString(), steps,
      summary, blanks: state.blanks ?? blanks, blanksReviewed: state.blanks !== undefined, notes: [...notes, ...remaining], actions, agent, completed, outcome, remaining, essay, formInfo, role: state.role?.title || o.role?.title || target.role, save: state.save, notion: state.notion, dir };
    if (essay?.result?.answers.length) { essay.file = path.join(dir, 'essays.md'); writeFileSync(essay.file, formatEssays(essay.result), { mode: 0o600 }); }
    if (outcome !== 'answered') {
      report.screenshot = path.join(dir, 'screenshot.png');
      await browser.screenshot().then(data => writeFileSync(report.screenshot!, data, { mode: 0o600 })).catch(() => { report.screenshot = undefined; });
      check();
    }
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1), { mode: 0o600 });
    writeFileSync(path.join(dir, 'report.md'), formatApplyReport(report), { mode: 0o600 });
    return report;
  } finally {
    await bridge?.close(); await browser?.close(); rmSync(aiDir, { recursive: true, force: true });
    if (!o.keepSession) await session.detach();
  }
}

export function formatApplyReport(r: ApplyReport): string {
  if (r.outcome === 'answered') return `# 대화 답변 — ${r.company || r.link}\n\n${r.summary}`;
  const filled = r.actions.filter((a) => a.ok && ['fill', 'select', 'check', 'upload', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_file_upload'].includes(a.tool)).length;
  const refused = r.actions.filter((a) => !a.ok);
  const e = r.essay;
  const essays = e?.questions.filter(q => !q.kind || q.kind === 'essay') ?? [];
  const otherFields = e?.questions.filter(q => q.kind && q.kind !== 'essay') ?? [];
  const filledCount = (qs: EssayQuestion[]) => qs.filter(q => e?.filled.some(f => f.id === q.id && f.ok)).length;
  const lines: (string | null)[] = [
    `# 지원서 작성 — ${r.company || r.link}`,
    '',
    r.completed ? null : '> ⚠️ 요청한 작업이 미완료입니다. 아래 남은 일과 저장 상태를 확인해 주세요.',
    r.completed ? null : '',
    `- 지원 페이지: ${r.link}`,
    ...(r.remaining?.length ? r.remaining.map(x => `- 남은 일: ${x}`) : []),
    r.notionUrl ? `- Notion: ${r.notionUrl}` : null,
    r.steps.includes('basic') ? `- 브라우저 입력 작업: ${filled}회 (여러 칸 일괄 입력 포함)` : null,
    e ? `- 자기소개서: ${e.error ? `실패 — ${e.error}` : essays.length ? `${filledCount(essays)}/${essays.length}문항 입력` : '기록된 실제 자소서 문항 없음'}` : null,
    otherFields.length ? `- 안내 확인·단답형: ${filledCount(otherFields)}/${otherFields.length}항목 입력` : null,
    r.agent.costUsd || e?.result?.costUsd ? `- AI 사용량: $${((r.agent.costUsd ?? 0) + (e?.result?.costUsd ?? 0)).toFixed(3)}` : null,
    e?.file ? `- 문항·입력 내용: ${e.file}` : null,
    r.save ? `- 임시저장: ${r.save.ok ? `저장 성공 확인 — ${r.save.message}` : r.save.message}${r.save.dialogs.length ? ` — 알림: ${r.save.dialogs.join(' / ')}` : ''}` : null,
    r.notion ? `- Notion: ${r.notion.verified ? `반영 확인 — ${r.notion.summary ?? ''}` : r.notion.error ?? '정리 완료 미확인'}` : null,
    r.screenshot ? `- 화면: ${r.screenshot}` : null,
    '', '## 작업 요약', r.summary || '(없음)',
    '',
    `## 미입력 항목${r.blanks.length || r.blanksReviewed ? ` (${r.blanks.length})` : ''}`,
    ...(r.blanks.length ? r.blanks.map((b) => `- ${b.field}: ${b.reason}`) : [r.blanksReviewed ? '- 확인된 미입력 항목 없음' : '- 미입력 항목 목록이 기록되지 않았습니다. 작업 요약과 남은 일을 확인해 주세요.']),
    '',
    `## 참고사항 (${r.notes.length})`,
    ...(r.notes.length ? r.notes.map((n) => `- ${n}`) : ['- 없음']),
    ...(e && e.questions.length
      ? [
          '',
          '## 문항별 입력 결과',
          ...e.questions.map((q) => {
            const c = e.result?.checks.find((x) => x.id === q.id);
            const f = e.filled.find((x) => x.id === q.id);
            const problems = [...(c?.issues ?? []).map((i) => `❌ ${i}`), ...(c?.warnings ?? []).map((w) => `⚠️ ${w}`)];
            return `- ${q.id}. ${q.kind === 'notice' ? '[안내 확인] ' : q.kind === 'short_answer' ? '[단답형] ' : ''}${q.question.slice(0, 60)}${q.question.length > 60 ? '…' : ''} — ${f ? f.message : '입력 안 함'}${problems.length ? `\n  ${problems.join('\n  ')}` : ''}`;
          }),
        ]
      : []),
    ...(refused.length ? ['', `## 막히거나 건너뛴 동작 (${refused.length})`, ...refused.map((a) => `- ${a.tool}: ${a.message}`)] : []),
    '',
    r.save?.ok ? '> 임시저장 성공을 확인했습니다. 브라우저에서 내용을 검토한 뒤 최종 제출은 직접 해 주세요.' : '> 최종 제출은 하지 않았습니다. 저장 상태와 남은 일을 확인해 주세요.',
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}
