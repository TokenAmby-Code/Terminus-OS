// The central-bus delivery door (/ingress/bus) — txd as a bus subscriber.
//
// busd retries a non-2xx delivery forever (head-of-line, never a skip), so the
// door's honest outcomes are: 422 ONLY for envelope/contract skew, 2xx for
// everything else with `consumed` reporting whether txd ingested the event.
// The ruled stop/prompt behaviors (record / dedupe / refuse-ghost, the
// 77f7cfb4 class) are preserved EXACTLY through the new door — the refusals
// just ride an ack now instead of a 422.

import { expect, test } from 'bun:test';
import { BUS_SCHEMA_VERSION, type BusDelivery } from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { makeServer } from '../src/server.ts';
import { findTmuxIdDeep } from '../src/ids.ts';

const build = { version: '0.1.0', git_sha: 'test', bun: '1.0' };

function setup() {
  const store = new MemoryEventStore();
  const d = new Daemon(store, new FakeTmux());
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${srv.port}/ingress/bus`, { method: 'POST', body: JSON.stringify(body) });
  return { store, d, srv, post };
}

let seqCounter = 0;
function delivery(event_type: string, payload: Record<string, unknown>, seq = ++seqCounter): BusDelivery {
  return {
    schema_version: BUS_SCHEMA_VERSION,
    subscription: 'txd',
    event: {
      seq,
      event_type,
      source: 'claude',
      payload,
      provenance: { ingress: 'hooks', transport_receipt: 'edge_proxy', machine: 'test' },
      occurred_at: '2026-07-22T00:00:00.000Z',
      recorded_at: '2026-07-22T00:00:00.100Z',
    },
  };
}

test('a delivered hook.stop is consumed via the SAME ruled stop path, provenance from the bus row', async () => {
  const { store, d, srv, post } = setup();
  try {
    await d.launch({ seat_id: 'palace:W', schema_version: 6, identity: 'i1', persona: 'p', tint: '#1' });
    const res = await post(delivery('hook.stop', { instance_id: 'i1', schema_version: 6 }, 41));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      seq: 41,
      consumed: true,
      reason: null,
      receipt: { ok: true, instance_id: 'i1', recorded: true, deduped: false, activity: 'stopped', auto_close: 'none' },
    });
    const stops = (await store.readAll()).filter((e) => e.event_type === 'act.stop_reported');
    expect(stops).toHaveLength(1);
    // The transport receipt points into the bus journal, not at an HTTP header.
    expect(stops[0]!.provenance.transport_receipt).toBe('bus:41');
  } finally {
    srv.stop(true);
  }
});

test('a delivered stop WITH content also routes the comm-stop path (old door parity)', async () => {
  const { store, d, srv, post } = setup();
  try {
    await d.launch({ seat_id: 'palace:W', schema_version: 6, identity: 'i1', persona: 'p', tint: '#1' });
    const res = await post(delivery('hook.stop', { instance_id: 'i1', schema_version: 6, content: 'final words' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { consumed: boolean }).consumed).toBe(true);
    expect((await store.readAll()).some((e) => e.event_type === 'act.stop_reported')).toBe(true);
  } finally {
    srv.stop(true);
  }
});

test('duplicate stop deliveries dedupe (act.receipt_deduped), never a second stop_reported', async () => {
  const { store, d, srv, post } = setup();
  try {
    await d.launch({ seat_id: 'palace:W', schema_version: 6, identity: 'i1', persona: 'p', tint: '#1' });
    await post(delivery('hook.stop', { instance_id: 'i1', schema_version: 6 }));
    const res = await post(delivery('hook.stop', { instance_id: 'i1', schema_version: 6 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, consumed: true, receipt: { recorded: false, deduped: true } });
    const events = await store.readAll();
    expect(events.filter((e) => e.event_type === 'act.stop_reported')).toHaveLength(1);
    expect(events.filter((e) => e.event_type === 'act.receipt_deduped')).toHaveLength(1);
  } finally {
    srv.stop(true);
  }
});

test('a GHOST stop is acked-not-consumed with zero footprint — refused at admission, lane never wedged', async () => {
  const { store, srv, post } = setup();
  try {
    const res = await post(delivery('hook.stop', { instance_id: '77f7cfb4-orphan', schema_version: 6 }));
    // 2xx (busd must not retry a ghost forever), but honestly not consumed…
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, consumed: false, reason: 'no_such_instance' });
    // …and the whole point: no phantom row, no stop_reported, no dedupe.
    expect(await store.count()).toBe(0);
  } finally {
    srv.stop(true);
  }
});

test('schema-version mismatch inside the stop payload refuses consumption, acks the delivery', async () => {
  const { store, d, srv, post } = setup();
  try {
    await d.launch({ seat_id: 'palace:W', schema_version: 6, identity: 'i1', persona: 'p', tint: '#1' });
    const before = await store.count();
    const res = await post(delivery('hook.stop', { instance_id: 'i1', schema_version: 999 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, consumed: false, reason: 'schema_version_mismatch' });
    expect(await store.count()).toBe(before);
  } finally {
    srv.stop(true);
  }
});

test('a delivered hook.user_prompt_submit with comm context asserts delivery via the ruled prompt path', async () => {
  const { d, srv, post } = setup();
  try {
    await d.launch({ seat_id: 'palace:W', schema_version: 6, identity: 'src', persona: 'p1', tint: '#1' });
    await d.launch({ seat_id: 'palace:N', schema_version: 6, identity: 'dst', persona: 'p2', tint: '#2' });
    const acc = await d.comm({ schema_version: 6, source_instance_id: 'src', target: 'dst', message: 'hi', ask: false, reply: false });
    const res = await post(
      delivery('hook.user_prompt_submit', { instance_id: 'dst', schema_version: 6, message_id: acc.message_id }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, consumed: true, receipt: { ok: true, asserted: true } });
  } finally {
    srv.stop(true);
  }
});

test('a NATURAL prompt-submit (no comm-message context) is acked-not-consumed — a daily hook can never wedge the lane', async () => {
  const { store, d, srv, post } = setup();
  try {
    await d.launch({ seat_id: 'palace:W', schema_version: 6, identity: 'i1', persona: 'p', tint: '#1' });
    const before = await store.count();
    const res = await post(delivery('hook.user_prompt_submit', { instance_id: 'i1', schema_version: 6 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, consumed: false, reason: 'message_target_mismatch' });
    expect(await store.count()).toBe(before);
  } finally {
    srv.stop(true);
  }
});

test('every other hook.% delivery is acked-not-consumed with zero footprint (ack ≠ consume)', async () => {
  const { store, srv, post } = setup();
  try {
    for (const type of ['hook.pre_tool_use', 'hook.notification', 'hook.session_end']) {
      const res = await post(delivery(type, { session_id: 's1', whatever: true }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, consumed: false, reason: 'not_consumed' });
    }
    expect(await store.count()).toBe(0);
  } finally {
    srv.stop(true);
  }
});

test('an unconsumed payload carrying raw-tmux-id-shaped text is acked — arbitrary tool output can never wedge the lane', async () => {
  const { store, srv, post } = setup();
  try {
    const res = await post(
      delivery('hook.post_tool_use', { tool_output: 'killed pane %42 in window @3', session_id: 's1' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, consumed: false });
    expect(findTmuxIdDeep(body)).toBeNull(); // and nothing leaks back out
    expect(await store.count()).toBe(0);
  } finally {
    srv.stop(true);
  }
});

test('the membrane still guards what txd INGESTS: a consumed-type payload with a raw tmux id is refused, acked, zero footprint', async () => {
  const { store, d, srv, post } = setup();
  try {
    await d.launch({ seat_id: 'palace:W', schema_version: 6, identity: 'i1', persona: 'p', tint: '#1' });
    const before = await store.count();
    const res = await post(
      delivery('hook.stop', { instance_id: 'i1', schema_version: 6, content: 'leaked pane %7' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, consumed: false, reason: 'tmux_id_refused' });
    expect(await store.count()).toBe(before);
  } finally {
    srv.stop(true);
  }
});

test('envelope/contract skew is the ONE loud non-2xx: malformed deliveries and version skew 422', async () => {
  const { store, srv, post } = setup();
  try {
    let res = await post({ not: 'a delivery' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_bus_delivery');

    const valid = delivery('hook.stop', { instance_id: 'i1', schema_version: 6 });
    res = await post({ ...valid, schema_version: 999 });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_bus_delivery', field: '$.schema_version' });

    res = await post({ ...valid, event: { ...valid.event, event_type: 'UnDotted' } });
    expect(res.status).toBe(422);
    expect(await store.count()).toBe(0);
  } finally {
    srv.stop(true);
  }
});
