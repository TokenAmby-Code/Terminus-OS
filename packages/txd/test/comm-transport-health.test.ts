// Behavioral pin: procedure-derived estate readiness cannot mask an observed
// zero-effect comm refusal. The fault remains open for the current binding
// until that same receiver produces a delivery assertion.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const provenance = {
  source: 'observer' as const,
  transport_receipt: null,
  emitter_version: SCHEMA_VERSION,
};

test('health is degraded by an unresolved zero-byte transport failure on a current binding', async () => {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const daemon = new Daemon(store, tmux);
  await daemon.constructEstate();
  await daemon.launch({
    schema_version: SCHEMA_VERSION,
    seat_id: 'council:pax',
    identity: 'pax-current',
    persona: 'pax',
    tint: '#1c2b3a',
  });
  await store.append({
    entity_type: 'message',
    entity_id: 'failed-message',
    event_type: 'act.comm_bytes_sent',
    payload: {
      target_agent_id: 'pax-current',
      seat_id: 'council:pax',
      bytes: 0,
      submit_verdict: 'transport_failed',
    },
    provenance,
    occurred_at: new Date().toISOString(),
  });

  const failed = await daemon.health('test', { version: 'test', git_sha: 'head', bun: Bun.version });
  expect(failed.ok).toBe(false);
  expect(failed.comm_transport).toEqual({
    state: 'degraded',
    unresolved_target_agent_ids: ['pax-current'],
  });

  await store.append({
    entity_type: 'assertion',
    entity_id: 'delivery-asserted',
    event_type: 'act.comm_delivery_asserted',
    payload: {
      message_id: 'recovery-message',
      source_agent_id: 'sender',
      target_agent_id: 'pax-current',
    },
    provenance,
    occurred_at: new Date().toISOString(),
  });

  const recovered = await daemon.health('test', { version: 'test', git_sha: 'head', bun: Bun.version });
  expect(recovered.ok).toBe(true);
  expect(recovered.comm_transport).toEqual({ state: 'ready', unresolved_target_agent_ids: [] });
});
