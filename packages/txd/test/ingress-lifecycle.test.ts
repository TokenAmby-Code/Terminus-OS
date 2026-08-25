// The lcd typed lifecycle-fact door (/ingress/lifecycle) — txd as a service
// subscriber of lifecycled's typed subscription plane (Token-Fleet lcd
// programme, Emperor ruling 2026-08-12: services consume agent lifecycle
// facts from lcd, never hook.% bus rows).
//
// lcd's lane retries a refused (non-2xx) delivery under its backoff and never
// skips a fact, so the door's honest outcomes are 422 ONLY
// for envelope/contract skew, 2xx for everything else with `consumed`
// reporting whether txd ingested the fact. The wrapper attestation semantics
// (txd-observed pane truth over the environmental claim, typed refusals
// publishing agent.pane_refused) are preserved EXACTLY through the new door.

import { expect, test } from 'bun:test';
import { LCD_PROPAGATION_SCHEMA_VERSION, type LcdServiceDelivery } from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { makeServer } from '../src/server.ts';
import type { TxdPublishedEventType } from '../src/events.ts';


const HOOK_REQUEST_ID = '3f1c2a5e-9d4b-4c6a-8e2f-1a7b9c0d3e5f';

function setup(physicalRegistration: ConstructorParameters<typeof Daemon>[4] = null) {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux, undefined, undefined, physicalRegistration);
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, machine: 'test' });
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${srv.port}/ingress/lifecycle`, { method: 'POST', body: JSON.stringify(body) });
  return { store, tmux, d, srv, post };
}

function runtime(published: Array<{ type: string; payload: Record<string, unknown> }>) {
  return {
    machine: 'k12-personal',
    configuration: { generation: 'estate-1', digest: 'a'.repeat(64) },
    agentWrapper: '/fleet/agent-wrapper',
    perpetual: {},
    sshSeatTargets: { pages: {}, seats: {}, targets: [], targetFor: () => undefined },
    publish: async (type: TxdPublishedEventType, payload: Record<string, unknown>) => {
      published.push({ type, payload });
    },
  };
}

let seqCounter = 0;
function delivery(payload: Record<string, unknown>, seq = ++seqCounter): LcdServiceDelivery {
  return {
    schema_version: LCD_PROPAGATION_SCHEMA_VERSION,
    lane: 'txd-wrapper',
    subscriber: 'txd',
    fact: {
      seq,
      fact_type: 'wrapper_started',
      payload,
      occurred_at: '2026-08-12T00:00:00.000Z',
      recorded_at: '2026-08-12T00:00:00.100Z',
    },
  };
}

function wrapperStartPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_request_id: HOOK_REQUEST_ID,
    engine: 'claude',
    cwd: '/work',
    machine: 'k12-personal',
    wrapper_pid: 4101,
    claimed_pane_id: 'council:custodes',
    argv: [],
    placement_hints: {},
    ...overrides,
  };
}

test('a wrapper_started fact drives txd-observed pane attestation truth', async () => {
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const { tmux, srv, post } = setup(runtime(published));
  try {
    await tmux.createSeat('palace:W');
    tmux.bindWrapper(4101, 'palace:W');
    const res = await post(delivery(wrapperStartPayload(), 7));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, seq: 7, consumed: true, reason: null });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: 'agent.pane_attested',
      payload: {
        claimed_pane_id: 'council:custodes',
        pane_id: 'palace:W',
        wrapper_pid: 4101,
        hook_request_id: HOOK_REQUEST_ID,
      },
    });
  } finally {
    srv.stop(true);
  }
});

test('an unattestable wrapper refuses through agent.pane_refused and acks consumed:false', async () => {
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const { srv, post } = setup(runtime(published));
  try {
    const res = await post(delivery(wrapperStartPayload({ wrapper_pid: 5101, claimed_pane_id: 'palace:W' }), 8));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, seq: 8, consumed: false, reason: 'wrapper_not_in_managed_pane' });
    expect(published.map((event) => event.type)).toEqual(['agent.pane_refused']);
  } finally {
    srv.stop(true);
  }
});

test('a malformed wrapper payload is acked-not-consumed so the lcd lane never wedges on a poison fact', async () => {
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const { srv, post } = setup(runtime(published));
  try {
    const res = await post(delivery({ not: 'a wrapper payload' }, 9));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, seq: 9, consumed: false, reason: 'invalid_wrapper_start_payload' });
    expect(published).toEqual([]);
  } finally {
    srv.stop(true);
  }
});

test('envelope skew is 422 — the one honest hard failure, lcd backs off and retries', async () => {
  const { srv, post } = setup();
  try {
    const versionSkew = await post({ ...delivery(wrapperStartPayload()), schema_version: 99 });
    expect(versionSkew.status).toBe(422);
    const notObject = await post(['not', 'an', 'object']);
    expect(notObject.status).toBe(422);
    const unknownFactType = await post({
      ...delivery(wrapperStartPayload()),
      fact: { ...delivery(wrapperStartPayload()).fact, fact_type: 'ghost_fact' },
    });
    expect(unknownFactType.status).toBe(422);
  } finally {
    srv.stop(true);
  }
});
