// Claude Code 를 헤드리스(claude -p)로 돌린다.
// 내장 도구는 넘겨받은 것만(기본: 없음), MCP 는 넘겨받은 서버만 쓴다. 사용자의 다른 MCP 설정은 불러오지 않는다.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export type AgentEvent =
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  | { type: 'text'; text: string }
  | { type: 'result'; text: string; isError: boolean; costUsd?: number; turns?: number };

export type AgentRun = {
  prompt: string;
  systemAppend: string;
  /** 쓸 수 있는 내장 도구 (예: ['WebSearch', 'WebFetch']). 비우면 내장 도구 없음 */
  tools?: string[];
  /** 쓸 MCP 서버 (stdio 로 띄울 명령) */
  mcp?: McpServerSpec;
  model?: string;
  cwd: string;
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
};

export type McpServerSpec = { server: string; command: string; args: string[]; env: Record<string, string> };

export type AgentResult = { text: string; isError: boolean; costUsd?: number };

/** 모든 AI 연결 방식이 같은 모양으로 부른다 (llm/index.ts) */
export type RunAgent = (o: AgentRun) => Promise<AgentResult>;

/** Claude Code 용 MCP 설정 파일 */
export function writeClaudeMcpConfig(o: McpServerSpec, dir: string): string {
  const file = path.join(dir, `mcp-${o.server}.json`);
  writeFileSync(
    file,
    // --mcp-config 서버는 기본적으로 뒤에서 연결되어 첫 턴에 도구가 없을 수 있다. alwaysLoad 는 연결을 기다린 뒤 시작한다.
    JSON.stringify({ mcpServers: { [o.server]: { alwaysLoad: true, command: o.command, args: o.args, env: o.env } } }),
    { mode: 0o600 },
  );
  return file;
}

export async function runClaudeAgent(o: AgentRun): Promise<AgentResult> {
  const tools = o.tools ?? [];
  const allowed = [...tools, ...(o.mcp ? [`mcp__${o.mcp.server}`] : [])];
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--tools', tools.join(','), // "" 이면 내장 도구 전부 끔
    '--strict-mcp-config', // 사용자의 다른 MCP 서버는 불러오지 않는다
    ...(o.mcp ? ['--mcp-config', writeClaudeMcpConfig(o.mcp, o.cwd)] : []),
    ...(allowed.length ? ['--allowedTools', allowed.join(',')] : []),
    '--permission-mode', 'dontAsk', // 허용 목록에 없는 것은 묻지 않고 거절
    '--no-session-persistence',
    '--append-system-prompt', o.systemAppend,
    ...(o.model ? ['--model', o.model] : []),
  ];
  const child = spawn('claude', args, {
    cwd: o.cwd,
    env: { ...process.env, MCP_TOOL_TIMEOUT: String(30 * 60_000) }, // ask_user 로 사람을 기다릴 수 있게
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: o.signal,
  });
  child.stdin.end(o.prompt);

  let buf = '';
  let stderr = '';
  let final: AgentResult | null = null;
  let startError: Error | null = null;
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === 'system' && msg.subtype === 'init' && o.mcp) {
        const mine = (msg.mcp_servers ?? []).find((s: { name: string }) => s.name === o.mcp!.server);
        // 도구 없이 시작하면 AI 가 도구를 흉내 낸 글만 쓰고 끝나므로, 연결이 안 됐으면 바로 멈춘다
        if (!mine || mine.status !== 'connected') {
          child.kill();
          startError = new Error(`${o.mcp.server} MCP 서버에 연결하지 못했습니다 (${mine?.status ?? '없음'}). 브라우저가 떠 있는지 확인하고 다시 시도해 주세요.`);
        }
      } else if (msg.type === 'assistant') {
        for (const c of msg.message?.content ?? []) {
          if (c.type === 'tool_use') o.onEvent?.({ type: 'tool', name: String(c.name).replace(/^mcp__[^_]+__/, ''), input: c.input ?? {} });
          if (c.type === 'text' && c.text?.trim()) o.onEvent?.({ type: 'text', text: c.text });
        }
      } else if (msg.type === 'result') {
        const text = String(msg.result ?? '');
        // 사용량 한도에 걸리면 정상 종료처럼 보이는 결과가 온다
        const limited = /hit your .*limit|usage limit|rate limit/i.test(text);
        final = { text: limited ? `Claude 사용량 한도에 걸려 멈췄습니다 (${text})` : text, isError: !!msg.is_error || limited, costUsd: msg.total_cost_usd };
        o.onEvent?.({ type: 'result', text: final.text, isError: final.isError, costUsd: final.costUsd, turns: msg.num_turns });
      }
    }
  });
  const code: number = await new Promise((resolve, reject) => {
    child.on('error', (e) => reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('claude 명령을 찾지 못했습니다. Claude Code 를 설치하고 로그인해 주세요.') : e));
    child.on('close', resolve);
  });
  if (startError) throw startError;
  if (!final) throw new Error(`Claude 실행이 결과 없이 끝났습니다 (코드 ${code}). ${stderr.slice(-500)}`);
  return final;
}

/** 결과 글에서 JSON 을 꺼낸다: 마지막 ```json 블록, 없으면 가장 바깥 { … } */
export function extractJson<T>(text: string): T {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const candidates = blocks.length ? blocks.reverse() : [];
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      /* 다음 후보 */
    }
  }
  throw new Error(`AI 응답에서 JSON 을 찾지 못했습니다: ${text.slice(0, 200)}`);
}
