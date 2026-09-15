// 설정 화면에서 지원서 여러 개를 함께 진행하기: 지원서마다 대화방 하나, 브라우저 창 하나.
// 방에는 AI 가 지금 하는 일이 계속 올라오고, 사람이 해야 할 일(로그인, 확인)이 생기면
// 알림을 보내고 그 창을 앞으로 띄운 뒤, 대화방에서 답을 받는다.
import type { BrowserSession } from '../browser/session';
import { applyNow, formatApplyReport, type ApplyOptions, type ApplyReport, type ApplyStep } from './run';

export type JobStatus = 'queued' | 'running' | 'waiting' | 'done' | 'error' | 'stopped';
export type JobMsgKind = 'ai' | 'log' | 'ask' | 'you' | 'system' | 'done' | 'error';
export type JobMsg = { seq: number; job: string; at: string; kind: JobMsgKind; text: string };
export type Job = {
  id: string;
  target: string;
  title: string;
  status: JobStatus;
  /** 방 목록에 보일 "지금 하는 일" */
  activity: string;
  /** 사람에게 물은 것 (답을 기다리는 중) */
  waiting: string | null;
  steps: ApplyStep[];
  createdAt: string;
  finishedAt?: string;
  reportDir?: string;
  messages: JobMsg[];
};

export type JobDeps = {
  run?: (o: ApplyOptions) => Promise<ApplyReport>;
  maxParallel: () => number;
  /** 알림 (macOS 알림 등) */
  notify?: (title: string, message: string) => void;
  /** 그 지원서의 브라우저 창을 맨 앞으로 */
  bringToFront?: (s: BrowserSession) => Promise<void>;
};

export const MAX_JOBS_PER_START = 8;
const ACTIVE: JobStatus[] = ['queued', 'running', 'waiting'];

/** 로그 한 줄 → 대화방 말풍선 (앞의 번호·들여쓰기는 정리) */
export function toMessage(line: string): { kind: JobMsgKind; text: string } {
  const t = line.replace(/^\s+/, '');
  if (t.startsWith('💭')) return { kind: 'ai', text: t.replace(/^💭\s*/, '') };
  return { kind: 'log', text: t };
}

export class ApplyJobManager {
  private seq = 0;
  private nextId = 1;
  readonly jobs = new Map<string, Job>();
  private readonly pending = new Map<string, { resolve: (s: string) => void; reject: (e: Error) => void }>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly aborts = new Map<string, AbortController>();

  constructor(private readonly deps: JobDeps) {}

  private push(job: Job, kind: JobMsgKind, text: string): void {
    const m: JobMsg = { seq: ++this.seq, job: job.id, at: new Date().toISOString(), kind, text };
    job.messages.push(m);
    if (job.messages.length > 2000) job.messages.splice(0, job.messages.length - 2000);
  }

  start(targets: { target: string; title?: string }[], steps: ApplyStep[] = ['basic', 'essay']): Job[] {
    if (!targets.length) throw new Error('지원할 공고를 골라 주세요');
    if (targets.length > MAX_JOBS_PER_START) throw new Error(`한 번에 ${MAX_JOBS_PER_START}개까지 고를 수 있습니다`);
    const created = targets.map((t) => {
      const job: Job = { id: `j${this.nextId++}`, target: t.target, title: t.title || t.target, status: 'queued', activity: '차례를 기다리는 중', waiting: null, steps, createdAt: new Date().toISOString(), messages: [] };
      this.jobs.set(job.id, job);
      this.push(job, 'system', `${job.title} 지원서를 맡았습니다.`);
      return job;
    });
    this.pump();
    return created;
  }

  private running(): number {
    return [...this.jobs.values()].filter((j) => j.status === 'running' || j.status === 'waiting').length;
  }

  private pump(): void {
    for (const job of this.jobs.values()) {
      if (this.running() >= this.deps.maxParallel()) return;
      if (job.status === 'queued') void this.run(job);
    }
  }

