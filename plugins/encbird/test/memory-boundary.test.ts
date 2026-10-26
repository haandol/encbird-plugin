import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { LearningTools, type Contract } from '../src/tools.js';
import { CredentialStore } from '../src/store.js';
import { safeError } from '../src/errors.js';
import { mock } from './helpers.js';
import snapshot from '../contracts/tools.json' with { type: 'json' };
import samples from '../contracts/serialization-samples.json' with { type: 'json' };

const retiredTools = ['encbird_save_memory', 'encbird_correct_memory', 'encbird_delete_memory', 'encbird_get_memory', 'encbird_list_memory', 'encbird_save_suggested_expressions', 'encbird_save_freechat_scenarios'];
const expectedTools = [
  'encbird_connect', 'encbird_disconnect', 'encbird_get_context',
  'encbird_list_expressions', 'encbird_search_expressions', 'encbird_get_expression', 'encbird_add_expression',
  'encbird_list_review_quizzes', 'encbird_submit_quiz_result',
  'encbird_list_suggested_expressions', 'encbird_submit_memory_candidates', 'encbird_accept_suggested_expression',
  'encbird_list_freechat_scenarios', 'encbird_get_memory_candidate_status',
].sort();
const factRefsValues = [[], [{ factId: 'private-fact', category: 'interest', version: 1 }], null, 'private-fact'];

test('source route allowlist rejects contracts that reintroduce any retired memory tool', () => {
  for (const name of retiredTools) {
    const contract = structuredClone(snapshot) as unknown as Contract;
    contract.tools[0]!.name = name;
    assert.throws(() => new LearningTools(contract), { code: 'INVALID_CONTRACT' });
  }
});

test('source route allowlist rejects incomplete discovery and altered candidate argument bindings', () => {
  const incomplete = structuredClone(snapshot) as unknown as Contract;
  incomplete.tools.pop();
  assert.throws(() => new LearningTools(incomplete), { code: 'INVALID_CONTRACT' });
  for (const patch of [{ path: '/memory/{id}' }, { method: 'POST' }, { pathArguments: { id: 'userId' } }, { query: ['userId'] }]) {
    const contract = structuredClone(snapshot) as unknown as Contract;
    Object.assign(contract.routes!.encbird_get_memory_candidate_status!, patch);
    assert.throws(() => new LearningTools(contract), { code: 'INVALID_CONTRACT' });
  }
});

