import { COMMANDS, type Command } from './commands.ts';
import { createClient, type TxdRequest } from './client.ts';
import { createLocalClipboard, type LocalClipboard } from './clipboard.ts';
import { findTmuxIdInIdentifiers } from '@terminus-os/contracts';

export type CliDependencies = {
  request: TxdRequest;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  clipboard?: () => LocalClipboard;
};

/**
 * Raw tmux ids live below the membrane and must never surface in an IDENTIFIER
 * the client prints. Output CONTENT is not judged: an answer, a message body or
 * a commit subject is prose, and a print guard cannot know whether a sigil in
 * it is an identifier or a quotation — it is not positioned to know.
 *
 * Judged on the same declared basis as the daemon, from one shared definition.
 */
function assertCanonicalOutput(value: unknown): void {
  if (findTmuxIdInIdentifiers(value)) {
    throw new Error('tx refused output containing a raw tmux identifier');
  }
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
      clipboard: deps.clipboard ?? createLocalClipboard,
    });
  } catch (error) {
    deps.stderr(`tx: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
