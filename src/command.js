import { AgentTimeout } from "./lib/agent-timeout.js";
import { AgentTimeoutError } from "./lib/process-supervisor.js";
/** Public registered argv wrapper. Its execution authority is inherited, never discovered. */
import { NativeExecutableInvocation } from './lib/command-invocation.js';
import { executeManagedProcess, withManagedProcessScope } from './lib/managed-process.js';
import { PROCESS_EXECUTION_SCOPE_ENV } from './lib/process-execution-runtime.js';

const MAX_STDIN_BYTES = 16 * 1024 * 1024;

export class CommandWrapperError extends Error {
  constructor(code, message, exitCode = 125) {
    super(message); this.code = code; this.exitCode = exitCode;
  }
}

async function readInput(stream) {
  const chunks = []; let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_STDIN_BYTES) throw new CommandWrapperError('COMMAND_STDIN_LIMIT', `Standard input exceeds ${MAX_STDIN_BYTES} bytes`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

export async function runCommandWrapper(argv, { environment = process.env, cwd = process.cwd(), stdin = process.stdin } = {}) {
  if (argv[0] !== '--' || argv.length < 2) {
    throw new CommandWrapperError('COMMAND_ARGUMENTS_INVALID', 'Use sennel command -- <executable> [literal argument ...]');
  }
  const serialized = environment[PROCESS_EXECUTION_SCOPE_ENV];
  if (serialized === undefined) throw new CommandWrapperError('COMMAND_CONTEXT_REQUIRED', 'Run this command from an active Sennel execution context');
  let grant;
  try { grant = JSON.parse(serialized); }
  catch { throw new CommandWrapperError('COMMAND_CONTEXT_INVALID', 'Inherited Sennel execution context is malformed'); }
  if (typeof grant?.executionRoot !== 'string') throw new CommandWrapperError('COMMAND_CONTEXT_INVALID', 'Inherited Sennel execution root is missing');
  return withManagedProcessScope({ executionRoot: grant.executionRoot, environment }, async (runtime) => {
    // Authentication completes before consuming input or starting any target.
    const input = stdin.isTTY ? null : await readInput(stdin);
    const invocation = new NativeExecutableInvocation({ executable: argv[1], args: argv.slice(2), cwd,
      env: environment, stdio: [stdin.isTTY ? 'inherit' : 'pipe', 'inherit', 'inherit'] });
    const result = await executeManagedProcess(invocation, [], { runtime, kind: 'command', commandId: 'command',
      stdinContent: input, timeoutMs: new AgentTimeout().toMilliseconds() });
    if (result.signal !== null || result.timedOut || result.aborted) {
      throw new CommandWrapperError('COMMAND_FORCED_TERMINATION', 'Registered command was forcibly terminated', 124);
    }
    if (!Number.isInteger(result.code)) throw new CommandWrapperError('COMMAND_EXECUTION_FAILED', 'Registered command did not return an exit status');
    return result.code;
  });
}

export async function main() {
  try { process.exitCode = await runCommandWrapper(process.argv.slice(2)); }
  catch (error) {
    const forced = error instanceof AgentTimeoutError || error.code === 'ABORT_ERR';
    process.stderr.write(`sennel command: ${forced ? 'COMMAND_FORCED_TERMINATION' : error.code ?? 'COMMAND_CONTROL_FAILED'}: ${error.message}\n`);
    process.exitCode = forced ? 124 : error.exitCode ?? 125;
  }
}
