// autojob apply: ① 준비 → ② 로그인 대기(사람) → ③ 인적사항 입력(AI) → ④ 자기소개서(문항 찾기 → 작성 → 입력) → 리포트
// 제출은 하지 않는다. 브라우저 창은 사용자가 검토하도록 그대로 둔다.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserSession } from '../browser/session';
import { loadSettings, type Settings } from '../config';
import { parseLimit } from '../essay/checks';
import { formatEssays, writeEssays, type EssayResult } from '../essay/pipeline';
import type { CountUnit, EssayQuestion } from '../essay/types';
import { agentFor, modelFor } from '../llm';
import type { AgentResult } from '../llm/claude-cli';
import { propText } from '../notion/client';
import { fillPageSections, setSubmitStatus, type PageContent, type SectionResult } from '../notion/page-fill';
import { notionClient } from '../notion/setup';
import { getSecret } from '../secrets';
import { notify as notifyMac } from '../notify';
import { DATA_HOME, paths, ROOT, runDir } from '../paths';
import { checkProfile } from '../profile/check';
import { loadSchema } from '../profile/schema';
import { ProfileStore } from '../profile/store';
import { parseNotionId } from '../settings/store';
import { startBridge, type BridgeEvent } from './bridge';
import { renderProfileForAgent } from './profile-doc';
import { ApplyTools, targetIdOf } from './tools';

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
  notes: string[];
  actions: Extract<BridgeEvent, { type: 'action' }>[];
  agent: { text: string; isError: boolean; costUsd?: number };
  /** 인적사항 AI 가 finish 까지 마쳤는지 (인적사항 단계를 건너뛰었으면 true) */
  completed: boolean;
  essay?: EssayStepReport;
  /** 문항 찾기 단계에서 기록한 지원서 구성, 직무명 (Notion 정리에 씀) */
  formInfo?: { projects: string[]; documents: string[]; procedure: string[] } | null;
  role?: string;
  /** ⑤ 임시저장 */
  save?: { ok: boolean; label?: string; message: string; dialogs: string[] };
  /** ⑥ Notion 정리 */
  notion?: { sections: SectionResult[]; status?: string; error?: string };
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
  onSession?: (s: BrowserSession) => void;
  /** 중지 */
  signal?: AbortSignal;
};

const TOOL_ICON: Record<string, string> = { fill: '✏️ ', select: '🔽', check: '☑️ ', click: '👆', press: '⌨️ ', upload: '📎', dialog: '💬' };
const readPrompt = (name: string) => readFileSync(path.join(paths.prompts, name), 'utf8');

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
  const base = readPrompt('fill-basic-info.md');
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

