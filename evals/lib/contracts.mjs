import { Ajv2020 } from 'ajv/dist/2020.js';
import { readJSON, same } from './files.mjs';

export const guidanceTool = {
  name: 'read_guidance',
  description: 'Read a snapshotted EncBird Skill reference by its exact relative path. No other files are accessible.',
  inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { path: { type: 'string' }, sha256: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'sha256', 'text'], additionalProperties: false },
};

export async function loadContracts(root, file = 'plugins/encbird/contracts/tools.json') {
  const contract = await readJSON(root, file);
  if (contract.apiVersion !== '1' || !Array.isArray(contract.tools)) throw new Error('INVALID_PUBLIC_CONTRACT');
  const openapi = await readJSON(root, file.replace(/tools\.json$/, 'openapi.json'));
  const errorSchemas = Object.values(openapi.paths ?? {}).flatMap(item => Object.values(item).map(operation => operation?.responses?.default?.content?.['application/json']?.schema).filter(Boolean));
  if (!errorSchemas.length || errorSchemas.some(schema => !same(schema, errorSchemas[0]))) throw new Error('UNSUPPORTED_PUBLIC_ERROR_CONTRACT');
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addKeyword({ keyword: 'x-maxUtf8Bytes', type: 'string', schemaType: 'number', validate: (limit, value) => Buffer.byteLength(value, 'utf8') <= limit });
  const tools = new Map();
  for (const tool of [...contract.tools, guidanceTool]) {
    if (tools.has(tool.name) || !tool.outputSchema) throw new Error('INVALID_PUBLIC_CONTRACT');
    tools.set(tool.name, { tool, input: ajv.compile(tool.inputSchema), output: ajv.compile(tool.outputSchema) });
  }
  return { contract, tools, error: ajv.compile(errorSchemas[0]) };
}

// Public client errors use this envelope; they are distinct from successful data.
export function serviceError(code, message, retryAfterSeconds) {
  return { error: { code, message, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) } };
}

