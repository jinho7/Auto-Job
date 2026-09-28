import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OUTCOME_LABEL } from './collect';
import { collectNow, saveCollectReport, type CollectRunOptions } from './run';

type Result = Awaited<ReturnType<typeof collectNow>> & { labels: typeof OUTCOME_LABEL };
type Snapshot = {
  id: string; status: 'idle' | 'running' | 'stopping' | 'completed' | 'stopped' | 'error';
  dryRun: boolean; startedAt?: string; finishedAt?: string; log: string[]; error?: string; result?: Result;
  preview?: Result;
};

/** Save partial reports separately from the lifetime of an HTTP request or server process. */
export class CollectTask {
  private task: Snapshot = { id: '', status: 'idle', dryRun: true, log: [] };
  private controller?: AbortController;
  private pending?: Promise<void>;
  private updatingPreview = false;

  constructor(private readonly run = collectNow, private readonly idleTimeoutMs = 10 * 60_000, private readonly stateFile?: string) {
    if (stateFile && existsSync(stateFile)) {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as Snapshot;
      if (typeof saved.id !== 'string' || !Array.isArray(saved.log)) throw new Error('저장된 수집 상태를 읽을 수 없습니다.');
      this.task = saved;
      if (['running', 'stopping'].includes(saved.status)) {
        saved.status = 'stopped'; saved.finishedAt = new Date().toISOString();
        saved.error = '서버가 재시작되어 중지됐습니다. 이미 모은 목록과 결과는 아래에 남아 있습니다.';
        this.persist();
      }
    }
  }

  private persist(): void {
    if (!this.stateFile) return;
    mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    writeFileSync(this.stateFile + '.tmp', JSON.stringify(this.task), { mode: 0o600 });
    renameSync(this.stateFile + '.tmp', this.stateFile);
  }

  snapshot(): Snapshot { return structuredClone(this.task); }

  start(options: CollectRunOptions): Snapshot {
    if (this.updatingPreview) throw new Error('계열사 묶음을 확인 중입니다. 완료 후 다시 시도해 주세요.');
    if (this.pending) throw new Error('이미 수집 중입니다. 진행 내역을 확인하거나 수집 중지를 눌러 주세요.');
    const ctl = this.controller = new AbortController();
    const preview = this.task.preview;
    const task = this.task = { id: randomUUID(), status: 'running', dryRun: options.dryRun, preview,
      startedAt: new Date().toISOString(), log: [options.dryRun ? '미리보기를 시작합니다. Notion에 쓰지 않습니다.' : '선택한 공고의 상세 확인과 등록을 시작합니다.'] } as Snapshot;
    this.persist();
    let timer: NodeJS.Timeout;
    const beat = () => {
      clearTimeout(timer);
      if (ctl.signal.aborted) return;
      timer = setTimeout(() => {
        task.status = 'stopping';
        const reason = new Error(`${Math.ceil(this.idleTimeoutMs / 60_000)}분 동안 진행이 없어 중지합니다. 이미 모은 목록과 결과는 유지합니다.`);
        task.log.push(reason.message); ctl.abort(reason); this.persist();
      }, this.idleTimeoutMs);
      timer.unref?.();
    };
    const log = (message: string) => { task.log.push(message); if (task.log.length > 500) task.log.shift(); beat(); };
    beat();
    this.pending = Promise.resolve().then(() => this.run({ ...options, signal: ctl.signal, log,
      onProgress: result => {
        if (ctl.signal.aborted) return;
        task.result = structuredClone({ ...result, labels: OUTCOME_LABEL });
        if (result.report.phase === 'preview') task.preview = task.result;
        this.persist(); beat();
      },
    })).then(result => {
      ctl.signal.throwIfAborted();
      task.result = { ...result, labels: OUTCOME_LABEL };
      if (result.report.phase === 'preview') task.preview = task.result;
      task.status = 'completed';
      log(options.dryRun ? '미리보기가 완료됐습니다. Notion에 등록하지 않았습니다.' : '선택한 공고의 처리가 완료됐습니다. 결과별 상태를 확인해 주세요.');
    }).catch((error: Error) => {
      task.status = ctl.signal.aborted ? 'stopped' : 'error';
      task.error = String(ctl.signal.reason?.message ?? error.message);
      task.log.push(task.error);
    }).finally(() => {
      clearTimeout(timer);
      task.finishedAt = new Date().toISOString();
      this.pending = undefined;
      this.controller = undefined;
      this.persist();
    });
    return this.snapshot();
  }

  stop(id: string): Snapshot {
    if (id !== this.task.id) throw new Error('현재 수집과 다른 요청입니다. 진행 상태를 새로 확인해 주세요.');
    if (this.pending && !this.controller?.signal.aborted) {
      this.task.status = 'stopping';
      this.controller?.abort(new Error('사용자가 수집을 중지했습니다. 이미 모은 목록과 결과는 유지합니다.'));
      this.persist();
    }
    return this.snapshot();
  }

  async updatePreview(transform: (report: Result['report']) => Promise<void>): Promise<Snapshot> {
    if (this.pending || this.updatingPreview) throw new Error('수집 또는 계열사 묶음 확인 중에는 변경할 수 없습니다.');
    this.updatingPreview = true;
    try {
      const preview = structuredClone(this.task.preview ?? (this.task.result?.report.phase === 'preview' ? this.task.result : undefined));
      if (preview) {
        await transform(preview.report);
        saveCollectReport(preview.dir, preview.report);
        if (this.task.result?.dir === preview.dir) this.task.result = preview;
        this.task.preview = preview;
        this.persist();
      }
      return this.snapshot();
    } finally { this.updatingPreview = false; }
  }

  async wait(): Promise<Snapshot> { await this.pending; return this.snapshot(); }
  async close(): Promise<void> { if (this.pending) this.stop(this.task.id); await this.pending; }
}
