import { expect, test } from 'bun:test';
import { MemoryEventStore } from '../src/store.ts';
import { buildProjections } from '../src/projections.ts';
import type { EventInput } from '@terminus-os/contracts';

// Committed replay-bound test (spec §2): full projection rebuild < 1s at 10k
// events. The bound is ENFORCED, not aspirational — no snapshots exist, so this
// guards the keep-forever / replay-from-zero decision.
test('full projection rebuild is < 1s at 10k events', async () => {
  const store = new MemoryEventStore();

  const batch: EventInput[] = [];
  const prov = { source: 'wrapper' as const, transport_receipt: null, emitter_version: 1 };
  for (let i = 0; i < 2500; i++) {
    const seat = `seat:${i}`;
    const inst = `inst:${i}`;
    batch.push({ entity_type: 'seat', entity_id: seat, event_type: 'reg.pane_created', payload: { pane_state: 'live' }, provenance: prov, occurred_at: '2026-07-12T00:00:00Z' });
    batch.push({ entity_type: 'seat', entity_id: seat, event_type: 'reg.bound', payload: { instance_id: inst, persona: 'p', tint: '#101010' }, provenance: prov, occurred_at: '2026-07-12T00:00:00Z' });
    batch.push({ entity_type: 'instance', entity_id: inst, event_type: 'act.prompt_submitted', payload: {}, provenance: prov, occurred_at: '2026-07-12T00:00:00Z' });
    batch.push({ entity_type: 'send', entity_id: `snd:${i}`, event_type: 'act.send_enqueued', payload: { target: seat }, provenance: prov, occurred_at: '2026-07-12T00:00:00Z' });
  }
  await store.appendAll(batch);
  expect(await store.count()).toBe(10_000);

  const events = await store.readAll();
  const t0 = performance.now();
  const proj = buildProjections(events);
  const ms = performance.now() - t0;

  expect(proj.currentBindings.length).toBe(2500);
  expect(proj.activityBoard.length).toBe(2500);
  expect(ms).toBeLessThan(1000);
  await store.close();
});
