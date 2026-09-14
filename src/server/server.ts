// `autojob ui`: 내 컴퓨터에서만 열리는 설정 화면.
// 127.0.0.1 에만 열고, 실행할 때마다 새로 만드는 토큰이 있어야 API 를 쓸 수 있다 (다른 사이트가 몰래 부르는 것 방지).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import path from 'node:path';
import { ROOT } from '../paths';
import { isPromptExit } from '../ui/prompter';
import { routes } from './api';

const WEB = path.join(ROOT, 'src', 'web');
const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16 * 1024 * 1024) throw new Error('요청이 너무 큽니다');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

export function startServer(port: number, token = randomBytes(16).toString('hex')): Promise<{ server: Server; url: string; token: string }> {
  let allowedHosts = new Set<string>();
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      if (!allowedHosts.has(req.headers.host ?? '')) return send(403, { error: '허용되지 않은 주소' });
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      const file = STATIC[url.pathname];
      if (req.method === 'GET' && file) return send(200, readFileSync(path.join(WEB, file[0])), file[1]);

      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) return send(404, { error: '없는 주소' });
      if (req.headers['x-autojob-token'] !== token) return send(401, { error: '토큰이 맞지 않습니다. 터미널에 나온 주소로 다시 열어주세요.' });
      const body = req.method === 'POST' ? await readBody(req) : {};
      return send(200, (await handler(body)) ?? {});
    } catch (e) {
      if (isPromptExit(e)) return;
      return send(400, { error: (e as Error).message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as { port: number }).port; // port 0 이면 OS 가 고른 포트
      allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
      resolve({ server, url: `http://127.0.0.1:${actual}/#t=${token}`, token });
    });
  });
}
