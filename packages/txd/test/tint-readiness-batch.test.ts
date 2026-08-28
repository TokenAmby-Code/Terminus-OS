// Behavioral-pin: the estate read observes all physical tint/generation facts
// in one tmux transaction. Adding seats must not add tmux commands.

import { expect, test } from 'bun:test';
import { Daemon } from '../src/core.ts';
import { TXD_ESTATE } from '../src/estate.ts';
import { MemoryEventStore } from '../src/store.ts';
import { RealTmux, type TmuxCommandResult } from '../src/tmux.ts';

function observationRows(count: number): string {
  return Array.from({ length: count }, (_, index) => [
    `proof:${index}`,
    '0',
    index % 2 === 0 ? 'bg=#302800' : 'default',
    index % 2 === 0 ? 'bg=#302800' : 'default',
    `generation-${index}`,
  ].join('\t')).join('\n');
}

test.each([1, 64])('tint readiness uses one tmux command for %i observed seats', async (seatCount) => {
  let commands = 0;
  const run = async (): Promise<TmuxCommandResult> => {
    commands += 1;
    return { code: 0, stdout: `${observationRows(seatCount)}\n`, stderr: '' };
  };
  const daemon = new Daemon(
    new MemoryEventStore(),
    new RealTmux('scratch', { run, audit: () => {} }),
  );

  const readiness = await daemon.tintReadiness();

  expect(readiness).toHaveLength(seatCount + TXD_ESTATE.length);
  expect(readiness.find((row) => row.seat_id === 'proof:0')).toMatchObject({
    observed: '#302800',
    state: 'mismatched',
  });
  if (seatCount > 1) {
    expect(readiness.find((row) => row.seat_id === 'proof:1')).toMatchObject({
      observed: null,
      state: 'ready',
    });
  }
  expect(commands).toBe(1);
});
