// 테스트용 MCP 서버: echo(글자), shot(이미지) 도구
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'echo', version: '0.0.1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: '받은 글을 돌려준다', inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'shot', description: '이미지', inputSchema: { type: 'object' as const, properties: {} } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'echo') return { content: [{ type: 'text', text: `echo:${(req.params.arguments as { text: string }).text}:${process.env.ECHO_TAG ?? ''}` }] };
  if (req.params.name === 'shot') return { content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/jpeg' }] };
  return { content: [{ type: 'text', text: 'none' }], isError: true };
});
await server.connect(new StdioServerTransport());
