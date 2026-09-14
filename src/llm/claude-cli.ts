// Claude Code 를 헤드리스(claude -p)로 돌린다. 내장 도구는 모두 끄고, 넘겨받은 MCP 서버의 도구만 쓰게 한다.
import { spawn } from 'node:child_process';

export type AgentEvent =
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  | { type: 'text'; text: string }
  | { type: 'result'; text: string; isError: boolean; costUsd?: number; turns?: number };

export type AgentRun = {
  prompt: string;
  systemAppend: string;
  mcpConfigPath: string;
  /** 허용할 MCP 서버 이름 (mcp__<이름> 으로 허용) */
  mcpServer: string;
  model?: string;
  cwd: string;
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
};

export async function runClaudeAgent(o: AgentRun): Promise<{ text: string; isError: boolean; costUsd?: number }> {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--tools', '', // 내장 도구(Bash, 파일 편집, 웹 등) 전부 끔
    '--strict-mcp-config',
    '--mcp-config', o.mcpConfigPath,
    '--allowedTools', `mcp__${o.mcpServer}`,
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
  let final: { text: string; isError: boolean; costUsd?: number } | null = null;
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
      if (msg.type === 'system' && msg.subtype === 'init') {
        const mine = (msg.mcp_servers ?? []).find((s: { name: string }) => s.name === o.mcpServer);
        // 도구 없이 시작하면 AI 가 도구를 흉내 낸 글만 쓰고 끝나므로, 연결이 안 됐으면 바로 멈춘다
        if (!mine || mine.status !== 'connected') {
          child.kill();
          startError = new Error(`${o.mcpServer} MCP 서버에 연결하지 못했습니다 (${mine?.status ?? '없음'}). 브라우저가 떠 있는지 확인하고 다시 시도해 주세요.`);
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
