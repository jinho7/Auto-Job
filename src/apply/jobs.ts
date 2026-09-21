// One queue and one revocable execution per company. Every message goes to the real AI.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserSession, MissingApplicationTab, type SessionRef } from '../browser/session';
import { loadSettings } from '../config';
import { applyNow, formatApplyReport, type ApplyOptions, type ApplyReport, type ApplyStep } from './run';
import type { AsideHandoff } from './aside-handoff';

export type JobStatus = 'queued' | 'running' | 'waiting' | 'done' | 'error' | 'stopped' | 'idle';
export type JobMsgKind = 'ai' | 'log' | 'ask' | 'you' | 'system' | 'done' | 'error';
export type JobMsg = { seq: number; job: string; at: string; kind: JobMsgKind; text: string };
export type Job = {
  id: string; target: string; title: string; status: JobStatus; activity: string; waiting: string | null;
  steps: ApplyStep[]; createdAt: string; finishedAt?: string; reportDir?: string; messages: JobMsg[];
  revision: number; stage?: ApplyStep; sessionRef?: SessionRef;
  role?: { title: string; reason: string }; roleExplicit?: boolean;
  summary?: string; blanks?: ApplyReport['blanks'];
  reportContext?: Record<string, unknown>;
  executionMode?: 'autojob' | 'aside';
  asideHandoff?: AsideHandoff;
};
export type JobDeps = {
  run?: (o: ApplyOptions) => Promise<ApplyReport>;
  maxParallel: () => number;
  notify?: (title: string, message: string) => void;
  bringToFront?: (s: BrowserSession) => Promise<void>;
  storageFile?: string;
  restoreSession?: (ref: SessionRef) => Promise<BrowserSession>;
};
export const MAX_JOBS_PER_START = 8;
const ACTIVE: JobStatus[] = ['queued', 'running', 'waiting'];
class UserInputRequired extends Error {}
type Turn = { revision: number; message?: string };

export function toMessage(line: string): { kind: JobMsgKind; text: string } {
  const t = line.replace(/^\s+/, '');
  return t.startsWith('💭') ? { kind: 'ai', text: t.replace(/^💭\s*/, '') } : { kind: 'log', text: t };
}

export class ApplyJobManager {
  private seq = 0;
  readonly jobs = new Map<string, Job>();
  private readonly pending = new Map<string, Turn>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly executions = new Map<string, { ctl: AbortController; done?: Promise<void> }>();
  private readonly handoffs = new Set<string>();

  constructor(private readonly deps: JobDeps) {
    if (!deps.storageFile || !existsSync(deps.storageFile)) return;
    const saved = JSON.parse(readFileSync(deps.storageFile, 'utf8')) as { version: number; seq: number; jobs: Job[] };
    if (saved.version !== 1 || !Array.isArray(saved.jobs)) throw new Error('대화 기록 형식을 확인하세요');
    this.seq = saved.seq;
    for (const job of saved.jobs) {
      this.jobs.set(job.id, job);
      job.revision++;
      if (ACTIVE.includes(job.status)) {
        job.status = 'stopped';
        job.activity = '앱이 재시작되었습니다. 대화에서 이어가기를 요청하세요.';
      }
    }
    this.persist();
  }

