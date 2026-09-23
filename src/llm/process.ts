import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

/** Wait for process exit after cancellation; an AbortError alone does not mean it has exited. */
export function waitForAgentExit(child: ChildProcess, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    let error: Error | undefined;
    let kill: NodeJS.Timeout | undefined;
    const terminate = () => {
      child.kill('SIGTERM');
      kill ??= setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 3000);
      kill.unref();
    };
    child.on('error', e => { error = e; });
    child.once('close', code => {
      clearTimeout(kill);
      signal?.removeEventListener('abort', terminate);
      if (signal?.aborted) reject(signal.reason ?? new Error('사용자가 중지했습니다'));
      else if (error) reject(error);
      else resolve(code ?? 1);
    });
    signal?.addEventListener('abort', terminate, { once: true });
    if (signal?.aborted) terminate();
  });
}

/** PATH 에서 실행 파일을 찾는다 (절대 경로면 그 파일) */
export function commandOnPath(bin: string): boolean {
  const ok = (f: string) => { try { accessSync(f, constants.X_OK); return true; } catch { return false; } };
  if (path.isAbsolute(bin)) return ok(bin);
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && ok(path.join(dir, bin)));
}

/**
 * 실행 오류를 알아보기 쉽게 바꾼다. ENOENT 는 "명령이 없음" 말고도 작업 폴더가 사라졌을 때 나서,
 * 그대로 "명령을 찾지 못함"으로 알리면 멀쩡한 AI 연결을 한동안 쉬게 만든다.
 */
export function spawnFailure(e: unknown, bin: string, cwd: string, notFound: string): Error {
  const err = e as NodeJS.ErrnoException;
  if (err?.code !== 'ENOENT') return err instanceof Error ? err : new Error(String(e));
  if (!existsSync(cwd)) return new Error(`AI 작업 폴더가 사라졌습니다 (${cwd})`);
  if (!commandOnPath(bin)) return new Error(notFound);
  return new Error(`${path.basename(bin)} 실행을 시작하지 못했습니다 (${err.message}, 작업 폴더 있음, 명령 있음). 잠시 뒤 다시 시도해 주세요.`);
}
