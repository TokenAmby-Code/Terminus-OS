// Adversarial lane: the removed tx dash grammar must never return as an alias.
import { expect, test } from 'bun:test';
import { runCli } from '../src/cli.ts';

test('old journal dispose dash form stays dead with the shared typed refusal', async () => {
  const errors: string[] = [];
  let transported = false;
  const exit = await runCli(
    ['journal', 'dispose', '417', '--reason', 'control'],
    {
      request: async () => { transported = true; },
      stdout: () => {},
      stderr: (line) => errors.push(line),
      timezone: async () => 'America/Phoenix',
    },
  );
  expect(exit).toBe(64);
  expect(errors.join('\n')).toContain('unknown_flag');
  expect(transported).toBe(false);
});
