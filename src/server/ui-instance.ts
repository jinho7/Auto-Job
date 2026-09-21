import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { paths } from '../paths';
import { startServer } from './server';

type Instance = { instanceId: string; token: string; pid: number };
const fileFor = (dir: string, port: number) => path.join(dir, `ui-${port}.json`);
function readInstance(file: string): Instance | undefined {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as Instance;
    if (/^[0-9a-f]{32}$/.test(r.instanceId) && /^[0-9a-f]{32}$/.test(r.token)) return r;
  } catch { /* Missing or stale registry is not an active server. */ }
}

async function existingUrl(port: number, dir: string): Promise<string | undefined> {
  const r = readInstance(fileFor(dir, port));
  if (!r) return;
  const base = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(`${base}/api/ui-instance`, { headers: { 'X-AutoJob-Token': r.token }, redirect: 'error', signal: AbortSignal.timeout(1000) });
    if (!response.ok) return;
    const current = await response.json() as { application?: string; instanceId?: string };
    if (current.application === 'auto-job' && current.instanceId === r.instanceId) return `${base}/#t=${r.token}`;
  } catch { /* Never reuse an unrelated or unresponsive listener. */ }
}

/** A repeated CLI launch opens the authenticated existing UI without replacing its jobs. */
export async function startOrReuseUi(port: number, dir = paths.data): Promise<
  { reused: false } & Awaited<ReturnType<typeof startServer>> | { reused: true; url: string }
> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('포트는 0~65535 사이의 정수로 지정해 주세요.');
  let started: Awaited<ReturnType<typeof startServer>>;
  try { started = await startServer(port); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    // Another simultaneous launch may still be publishing its local registry.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await setTimeout(100);
      const url = await existingUrl(port, dir);
      if (url) return { reused: true, url };
    }
    throw new Error(`${port} 포트가 사용 중이며 현재 Auto-Job 서버로 확인되지 않았습니다. 다른 포트로 열려면 autojob ui --port ${port === 65535 ? 4777 : port + 1} 을 실행하세요.`);
  }
  const actual = Number(new URL(started.url).port);
  const file = fileFor(dir, actual), tmp = `${file}.${started.instanceId}.tmp`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify({ instanceId: started.instanceId, token: started.token, pid: process.pid }), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    await new Promise<void>(resolve => started.server.close(() => resolve()));
    throw e;
  }
  started.server.once('close', () => {
    if (readInstance(file)?.instanceId === started.instanceId) rmSync(file, { force: true });
  });
  return { ...started, reused: false };
}