for (const mode of ['source', 'bundled stdio']) {
  test(`${mode} enforces the candidate-only memory boundary with authenticated credentials`, async t => {
    const m = await mock(); t.after(() => m.close()); await m.login();
    const tools = new LearningTools();
    let list = async () => tools.list();
    let call = async (name: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      try { return await tools.call(m.auth, name, input); }
      catch (error) { return safeError(error); }
    };
    let activeStore = m.store;
    let stderr = '';
    if (mode === 'bundled stdio') {
      const clientName = 'candidate-boundary-host';
      const scoped = new CredentialStore(m.base, clientName, m.secrets, m.directory); activeStore = scoped;
      await scoped.withLock(async tx => tx.save(await m.read()));
      const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')],
        env: { PATH: process.env.PATH ?? '', ENCBIRD_CREDENTIALS_DIR: m.directory, ENCBIRD_API_BASE_URL: m.base }, stderr: 'pipe' });
      transport.stderr?.on('data', data => { stderr += data; });
      const client = new Client({ name: clientName, version: '1.0.0' });
      t.after(() => client.close()); await client.connect(transport);
      list = async () => (await client.listTools()).tools;
      call = async (name, input = {}) => {
        // Inspect error envelopes on the wire without the SDK applying a success-only output schema.
        const result = await client.request({ method: 'tools/call', params: { name, arguments: input } }, CallToolResultSchema);
        const body = result.structuredContent as Record<string, unknown>;
        assert.ok(body);
        assert.deepEqual(JSON.parse((result.content as { text: string }[])[0]!.text), body);
        assert.equal(result.isError === true, 'error' in body);
        return body;
      };
    }
    // These independent schema scenarios are isolated from the separately tested traffic budget.
    const invoke = call;
    call = async (name, input = {}) => {
      await activeStore.withLock(async tx => { const value = (await tx.load())!; delete value.traffic; await tx.save(value); });
      return invoke(name, input);
    };
    assert.deepEqual(await call('encbird_get_context'), samples.encbird_get_context.output);
    assert.match(m.requests.at(-1)!.token!, /^Bearer AT-/);

    await t.test('discovery exposes exactly twelve learning tools and connect/disconnect', async () => {
      const names = (await list()).map(tool => tool.name).sort();
      assert.deepEqual(names, expectedTools);
      for (const name of retiredTools) assert.ok(!names.includes(name));
    });

    const expectError = (result: Record<string, unknown>, code: string) => {
      assert.equal((result.error as { code: string }).code, code);
      assert.equal(result.data, undefined);
      assert.ok(!JSON.stringify(result).includes('private-fact'));
    };
    await t.test('retired tool names send no HTTP request even after authentication', async () => {
      const before = m.requests.length;
      for (const name of retiredTools) {
        for (const input of [{}, samples.encbird_submit_memory_candidates.input]) {
          expectError(await call(name, input), 'TOOL_UNAVAILABLE');
          assert.equal(m.requests.length, before, name);
        }
      }
    });

    await t.test('factRefs in inputs are rejected before HTTP, including nested memory candidates', async () => {
      const before = m.requests.length;
      for (const [name, sample] of Object.entries(samples)) {
        expectError(await call(name, { ...sample.input, factRefs: [] }), 'INVALID_ARGUMENTS');
      }
      for (const name of ['encbird_submit_memory_candidates'] as const) {
        for (const factRefs of factRefsValues) {
          const input = structuredClone(samples[name].input);
          Object.assign(input.candidates[0]!, { factRefs });
          expectError(await call(name, input), 'INVALID_ARGUMENTS');
        }
      }
      assert.equal(m.requests.length, before);
    });

    await t.test('factRefs in outputs fail closed without returning private references', async () => {
      for (const name of ['encbird_list_suggested_expressions', 'encbird_list_freechat_scenarios'] as const) {
        for (const factRefs of factRefsValues) {
          const output = structuredClone(samples[name].output);
          Object.assign(output.data[0]!, { factRefs });
          m.flags.apiBody = output;
          expectError(await call(name), 'INVALID_RESPONSE');
        }
        const output = structuredClone(samples[name].output);
        Object.assign(output.data[0]!, { external: { factRefs: factRefsValues[1] } });
        m.flags.apiBody = output;
        expectError(await call(name), 'INVALID_RESPONSE');
      }
      m.flags.apiBody = { data: { ...samples.encbird_get_context.output.data, factRefs: factRefsValues[1] } };
      expectError(await call('encbird_get_context'), 'INVALID_RESPONSE');
    });

    await t.test('summary-only profile and activity candidates reach server intake without changing basic profile', async () => {
      m.flags.apiBody = undefined;
      const credentials = await m.read();
      for (const kind of ['profile', 'activity']) {
        const input = { operationKey: `summary-${kind}`, sourceHost: 'codex', sourceSessionId: 'fixture-session',
          candidates: [{ id: `summary-${kind}`, kind, content: 'The learner discussed hiking.', observedAt: '2026-10-01T12:00:00Z' }] };
        const before = m.requests.length;
        assert.deepEqual(await call('encbird_submit_memory_candidates', input), samples.encbird_submit_memory_candidates.output);
        assert.equal(m.requests.length, before + 3);
        assert.equal(m.requests.at(-1)!.method, 'POST');
        assert.equal(m.requests.at(-1)!.path, '/mcp');
        assert.equal((m.requests.at(-1)!.body as any).params.name, 'encbird_submit_memory_candidates');
        assert.deepEqual((m.requests.at(-1)!.body as any).params.arguments, input);
      }
      const current = (await m.read())!; delete current.traffic; delete credentials!.traffic;
      assert.deepEqual(current, credentials);
      assert.deepEqual(await call('encbird_get_context'), samples.encbird_get_context.output);
    });

    await t.test('learning evidence and generated context keep their original roles on the wire', async () => {
      const input = structuredClone(samples.encbird_submit_memory_candidates.input);
      input.candidates[0]!.kind = 'learning';
      input.candidates[0]!.evidenceIds = ['user-1', 'user-3'];
      input.messages = ['user', 'user', 'user', 'user', 'assistant', 'generated'].map((role, i) => ({
        id: `${role}-${i + 1}`, role, content: `Practice observation ${i + 1}.`, observedAt: '2026-10-01T12:00:00Z',
      }));
      assert.deepEqual(await call('encbird_submit_memory_candidates', input), samples.encbird_submit_memory_candidates.output);
      assert.deepEqual((m.requests.at(-1)!.body as any).params.arguments, input);
    });

    await t.test('unknown authority and target fields are rejected at every input level before HTTP', async () => {
      const before = m.requests.length;
      for (const key of ['userId', 'source', 'target', 'factId', 'basicProfile', 'external', 'phraseOrigin']) {
        for (const level of ['batch', 'candidate', 'message']) {
          const input = structuredClone(samples.encbird_submit_memory_candidates.input);
          const target = level === 'batch' ? input : level === 'candidate' ? input.candidates[0]! : input.messages[0]!;
          Object.assign(target, { [key]: 'private-fact' });
          expectError(await call('encbird_submit_memory_candidates', input), 'INVALID_ARGUMENTS');
        }
      }
      for (const input of [{ id: 'a'.repeat(64) }, { candidateId: '../context' }, { candidateId: 'a'.repeat(64), userId: 'other' }]) {
        expectError(await call('encbird_get_memory_candidate_status', input), 'INVALID_ARGUMENTS');
      }
      assert.equal(m.requests.length, before);
    });

    await t.test('candidate privacy filtering blocks excerpts and summary content before HTTP without echoing them', async () => {
      const before = m.requests.length;
      for (const content of ['Contact user@example.com', 'https://private.example/report', 'password: topsecret',
        '010-1234-5678', 'sk-abcdefghijklmno', 'AKIAABCDEFGHIJKLMNOP', 'eyJabc.abc.def', 'bad\u0000control',
        (await m.read())!.accessToken!]) {
        for (const location of ['candidate', 'message']) {
          const input = structuredClone(samples.encbird_submit_memory_candidates.input);
          (location === 'candidate' ? input.candidates[0]! : input.messages[0]!).content = content;
          const result = await call('encbird_submit_memory_candidates', input);
          expectError(result, 'PRIVACY_FILTERED');
          assert.ok(!JSON.stringify(result).includes(content));
        }
      }
      assert.equal(m.requests.length, before);
    });

    await t.test('candidate limits, observation times and actual user evidence fail before HTTP', async () => {
      const before = m.requests.length;
      const sample = () => structuredClone(samples.encbird_submit_memory_candidates.input);
      const invalid: Record<string, unknown>[] = [];
      for (const count of [0, 21]) {
        const input = sample(); input.candidates = Array.from({ length: count }, (_, i) => ({ ...input.candidates[0]!, id: `c-${i}` })); invalid.push(input);
      }
      for (const content of ['', '한'.repeat(667), 'x'.repeat(2001)]) {
        const input = sample(); input.candidates[0]!.content = content; invalid.push(input);
      }
      for (const content of ['', '한'.repeat(1334), 'x'.repeat(4001)]) {
        const input = sample(); input.messages[0]!.content = content; invalid.push(input);
      }
      const tooManyMessages = sample();
      tooManyMessages.messages = Array.from({ length: 81 }, (_, i) => ({ ...tooManyMessages.messages[0]!, id: `m-${i}` }));
      invalid.push(tooManyMessages);
      for (const role of ['assistant', 'generated', 'system']) {
        const input = sample(); input.messages[0]!.role = role; invalid.push(input);
      }
      const missingEvidence = sample(); missingEvidence.candidates[0]!.evidenceIds = ['missing-user-message']; invalid.push(missingEvidence);
      const duplicateMessage = sample(); duplicateMessage.messages.push({ ...duplicateMessage.messages[0]!, role: 'generated' }); invalid.push(duplicateMessage);
      const duplicateCandidate = sample(); duplicateCandidate.candidates.push({ ...duplicateCandidate.candidates[0]! }); invalid.push(duplicateCandidate);
      for (const observedAt of ['', 'yesterday', '2026-10-01', '2026-02-30T12:00:00Z', '2026-10-01T24:00:00Z',
        '2026-10-01T12:00:00+24:00', new Date(Date.now() + 600_000).toISOString()]) {
        for (const location of ['candidate', 'message']) {
          const input = sample(); (location === 'candidate' ? input.candidates[0]! : input.messages[0]!).observedAt = observedAt; invalid.push(input);
        }
      }
      const unknownKind = sample(); unknownKind.candidates[0]!.kind = 'memory_fact'; invalid.push(unknownKind);
      for (const input of invalid) expectError(await call('encbird_submit_memory_candidates', input), 'INVALID_ARGUMENTS');
      assert.equal(m.requests.length, before);

      const input = sample();
      input.messages = Array.from({ length: 80 }, (_, i) => ({ ...input.messages[0]!, id: `m-${i}`, content: 'A short practice observation.', observedAt: '2024-02-29T12:00:00.123+09:00' }));
      input.candidates = Array.from({ length: 20 }, (_, i) => ({ ...input.candidates[0]!, id: `c-${i}`, evidenceIds: ['m-0'] }));
      input.messages[0]!.content = '한'.repeat(1333) + 'a';
      input.candidates[0]!.content = '한'.repeat(666) + 'ab';
      assert.deepEqual(await call('encbird_submit_memory_candidates', input), samples.encbird_submit_memory_candidates.output);
      assert.deepEqual((m.requests.at(-1)!.body as any).params.arguments, input);
    });

    await t.test('the complete serialized request respects the 64 KiB limit before HTTP', async () => {
      const input = structuredClone(samples.encbird_submit_memory_candidates.input);
      input.messages = Array.from({ length: 20 }, (_, i) => ({ ...input.messages[0]!, id: `m-${i}`, content: 'x'.repeat(3000) }));
      input.candidates = Array.from({ length: 2 }, (_, i) => ({ ...input.candidates[0]!, id: `c-${i}`, content: 'x', evidenceIds: ['m-0'] }));
      let remaining = 64 * 1024 - Buffer.byteLength(JSON.stringify(input));
      for (const candidate of input.candidates) {
        const added = Math.min(remaining, 1999); candidate.content += 'x'.repeat(added); remaining -= added;
      }
      input.messages[0]!.content += 'x'.repeat(remaining);
      assert.equal(Buffer.byteLength(JSON.stringify(input)), 64 * 1024);
      assert.deepEqual(await call('encbird_submit_memory_candidates', input), samples.encbird_submit_memory_candidates.output);
      const before = m.requests.length;
      input.messages[1]!.content += 'x';
      expectError(await call('encbird_submit_memory_candidates', input), 'INVALID_ARGUMENTS');
      input.messages[1]!.content = '한' + 'x'.repeat(2999);
      assert.equal(Buffer.byteLength(JSON.stringify(input)), 64 * 1024 + 2);
      expectError(await call('encbird_submit_memory_candidates', input), 'INVALID_ARGUMENTS');
      input.messages[1]!.content = '"' + 'x'.repeat(2999);
      assert.equal(Buffer.byteLength(JSON.stringify(input)), 64 * 1024 + 1);
      expectError(await call('encbird_submit_memory_candidates', input), 'INVALID_ARGUMENTS');
      assert.equal(m.requests.length, before);
    });

    await t.test('only server-returned batch IDs and five processing statuses are exposed, including zero-fact completion', async () => {
      for (const status of ['pending', 'processing', 'completed', 'cancelled', 'failed']) {
        const output = { data: { candidateId: 'b'.repeat(64), status } };
        m.flags.apiBody = output;
        assert.deepEqual(await call('encbird_submit_memory_candidates', samples.encbird_submit_memory_candidates.input), output);
        const before = m.requests.length;
        assert.deepEqual(await call('encbird_get_memory_candidate_status', { candidateId: output.data.candidateId }), output);
        assert.equal(m.requests.length, before + 3);
        assert.equal(m.requests.at(-1)!.method, 'POST');
        assert.equal(m.requests.at(-1)!.path, '/mcp');
        assert.deepEqual((m.requests.at(-1)!.body as any).params, { name: 'encbird_get_memory_candidate_status', arguments: { candidateId: output.data.candidateId } });
      }
      for (const data of [{ candidateId: 'b'.repeat(64), status: 'saved' }, { candidateId: 'b'.repeat(64), status: 'accepted' },
        { candidateId: 'bad', status: 'pending' }, { status: 'completed' },
        { candidateId: 'b'.repeat(64), status: 'completed', facts: [] },
        { candidateId: 'b'.repeat(64), status: 'completed', content: 'private-fact' }]) {
        m.flags.apiBody = { data };
        for (const name of ['encbird_submit_memory_candidates', 'encbird_get_memory_candidate_status'] as const) {
          expectError(await call(name, samples[name].input), 'INVALID_RESPONSE');
        }
      }
    });

    await t.test('server conflicts and failures never confirm memory or retry automatically; explicit retries preserve IDs and keys', async () => {
      const input = structuredClone(samples.encbird_submit_memory_candidates.input);
      input.candidates[0]!.content = 'private-fact observation';
      const before = m.requests.length;
      m.flags.apiStatus = 503; m.flags.apiBody = { error: { code: 'LEARNING_UNAVAILABLE', message: input.candidates[0]!.content } };
      expectError(await call('encbird_submit_memory_candidates', input), 'LEARNING_UNAVAILABLE');
      assert.equal(m.requests.length, before + 3);
      m.flags.apiStatus = 200; m.flags.apiBody = samples.encbird_submit_memory_candidates.output;
      assert.deepEqual(await call('encbird_submit_memory_candidates', input), samples.encbird_submit_memory_candidates.output);
      assert.deepEqual(m.requests.slice(before).filter(request => (request.body as any).method === 'tools/call').map(request => (request.body as any).params.arguments), [input, input]);
      for (const patch of [{ content: 'changed private-fact' }, { kind: 'activity' }, { observedAt: '2026-10-02T12:00:00Z' }]) {
        const changed = structuredClone(input); Object.assign(changed.candidates[0]!, patch);
        m.flags.apiStatus = 409; m.flags.apiBody = { error: { code: 'LEARNING_CONFLICT', message: changed.candidates[0]!.content } };
        const start = m.requests.length;
        expectError(await call('encbird_submit_memory_candidates', changed), 'LEARNING_CONFLICT');
        assert.equal(m.requests.length, start + 3);
        assert.deepEqual((m.requests.at(-1)!.body as any).params.arguments, changed);
      }
      m.flags.apiStatus = 200; m.flags.apiBody = undefined;
    });

    await t.test('material reads allow only internal sources and never expose host artifacts or provenance', async () => {
      const sources = {
        encbird_list_suggested_expressions: ['chatbot', 'diarychat', 'pictochat', 'podcast', 'office-raid'],
        encbird_list_freechat_scenarios: ['DIARYCHAT', 'FREECHAT'],
      };
      for (const name of Object.keys(sources) as (keyof typeof sources)[]) {
        for (const source of sources[name]) {
          const output = structuredClone(samples[name].output); output.data[0]!.source = source; m.flags.apiBody = output;
          const before = m.requests.length;
          assert.deepEqual(await call(name), output);
          assert.equal(m.requests.length, before + 3);
          assert.equal(m.requests.at(-1)!.method, 'POST');
        }
        for (const patch of [{ source: 'external_host' }, { source: 'unknown' }, { external: {} }, { phraseOrigin: 'host_generated' }]) {
          const output = structuredClone(samples[name].output); Object.assign(output.data[0]!, patch); m.flags.apiBody = output;
          expectError(await call(name), 'INVALID_RESPONSE');
        }
      }
    });
    assert.equal(stderr, '');
  });
}