export async function applyNow(o: ApplyOptions): Promise<ApplyReport> {
  const log = o.log ?? console.log;
  const notify = o.notify ?? notifyMac;
  const steps: ApplyStep[] = o.steps?.length ? o.steps : ['basic', 'essay'];
  const settings = loadSettings();
  if (settings.browser.driver === 'handoff') throw new Error('handoff 브라우저 설정에서는 자동 입력을 할 수 없습니다. 설정 → 브라우저에서 Aside 나 Chrome 을 골라 주세요.');
  const driver = settings.browser.driver;

  // 내 정보
  const store = new ProfileStore(paths.profileMe, loadSchema(paths.profileSchema));
  const check = checkProfile(store.toJSON(), store.schema, store.filesDir);
  if (check.missing.length) log(`⚠️  내 정보에 비어 있는 필수 항목 ${check.missing.length}개 — 해당 칸은 비워 둡니다: ${check.missing.map((m) => m.where).join(', ')}`);
  const files = existsSync(store.filesDir) ? readdirSync(store.filesDir).filter((f) => !f.startsWith('.')) : [];
  const profileDoc = renderProfileForAgent(store.toJSON(), store.schema, { sections: ['basic', 'education', 'career', 'extras', 'target', 'notes'] });

  // ① 준비
  const target = await resolveTarget(o.target, settings);
  log(`① ${target.company || '지원 페이지'} — ${target.link}`);
  const session = await BrowserSession.open(settings, o.window);
  o.onSession?.(session);
  const startedAt = new Date().toISOString();
  const dir = runDir(`apply-${(target.company || 'site').replace(/[^0-9A-Za-z가-힣]+/g, '_').slice(0, 30)}`);
  mkdirSync(dir, { recursive: true });
  const blanks: ApplyReport['blanks'] = [];
  const notes: string[] = [];
  const actions: ApplyReport['actions'] = [];
  let summary = '';
  let found: { role: string; questions: unknown[] } | null = null;
  let formInfo: { projects: string[]; documents: string[]; procedure: string[] } | null = null;
  let bridge: Awaited<ReturnType<typeof startBridge>> | null = null;
  let agent: AgentResult = { text: '', isError: false, costUsd: 0 };
  let essay: EssayStepReport | undefined;
  try {
    await session.goto(target.link);
    await session.bringToFront();
    const targetId = await targetIdOf(session.context, session.page);

    // ② 로그인 대기 — 사람만 하는 일
    if (!o.skipLoginWait) {
      notify('Auto-Job 지원서', '브라우저에서 로그인/본인인증을 마치고 지원서 입력 화면으로 이동해 주세요');
      const a = await o.ask('② 브라우저 창에서 직접 해 주세요: 회원가입·로그인·본인인증·약관 동의 → 지원서의 인적사항 입력 화면까지 이동.\n   다 되면 알려 주세요 (터미널은 Enter, 대화창은 아무 말이나 / 그만두려면 q 또는 "중지")');
      if (/^(q|중지|그만|취소)$/i.test(a.trim())) throw new Error('사용자가 중단했습니다');
    }

    bridge = await startBridge({
      ask: async (q) => {
        notify('Auto-Job 지원서', `확인이 필요합니다 — ${q.slice(0, 60)}`);
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
          log(`   ${TOOL_ICON[e.tool] ?? '•'} ${e.value ? `${e.value.slice(0, 40)} — ` : ''}${e.message}`);
        } else if (e.type === 'finish') {
          summary ||= e.summary;
        } else if (e.type === 'questions') {
          found = { role: e.role, questions: e.questions };
        } else if (e.type === 'form_info') {
          formInfo = { projects: e.projects, documents: e.documents, procedure: e.procedure };
        }
      },
    });
    const runAgent = agentFor(settings);
    const bridgeEnv = { AUTOJOB_BRIDGE_URL: bridge.url, AUTOJOB_BRIDGE_TOKEN: bridge.token };
    const browserAgent = (prompt: string, system: string) =>
      runAgent({
        prompt,
        systemAppend: system,
        mcp: {
          server: 'autojob',
          command: path.join(ROOT, 'node_modules', '.bin', 'tsx'),
          args: [path.join(ROOT, 'src', 'mcp', 'browser-server.ts')],
          env: { AUTOJOB_HOME: DATA_HOME, AUTOJOB_TARGET_ID: targetId, ...bridgeEnv },
        },
        model: modelFor(settings, settings.apply.model),
        effort: settings.apply.effort || undefined,
        cwd: dir,
        signal: o.signal,
        onEvent: (e) => {
          if (e.type === 'text') log(`   💭 ${e.text.replace(/\s+/g, ' ').slice(0, 200)}`);
          if (e.type === 'switch') log(`   🔁 ${e.from}: ${e.reason} → 다음 AI 연결로 이어서 합니다 (이미 넣은 칸은 그대로 둡니다)`);
        },
      });

    // ③ 인적사항 입력 — AI
    if (steps.includes('basic')) {
      log('③ AI 가 인적사항을 입력합니다 (자기소개서 전까지, 제출 버튼은 막혀 있음)');
      agent = await browserAgent(buildPrompt(target, profileDoc, files), buildSystemPrompt(settings));
    }

    // ④ 자기소개서 — 문항 찾기(AI+브라우저) → 작성(AI+웹) → 입력(코드)
    if (steps.includes('essay') && !agent.isError) {
      essay = { questions: [], filled: [] };
      try {
        log('④ 자기소개서 문항을 찾습니다');
        const ex = await browserAgent(
          `지원 회사: ${target.company || '(모름)'}\n지원 페이지: ${target.link}\n\n이 지원서의 자기소개서 문항을 찾아 set_questions 로 기록하고 finish 하세요. 아무것도 입력하지 마세요.`,
          readPrompt('essay-extract.md'),
        );
        agent.costUsd = (agent.costUsd ?? 0) + (ex.costUsd ?? 0);
        const got = found as { role: string; questions: unknown[] } | null;
        essay.questions = normalizeQuestions(got?.questions ?? []);
        if (!essay.questions.length) throw new Error(ex.isError ? ex.text : '자기소개서 문항을 찾지 못했습니다');
        log(`   문항 ${essay.questions.length}개: ${essay.questions.map((q) => `${q.id}번${q.maxChars ? `(${q.maxChars}자)` : ''}`).join(', ')}`);

        essay.result = await writeEssays(
          { company: target.company, role: got?.role || target.role || '', postingUrl: target.link, questions: essay.questions },
          { settings, profile: store.toJSON(), schema: store.schema, cwd: dir, log, signal: o.signal },
        );
        essay.file = path.join(dir, 'essays.md');
        writeFileSync(essay.file, formatEssays(essay.result));

        log('   ⌨️  답변을 입력합니다');
        const tools = await ApplyTools.connect(settings, settings.browser[driver].cdp_port, targetId, store.filesDir);
        try {
          for (const q of essay.questions) {
            const text = essay.result.answers.find((a) => a.id === q.id)?.text.trim() ?? '';
            if (!q.ref || !text) {
              essay.filled.push({ id: q.id, ok: false, message: !q.ref ? '입력칸을 찾지 못함' : '답변 없음' });
              continue;
            }
            const msg = await tools.fill(q.ref, text).catch((e) => `실패: ${(e as Error).message}`);
            const now = await tools.valueOf(q.ref).catch(() => '');
            const ok = now.trim() === text;
            essay.filled.push({ id: q.id, ok, message: ok ? `입력함 (${[...now].length}자)` : now.trim() ? `${msg}${now.trim() !== text ? ' — 들어간 글이 답변과 다릅니다 (사이트가 자르거나 이미 값이 있었음)' : ''}` : msg });
            log(`   ${ok ? '✅' : '⚠️ '} ${q.id}번 ${essay.filled.at(-1)!.message}`);
          }
        } finally {
          await tools.close();
        }
      } catch (e) {
        essay.error = (e as Error).message;
        log(`   ❌ 자기소개서: ${essay.error}`);
      }
    }

    // ⑤ 임시저장 — 코드 (설정의 저장 버튼 문구만, 제출 가드 적용)
    let save: ApplyReport['save'];
    if (settings.apply.save_draft && !agent.isError) {
      log('⑤ 임시저장');
      const tools = await ApplyTools.connect(settings, settings.browser[driver].cdp_port, targetId, store.filesDir);
      try {
        save = await tools.saveDraft(settings.apply.save_buttons);
      } catch (e) {
        save = { ok: false, message: (e as Error).message, dialogs: [] };
      } finally {
        await tools.close();
      }
      log(`   ${save.ok ? '💾' : '⚠️ '} ${save.message}${save.dialogs.length ? ` / 알림: ${save.dialogs.join(' / ')}` : ''}`);
    }

    // 결과 화면을 앞으로
    await session.show();
    let screenshot: string | undefined = path.join(dir, 'screenshot.png');
    await session.screenshot(screenshot).catch(() => (screenshot = undefined));

    // ⑥ Notion 정리 — 본문 섹션 채우기, 제출 상태 변경
    let notionReport: ApplyReport['notion'];
    if (settings.apply.update_notion && target.notionPageId && getSecret('NOTION_TOKEN')) {
      log('⑥ Notion 페이지 정리');
      notionReport = { sections: [] };
      try {
        const client = notionClient();
        const content = buildPageContent({ essay, formInfo: formInfo as typeof formInfo, role: (found as { role: string } | null)?.role || target.role, uploads: actions.filter((a) => a.tool === 'upload' && a.ok).map((a) => a.value ?? '') });
        notionReport.sections = await fillPageSections(client, target.notionPageId, content, settings.notion.section_map);
        for (const r of notionReport.sections) if (r.status !== 'no_data') log(`   ${r.status === 'skipped_has_content' ? '⏭️  이미 내용이 있어 둠' : '📝 채움'}: ${r.title}`);
        if (essay?.error || (steps.includes('basic') && agent.isError)) {
          notionReport.status = '끝까지 마치지 못해 제출 상태는 바꾸지 않았습니다';
        } else {
          notionReport.status = await setSubmitStatus(client, target.notionPageId, settings);
        }
        log(`   ${notionReport.status}`);
      } catch (e) {
        notionReport.error = (e as Error).message;
        log(`   ❌ Notion: ${notionReport.error}`);
      }
    }
    const report: ApplyReport = {
      company: target.company,
      link: target.link,
      notionUrl: target.notionUrl,
      startedAt,
      finishedAt: new Date().toISOString(),
      steps,
      summary: summary || (agent.isError ? `AI 가 끝까지 마치지 못했습니다: ${agent.text}` : agent.text),
      blanks,
      notes,
      actions,
      agent,
      completed: steps.includes('basic') ? !!summary && !agent.isError : true,
      essay,
      formInfo: formInfo as typeof formInfo,
      role: (found as { role: string } | null)?.role || target.role,
      save,
      notion: notionReport,
      dir,
      screenshot,
    };
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1));
    writeFileSync(path.join(dir, 'report.md'), formatApplyReport(report));
    const essayOk = !essay || (!essay.error && essay.filled.every((f) => f.ok));
    notify('Auto-Job 지원서', report.completed && essayOk ? '지원서 작성을 마쳤습니다 — 검토해 주세요' : '끝까지 마치지 못한 부분이 있습니다 — 리포트를 확인해 주세요');
    return report;
  } finally {
    bridge?.server.close();
    await session.detach(); // 창은 사용자가 검토하도록 그대로 둔다
  }
}

