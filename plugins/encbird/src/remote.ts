import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { validateBase } from './config.js';
import { SafeError } from './errors.js';
import { object, serviceUrl } from './http.js';
import { retryAfterSeconds } from './traffic.js';

export function remoteMcpUrl(base: string): string {
  return new URL('/mcp', validateBase(base)).href;
}

function domainCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  const code = data.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
  return domainCode(data.error);
}

function remoteError(value: unknown, fallback = 'MCP_TOOL_FAILED', status?: number, pause?: number): SafeError {
  const code = domainCode(value) ?? fallback;
  if (status === 429 || status === 503) {
    return new SafeError(domainCode(value) ?? (status === 429 ? 'RATE_LIMITED' : 'SERVICE_UNAVAILABLE'),
      'The service requested a pause. Wait before retrying; keep the same input and operation key for writes.', pause);
  }
  if (status === 401 || ['AUTH_REQUIRED', 'AUTHENTICATION_REQUIRED', 'UNAUTHORIZED'].includes(code)) {
    return new SafeError('AUTH_REQUIRED', 'EncBird rejected this connection. Reconnect or retry the same operation after refresh.');
  }
  if (code === 'CONNECTION_INACTIVE') return new SafeError(code, 'This connection is inactive. Run connect for same-account browser recovery.');
  return new SafeError(code, 'EncBird could not complete the request. If retrying a write, keep the same operation key and payload.');
}

function toolEnvelope(result: CallToolResult): Record<string, unknown> {
  let envelope: unknown = result.structuredContent;
  if (envelope === undefined && result.content.length === 1 && result.content[0]?.type === 'text') {
    try { envelope = JSON.parse(result.content[0].text); } catch { /* Reject non-JSON content below. */ }
  }
  if (result.isError) throw remoteError(envelope);
  const value = object(envelope);
  if (Object.hasOwn(value, 'error')) throw remoteError(value);
  if (!Object.hasOwn(value, 'data')) throw new SafeError('INVALID_RESPONSE', 'The MCP result did not contain an EncBird data envelope.');
  return value;
}

async function boundedBody(response: Response): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = response.body?.getReader();
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_048_576) { await reader.cancel(); throw new SafeError('INVALID_RESPONSE', 'The remote MCP response exceeded its size limit.'); }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function callRemoteTool(base: string, currentToken: () => Promise<string>, name: string,
  args: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const endpoint = remoteMcpUrl(base);
  const client = new Client({ name: 'encbird-stdio-bridge', version: '0.1.0' }, { capabilities: {} });
  client.onerror = () => {}; // SDK errors can include remote payloads; only safe errors leave this boundary.
  const inFlight = new Set<Promise<Response>>();
  const performFetch: typeof fetch = async (input, init) => {
    if (serviceUrl(input instanceof Request ? input.url : String(input)).href !== endpoint) {
      throw new SafeError('INVALID_ROUTE', 'MCP requests must use the configured EncBird endpoint.');
    }
    // StreamableHTTPClientTransport probes optional SSE after initialization. This stateless bridge declines it locally.
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    if (init?.method !== 'POST' || typeof init.body !== 'string') throw new SafeError('MCP_PROTOCOL_ERROR', 'Unsupported MCP transport operation.');
    const request = object(JSON.parse(init.body));
    const notification = !Object.hasOwn(request, 'id');
    const headers = new Headers(init.headers);
    if (headers.has('mcp-session-id')) throw new SafeError('MCP_PROTOCOL_ERROR', 'This bridge requires a stateless MCP server.');
    headers.set('authorization', `Bearer ${await currentToken()}`);
    headers.set('accept', 'application/json, text/event-stream');
    headers.set('content-type', 'application/json');
    try {
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init.signal ? [init.signal] : [])]);
      const response = await fetch(endpoint, { ...init, headers, signal, redirect: 'error', credentials: 'omit' });
      if (response.headers.has('mcp-session-id')) {
        await response.body?.cancel();
        throw new SafeError('MCP_PROTOCOL_ERROR', 'The remote MCP server unexpectedly issued a session.');
      }
      const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (response.ok && !notification && mediaType !== 'application/json') {
        await response.body?.cancel();
        throw new SafeError('INVALID_RESPONSE', 'The remote MCP server must return stateless JSON responses.');
      }
      const overloaded = response.status === 429 || response.status === 503;
      const pause = overloaded ? retryAfterSeconds(response.headers.get('retry-after')) : undefined;
      let raw: string;
      try { raw = await boundedBody(response); }
      catch (error) {
        if (overloaded) throw remoteError(undefined, 'MCP_HTTP_ERROR', response.status, pause);
        throw error;
      }
      let body: unknown;
      if (raw) { try { body = JSON.parse(raw); } catch { /* Status errors remain safe even without JSON. */ } }
      if (!response.ok) throw remoteError(body, 'MCP_HTTP_ERROR', response.status, pause);
      if (notification) {
        if (![200, 202, 204].includes(response.status) || raw.trim()) throw new SafeError('MCP_PROTOCOL_ERROR', 'The MCP notification acknowledgement was invalid.');
        return new Response(null, { status: response.status });
      }
      const message = object(body);
      if (message.jsonrpc !== '2.0' || message.id !== request.id || Object.hasOwn(message, 'method') ||
          (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) {
        throw new SafeError('INVALID_RESPONSE', 'The remote MCP response did not match its request.');
      }
      return new Response(raw, { status: response.status, headers: { 'content-type': 'application/json' } });
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError('NETWORK_ERROR', 'The remote MCP request failed. No fallback or automatic retry was attempted.');
    }
  };
  const guardedFetch: typeof fetch = (input, init) => {
    const request = performFetch(input, init);
    inFlight.add(request);
    void request.finally(() => inFlight.delete(request)).catch(() => {});
    return request;
  };
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: guardedFetch,
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  try {
    await client.connect(transport, { timeout: timeoutMs * 3 + 1000 });
    return toolEnvelope(CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs + 1000 })));
  } catch (error) {
    if (error instanceof SafeError) throw error;
    if (error instanceof McpError) {
      if (domainCode(error.data)) throw remoteError(error.data);
      throw remoteError(undefined, error.code === -32601 ? 'TOOL_UNAVAILABLE' : 'MCP_PROTOCOL_ERROR');
    }
    throw new SafeError('MCP_PROTOCOL_ERROR', 'The remote MCP negotiation or result was invalid. No automatic retry was attempted.');
  } finally {
    await client.close().catch(() => {});
    // Keep the credential lock until any refresh already started by the transport has settled.
    await Promise.allSettled([...inFlight]);
  }
}
