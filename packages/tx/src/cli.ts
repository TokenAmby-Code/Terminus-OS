import { COMMANDS, type Command } from './commands.ts';
import { createClient, type TxdRequest } from './client.ts';

export type CliDependencies = {
  request: TxdRequest;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

function assertCanonicalOutput(value: unknown): void {
  if (typeof value === 'string' && /(^|[^A-Za-z0-9])[%@$]\d+\b/.test(value)) {
    throw new Error('tx refused output containing a raw tmux identifier');
  }
  if (Array.isArray(value)) for (const item of value) assertCanonicalOutput(item);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) assertCanonicalOutput(item);
}

function usage(commands: readonly Command[]): string {
  const rows = commands.map((command) => `  tx ${command.path.join(' ')}  ${command.summary}`);
  return ['Usage: tx <command>', '', 'Commands:', ...rows].join('\n');
}

export async function runCli(
  argv: string[],
  deps: CliDependencies = { request: createClient(), stdout: console.log, stderr: console.error },
  commands: readonly Command[] = COMMANDS,
): Promise<number> {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    deps.stdout(usage(commands));
    return 0;
  }
  const command = [...commands]
    .sort((a, b) => b.path.length - a.path.length)
    .find((candidate) => candidate.path.every((part, index) => argv[index] === part));
  if (!command) {
    deps.stderr(`tx: unknown command: ${argv.join(' ')}`);
    deps.stderr(usage(commands));
    return 2;
  }
  try {
    return await command.run({
      args: argv.slice(command.path.length),
      request: deps.request,
      write: (value) => { assertCanonicalOutput(value); deps.stdout(JSON.stringify(value, null, 2)); },
    });
  } catch (error) {
    deps.stderr(`tx: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
