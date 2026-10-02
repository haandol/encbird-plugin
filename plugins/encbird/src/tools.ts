import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import snapshot from '../contracts/tools.json' with { type: 'json' };
import { SafeError } from './errors.js';
import type { Auth } from './auth.js';
import { filterExternalInput } from './privacy.js';

const routes: Record<string, { method: 'GET' | 'POST'; path: string; query?: string[]; id?: boolean }> = {
  encbird_get_context: { method: 'GET', path: '/context' },
  encbird_list_expressions: { method: 'GET', path: '/expressions', query: ['limit', 'beforeAt'] },
  encbird_search_expressions: { method: 'GET', path: '/expressions/search', query: ['query', 'limit'] },
  encbird_get_expression: { method: 'GET', path: '/expressions/{id}', id: true },
  encbird_add_expression: { method: 'POST', path: '/expressions' },
  encbird_list_review_quizzes: { method: 'GET', path: '/review-quizzes' },
  encbird_submit_quiz_result: { method: 'POST', path: '/quiz-results' },
  encbird_save_memory: { method: 'POST', path: '/memory' },
  encbird_correct_memory: { method: 'POST', path: '/memory/corrections' },
  encbird_delete_memory: { method: 'POST', path: '/memory/deletions' },
  encbird_list_suggested_expressions: { method: 'GET', path: '/suggested-expressions' },
  encbird_save_suggested_expressions: { method: 'POST', path: '/suggested-expressions' },
  encbird_accept_suggested_expression: { method: 'POST', path: '/suggested-expressions/accept' },
  encbird_list_freechat_scenarios: { method: 'GET', path: '/freechat-scenarios' },
  encbird_save_freechat_scenarios: { method: 'POST', path: '/freechat-scenarios' },
};
export const localTools: Tool[] = [
  { name: 'encbird_connect', description: 'Start EncBird browser sign-in or check its progress. Never supply tokens. Call again after completing browser sign-in.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'encbird_disconnect', description: 'Disable local learning access, revoke the EncBird connection and provider refresh token, or retry pending cleanup.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];
type Route = { method: 'GET' | 'POST'; path: string; query: string[]; pathArguments: Record<string, string> };
export interface Contract { apiVersion: string; status: string; tools: Tool[]; routes?: Record<string, Route> }
export class LearningTools {
  readonly tools: Tool[];
  private validators;
  private outputValidators;
  private routes: Record<string, Route>;
  constructor(contract: Contract = snapshot as unknown as Contract) {
    if (contract.apiVersion !== '1' || !['integration-stub', 'backend-aligned'].includes(contract.status)) throw new SafeError('INVALID_CONTRACT', 'The bundled learning contract is not supported.');
    const names = new Set<string>();
    for (const tool of contract.tools) {
      if (!Object.hasOwn(routes, tool.name) || names.has(tool.name) || tool.inputSchema.type !== 'object' || tool.inputSchema.additionalProperties !== false || Object.hasOwn(tool.inputSchema.properties ?? {}, 'userId')) {
        throw new SafeError('INVALID_CONTRACT', 'The bundled contract contains an unsupported tool or authority field.');
      }
      names.add(tool.name);
    }
    this.tools = contract.status === 'backend-aligned' ? contract.tools : [];
    this.routes = contract.routes ?? {};
    for (const tool of this.tools) {
      const route = this.routes[tool.name];
      if (!route || route.method !== routes[tool.name]!.method || route.path !== routes[tool.name]!.path || !tool.outputSchema) {
        throw new SafeError('INVALID_CONTRACT', 'The bundled route or output contract is not supported.');
      }
    }
    const ajv = new Ajv2020({ strict: true, allErrors: false });
    ajv.addKeyword({ keyword: 'x-maxUtf8Bytes', type: 'string', schemaType: 'number', validate: (limit: number, value: string) => Buffer.byteLength(value, 'utf8') <= limit });
    this.validators = new Map([...localTools, ...this.tools].map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
    this.outputValidators = new Map(this.tools.map(tool => [tool.name, ajv.compile(tool.outputSchema!)]));
  }
  list() { return [...localTools, ...this.tools]; }
  async call(auth: Auth, name: string, input: Record<string, unknown> = {}) {
    const validator = this.validators.get(name);
    if (!validator) throw new SafeError('TOOL_UNAVAILABLE', 'This tool is not available in the installed contract. Discover the available tools first.');
    if (!validator(input) || Object.hasOwn(input, 'userId')) throw new SafeError('INVALID_ARGUMENTS', 'Tool arguments do not match the bundled contract.');
    if (name === 'encbird_connect') return auth.connect();
    if (name === 'encbird_disconnect') return auth.disconnect();
    filterExternalInput(name, input, auth.secrets);
    const route = this.routes[name]!;
    let path = route.path;
    for (const [parameter, argument] of Object.entries(route.pathArguments)) {
      const id = input[argument];
      if (typeof id !== 'string' || !id || ['.', '..'].includes(id)) throw new SafeError('INVALID_ARGUMENTS', 'An expression identifier is required.');
      path = path.replace(`{${parameter}}`, encodeURIComponent(id));
    }
    if (route.query) {
      const query = new URLSearchParams();
      for (const key of route.query) if (input[key] !== undefined) query.set(key, String(input[key]));
      if (query.size) path += `?${query}`;
    }
    const result = { data: await auth.request(route.method, path, route.method === 'POST' ? input : undefined) };
    if (!this.outputValidators.get(name)!(result)) throw new SafeError('INVALID_RESPONSE', 'EncBird returned data that does not match the installed contract.');
    return result;
  }
}
