// MCP 서버(Claude 가 띄운 별도 프로세스) ↔ autojob apply(사용자 앞의 프로세스) 연결.
// MCP 서버는 표준입출력을 Claude 와의 통신에 쓰므로, 사용자에게 묻거나 결과를 모으는 일은 이 연결로 한다.
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export type BridgeEvent =
  | { type: 'blank'; field: string; reason: string }
  | { type: 'note'; text: string }
  | { type: 'action'; tool: string; label?: string; value?: string; ok: boolean; message: string }
  | { type: 'finish'; summary: string };

export type BridgeHandlers = {
  ask: (question: string) => Promise<string>;
  event: (e: BridgeEvent) => void;
};

export async function startBridge(h: BridgeHandlers): Promise<{ url: string; token: string; server: Server }> {
  const token = randomBytes(16).toString('hex');
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['x-autojob-token'] !== token) return send(401, { error: 'token' });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    try {
      if (req.url === '/ask') return send(200, { answer: await h.ask(String(body.question ?? '')) });
      if (req.url === '/event') {
        h.event(body as BridgeEvent);
        return send(200, { ok: true });
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(500, { error: (e as Error).message });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, token, server };
}

export class BridgeClient {
  constructor(private readonly url: string, private readonly token: string) {}

  private async post(p: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(this.url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AutoJob-Token': this.token }, body: JSON.stringify(body) });
    return (await res.json()) as Record<string, unknown>;
  }

  async ask(question: string): Promise<string> {
    return String((await this.post('/ask', { question })).answer ?? '');
  }

  async event(e: BridgeEvent): Promise<void> {
    await this.post('/event', e).catch(() => {});
  }
}
