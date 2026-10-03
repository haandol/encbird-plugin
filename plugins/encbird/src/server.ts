import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PluginRuntime } from './runtime.js';

export function createServer() {
  const server = new Server({ name: 'encbird', version: '0.1.0' }, { capabilities: { tools: {} },
    instructions: 'Use EncBird tools for account data; adapt teaching and explanations to the learner. Sign in through the browser, never request tokens. Reuse relevant results and avoid polling or parallel request loops. Honor retryAfterSeconds. Retry a write only with its original input/key when the error permits it. Report saves only when confirmed. Preserve user approval and learner ratings.' });
  const runtime = new PluginRuntime(() => server.getClientVersion()?.name ?? 'unknown-mcp-client');
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: runtime.tools.list() }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const result = await runtime.call(request.params.name, request.params.arguments);
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }],
      ...('error' in result ? { isError: true } : {}) };
  });
  server.onerror = () => {}; // Transport errors never include payloads or credentials in logs.
  return { server, stop: async () => { await runtime.stop(); await server.close(); } };
}
