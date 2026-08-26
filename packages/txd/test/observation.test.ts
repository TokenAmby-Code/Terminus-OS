// Behavioral pins for txd's STC-owned observation doors.

import { expect, test } from 'bun:test';
import { HealthResponseSchema, InspectResponseSchema } from '@tokenamby-code/stc-contract/schemas';
import type { ObservationStore } from '@tokenamby-code/stc-contract/observation';
import {
  makeTxdObservationHandler,
  type TxdObservationSource,
} from '../src/observation.ts';
import { MemoryEventStore } from '../src/store.ts';
import { Daemon } from '../src/core.ts';
import { FakeTmux } from '../src/tmux.ts';
import { SCHEMA_VERSION } from '@terminus-os/contracts';

const observationStore: ObservationStore = {
  recordWalk: async () => {},
};

function source(overrides: Partial<TxdObservationSource> = {}): TxdObservationSource {
  const ready = async (signal: AbortSignal) => {
    expect(signal).toBeInstanceOf(AbortSignal);
    return { state: 'ready' as const, evidence: {} };
  };
  return {
    postgres: ready,
    tmuxSocket: ready,
    journalConsumer: ready,
    lifecycleHooks: ready,
    commTransport: ready,
    contradictions: ready,
    estate: ready,
    events: async () => ({ count: 11, breakdown: {} }),
    contradictionsHeld: async () => ({ count: 0, breakdown: {} }),
    bindings: async () => ({ count: 4, breakdown: { registered: 4 }, evidence: { debt: 'agent-semantic surface is not observation identity' } }),
    freelist: async () => ({ count: 2, breakdown: { live: 2 } }),
    zombies: async () => ({ count: 0, breakdown: {} }),
    divergence: async () => ({ count: 0, breakdown: {} }),
    ...overrides,
  };
}

function handler(observationSource = source()) {
  return makeTxdObservationHandler({
    source: observationSource,
    observationStore,
    machine: 'test',
    version: '0.1.0',
  });
}

test('health and inspect are strict STC 1.4.0 envelopes with txd identity and ring evidence', async () => {
  const observe = handler();
  const health = await observe(new Request('http://txd/health'));
  expect(health?.status).toBe(200);
  const healthBody = HealthResponseSchema.parse(await health!.json());
  expect(healthBody.identity).toEqual({ service: 'txd', daemon: 'txd', cli: 'tx' });
  expect(healthBody.stc_version).toBe('1.4.0');
  expect(healthBody.probes.map((probe: { name: string; rung: string }) => [probe.name, probe.rung])).toEqual([
    ['postgres', 'dependency'],
    ['tmux-socket', 'dependency'],
    ['estate', 'worker'],
    ['journal-consumer', 'worker'],
    ['comm-transport', 'function'],
    ['contradictions', 'function'],
    ['lifecycle-hooks', 'function'],
  ]);

  const inspect = await observe(new Request('http://txd/inspect'));
  const inspectBody = InspectResponseSchema.parse(await inspect!.json());
  expect(inspectBody).not.toHaveProperty('ok');
  expect(inspectBody.observation_ring.probes.map((probe) => probe.name)).toContain('comm-transport');
  expect(inspectBody.holdings.map((holding: { name: string }) => holding.name)).toEqual([
    'bindings', 'contradictions', 'divergence', 'events', 'freelist', 'zombies',
  ]);
});

test('a foreign or divergent estate is red-but-available and never hides another failing lane', async () => {
  const observe = handler(source({
    estate: async () => ({ state: 'blocked', detail: 'foreign or pending estate', evidence: { divergences: 1 } }),
    contradictions: async () => ({
      state: 'failed',
      detail: 'named contradictions remain open',
      evidence: { kinds: ['physical_declaration_contradicted'] },
    }),
    commTransport: async () => ({
      state: 'failed',
      detail: 'zero-byte transport refusal remains unresolved',
      evidence: { unresolved_target_agent_ids: ['agent-1'] },
    }),
  }));
  const response = await observe(new Request('http://txd/health'));
  expect(response?.status).toBe(503);
  const body = HealthResponseSchema.parse(await response!.json());
  expect(body.ok).toBe(false);
  expect(body.probes.filter((probe) => probe.state !== 'ready').map((probe) => probe.name)).toEqual([
    'estate', 'comm-transport', 'contradictions',
  ]);
});

test('comm transport reads the dedicated current-binding projection and recovery closes it', async () => {
  const store = new MemoryEventStore();
  const daemon = new Daemon(store, new FakeTmux());
  await daemon.launch({
    schema_version: SCHEMA_VERSION,
    seat_id: 'council:pax',
    identity: 'pax-current',
    persona: 'pax',
    tint: '#1c2b3a',
  });
  const provenance = { source: 'observer' as const, transport_receipt: null, emitter_version: SCHEMA_VERSION };
  await store.append({
    entity_type: 'message', entity_id: 'failed-message', event_type: 'act.comm_bytes_sent',
    payload: { target_agent_id: 'pax-current', seat_id: 'council:pax', bytes: 0, submit_verdict: 'transport_failed' },
    provenance, occurred_at: new Date().toISOString(),
  });
  const signal = new AbortController().signal;
  expect(await store.unresolvedCommTransportTargets(signal)).toEqual(['pax-current']);
  await store.append({
    entity_type: 'assertion', entity_id: 'delivery-asserted', event_type: 'act.comm_delivery_asserted',
    payload: { message_id: 'recovery-message', source_agent_id: 'sender', target_agent_id: 'pax-current' },
    provenance, occurred_at: new Date().toISOString(),
  });
  expect(await store.unresolvedCommTransportTargets(signal)).toEqual([]);
});
