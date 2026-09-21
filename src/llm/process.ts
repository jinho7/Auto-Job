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
