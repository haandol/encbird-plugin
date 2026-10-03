import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

const { server, stop } = createServer();
const shutdown = () => { void stop().finally(() => process.exit(0)); };
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
process.stdin.once('end', shutdown);
await server.connect(new StdioServerTransport());