  private persist(): void {
    const file = this.deps.storageFile;
    if (!file) return;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, seq: this.seq, jobs: [...this.jobs.values()] }), { mode: 0o600 });
    renameSync(tmp, file);
  }

  private push(job: Job, kind: JobMsgKind, text: string): void {
    job.messages.push({ seq: ++this.seq, job: job.id, at: new Date().toISOString(), kind, text });
    if (job.messages.length > 2000) job.messages.splice(0, job.messages.length - 2000);
    this.persist();
  }

  start(targets: { target: string; title?: string }[], steps: ApplyStep[] = ['basic', 'essay'], mode: 'autojob' | 'aside' = 'autojob'): Job[] {
    if (mode !== 'autojob' && mode !== 'aside') throw new Error('작업 방식을 확인하세요');
    if (!targets.length) throw new Error('지원할 공고를 골라 주세요');
    if (targets.length > MAX_JOBS_PER_START) throw new Error(`한 번에 ${MAX_JOBS_PER_START}개까지 고를 수 있습니다`);
    if (!steps.length || steps.some(s => s !== 'basic' && s !== 'essay')) throw new Error('작성 단계를 확인하세요');
    const created = targets.map(t => {
      const existing = [...this.jobs.values()].find(j => j.target === t.target);
      if (existing) return existing;
      const job: Job = { id: randomUUID(), target: t.target, title: t.title || t.target, status: 'queued', activity: '차례를 기다리는 중', waiting: null,
        steps, createdAt: new Date().toISOString(), messages: [], revision: 1, executionMode: mode };
      if (mode === 'aside') { job.status = 'idle'; job.activity = 'Aside용 자료를 준비해 우측 패널에 붙여넣으세요'; }
      this.jobs.set(job.id, job);
      this.push(job, 'system', mode === 'aside' ? `${job.title}: Aside 패널에서 직접 작업하도록 선택했습니다. Auto-Job은 자동 실행하지 않습니다.` : `${job.title} 지원서를 맡았습니다.`);
      if (mode === 'autojob') this.pending.set(job.id, { revision: job.revision });
      return job;
    });
    this.pump();
    return created;
  }

  private pump(): void {
    for (const [id, turn] of this.pending) {
      if (this.executions.size >= Math.max(1, Math.min(8, this.deps.maxParallel()))) break;
      if (this.executions.has(id)) continue;
      this.pending.delete(id);
      const execution = { ctl: new AbortController(), done: undefined as Promise<void> | undefined };
      this.executions.set(id, execution);
      execution.done = this.execute(this.jobs.get(id)!, turn, execution.ctl).finally(() => {
        this.executions.delete(id);
        this.pump();
      });
    }
  }

  private async session(job: Job, reopenMissing = false): Promise<BrowserSession | undefined> {
    const existing = this.sessions.get(job.id);
    if (existing?.connected) return existing;
    if (!job.sessionRef) return undefined;
    if ([...this.jobs.values()].some(j => j.id !== job.id && j.sessionRef?.targetId === job.sessionRef!.targetId && j.sessionRef?.cdpPort === job.sessionRef!.cdpPort))
      throw new Error('다른 작업에서 사용 중인 탭입니다');
    try {
      const restored = await (this.deps.restoreSession ?? (ref => BrowserSession.attach(loadSettings(), ref)))(job.sessionRef);
      const ref = await restored.reference();
      if ([...this.jobs.values()].some(j => j.id !== job.id && j.sessionRef?.targetId === ref.targetId && j.sessionRef?.cdpPort === ref.cdpPort)) {
        await restored.detach(); throw new Error('복구된 탭을 다른 작업에서 사용 중입니다');
      }
      if (ref.targetId !== job.sessionRef.targetId) this.push(job, 'system', '브라우저를 다시 켜고 이 작업의 탭을 복구했습니다. 저장되지 않은 값은 남아 있지 않을 수 있어 실제 화면을 다시 확인합니다.');
      this.sessions.set(job.id, restored); job.sessionRef = ref; this.persist();
      return restored;
    } catch (e) {
      if (!reopenMissing || !(e instanceof MissingApplicationTab)) throw e;
      this.sessions.delete(job.id);
      job.sessionRef = undefined;
      this.push(job, 'system', '기존 지원서 탭이 사라져 이 회사 전용 새 창에서 이어갑니다. 사이트에 저장되지 않은 이전 입력은 복구되지 않을 수 있습니다.');
      return undefined; // applyNow creates a new owned window for this task's original target.
    }
  }

  /** 미완료로 끝났을 때 사용자를 부르지 않고 스스로 이어서 할 횟수 */
  private static readonly AUTO_CONTINUE = 2;


  /** 한 번 실행. 미완료면 부르는 쪽에서 남은 일만 다시 맡긴다 */
  private async runOnce(job: Job, o: { request?: string; context: Record<string, unknown>; session?: BrowserSession; ctl: AbortController; check: () => void }): Promise<ApplyReport> {
    const { check, ctl } = o;
    const current = () => !ctl.signal.aborted;
    return (this.deps.run ?? applyNow)({
      target: job.target, steps: job.steps, request: o.request, context: o.context, role: job.role,
      window: { newWindow: true, background: true }, session: o.session, keepSession: true, skipLoginWait: !!o.session,
      signal: ctl.signal,
      onSession: async s => {
        // Keep the exact tab even when a new instruction arrives during browser creation.
        this.sessions.set(job.id, s);
        job.sessionRef = await s.reference();
        this.persist(); check();
      },
      onNotion: notion => { check(); job.reportContext = { ...job.reportContext, notion }; this.persist(); },
      onRole: role => { check(); job.role = role; this.persist(); },
      ask: async question => {
        check(); job.waiting = question; job.status = 'waiting'; job.activity = '확인이 필요합니다';
        this.push(job, 'ask', question); this.attention(job, question);
        const reason = new UserInputRequired(question);
        ctl.abort(reason); // revoke the browser bridge and release this company's worker
        throw reason;
      },
      notify: (_title, text) => { if (current()) this.attention(job, text); },
      log: line => { if (!current()) return; const m = toMessage(line); if (m.text) { job.activity = m.text.slice(0, 100); this.push(job, m.kind, m.text); } },
    });
  }

  private async execute(job: Job, turn: Turn, ctl: AbortController): Promise<void> {
    const current = () => !ctl.signal.aborted && job.revision === turn.revision;
    const check = () => { if (!current()) throw ctl.signal.reason ?? new Error('새 사용자 지시로 중지되었습니다'); };
    job.status = 'running';
    job.finishedAt = undefined;
    job.activity = turn.message ? 'AI가 대화와 현재 상태를 확인하고 있습니다' : '지원서 작성을 시작합니다';
    this.persist();
    try {
      const context: Record<string, unknown> = { title: job.title, requested_role: job.role, original_steps: job.steps, interrupted_stage: job.stage,
        waiting: job.waiting, summary: job.summary, blanks: job.blanks, last_result: job.reportContext,
        ...(job.asideHandoff ? { external_work: { app: 'Aside', handed_off_at: job.asideHandoff.createdAt, result: 'Aside에서 한 작업은 동기화되지 않았습니다. 이전 리포트는 전달 이전 기록이며 현재 화면과 연결된 Notion에서 상태를 다시 확인해야 합니다.' } } : {}),
        conversation: job.messages.filter(m => ['you', 'ai', 'ask', 'done'].includes(m.kind)).slice(-30).map(({ kind, text }) => ({ kind, text })),
        recent_progress: job.messages.filter(m => m.kind === 'log').slice(-10).map(m => m.text) };
      job.waiting = null;
      const previousTarget = job.sessionRef?.targetId;
      let session = await this.session(job, true);
      if (previousTarget && job.sessionRef?.targetId !== previousTarget) context.browser_recovery = '브라우저 또는 지원서 탭을 다시 열었습니다. 이전 요약에 입력됐다고 적힌 값도 현재 화면에서 재확인하세요. 저장 전 값은 사라졌을 수 있습니다.';
      check();
      // 미완료로 끝나면 사용자를 부르지 않고 남은 일만 다시 맡긴다 (같은 창에서 이어서)
      let report!: ApplyReport;
      let request = turn.message;
      for (let round = 0; ; round++) {
        report = await this.runOnce(job, { request, context, session, ctl, check });
        if (report.outcome === 'answered' || report.completed) break;
        const remaining = (report.remaining ?? []).filter(x => x.trim());
        if (!remaining.length || round >= ApplyJobManager.AUTO_CONTINUE) break;
        if (context.previous_remaining && String(context.previous_remaining) === remaining.join('|')) break; // 더 나아가지 못하면 사용자에게
        context.previous_remaining = remaining.join('|');
        context.last_result = { summary: report.summary, remaining, save: report.save, notion: report.notion };
        job.reportDir = report.dir;
        this.push(job, 'system', `남은 일을 이어서 합니다 (${round + 1}/${ApplyJobManager.AUTO_CONTINUE}): ${remaining.join(' / ')}`);
        request = `아직 끝나지 않았습니다. 지금 화면과 연결된 Notion 을 다시 확인하고 남은 일을 끝내 주세요:\n- ${remaining.join('\n- ')}`;
        session = this.sessions.get(job.id) ?? session;
        check();
      }
      check();
      if (report.outcome === 'answered') {
        job.status = 'idle'; job.activity = '답변했습니다 · 새 요청을 기다립니다';
        this.push(job, 'ai', report.summary); return;
      }
      job.reportDir = report.dir; job.summary = report.summary; job.blanks = report.blanks;
      job.reportContext = { role: report.role, summary: report.summary, blanks: report.blanks, save: report.save, notion: report.notion,
        questions: report.essay?.questions.map(q => ({ id: q.id, question: q.question, kind: q.kind, answer: report.essay?.result?.answers.find(a => a.id === q.id)?.text })),
        strategy: report.essay?.result?.strategy, checks: report.essay?.result?.checks };
      job.status = report.completed ? 'done' : 'waiting';
      job.waiting = report.completed ? null : report.remaining?.join('\n') || '미완료 항목을 확인해 주세요.';
      job.activity = report.completed ? '작성 결과를 검토해 주세요 · 제출은 직접' : '미완료 · 남은 작업을 확인해 주세요';
      this.push(job, report.completed ? 'done' : 'ask', formatApplyReport(report));
      this.attention(job, job.activity, true);
    } catch (e) {
      if (job.revision !== turn.revision) return;
      if (ctl.signal.reason instanceof UserInputRequired) return;
      if (ctl.signal.aborted) { job.status = 'stopped'; return; }
      job.status = 'error'; job.activity = `오류: ${(e as Error).message.slice(0, 100)}`;
      this.push(job, 'error', `멈췄습니다: ${(e as Error).message}\n문제를 해결한 뒤 대화에서 이어가기를 요청하세요.`);
    } finally {
      if (job.revision === turn.revision) job.finishedAt = new Date().toISOString();
      this.persist();
    }
  }

  private attention(job: Job, message: string, quiet = false): void {
    this.deps.notify?.(`Auto-Job — ${job.title}`, message.replace(/\s+/g, ' ').slice(0, 120));
    const session = this.sessions.get(job.id);
    if (!quiet && session) void this.deps.bringToFront?.(session).catch(() => {});
  }

  answer(id: string, text: string): { answered: boolean; queued: boolean } {
    const job = this.jobs.get(id);
    if (!job) throw new Error('없는 대화방입니다');
    if (this.handoffs.has(id)) throw new Error('Aside용 자료를 준비 중입니다. 잠시 후 다시 시도해 주세요.');
    if (job.executionMode === 'aside') throw new Error('Aside 패널에서 직접 대화하거나 Auto-Job으로 전환해 주세요.');
    const message = text.trim();
    if (!message || message.length > 30000) throw new Error('메시지를 1~30,000자로 입력하세요');
    job.revision++;
    this.executions.get(id)?.ctl.abort(new Error('새 사용자 지시로 중지되었습니다'));
    job.status = 'queued'; job.activity = '새 메시지를 AI에 전달하고 있습니다';
    this.push(job, 'you', message);
    this.pending.set(id, { revision: job.revision, message });
    this.pump();
    return { answered: true, queued: true };
  }

  stop(id: string): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error('없는 대화방입니다');
    if (job.executionMode === 'aside') throw new Error('Aside 작업의 중지는 Aside 패널에서 직접 해 주세요.');
    job.revision++;
    this.pending.delete(id);
    this.executions.get(id)?.ctl.abort(new Error('사용자가 중지했습니다'));
    job.status = 'stopped'; job.activity = '중지했습니다';
    this.push(job, 'system', '이 회사의 작업을 중지했습니다. 입력한 값과 탭은 유지됩니다.');
  }

  async focus(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) throw new Error('없는 대화방입니다');
    if (job.executionMode === 'aside') return false;
    const session = await this.session(job);
    if (!session) return false;
    if (this.deps.bringToFront) await this.deps.bringToFront(session);
    else await session.show();
    return true;
  }

  remove(id: string): void {
    const job = this.jobs.get(id);
    if (this.handoffs.has(id) || this.executions.has(id) || job && ACTIVE.includes(job.status)) throw new Error('진행 중인 지원서는 먼저 중지하고 종료를 기다려 주세요');
    void this.sessions.get(id)?.detach().catch(() => {});
    this.sessions.delete(id); this.pending.delete(id); this.jobs.delete(id); this.persist();
  }

  async handoff(id: string, prepare: (job: Job) => Promise<AsideHandoff>): Promise<AsideHandoff> {
    const job = this.jobs.get(id);
    if (!job) throw new Error('없는 대화방입니다');
    if (this.handoffs.has(id)) throw new Error('이미 자료를 준비 중입니다');
    this.handoffs.add(id);
    try {
      if (job.executionMode !== 'aside' && (ACTIVE.includes(job.status) || this.executions.has(id))) this.stop(id);
      await this.executions.get(id)?.done;
      // No native agent is launched. Ownership passes to the user in Aside after the old worker exits.
      const handoff = await prepare(job);
      job.asideHandoff = handoff; job.executionMode = 'aside'; job.status = 'idle';
      job.activity = 'Aside용 자료 준비됨 · 패널에 붙여넣어 시작';
      this.push(job, 'system', 'Aside용 자료를 준비했습니다. 요청을 복사해 Aside 우측 패널에 붙여넣으세요. 이후 진행·중지는 Aside에서 직접 확인합니다. 기존 브라우저의 저장 전 입력값은 옮겨지지 않습니다.');
      return handoff;
    } finally { this.handoffs.delete(id); }
  }

  useAutoJob(id: string): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error('없는 대화방입니다');
    if (this.handoffs.has(id) || this.executions.has(id)) throw new Error('현재 작업이 정리된 뒤 전환해 주세요.');
    if (job.executionMode !== 'aside') return;
    job.executionMode = 'autojob'; job.status = 'idle'; job.activity = 'Auto-Job 선택됨 · 새 요청을 기다립니다';
    this.push(job, 'system', 'Auto-Job으로 전환했습니다. Aside에서 진행하던 작업을 먼저 마친 뒤 여기에서 요청하세요. Aside의 변경 결과는 현재 화면에서 다시 확인합니다.');
  }

  async close(): Promise<void> {
    for (const id of this.jobs.keys()) if (this.executions.has(id) || this.pending.has(id)) this.stop(id);
    await Promise.all([...this.executions.values()].map(e => e.done));
    await Promise.all([...this.sessions.values()].map(s => s.detach().catch(() => {})));
    this.sessions.clear();
  }

  snapshot(since = 0) {
    const jobs = [...this.jobs.values()];
    return { seq: this.seq,
      jobs: jobs.map(({ messages, sessionRef, reportContext, ...j }) => ({ ...j, lastSeq: messages.at(-1)?.seq ?? 0 })),
      messages: jobs.flatMap(j => j.messages.filter(m => m.seq > since)).sort((a, b) => a.seq - b.seq),
    };
  }
}
