// Adversarial: the hollow attestation surface stays dead.
//
// Two shapes are named here so neither can return by a quiet edit.
//
//   - An admitted event type with no writer. `act.comm_delivery_failed` sat in
//     the contract union with 1334 rows in the journal (last 2026-08-06) and no
//     emitter left in the runtime, so the surface answered for a state the
//     daemon could no longer reach. A contract that declares a fact nothing
//     writes is the same defect as a shim, sited where a reader trusts it.
//
//   - Resolution derived from procedure completion. `staged` means bytes
//     reached a composer. It has never meant delivered, and it must never come
//     to mean resolved either: a staged comm to a live target is silence, and
//     silence is not a verdict.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION, EVENT_TYPES } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const CORE_SOURCE = new URL('../src/core.ts', import.meta.url).pathname;
const PROV = { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION } as const;

test('every admitted comm attestation event type has a writer in the daemon', async () => {
  const core = await Bun.file(CORE_SOURCE).text();
  const attestations = EVENT_TYPES.filter((type) =>
    type.startsWith('act.comm_') && type !== 'act.comm_bytes_sent');
  expect(attestations.length).toBeGreaterThan(0);
  for (const type of attestations) {
    expect(core).toContain(`event_type: '${type}'`);
  }
});

test('a staged comm to a live target is neither delivered, refused, nor resolved', async () => {
  const store = new MemoryEventStore();
  const daemon = new Daemon(store, new FakeTmux());
  for (const [seat, identity] of [['council:custodes', 'sender'], ['palace:W', 'target']] as const) {
    await daemon.launch({ seat_id: seat, schema_version: SCHEMA_VERSION, identity, persona: 'p', tint: '#111111' });
    await store.append({
      entity_type: 'agent', entity_id: identity, event_type: 'reg.agent_registered',
      payload: { persona: 'p', rank: 'astartes', commander: null }, provenance: PROV,
      occurred_at: '2026-08-19T00:00:00.000Z',
    });
  }
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'target',
    message: 'staged is not delivered', ask: false, reply: false,
  });
  expect(accepted.staged).toBe(true);

  const delivery = await daemon.commDelivery(accepted.message_id);
  expect(delivery).toMatchObject({ complete: false, resolved: false });
  expect(delivery.deliveries[0]).toMatchObject({
    delivered: false, asserted_at: null, assertion_event_id: null,
    failed: false, failed_at: null, failure_event_id: null, failure_reason: null,
  });
});
