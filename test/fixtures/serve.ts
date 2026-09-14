// 테스트용: 가짜 채용 사이트(test/fixtures/fake-apply)를 빈 포트에 띄운다
import { readFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-apply');

export async function serveFakeSite(): Promise<{ base: string; server: Server }> {
  const server = createServer((req, res) => {
    const name = path.basename(new URL(req.url ?? '/', 'http://x').pathname) || 'login.html';
    const file = path.join(DIR, name);
    if (!existsSync(file)) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}
