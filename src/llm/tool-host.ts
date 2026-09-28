// API 로 AI 를 쓸 때 우리 MCP 서버(autojob-browser)의 도구를 직접 부른다.
// Claude Code / Codex 는 MCP 서버를 스스로 띄우지만, API 는 우리가 도구 호출을 대신 전달해야 한다.
// MCP 클라이언트는 실제로 연결할 때만 불러온다. stdio 전송 모듈은 불러오기만 해도 표준 입출력 소켓을 열어,
// 이 파일을 거쳐 가는 모든 곳(테스트 포함)이 끝나지 않고 오래 붙잡혀 있었다.
import pkg from '../../package.json' with { type: 'json' };
import type { McpServerSpec } from './claude-cli';

export type HostTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolOutput = { text: string; images: { data: string; mimeType: string }[]; isError: boolean };

export interface ToolHost {
  tools: HostTool[];
  call(name: string, args: Record<string, unknown>): Promise<ToolOutput>;
  close(): Promise<void>;
}

/** ask_user 로 사람을 기다릴 수 있게 도구 호출 시간 제한을 넉넉히 둔다 */
const CALL_TIMEOUT_MS = 30 * 60_000;

export async function connectMcp(spec: McpServerSpec): Promise<ToolHost> {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/stdio.js')]);
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...(process.env as Record<string, string>), ...spec.env }, stderr: 'pipe' });
  const client = new Client({ name: 'autojob', version: pkg.version });
  await client.connect(transport);
  const listed = await client.listTools();
  return {
    tools: listed.tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema as Record<string, unknown> })),
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
      const content = (r.content ?? []) as { type: string; text?: string; data?: string; mimeType?: string }[];
      return {
        text: content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n'),
        images: content.filter((c) => c.type === 'image' && c.data).map((c) => ({ data: c.data!, mimeType: c.mimeType ?? 'image/jpeg' })),
        isError: !!r.isError,
      };
    },
    close: () => client.close(),
  };
}
