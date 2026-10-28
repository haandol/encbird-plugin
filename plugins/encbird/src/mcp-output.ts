import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const errorOutputSchema: NonNullable<Tool['outputSchema']> = {
  type: 'object', additionalProperties: false, required: ['error'],
  properties: {
    error: {
      type: 'object', additionalProperties: false, required: ['code', 'message'],
      properties: {
        code: { type: 'string' }, message: { type: 'string' },
        retryAfterSeconds: { type: 'integer', minimum: 1, maximum: 86400 },
      },
    },
  },
};

// Discovery describes both wire outcomes; successful service data stays strictly validated separately.
export function withErrorOutputSchemas(tools: Tool[]): Tool[] {
  return tools.map(tool => !tool.outputSchema ? tool : {
    ...tool,
    outputSchema: { type: 'object', oneOf: [tool.outputSchema, errorOutputSchema] },
  });
}