export function formatApplyReport(r: ApplyReport): string {
  const filled = r.actions.filter((a) => a.ok && ['fill', 'select', 'check', 'upload'].includes(a.tool)).length;
  const refused = r.actions.filter((a) => !a.ok);
  const e = r.essay;
  const lines: (string | null)[] = [
    `# 지원서 작성 — ${r.company || r.link}`,
    '',
    r.completed ? null : '> ⚠️ AI 가 인적사항 입력을 끝까지 마치지 못했습니다. 아래 요약을 보고 빈 칸을 직접 확인해 주세요.',
    r.completed ? null : '',
    `- 지원 페이지: ${r.link}`,
    r.notionUrl ? `- Notion: ${r.notionUrl}` : null,
    r.steps.includes('basic') ? `- 인적사항 입력한 칸: ${filled}개` : null,
    e ? `- 자기소개서: ${e.error ? `실패 — ${e.error}` : `${e.filled.filter((f) => f.ok).length}/${e.questions.length}문항 입력`}` : null,
    r.agent.costUsd || e?.result?.costUsd ? `- AI 사용량: $${((r.agent.costUsd ?? 0) + (e?.result?.costUsd ?? 0)).toFixed(3)}` : null,
    e?.file ? `- 자기소개서 전문: ${e.file}` : null,
    r.save ? `- 임시저장: ${r.save.ok ? `눌렀습니다 ("${r.save.label}")` : r.save.message}${r.save.dialogs.length ? ` — 알림: ${r.save.dialogs.join(' / ')}` : ''}` : null,
    r.notion ? `- Notion: ${r.notion.error ? `실패 — ${r.notion.error}` : `${r.notion.sections.filter((x) => x.status === 'filled' || x.status === 'added_heading').map((x) => x.title).join(', ') || '채운 섹션 없음'}${r.notion.sections.some((x) => x.status === 'skipped_has_content') ? ` (이미 내용이 있어 둔 섹션: ${r.notion.sections.filter((x) => x.status === 'skipped_has_content').map((x) => x.title).join(', ')})` : ''} · ${r.notion.status ?? ''}`}` : null,
    r.screenshot ? `- 화면: ${r.screenshot}` : null,
    ...(r.steps.includes('basic') ? ['', '## 인적사항 요약', r.summary || '(없음)'] : []),
    '',
    `## 비워둔 Value 값 (${r.blanks.length})`,
    ...(r.blanks.length ? r.blanks.map((b) => `- ${b.field}: ${b.reason}`) : ['- 없음']),
    '',
    `## 참고사항 (${r.notes.length})`,
    ...(r.notes.length ? r.notes.map((n) => `- ${n}`) : ['- 없음']),
    ...(e && e.questions.length
      ? [
          '',
          '## 자기소개서',
          ...e.questions.map((q) => {
            const c = e.result?.checks.find((x) => x.id === q.id);
            const f = e.filled.find((x) => x.id === q.id);
            const problems = [...(c?.issues ?? []).map((i) => `❌ ${i}`), ...(c?.warnings ?? []).map((w) => `⚠️ ${w}`)];
            return `- ${q.id}. ${q.question.slice(0, 60)}${q.question.length > 60 ? '…' : ''} — ${f ? f.message : '입력 안 함'}${problems.length ? `\n  ${problems.join('\n  ')}` : ''}`;
          }),
        ]
      : []),
    ...(refused.length ? ['', `## 막히거나 건너뛴 동작 (${refused.length})`, ...refused.map((a) => `- ${a.tool}: ${a.message}`)] : []),
    '',
    '> 제출은 하지 않았습니다. 브라우저에서 내용을 확인한 뒤 직접 저장/제출해 주세요.',
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}
