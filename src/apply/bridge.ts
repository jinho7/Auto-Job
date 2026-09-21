// MCP 서버(Claude 가 띄운 별도 프로세스) ↔ autojob apply(사용자 앞의 프로세스) 연결.
// MCP 서버는 표준입출력을 Claude 와의 통신에 쓰므로, 사용자에게 묻거나 결과를 모으는 일은 이 연결로 한다.
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export type BridgeEvent =
  | { type: 'blank'; field: string; reason: string }
  | { type: 'note'; text: string }
  | { type: 'action'; tool: string; label?: string; value?: string; ok: boolean; message: string }
  | { type: 'finish'; summary: string }
  | { type: 'questions'; role: string; questions: unknown[] }
  | { type: 'form_info'; projects: string[]; documents: string[]; procedure: string[] };

export type BridgeHandlers = {
  ask: (question: string) => Promise<string>;
  event: (e: BridgeEvent) => void;
  tools?: BridgeTools;
  signal?: AbortSignal;
};

export type BridgeToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };
export type BridgeTool = { name: string; description: string; inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean } };
export type BridgeTools = { list(): BridgeTool[]; call(name: string, args: Record<string, unknown>): Promise<BridgeToolResult> };

export async function startBridge(h: BridgeHandlers) {
  const token = randomBytes(16).toString('hex');
  let revoked = false;
  let tail: Promise<unknown> = Promise.resolve();
  const check = () => { if (revoked || h.signal?.aborted) throw new Error('종료되었거나 중지된 AI 작업입니다'); };
  const revoke = () => { revoked = true; };
  h.signal?.addEventListener('abort', revoke, { once: true });
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['x-autojob-token'] !== token) return send(401, { error: 'token' });
    if (revoked || h.signal?.aborted) return send(403, { error: '종료되었거나 중지된 AI 작업입니다' });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 2 * 1024 * 1024) throw new Error('요청이 너무 큽니다');
        chunks.push(c as Buffer);
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      // Serialize operations; revocation also rejects calls already waiting in this queue.
      const operation = tail.then(async () => {
        check();
        if (req.url === '/tools' && h.tools) return h.tools.list();
        if (req.url === '/call' && h.tools) return h.tools.call(String(body.name), body.arguments ?? {});
        if (req.url === '/ask') return { answer: await h.ask(String(body.question ?? '')) };
        if (req.url === '/event') { h.event(body as BridgeEvent); return { ok: true }; }
        throw new Error('없는 도구 주소');
      });
      tail = operation.catch(() => {});
      return send(200, await operation);
    } catch (e) {
      return send(500, { error: (e as Error).message });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, token, server, revoke,
    async close() {
      revoke();
      h.signal?.removeEventListener('abort', revoke);
      await tail; // Finish the in-flight action before another agent can reuse this tab.
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export class BridgeClient {
  constructor(private readonly url: string, private readonly token: string) {}

  private async post(p: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(this.url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AutoJob-Token': this.token }, body: JSON.stringify(body) });
    const result = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new Error(String(result.error || `도구 연결 오류 ${res.status}`));
    return result;
  }

  async ask(question: string): Promise<string> {
    return String((await this.post('/ask', { question })).answer ?? '');
  }

  async event(e: BridgeEvent): Promise<void> {
    await this.post('/event', e).catch(() => {});
  }

  async tools(): Promise<BridgeTool[]> { return await this.post('/tools', {}) as unknown as BridgeTool[]; }
  async call(name: string, args: Record<string, unknown>): Promise<BridgeToolResult> {
    return await this.post('/call', { name, arguments: args }) as unknown as BridgeToolResult;
  }
}
