import { constants, openSync, closeSync, writeSync, fstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadContracts, serviceError } from './lib/contracts.mjs';
import { readJSON, readScoped, sha256 } from './lib/files.mjs';
import { classifyAttempt } from './lib/policy.mjs';

const MAX_TRACE_BYTES = 4 * 1024 * 1024;
const response = body => ({ content: [{ type: 'text', text: JSON.stringify(body) }], ...(body.error ? { isError: true } : { structuredContent: body }) });

export async function startFixture({ runRoot, contextFile, traceFile, transport = new StdioServerTransport() }) {
  const context = await readJSON(runRoot, contextFile);
  const testCase = await readJSON(runRoot, `snapshot/cases/${context.caseId}.json`);
  const phase = testCase.phases.find(item => item.id === context.phaseId);
  if (!phase) throw new Error('UNKNOWN_FIXTURE_PHASE');
  const { tools, error: validateError } = await loadContracts(runRoot, 'snapshot/contracts/tools.json');
  const manifest = await readJSON(runRoot, 'manifest.json');
  const existing = (await readScoped(runRoot, traceFile)).toString('utf8');
  const tracePath = path.join(runRoot, traceFile);
  const fd = openSync(tracePath, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW);
  if (Buffer.byteLength(existing) > MAX_TRACE_BYTES) throw new Error('TRACE_LIMIT');
  const prior = existing.trim() ? existing.trim().split('\n').map(line => JSON.parse(line)).filter(event => event.kind === 'attempt') : [];
  const pending = new Map();
  let closed = false;
  const append = event => {
    const line = `${JSON.stringify(event)}\n`;
    if (fstatSync(fd).size + Buffer.byteLength(line) > MAX_TRACE_BYTES) throw new Error('TRACE_LIMIT');
    writeSync(fd, line);
  };
  const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: 'Synthetic EncBird learning tools for this user phase. The account is already connected. No network, sign-in, browser, credentials, files outside guidance, or arbitrary commands are available.' });
  server.onerror = () => {};
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools.values()].map(item => item.tool) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const entry = pending.get(JSON.stringify(extra.requestId));
    if (!entry) throw new Error('UNAUDITED_CALL');
    const { name, input } = entry.attempt;
    const spec = tools.get(name);
    if (!spec || !spec.input(input)) {
      entry.decision = { allowed: false, code: 'INVALID_CONTRACT_INPUT' };
      return response(serviceError('FIXTURE_DENIED', 'The attempted call does not match an available public tool schema.'));
    }
    entry.decision = classifyAttempt(testCase, phase, name, input, prior.filter(event => event.callId !== entry.attempt.callId));
    if (!entry.decision.allowed) return response(serviceError('FIXTURE_DENIED', 'This effect is not authorized by the original user phase. The attempted call is recorded.'));
    let body;
    if (entry.decision.guidance) {
      try {
        const bytes = await readScoped(runRoot, `snapshot/guidance/${input.path}`);
        const hash = sha256(bytes);
        if (hash !== manifest.snapshots[`snapshot/guidance/${input.path}`]) throw new Error('GUIDANCE_CHANGED');
        body = { path: input.path, sha256: hash, text: bytes.toString('utf8') };
      } catch {
        entry.decision = { allowed: false, code: 'GUIDANCE_SCOPE_OR_INTEGRITY' };
        return response(serviceError('FIXTURE_DENIED', 'Guidance scope or integrity check failed.'));
      }
    } else body = phase.rules[entry.decision.ruleIndex].output;
    if (body.error ? !validateError(body) : !spec.output(body)) {
      entry.decision = { allowed: false, code: 'FIXTURE_OUTPUT_INVALID', infrastructureError: true };
      return response(serviceError('FIXTURE_ERROR', 'Synthetic output does not match the snapshotted public contract.'));
    }
    return response(body);
  });

  // Observe raw decoded requests before the SDK validates a call's parameters.
  const audited = {
    onmessage: undefined, onerror: undefined, onclose: undefined,
    async start() {
      transport.onmessage = (message, extra) => {
        if (message.method === 'tools/call') {
          const callId = `${context.caseId}.${context.phaseId}.${randomUUID()}`;
          const attempt = { id: `${callId}.attempt`, callId, kind: 'attempt', phaseId: phase.id, name: message.params?.name ?? null, input: message.params && Object.hasOwn(message.params, 'arguments') ? message.params.arguments : {}, at: Date.now() };
          try {
            append(attempt);
            pending.set(JSON.stringify(message.id), { attempt, decision: { allowed: false, code: 'INVALID_MCP_REQUEST' } });
            prior.push(attempt);
          } catch {
            audited.onerror?.(new Error('TRACE_LIMIT'));
            void audited.close();
            return;
          }
        }
        audited.onmessage?.(message, extra);
      };
      transport.onerror = error => audited.onerror?.(error);
      transport.onclose = () => audited.onclose?.();
      await transport.start();
    },
    async send(message, options) {
      const entry = pending.get(JSON.stringify(message.id));
      if (entry && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
        const body = message.result?.structuredContent;
        append({ id: `${entry.attempt.callId}.result`, callId: entry.attempt.callId, kind: 'result', phaseId: phase.id, at: Date.now(), decision: entry.decision,
          status: body?.error || message.result?.isError || message.error ? 'error' : 'completed', result: message.result ?? null,
          ...(message.error ? { protocolError: { code: message.error.code, message: 'MCP request rejected before handler completion.' } } : {}) });
        pending.delete(JSON.stringify(message.id));
      }
      await transport.send(message, options);
    },
    async close() {
      if (closed) return;
      closed = true;
      await transport.close();
      closeSync(fd);
    },
  };
  await server.connect(audited);
  return { server, close: () => server.close() };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== '--run-root' || args[2] !== '--context' || args[4] !== '--trace') throw new Error('INVALID_FIXTURE_INVOCATION');
  await startFixture({ runRoot: path.resolve(args[1]), contextFile: args[3], traceFile: args[5] });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.stderr.write('Fixture startup failed.\n'); process.exitCode = 1; });

