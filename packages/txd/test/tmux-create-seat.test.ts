import { expect, test } from 'bun:test';
import { RealTmux, type TmuxCommandResult } from '../src/tmux.ts';

// Behavioral pin: a failed canonical tag is a failed creation. The adapter
// compensates only the session it just created, leaving every existing seat alone.
test('failed canonical tag write removes the newly created seat', async () => {
  const calls: string[][] = [];
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'show-options') return { code: 0, stdout: 'off\n', stderr: '' };
    if (args[0] === 'new-session') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'list-panes') return { code: 0, stdout: '%41\n', stderr: '' };
    if (args[0] === 'set-option') return { code: 1, stdout: '', stderr: 'tag refused' };
    if (args[0] === 'kill-session') return { code: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected tmux call: ${args[0]}`);
  };
  const tmux = new RealTmux('scratch', { run });

  await expect(tmux.createSeat('somnium:NE')).rejects.toThrow('tag');

  expect(calls.at(-1)).toEqual(['kill-session', '-t', 'seat_somnium_NE']);
  expect(calls.filter((args) => args[0] === 'kill-session')).toHaveLength(1);
});
