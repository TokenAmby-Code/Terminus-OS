import { expect, test } from 'bun:test';
import { COMMANDS } from '../src/commands.ts';

test('tx is an endpoint client and has no truth-owning dependency', async () => {
  const source = await Promise.all([
    Bun.file(new URL('../src/commands.ts', import.meta.url)).text(),
    Bun.file(new URL('../src/client.ts', import.meta.url)).text(),
    Bun.file(new URL('../src/cli.ts', import.meta.url)).text(),
  ]).then((parts) => parts.join('\n'));

  for (const forbidden of [
    'EventStore', 'PostgresEventStore', 'MemoryEventStore', 'buildProjections',
    'TmuxControlPlane', 'RealTmux', 'FakeTmux', 'sendToSeat',
  ]) expect(source).not.toContain(forbidden);
  expect(source).not.toMatch(/from ['"]\.\.\/\.\.\/txd\//);
});

test('public commands are declarative endpoint pingers with no parallel state surface', () => {
  expect(COMMANDS.map((command) => command.path.join(' '))).toEqual([
    'comm', 'health', 'estate show', 'estate reconcile', 'estate rotate',
  ]);
});
