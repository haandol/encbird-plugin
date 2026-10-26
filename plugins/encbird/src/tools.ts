import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import snapshot from '../contracts/tools.json' with { type: 'json' };
import { uncertainOutcome, SafeError } from './errors.js';
import type { Auth } from './auth.js';
import { filterExternalInput } from './privacy.js';
import { validateCandidateEvidence } from './candidates.js';

const routes: Record<string, { method: 'GET' | 'POST'; path: string; query?: string[]; pathArguments?: Record<string, string> }> = {
  encbird_get_context: { method: 'GET', path: '/context' },
  encbird_list_expressions: { method: 'GET', path: '/expressions', query: ['limit', 'beforeAt'] },
  encbird_search_expressions: { method: 'GET', path: '/expressions/search', query: ['query', 'limit'] },
  encbird_get_expression: { method: 'GET', path: '/expressions/{id}', pathArguments: { id: 'expressionId' } },
  encbird_add_expression: { method: 'POST', path: '/expressions' },
  encbird_list_review_quizzes: { method: 'GET', path: '/review-quizzes' },
  encbird_submit_quiz_result: { method: 'POST', path: '/quiz-results' },
  encbird_list_suggested_expressions: { method: 'GET', path: '/suggested-expressions' },
  encbird_accept_suggested_expression: { method: 'POST', path: '/suggested-expressions/accept' },
  encbird_list_freechat_scenarios: { method: 'GET', path: '/freechat-scenarios' },
  encbird_submit_memory_candidates: { method: 'POST', path: '/memory-candidates' },
  encbird_get_memory_candidate_status: { method: 'GET', path: '/memory-candidates/{id}', pathArguments: { id: 'candidateId' } },
};
export const localTools: Tool[] = [
  { name: 'encbird_connect', description: 'Start EncBird browser sign-in or check its progress. Never supply tokens. Call again after completing browser sign-in.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'encbird_disconnect', description: 'Disable local learning access, revoke the EncBird connection and provider refresh token, or retry pending cleanup.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];
type Route = { method: 'GET' | 'POST'; path: string; query: string[]; pathArguments: Record<string, string> };
export interface Contract { apiVersion: string; contractVersion?: string; status: string; tools: Tool[]; routes?: Record<string, Route> }
export class LearningTools {
  readonly tools: Tool[];
  private validators;
  private outputValidators;
  private routes: Record<string, Route>;
  constructor(contract: Contract = snapshot as unknown as Contract) {
    if (contract.apiVersion !== '1' || !['integration-stub', 'backend-aligned'].includes(contract.status)) throw new SafeError('INVALID_CONTRACT', 'The bundled learning contract version or status is unsupported. Ask the local operator to reinstall a compatible plugin before retrying; do not edit the bundled contract.');
    const names = new Set<string>();
    for (const tool of contract.tools) {
      if (!Object.hasOwn(routes, tool.name) || names.has(tool.name) || tool.inputSchema.type !== 'object' || tool.inputSchema.additionalProperties !== false || Object.hasOwn(tool.inputSchema.properties ?? {}, 'userId')) {
        throw new SafeError('INVALID_CONTRACT', 'The bundled contract contains a duplicate or unsupported tool or authority field. Ask the local operator to reinstall a verified plugin before retrying; do not add authority fields or bypass validation.');
      }
      names.add(tool.name);
    }
    this.tools = contract.status === 'backend-aligned' ? contract.tools : [];
    this.routes = contract.routes ?? {};
    if (contract.status === 'backend-aligned' && (contract.contractVersion !== '3.0.0' || names.size !== Object.keys(routes).length || Object.keys(this.routes).length !== names.size)) {
      throw new SafeError('INVALID_CONTRACT', 'The bundled learning contract is incomplete or incompatible. Ask the local operator to reinstall a compatible plugin before retrying; do not patch the contract manually.');
    }
    for (const tool of this.tools) {
      const route = this.routes[tool.name];
      const expected = routes[tool.name]!;
      if (!route || route.method !== expected.method || route.path !== expected.path || !tool.outputSchema ||
          JSON.stringify(route.query) !== JSON.stringify(expected.query ?? []) ||
          JSON.stringify(route.pathArguments) !== JSON.stringify(expected.pathArguments ?? {})) {
        throw new SafeError('INVALID_CONTRACT', 'The bundled route or output definition does not match supported tools. Ask the local operator to reinstall a verified compatible plugin before retrying; do not use a direct API route to bypass validation.');
      }
    }
    const ajv = new Ajv2020({ strict: true, allErrors: false });
    ajv.addKeyword({ keyword: 'x-maxUtf8Bytes', type: 'string', schemaType: 'number', validate: (limit: number, value: string) => Buffer.byteLength(value, 'utf8') <= limit });
    this.validators = new Map([...localTools, ...this.tools].map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
    this.outputValidators = new Map(this.tools.map(tool => [tool.name, ajv.compile(tool.outputSchema!)]));
  }
  list() { return [...localTools, ...this.tools]; }
  isReadOnly(name: string) { return this.routes[name]?.method === 'GET'; }
  validateInput(name: string, input: Record<string, unknown>) {
    const validator = this.validators.get(name);
    if (!validator) throw new SafeError('TOOL_UNAVAILABLE', 'This tool is not available in the installed contract. Discover available tools and choose one that supports the learner request; do not invent tool names or substitute direct API calls.');
    if (!validator(input) || Object.hasOwn(input, 'userId')) throw new SafeError('INVALID_ARGUMENTS', 'Tool arguments do not match the installed input schema. Discover the tool schema and correct required fields, types, and limits before calling it again; never supply userId, tokens, or invented approval. This call sent no request.');
  }
  async call(auth: Auth, name: string, input: Record<string, unknown> = {}) {
    this.validateInput(name, input);
    if (name === 'encbird_connect') return auth.connect();
    if (name === 'encbird_disconnect') return auth.disconnect();
    filterExternalInput(name, input, auth.secrets);
    if (name === 'encbird_submit_memory_candidates') validateCandidateEvidence(input);
    const route = this.routes[name]!;
    for (const argument of Object.values(route.pathArguments)) {
      const id = input[argument];
      if (typeof id !== 'string' || !id || ['.', '..'].includes(id)) throw new SafeError('INVALID_ARGUMENTS', 'The resource identifier is empty or a path traversal segment. Use the identifier returned by the matching EncBird list or submission tool before calling again. This call sent no request.');
    }
    const result = await auth.callLearningTool(name, input);
    if (!this.outputValidators.get(name)!(result)) throw new SafeError('INVALID_RESPONSE', `EncBird returned data that does not match the installed output schema. Ask the operator to align plugin and service versions before retrying. ${uncertainOutcome}`);
    return result;
  }
}
