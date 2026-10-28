import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PluginRuntime } from './runtime.js';
import { pluginVersion } from './version.js';
import { withErrorOutputSchemas } from './mcp-output.js';

export function createServer() {
  const server = new Server({ name: 'encbird', version: pluginVersion }, { capabilities: { tools: {} },
    instructions: 'Reads return EncBird-generated materials and basic profile only. Memory candidates are intake for EncBird evaluation, not direct memory writes or confirmation; completed processing may produce zero facts. Do not expose memory, fact references, or directly edit profiles from candidates. Use EncBird tools for account data; adapt teaching and explanations to the learner. Sign in through the browser, never request tokens. Reuse relevant results and avoid polling or parallel request loops. Honor retryAfterSeconds. Retry a write only with its original input/key when the error permits it. Report saves only when confirmed. Preserve user approval and learner ratings. Before sending any learning arguments, exclude PII and secrets: identifying names, contact details, exact birth dates or locations, government/account/payment identifiers, health or biometric details, and identifying combinations. Check queries, expressions, answers, candidates, messages and metadata; send only minimum nonidentifying information and required opaque references. Context consent and passing filters do not authorize PII uploads. Do not probe filters with raw PII or disguise it across fields or transports. Generalized observations are host-authored candidates, never actual user messages. Omit unsafe evidence and its references; if an actual answer contains PII, do not submit or rewrite it as the original attempt. Withhold uncertain cases and preserve prior operation inputs/keys without replaying PII. Keep authentication inside the runtime.' });
  const runtime = new PluginRuntime(() => server.getClientVersion()?.name ?? 'unknown-mcp-client');
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: withErrorOutputSchemas(runtime.tools.list()) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const result = await runtime.call(request.params.name, request.params.arguments);
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }],
      ...('error' in result ? { isError: true } : {}) };
  });
  server.onerror = () => {}; // Transport errors never include payloads or credentials in logs.
  return { server, stop: async () => { await runtime.stop(); await server.close(); } };
}
