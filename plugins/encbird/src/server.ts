import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Auth } from './auth.js';
import { resolveBase } from './config.js';
import { Secrets, safeError } from './errors.js';
import { CredentialStore } from './store.js';
import { LearningTools } from './tools.js';

export function createServer() {
  const server = new Server({ name: 'encbird', version: '0.1.0' }, { capabilities: { tools: {} },
    instructions: 'Discover available tools. EncBird authentication happens in the browser; never request or print tokens. Only report saved results returned by a tool.' });
  const tools = new LearningTools();
  const secrets = new Secrets();
  let auth: Auth | undefined;
  const getAuth = () => {
    if (!auth) {
      const base = resolveBase();
      const clientName = server.getClientVersion()?.name ?? 'unknown-mcp-client';
      auth = new Auth(base, new CredentialStore(base, clientName, secrets), secrets);
    }
    return auth;
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.list() }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    let result: Record<string, unknown>;
    try { result = await tools.call(getAuth(), request.params.name, request.params.arguments); }
    catch (error) { result = safeError(error); }
    const cleaned = secrets.clean(result) as Record<string, unknown>;
    return { structuredContent: cleaned, content: [{ type: 'text', text: JSON.stringify(cleaned) }],
      ...('error' in cleaned ? { isError: true } : {}) };
  });
  server.onerror = () => {}; // Transport errors never include payloads or credentials in logs.
  return { server, stop: async () => { await auth?.cancel(); await server.close(); } };
}
