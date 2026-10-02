import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolveBase, DEFAULT_BASE, validateOAuth } from '../src/config.js';
import { Secrets, safeError } from '../src/errors.js';
import { requestJson } from '../src/http.js';
import { LearningTools, type Contract } from '../src/tools.js';
import snapshot from '../contracts/tools.json' with { type: 'json' };
import { mock } from './helpers.js';
import samples from '../contracts/serialization-samples.json' with { type: 'json' };

test('production default; override permits only explicit loopback HTTP with no implicit fallback', () => {
  assert.equal(resolveBase(undefined), DEFAULT_BASE);
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(resolveBase(`http://${host}:1234/v1/mcp-learning`), `http://${host}:1234/v1/mcp-learning`);
  for (const url of ['https://localhost/x', 'https://api.encbird.com/v1/mcp-learning', 'http://evil.example/x', 'http://127.0.0.1.evil.example/x',
    'http://user:pass@localhost/x', 'http://localhost/x?key=x', 'http://localhost/x#x', '', 'file:///tmp/x']) assert.throws(() => resolveBase(url), { code: 'INVALID_CONFIG' });
});

test('bootstrap rejects unsafe OAuth endpoints, wrong redirect, missing openid', async t => {
  const m = await mock(); t.after(() => m.close());
  assert.throws(() => validateOAuth(m.config, DEFAULT_BASE), { code: 'INVALID_CONFIG' });
  for (const patch of [{ redirectUri: 'http://localhost:9999/callback' }, { scopes: ['learning'] },
    { tokenEndpoint: 'http://localhost:8888/token' }, { issuer: 'https://user:pass@issuer.example' }, { authorizationEndpoint: 'javascript:evil' }]) {
    assert.throws(() => validateOAuth({ ...m.config, ...patch }, m.base), { code: 'INVALID_CONFIG' });
  }
});

test('all fifteen data tools are discoverable; unsupported tools and userId authority are rejected', async t => {
  const m = await mock(); t.after(() => m.close());
  const stub = new LearningTools(); assert.equal(stub.list().length, 17);
  await assert.rejects(stub.call(m.auth, 'not_allowed'), { code: 'TOOL_UNAVAILABLE' });
  await assert.rejects(stub.call(m.auth, 'encbird_connect', { userId: 'someone-else' }), { code: 'INVALID_ARGUMENTS' });
  const contract = structuredClone(snapshot) as unknown as Contract; contract.status = 'backend-aligned';
  contract.tools[0]!.name = 'run_arbitrary_command'; assert.throws(() => new LearningTools(contract), { code: 'INVALID_CONTRACT' });
});

test('aligned contract dispatches all fifteen fixed routes, encoded query/id, and exact write payloads', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  const tools = new LearningTools({ ...snapshot, status: 'backend-aligned' } as unknown as Contract);
  for (const tool of snapshot.tools) {
    const sample = (samples as Record<string, { input: Record<string, unknown>; output: unknown }>)[tool.name]!;
    const args = sample.input;
    const route = (snapshot.routes as Record<string, { method: string; path: string; query: string[]; pathArguments: Record<string,string> }>)[tool.name]!;
    let path = route.path;
    for (const [parameter, argument] of Object.entries(route.pathArguments)) path = path.replace(`{${parameter}}`, encodeURIComponent(String(args[argument])));
    const query = new URLSearchParams(); for (const key of route.query) if (args[key] !== undefined) query.set(key, String(args[key]));
    if (query.size) path += `?${query}`;
    const result = await tools.call(m.auth, tool.name, args); const request = m.requests.at(-1)!;
    assert.deepEqual(result, sample.output);
    assert.equal(request.method, route.method); assert.equal(request.path, `/v1/mcp-learning${path}`);
    if (route.method === 'POST') assert.deepEqual(request.body, args);
    assert.match(request.token!, /^Bearer AT-/);
  }
  await assert.rejects(tools.call(m.auth, 'encbird_add_expression', { phrase: 'x', userId: 'evil', idempotencyKey: 'key' }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(tools.call(m.auth, 'encbird_get_expression', { expressionId: '..' }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(tools.call(m.auth, 'encbird_submit_quiz_result', { quizId: 'q1', answer: 'x', rating: 5 }), { code: 'INVALID_ARGUMENTS' });
});

test('server errors expose safe codes only; a failed write never automatically repeats', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  m.flags.apiStatus = 500; m.flags.apiBody = { error: { code: 'RATE_LIMITED', message: 'secret token stack trace at api.go:42' } };
  const before = m.requests.length;
  let failure: unknown; try { await m.auth.request('POST', '/expressions', { phrase: 'hello', idempotencyKey: 'same' }); } catch (error) { failure = safeError(error); }
  assert.equal(m.requests.length - before, 1);
  assert.equal((failure as any).error.code, 'RATE_LIMITED'); assert.ok(!JSON.stringify(failure).includes('api.go'));
  m.flags.apiStatus = 200; m.flags.apiBody = { unexpected: true };
  await assert.rejects(m.auth.request('GET', '/context'), { code: 'INVALID_RESPONSE' });
});

test('401 requires explicit same-operation retry, refresh happens before that retry', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login(); m.flags.apiStatus = 401;
  m.flags.apiBody = { error: { code: 'UNAUTHORIZED', message: 'unsafe' } };
  await assert.rejects(m.auth.request('POST', '/quiz-results', { idempotencyKey: 'same' }), { code: 'AUTH_REQUIRED' });
  assert.equal(m.counts.refresh, 0); m.flags.apiStatus = 200; m.flags.apiBody = { data: { saved: true } };
  await m.auth.request('POST', '/quiz-results', { idempotencyKey: 'same' }); assert.equal(m.counts.refresh, 1);
  assert.deepEqual(m.requests.filter(r => r.path.endsWith('/quiz-results')).map(r => r.body), [{ idempotencyKey: 'same' }, { idempotencyKey: 'same' }]);
});

test('403 domain errors preserve safe protocol codes without exposing server text', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  m.flags.apiStatus = 403; m.flags.apiBody = { error: { code: 'LEARNING_SOURCE_UNAVAILABLE', message: 'private server stack' } };
  await assert.rejects(m.auth.request('POST', '/memory', {}), error => {
    const result = safeError(error); assert.equal(result.error.code, 'LEARNING_SOURCE_UNAVAILABLE');
    assert.ok(!result.error.message.includes('stack')); return true;
  });
});

