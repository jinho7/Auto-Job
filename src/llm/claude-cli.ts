// Claude Code 를 헤드리스(claude -p)로 돌린다.
// 내장 도구는 넘겨받은 것만(기본: 없음), MCP 는 넘겨받은 서버만 쓴다. 사용자의 다른 MCP 설정은 불러오지 않는다.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { waitForAgentExit } from './process';

export type AgentEvent =
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  | { type: 'text'; text: string }
  | { type: 'result'; text: string; isError: boolean; costUsd?: number; turns?: number }
  /** 연결을 바꿈 (한도, 로그인 문제) */
  | { type: 'switch'; from: string; reason: string };

export type AgentRun = {
  prompt: string;
  systemAppend: string;
  /** 쓸 수 있는 내장 도구 (예: ['WebSearch', 'WebFetch']). 비우면 내장 도구 없음 */
  tools?: string[];
  /** 쓸 MCP 서버 (stdio 로 띄울 명령) */
  mcp?: McpServerSpec;
  /** 읽어도 되는 폴더 (tools 에 Read/Glob/Grep 이 있을 때). 이 폴더 밖의 파일은 읽지 못한다 */
  readDirs?: string[];
  /** 추가 환경 변수 (계정 폴더 등) */
  env?: Record<string, string>;
  model?: string;
  /** 추론 성능 (low | medium | high | xhigh | max). 연결 종류에 맞게 바꿔 넘긴다 */
  effort?: string;
  cwd: string;
  /** 이 시간 동안 아무 반응이 없으면 멈추고 다음 연결로 넘어간다 (0 이면 끄기) */
  stallMs?: number;
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
  /** Only supplied MCP tools; no user plugins, shell, or implicit tools (conversation/browser agents). */
  isolated?: boolean;
};

/**
 * 한도에 걸린 신호. 요즘 CLI 는 한도에 걸리면 오류로 끝내지 않고 **풀릴 때까지 기다렸다가 이어서** 한다.
 * 그러면 몇 시간이고 붙잡혀 있게 되므로, 이 말이 보이면 바로 멈추고 다음 AI 연결로 넘어간다.
 */
export const LIMIT_SIGNAL =
  /usage limit reached|limit reached|hit your (?:usage |session |weekly |5-hour )?limit|limit will reset|resets? at \d|사용량 한도에 도달|사용량 한도에 걸|한도에 도달했지만|한도가 초과/i;

const FILE_TOOLS = new Set(['Read', 'Glob', 'Grep']);

export type McpServerSpec = { server: string; command: string; args: string[]; env: Record<string, string> };

export type AgentResult = { text: string; isError: boolean; costUsd?: number; /** 실제로 쓴 연결 */ connection?: string };

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
  o.signal?.throwIfAborted();
  const tools = o.tools ?? [];
  // 파일 도구는 허용 목록에 넣지 않는다: 그러면 작업 폴더(cwd, --add-dir) 안에서만 저절로 허용되고 밖은 거절된다
  const allowed = [...tools.filter((t) => !FILE_TOOLS.has(t)), ...(o.mcp ? [`mcp__${o.mcp.server}`] : [])];
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--tools', tools.join(','), // "" 이면 내장 도구 전부 끔
    '--strict-mcp-config', // 사용자의 다른 MCP 서버는 불러오지 않는다
    ...(o.mcp ? ['--mcp-config', writeClaudeMcpConfig(o.mcp, o.cwd)] : []),
    ...(o.readDirs ?? []).flatMap((d) => ['--add-dir', d]),
    ...(allowed.length ? ['--allowedTools', allowed.join(',')] : []),
    '--permission-mode', 'dontAsk', // 허용 목록에 없는 것은 묻지 않고 거절
    '--no-session-persistence',
    '--append-system-prompt', o.systemAppend,
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : []),
  ];
  const child = spawn('claude', args, {
    cwd: o.cwd,
    env: { ...process.env, ...o.env, MCP_TOOL_TIMEOUT: String(30 * 60_000) }, // ask_user 로 사람을 기다릴 수 있게
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = waitForAgentExit(child, o.signal);
  child.stdin.on('error', () => {});
  child.stdin.end(o.prompt);

  let buf = '';
  let stderr = '';
  let final: AgentResult | null = null;
  let startError: Error | null = null;
  child.stderr.on('data', (d) => (stderr += d));
  let stall: NodeJS.Timeout | null = null;
  const beat = () => {
    if (!o.stallMs) return;
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => {
      startError ??= new Error(`AI 가 ${Math.round(o.stallMs! / 60_000)}분 동안 아무 반응이 없어 멈췄습니다 (다음 연결로 넘어갑니다)`);
      child.kill();
    }, o.stallMs);
    stall.unref?.();
  };
  beat();
  child.stdout.on('data', (d: Buffer) => {
    beat();
    buf += d.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      // 한도 신호는 어떤 메시지로 오든(알림, 이어서 하기 안내) 바로 잡아서 다음 연결로 넘어간다
      if (LIMIT_SIGNAL.test(line)) {
        startError ??= new Error(`Claude 사용량 한도에 걸렸습니다: ${line.slice(0, 200)}`);
        child.kill();
        continue;
      }
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
  const code = await exited.catch(e => {
    throw (e as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('claude 명령을 찾지 못했습니다. Claude Code 를 설치하고 로그인해 주세요.') : e;
  }).finally(() => { if (stall) clearTimeout(stall); });
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
