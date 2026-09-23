// OpenAI Codex CLI 를 헤드리스(codex exec --json)로 돌린다 (ChatGPT 구독 또는 OpenAI API 키로 로그인한 codex).
// Codex 에는 "시스템 프롬프트 덧붙이기"가 없어 지시문을 작업 앞에 붙인다. 파일은 읽기 전용(read-only) 샌드박스로 돌린다.
// MCP 서버와 웹 검색은 -c 설정 덮어쓰기로 이번 실행에만 켠다.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LIMIT_SIGNAL, type AgentResult, type AgentRun } from './claude-cli';
import { spawnFailure, waitForAgentExit } from './process';

const WEB = new Set(['WebSearch', 'WebFetch']);
/** TOML 값: 문자열/배열/인라인 표. JSON 문자열 표기는 TOML 기본 문자열로도 유효하다 */
const toml = (v: unknown): string =>
  typeof v === 'string' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(toml).join(', ')}]` : v && typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)} = ${toml(x)}`).join(', ')} }` : String(v);

export function codexArgs(o: AgentRun, lastFile: string): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', o.cwd, '--output-last-message', lastFile];
  if (o.isolated) {
    args.push('--ephemeral', '--ignore-user-config', '--ignore-rules', '-c', 'approval_policy="never"', '-c', `web_search=${toml((o.tools ?? []).some(t => WEB.has(t)) ? 'live' : 'disabled')}`);
    for (const feature of ['shell_tool', 'unified_exec', 'apply_patch_freeform', 'plugins', 'apps', 'multi_agent', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'hooks', 'memories', 'workspace_dependencies', 'in_app_browser']) args.push('--disable', feature);
  }
  if (o.model) args.push('--model', o.model);
  // 사용자가 고른 추론 수준을 그대로 전달한다. 지원 여부는 선택한 모델/CLI가 판단한다.
  if (o.effort) args.push('-c', `model_reasoning_effort=${toml(o.effort)}`);
  if ((o.tools ?? []).some((t) => WEB.has(t))) args.push('-c', 'tools.web_search=true');
  if (o.mcp) {
    const k = `mcp_servers.${o.mcp.server}`;
    args.push('-c', `${k}.command=${toml(o.mcp.command)}`, '-c', `${k}.args=${toml(o.mcp.args)}`, '-c', `${k}.env=${toml(o.mcp.env)}`, '-c', `${k}.tool_timeout_sec=1800`);
    // codex exec 는 승인 정책이 never 로 고정이라, 이 서버의 도구를 미리 승인해 두지 않으면
    // 도구 호출이 전부 "승인이 필요하지만 승인 정책이 never" 로 거절된다 (지원서를 한 칸도 못 채운다)
    args.push('-c', `${k}.default_tools_approval_mode="approve"`);
    if (o.isolated) args.push('-c', `${k}.required=true`);
  }
  args.push('-'); // 작업 내용은 표준 입력으로
  return args;
}

export function codexPrompt(o: AgentRun): string {
  return `# 지시\n${o.systemAppend}\n\n# 작업\n${o.prompt}`;
}

export async function runCodexAgent(o: AgentRun, bin = 'codex'): Promise<AgentResult> {
  // 작업 폴더가 없으면 실행 오류(ENOENT)가 "명령을 찾지 못함"처럼 보여, 멀쩡한 연결을 쉬게 만든다. 먼저 따로 알린다
  if (!existsSync(o.cwd)) throw new Error(`AI 작업 폴더가 없습니다 (이미 끝난 작업일 수 있습니다): ${o.cwd}`);
  o.signal?.throwIfAborted();
  const lastFile = path.join(o.cwd, `codex-last-${Date.now()}.txt`);
  const child = spawn(bin, codexArgs(o, lastFile), { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = waitForAgentExit(child, o.signal);
  child.stdin.on('error', () => {});
  child.stdin.end(codexPrompt(o));
  let buf = '';
  let stderr = '';
  let lastMessage = '';
  let failure = '';
  child.stderr.on('data', (d) => (stderr += d));
  let stall: NodeJS.Timeout | null = null;
  const beat = () => {
    if (!o.stallMs) return;
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => {
      failure ||= `AI 가 ${Math.round(o.stallMs! / 60_000)}분 동안 아무 반응이 없어 멈췄습니다 (다음 연결로 넘어갑니다)`;
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
      // 한도에 걸리면 CLI 가 풀릴 때까지 기다리기도 한다. 그 전에 멈추고 다음 연결로 넘어간다
      if (LIMIT_SIGNAL.test(line)) {
        failure ||= `사용량 한도에 걸렸습니다: ${line.slice(0, 200)}`;
        child.kill();
        continue;
      }
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const item = msg.item ?? {};
      if (msg.type === 'item.started' && item.type === 'mcp_tool_call') o.onEvent?.({ type: 'tool', name: String(item.tool ?? ''), input: item.arguments ?? {} });
      else if (msg.type === 'item.started' && item.type === 'web_search') o.onEvent?.({ type: 'tool', name: 'web_search', input: { query: item.query } });
      else if (msg.type === 'item.completed' && item.type === 'agent_message' && item.text) {
        lastMessage = String(item.text);
        o.onEvent?.({ type: 'text', text: lastMessage });
      } else if (msg.type === 'turn.failed' || msg.type === 'error') failure = String(msg.error?.message ?? msg.message ?? '실패');
    }
  });
  const code = await exited.catch(e => {
    throw spawnFailure(e, bin, o.cwd, 'codex 명령을 찾지 못했습니다. Codex CLI 를 설치하고 로그인해 주세요 (npm i -g @openai/codex, codex login).');
  }).finally(() => { if (stall) clearTimeout(stall); });
  const text = existsSync(lastFile) ? readFileSync(lastFile, 'utf8') : lastMessage;
  const isError = !!failure || (code !== 0 && !text);
  const result = { text: isError ? `Codex 실행 실패: ${failure || stderr.slice(-400) || `코드 ${code}`}` : text, isError };
  o.onEvent?.({ type: 'result', text: result.text, isError });
  return result;
}
