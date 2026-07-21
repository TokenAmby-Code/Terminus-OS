import { expect, test } from 'bun:test';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { registration } from './registration-fixture.ts';

test('ready registered agent delivery uses the active registered route', async () => {
  const store = new MemoryEventStore(); const tmux = new FakeTmux(); const d = new Daemon(store, tmux);
  await d.launch(registration('somnium:NE'));
  const result = await d.send({ schema_version: 5, target: 'somnium:NE', text: 'hello' });
  expect(result).toMatchObject({ verdict: 'delivered', gate_reason: null });
});

test('unregistered operator pane is closed to routing', async () => {
  const store = new MemoryEventStore(); const d = new Daemon(store, new FakeTmux()); await d.constructEstate();
  expect(await d.send({ schema_version: 5, target: 'somnium:NE', text: 'hello' })).toMatchObject({ refused: true, reason: 'unregistered' });
});
