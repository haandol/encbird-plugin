import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import Ajv from 'ajv';

const root = new URL('../', import.meta.url);
const plugin = new URL('plugins/encbird/', root);
const json = async (file, base = plugin) => JSON.parse(await readFile(new URL(file, base), 'utf8'));
const ajv = new Ajv2020({ strict: true });
for (const [file, schema] of [['plugin.json', 'plugin.schema.json'], ['mcp.json', 'mcp.schema.json']]) {
  const validate = ajv.compile(await json(`docs/evidence/${schema}`, root));
  assert.ok(validate(await json(file)), `${file}: ${ajv.errorsText(validate.errors)}`);
}
const codex = await json('.codex-plugin/plugin.json');
const claude = await json('.claude-plugin/plugin.json');
const portable = await json('plugin.json');
for (const manifest of [codex, claude, portable]) {
  assert.equal(manifest.name, 'encbird'); assert.equal(manifest.author.name, 'EncBird'); assert.equal(manifest.homepage, 'https://encbird.com');
  assert.equal(manifest.repository, 'https://github.com/haandol/encbird-plugin'); assert.equal(manifest.version, '0.1.0');
}
assert.deepEqual((await json('mcp.json')).mcpServers.encbird.args, ['${PLUGIN_ROOT}/dist/index.js']);
assert.deepEqual(codex.mcpServers.encbird.args, ['${PLUGIN_ROOT}/dist/index.js']);
assert.deepEqual((await json('.mcp.json')).mcpServers.encbird.args, ['${CLAUDE_PLUGIN_ROOT}/dist/index.js']);
assert.equal((await json('.agents/plugins/marketplace.json', root)).plugins[0].source.path, './plugins/encbird');
assert.equal((await json('.claude-plugin/marketplace.json', root)).plugins[0].source, './plugins/encbird');
const contract = await json('contracts/tools.json');
assert.equal(contract.status, 'backend-aligned');
const canonicalRaw = await readFile(new URL('contracts/openapi.json', plugin));
const canonical = JSON.parse(canonicalRaw);
assert.equal(canonical.openapi, '3.1.0');
assert.equal(contract.openapiSha256, createHash('sha256').update(canonicalRaw).digest('hex'));
const expectedTools = [], expectedRoutes = {};
for (const [path, operations] of Object.entries(canonical.paths)) {
  for (const [method, operation] of Object.entries(operations)) {
    const name = operation['x-mcp-tool'];
    if (!name) continue;
    assert.equal(operation['x-mcp-input-schema'], undefined, 'Native OpenAPI is the sole input authority');
    const parameters = operation.parameters ?? [];
    const input = method === 'post' ? operation.requestBody.content['application/json'].schema : {
      type: 'object', properties: Object.fromEntries(parameters.map(p => [p['x-mcp-argument'] ?? p.name, p.schema])),
      required: parameters.filter(p => p.required).map(p => p['x-mcp-argument'] ?? p.name), additionalProperties: false,
    };
    expectedTools.push({ name, description: operation.summary, inputSchema: input, outputSchema: operation.responses['200'].content['application/json'].schema });
    expectedRoutes[name] = { method: method.toUpperCase(), path, operationId: operation.operationId,
      query: parameters.filter(p => p.in === 'query').map(p => p.name),
      pathArguments: Object.fromEntries(parameters.filter(p => p.in === 'path').map(p => [p.name, p['x-mcp-argument'] ?? p.name])),
    };
  }
}
assert.equal(expectedTools.length, 15);
assert.deepEqual(contract.tools, expectedTools);
assert.deepEqual(contract.routes, expectedRoutes);
const contractAjv = new Ajv2020({ strict: true });
contractAjv.addKeyword({ keyword: 'x-maxUtf8Bytes', type: 'string', schemaType: 'number', validate: (limit, value) => Buffer.byteLength(value, 'utf8') <= limit });
for (const tool of contract.tools) { contractAjv.compile(tool.inputSchema); contractAjv.compile(tool.outputSchema); assert.equal(tool.inputSchema.additionalProperties, false); }
const samples = await json('contracts/serialization-samples.json');
for (const tool of contract.tools) {
  assert.ok(contractAjv.compile(tool.inputSchema)(samples[tool.name].input), `${tool.name}: request serialization sample`);
  assert.ok(contractAjv.compile(tool.outputSchema)(samples[tool.name].output), `${tool.name}: response serialization sample`);
}
const build = await json('dist/build-info.json');
const hash = async file => createHash('sha256').update(await readFile(new URL(file, plugin))).digest('hex');
assert.equal(build.contractsSha256, await hash('contracts/tools.json'));
assert.equal(build.bundleSha256, await hash('dist/index.js'));
assert.equal(build.cliSha256, await hash('dist/cli.js'));
await access(new URL('skills/encbird-learning/scripts/encbird.mjs', plugin));
await access(new URL('dist/THIRD_PARTY_LICENSES.txt', plugin));
await access(new URL('skills/encbird-learning/SKILL.md', plugin));
console.log(`Validated portable schemas, host manifests, marketplaces, ${contract.tools.length} tool schemas, and bundle/contract hashes (${contract.status}).`);