  private async run(job: Job): Promise<void> {
    job.status = 'running';
    job.activity = '브라우저 창을 여는 중';
    this.push(job, 'system', '시작합니다. 브라우저에 이 지원서 창을 따로 엽니다.');
    const ctl = new AbortController();
    this.aborts.set(job.id, ctl);
    try {
      const report = await (this.deps.run ?? applyNow)({
        target: job.target,
        steps: job.steps,
        window: { newWindow: true, background: true },
        signal: ctl.signal,
        onSession: (s) => this.sessions.set(job.id, s),
        ask: (q) => this.ask(job, q),
        notify: (_t, m) => this.attention(job, m),
        log: (line) => {
          const m = toMessage(line);
          if (!m.text) return;
          this.push(job, m.kind, m.text);
          job.activity = m.text.slice(0, 80);
        },
      });
      job.reportDir = report.dir;
      job.status = 'done';
      job.activity = report.completed ? '다 썼습니다 — 검토해 주세요 (제출은 직접)' : '끝까지 마치지 못한 부분이 있습니다';
      this.push(job, 'done', formatApplyReport(report));
      this.attention(job, job.activity, { quiet: true });
    } catch (e) {
      const stopped = ctl.signal.aborted;
      job.status = stopped ? 'stopped' : 'error';
      job.activity = stopped ? '중지했습니다' : `오류: ${(e as Error).message.slice(0, 80)}`;
      this.push(job, stopped ? 'system' : 'error', stopped ? '중지했습니다. 브라우저 창은 그대로 둡니다.' : `멈췄습니다: ${(e as Error).message}`);
    } finally {
      job.waiting = null;
      job.finishedAt = new Date().toISOString();
      this.pending.delete(job.id);
      this.aborts.delete(job.id);
      this.sessions.delete(job.id);
      this.pump();
    }
  }

  /** 사람에게 묻는다: 방에 빨간 점, 알림, 그 창을 앞으로. 답은 대화방에서 */
  private ask(job: Job, question: string): Promise<string> {
    job.waiting = question;
    job.status = 'waiting';
    job.activity = '확인이 필요합니다';
    this.push(job, 'ask', question);
    this.attention(job, question);
    return new Promise((resolve, reject) => this.pending.set(job.id, { resolve, reject }));
  }

  private attention(job: Job, message: string, opts: { quiet?: boolean } = {}): void {
    this.deps.notify?.(`Auto-Job — ${job.title}`, message.replace(/\s+/g, ' ').slice(0, 120));
    if (opts.quiet) return;
    const s = this.sessions.get(job.id);
    if (s) void this.deps.bringToFront?.(s).catch(() => {});
  }

  /** 대화방에서 보낸 말 */
  answer(id: string, text: string): { answered: boolean } {
    const job = this.jobs.get(id);
    if (!job) throw new Error('없는 대화방입니다');
    const t = text.trim();
    if (!t) throw new Error('보낼 말이 없습니다');
    this.push(job, 'you', t);
    const p = this.pending.get(id);
    if (!p) {
      this.push(job, 'system', '지금은 묻고 있는 것이 없어 기록만 했습니다.');
      return { answered: false };
    }
    this.pending.delete(id);
    job.waiting = null;
    job.status = 'running';
    job.activity = '답을 받아 이어서 하는 중';
    p.resolve(t);
    return { answered: true };
  }

  stop(id: string): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error('없는 대화방입니다');
    if (job.status === 'queued') {
      job.status = 'stopped';
      job.activity = '시작 전에 취소했습니다';
      this.push(job, 'system', '시작 전에 취소했습니다.');
      return;
    }
    this.aborts.get(id)?.abort();
    this.pending.get(id)?.reject(new Error('사용자가 중지했습니다'));
  }

  async focus(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    await this.deps.bringToFront?.(s);
    return true;
  }

  /** 끝난 방 지우기 */
  remove(id: string): void {
    const job = this.jobs.get(id);
    if (job && ACTIVE.includes(job.status)) throw new Error('진행 중인 지원서는 먼저 중지해 주세요');
    this.jobs.delete(id);
  }

  /** 화면 갱신용: 방 목록과 since 이후 새 말풍선 */
  snapshot(since = 0) {
    const jobs = [...this.jobs.values()];
    return {
      seq: this.seq,
      jobs: jobs.map(({ messages, ...j }) => ({ ...j, lastSeq: messages.at(-1)?.seq ?? 0 })),
      messages: jobs.flatMap((j) => j.messages.filter((m) => m.seq > since)).sort((a, b) => a.seq - b.seq),
    };
  }
}
