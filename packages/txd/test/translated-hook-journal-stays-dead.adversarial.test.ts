// Adversarial lane: raw engine hooks enter txd through the proxy broadcast.
// No invented translated journal spelling may become a second authority.
import { expect, test } from 'bun:test';
import { Daemon } from '../src/core.ts';
import { createTxdEventLane } from '../src/event-journal.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

test('translated hook journal aliases stay dead', () => {
  const lane = createTxdEventLane({ machine: 'test', daemon: new Daemon(new MemoryEventStore(), new FakeTmux()) });
  expect(lane.predicate.exact).not.toContain('agent.stop');
  expect(lane.predicate.exact).not.toContain('agent.prompt_submitted');
  expect(lane.predicateHash).toBe('sha256:txd-events:journal-v2');
});