test('secret filter redacts nested credential keys, known tokens, JWTs and bearer strings', () => {
  const secrets = new Secrets(); secrets.add('sensitive-access', 'rotated-refresh');
  const clean = JSON.stringify(secrets.clean({ access_token: 'sensitive-access', nested: [{ refreshToken: 'rotated-refresh',
    text: 'sensitive-access rotated-refresh Bearer something eyJabc.abc.def' }] }));
  for (const value of ['sensitive-access', 'rotated-refresh', 'something', 'eyJabc.abc.def']) assert.ok(!clean.includes(value));
  assert.ok(!JSON.stringify(safeError(new Error('private-stack'))).includes('private-stack'));
});

test('CONNECTION_INACTIVE disables the family and requires new browser sign-in instead of refreshing', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  m.flags.apiStatus = 403; m.flags.apiBody = { error: { code: 'CONNECTION_INACTIVE', message: 'internal detail' } };
  await assert.rejects(m.auth.request('GET', '/context'), { code: 'CONNECTION_INACTIVE' });
  assert.equal(m.counts.refresh, 0); assert.equal(m.counts.disconnect, 1); assert.equal(m.counts.revoke, 1);
  assert.equal(await m.read(), undefined);
  await assert.rejects(m.auth.request('GET', '/context'), { code: 'AUTH_REQUIRED' });
  const authorizations = () => m.requests.filter(r => r.path.startsWith('/authorize')).length;
  assert.equal(authorizations(), 1); await m.auth.connect(); await m.auth.waitForIdle(); assert.equal(authorizations(), 2);
});

test('inactive family with failed revocation remains disabled until cleanup succeeds', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login(); m.flags.providerFailure = true;
  m.flags.apiStatus = 403; m.flags.apiBody = { error: { code: 'CONNECTION_INACTIVE', message: 'unsafe' } };
  await assert.rejects(m.auth.request('GET', '/context'), { code: 'CONNECTION_INACTIVE' });
  assert.equal((await m.read())?.status, 'disabled'); assert.equal(m.counts.refresh, 0);
  assert.equal(((await m.auth.connect()).error as any).code, 'CLEANUP_REQUIRED'); await m.auth.waitForIdle();
  await assert.rejects(m.auth.request('GET', '/context'), { code: 'AUTH_REQUIRED' }); assert.equal(m.counts.refresh, 0);
});

test('network redirect, invalid JSON, and oversized responses fail closed without fallback', async t => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url!);
    if (req.url === '/redirect') res.writeHead(302, { location: '/fallback' }).end();
    else if (req.url === '/large') res.end('x'.repeat(1_048_577));
    else res.end('not json');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number }; const origin = `http://127.0.0.1:${address.port}`;
  await assert.rejects(requestJson(`${origin}/redirect`), { code: 'NETWORK_ERROR' });
  await assert.rejects(requestJson(`${origin}/bad`), { code: 'INVALID_RESPONSE' });
  await assert.rejects(requestJson(`${origin}/large`), { code: 'INVALID_RESPONSE' });
  assert.deepEqual(seen, ['/redirect', '/bad', '/large']);
});
