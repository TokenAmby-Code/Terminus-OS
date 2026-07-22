import type { TxdRequest } from './client.ts';

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

/** The single extension point: subcommands add one declarative entry here. */
export const COMMANDS: readonly Command[] = [
  {
    path: ['health'],
    summary: 'Show txd and estate health',
    run: async ({ request, write }) => { write(await request('GET', '/ctl/health')); return 0; },
  },
];
