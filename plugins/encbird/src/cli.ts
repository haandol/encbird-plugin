import { PluginRuntime } from './runtime.js';
import { SafeError, safeError } from './errors.js';

const MAX_INPUT_BYTES = 1_048_576;
const MAX_READS = 5;
type Call = { name: string; arguments: Record<string, unknown> };

async function readInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_INPUT_BYTES) throw new SafeError('INVALID_ARGUMENTS', 'Script input exceeds 1 MiB.');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SafeError('INVALID_ARGUMENTS', 'Provide one JSON value on standard input.'); }
}

function argumentsObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SafeError('INVALID_ARGUMENTS', 'Tool arguments must be a JSON object.');
  return value as Record<string, unknown>;
}

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  const runtime = new PluginRuntime(() => 'encbird-script');
  const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  let cancelled = false;
  const checkCancelled = () => { if (cancelled) throw new SafeError('AUTH_CANCELLED', 'Script execution was cancelled. No further calls were started.'); };
  const cancel = () => { cancelled = true; process.stdin.destroy(); void runtime.stop(); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    if (args.length === 1 && args[0] === 'list') {
      output({ data: { tools: runtime.tools.list().map(({ name, description }) => ({ name, description, readOnly: runtime.tools.isReadOnly(name) })) } }); return 0;
    }
    if (args.length === 2 && args[0] === 'describe') {
      const tool = runtime.tools.list().find(tool => tool.name === args[1]);
      if (!tool) throw new SafeError('TOOL_UNAVAILABLE', 'This tool is not available in the installed contract.');
      output({ data: tool }); return 0;
    }
    if (args.length === 2 && args[0] === 'call') {
      const name = args[1]!;
      const input = argumentsObject(await readInput());
      checkCancelled();
      let result = await runtime.call(name, input);
      if (name === 'encbird_connect' && (result.data as { status?: string } | undefined)?.status === 'authentication_pending') {
        process.stderr.write('Finish EncBird sign-in in the browser. This process stays open until sign-in completes.\n');
        await runtime.waitForSignIn();
        checkCancelled();
        result = await runtime.call(name, {});
      }
      checkCancelled();
      output(result); return 'error' in result ? 1 : 0;
    }
    if (args.length !== 1 || args[0] !== 'read-plan') throw new SafeError('INVALID_ARGUMENTS', 'Use list, describe <tool-name>, call <tool-name>, or read-plan. Pass call arguments or the read plan as JSON on standard input.');
    const input = await readInput();
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_READS) throw new SafeError('INVALID_ARGUMENTS', 'A read plan must contain 1 to 5 calls.');
    const calls: Call[] = input.map(item => {
      const call = argumentsObject(item);
      if (Object.keys(call).some(key => !['name', 'arguments'].includes(key)) || typeof call.name !== 'string') throw new SafeError('INVALID_ARGUMENTS', 'Each call requires name and arguments only.');
      const args = argumentsObject(call.arguments);
      runtime.tools.validateInput(call.name, args);
      if (!runtime.tools.isReadOnly(call.name)) throw new SafeError('INVALID_ARGUMENTS', 'Read plans cannot include writes or account connection changes. Use one explicit call for those operations.');
      return { name: call.name, arguments: args };
    });
    // Validate the whole plan before any network access, then stop at the first failure.
    const results = [];
    for (const call of calls) {
      checkCancelled();
      const result = await runtime.call(call.name, call.arguments);
      results.push({ name: call.name, result });
      if ('error' in result) { output({ data: { status: 'stopped', results } }); return 1; }
    }
    output({ data: { status: 'completed', results } }); return 0;
  } catch (error) { output(safeError(error)); return 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); await runtime.stop(); }
}
