// Adversarial: the hollow attestation surface stays dead.
//
// An admitted event type with no writer cannot return by a quiet edit.
// `act.comm_delivery_failed` sat in
//     the contract union with 1334 rows in the journal (last 2026-08-06) and no
//     emitter left in the runtime, so the surface answered for a state the
//     daemon could no longer reach. A contract that declares a fact nothing
// writes is the same defect as a shim, sited where a reader trusts it.

import { expect, test } from 'bun:test';
import { EVENT_TYPES } from '@terminus-os/contracts';

const CORE_SOURCE = new URL('../src/core.ts', import.meta.url).pathname;
test('every admitted comm attestation event type has a writer in the daemon', async () => {
  const core = await Bun.file(CORE_SOURCE).text();
  const attestations = EVENT_TYPES.filter((type) =>
    type.startsWith('act.comm_') && type !== 'act.comm_bytes_sent');
  expect(attestations.length).toBeGreaterThan(0);
  for (const type of attestations) {
    expect(core).toContain(`event_type: '${type}'`);
  }
});
