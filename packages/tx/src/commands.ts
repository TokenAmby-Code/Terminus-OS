import type { TxdRequest } from './client.ts';
import { SCHEMA_VERSION } from '@terminus-os/contracts';

export type CommandContext = {
  args: string[];
  request: TxdRequest;
  write: (value: unknown) => void;
};

export type Command = {
  path: readonly string[];
  summary: string;
  run: (context: CommandContext) => Promise<number>;
};

function commSource(): string {
  const value = process.env.TX_INSTANCE_ID;
  if (!value) throw new Error('TX_INSTANCE_ID is required for tx comm');
  return value;
}

async function comm({ args, request, write }: CommandContext): Promise<number> {
  let ask = false;
  let page: string | undefined;
  let reply = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if ((page || reply) && positional.length === 0) {
      positional.push(...args.slice(index));
      break;
    }
    const arg = args[index]!;
    if (arg === '--ask') ask = true;
    else if (arg === '--reply') reply = true;
    else if (arg === '--page') {
      page = args[++index];
      if (!page) throw new Error('--page requires a page name');
    } else if (arg.startsWith('-') && positional.length === 0) throw new Error(`unknown comm option: ${arg}`);
    else {
      positional.push(...args.slice(index));
      break;
    }
  }
  if (reply) {
    if (page || ask || positional.length !== 1) throw new Error('usage: tx comm --reply <message>');
  } else if (page) {
    if (positional.length !== 1) throw new Error('usage: tx comm [--ask] --page <page> <message>');
  } else if (positional.length !== 2) throw new Error('usage: tx comm [--ask] <identity> <message>');
  const message = positional.at(-1)!;
  const accepted = await request('POST', '/agents/comm', {
    schema_version: SCHEMA_VERSION, source_instance_id: commSource(), message, ask, reply,
    ...(page ? { page } : {}), ...(!page && !reply ? { target: positional[0] } : {}),
  }) as { ask_id: string | null };
  write(accepted);
  if (!ask) return 0;
  const result = await request('POST', '/agents/comm/wait', {
    schema_version: SCHEMA_VERSION, ask_id: accepted.ask_id, subscriber_instance_id: commSource(), timeout_ms: 7 * 60 * 1000,
  }) as { complete: boolean };
  write(result);
  return result.complete ? 0 : 3;
}

/** The single extension point: subcommands add one declarative entry here. */
export const COMMANDS: readonly Command[] = [
  { path: ['comm'], summary: 'Send, ask, page, or reply through txd event truth', run: comm },
  {
    path: ['health'],
    summary: 'Show txd and estate health',
    run: async ({ request, write }) => { write(await request('GET', '/ctl/health')); return 0; },
  },
  {
    path: ['estate', 'show'],
    summary: 'Show estate generation, compatibility, and seats',
    run: async ({ args, request, write }) => {
      if (args.length) throw new Error('usage: tx estate show');
      write(await request('GET', '/tmux/read/estate'));
      return 0;
    },
  },
  {
    path: ['estate', 'reconcile'],
    summary: 'Observe and non-destructively reconcile the estate',
    run: async ({ args, request, write }) => {
      if (args.length) throw new Error('usage: tx estate reconcile');
      write(await request('POST', '/ctl/reconcile', {}));
      return 0;
    },
  },
  {
    path: ['estate', 'rotate'],
    summary: 'Explicitly rotate the local estate generation',
    run: async ({ args, request, write }) => {
      if (args.some((arg) => arg !== '--force') || args.filter((arg) => arg === '--force').length > 1) {
        throw new Error('usage: tx estate rotate [--force]');
      }
      write(await request('POST', '/ctl/estate/rotate', {
        schema_version: SCHEMA_VERSION,
        force: args.includes('--force'),
      }));
      return 0;
    },
  },
];
