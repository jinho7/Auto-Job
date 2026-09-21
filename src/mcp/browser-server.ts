// Stdio transport only. The owner process validates the per-run token and executes every tool.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import pkg from '../../package.json' with { type: 'json' };
import { BridgeClient } from '../apply/bridge';

const bridge = new BridgeClient(process.env.AUTOJOB_BRIDGE_URL ?? '', process.env.AUTOJOB_BRIDGE_TOKEN ?? '');
const server = new Server({ name: 'autojob', version: pkg.version }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await bridge.tools() }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try { return await bridge.call(req.params.name, req.params.arguments ?? {}); }
  catch (e) { return { content: [{ type: 'text', text: `실패: ${(e as Error).message}` }], isError: true }; }
});
await server.connect(new StdioServerTransport());
const shutdown = () => { void server.close().finally(() => process.exit(0)); };
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
