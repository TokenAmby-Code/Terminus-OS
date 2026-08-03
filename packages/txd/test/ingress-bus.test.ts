// The central-bus delivery door (/ingress/bus) — txd as a bus subscriber.
//
// busd retries a non-2xx delivery forever (head-of-line, never a skip), so the
// door's honest outcomes are: 422 ONLY for envelope/contract skew, 2xx for
// everything else with `consumed` reporting whether txd ingested the event.
// The ruled stop/prompt behaviors (record / dedupe / refuse-ghost, the
// 77f7cfb4 class) are preserved EXACTLY through the new door — the refusals
// just ride an ack now instead of a 422.

import { expect, test } from 'bun:test';
import { AGENT_SCHEMA_VERSION, BUS_SCHEMA_VERSION, SCHEMA_VERSION, type BusDelivery } from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { makeServer } from '../src/server.ts';
import { findTmuxIdDeep } from '../src/ids.ts';
import type { TxdPublishedEventType } from '../src/events.ts';

const build = { version: '0.1.0', git_sha: 'test', bun: '1.0' };

function setup(physicalRegistration: ConstructorParameters<typeof Daemon>[4] = null) {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux, undefined, undefined, physicalRegistration);
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${srv.port}/ingress/bus`, { method: 'POST', body: JSON.stringify(body) });
  return { store, tmux, d, srv, post };
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

test('wrapper start publishes txd-observed pane truth even when the environmental claim is forged', async () => {
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const runtime = {
    machine: 'k12-personal',
    configuration: { generation: 'estate-1', digest: 'a'.repeat(64) },
    agentWrapper: '/fleet/agent-wrapper',
    perpetual: {},
    publish: async (type: TxdPublishedEventType, payload: Record<string, unknown>) => {
      published.push({ type, payload });
    },
  };
  const { tmux, srv, post } = setup(runtime);
  try {
    await tmux.createSeat('palace:W');
    tmux.bindWrapper(4101, 'palace:W');
    const res = await post(delivery('hook.wrapper_start', {
      hook_request_id: '2ea2d049-0106-4957-8649-31f93bdc8c9a',
      engine: 'codex',
      cwd: '/work',
      machine: 'k12-personal',
      wrapper_pid: 4101,
      claimed_pane_id: 'council:custodes',
      argv: [],
      placement_hints: {},
    }, 301));
    expect(await res.json()).toEqual({
      ok: true,
      seq: 301,
      consumed: true,
      reason: null,
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: 'agent.pane_attested',
      payload: {
        claimed_pane_id: 'council:custodes',
        pane_id: 'palace:W',
        wrapper_pid: 4101,
        configuration: runtime.configuration,
      },
    });
  } finally {
    srv.stop(true);
  }
});

test('wrapper outside a managed pane emits a factual refusal and never attests placement', async () => {
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const runtime = {
    machine: 'k12-personal',
    configuration: { generation: 'estate-1', digest: 'b'.repeat(64) },
    agentWrapper: '/fleet/agent-wrapper',
    perpetual: {},
    publish: async (type: TxdPublishedEventType, payload: Record<string, unknown>) => {
      published.push({ type, payload });
    },
  };
  const { srv, post } = setup(runtime);
  try {
    const res = await post(delivery('hook.wrapper_start', {
      hook_request_id: '1cc2112c-9c38-45a1-839f-831c33a1096a',
      engine: 'claude',
      cwd: '/work',
      machine: 'k12-personal',
      wrapper_pid: 5101,
      claimed_pane_id: 'palace:W',
      argv: [],
      placement_hints: {},
    }, 302));
    expect(await res.json()).toMatchObject({
      ok: true,
      seq: 302,
      consumed: false,
      reason: 'wrapper_not_in_managed_pane',
    });
    expect(published).toEqual([{
      type: 'agent.pane_refused',
      payload: {
        hook_request_id: '1cc2112c-9c38-45a1-839f-831c33a1096a',
        claimed_pane_id: 'palace:W',
        machine: 'k12-personal',
        wrapper_pid: 5101,
        reason: 'wrapper_not_in_managed_pane',
      },
    }]);
  } finally {
    srv.stop(true);
  }
});

test('physical signoff precedes registration and routing activation', async () => {
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const runtime = {
    machine: 'k12-personal',
    configuration: { generation: 'estate-1', digest: 'c'.repeat(64) },
    agentWrapper: '/fleet/agent-wrapper',
    perpetual: {},
    publish: async (type: TxdPublishedEventType, payload: Record<string, unknown>) => {
      published.push({ type, payload });
    },
  };
  const { tmux, d, srv, post } = setup(runtime);
  const agentId = '2ea2d049-0106-4957-8649-31f93bdc8c9a';
  const birthGeneration = '1cc2112c-9c38-45a1-839f-831c33a1096a';
  try {
    await tmux.createSeat('palace:W');
    const paneGeneration = (await tmux.seatGeneration('palace:W'))!;
    tmux.bindWrapper(4101, 'palace:W');

    let response = await post(delivery('agent.physical_declared', {
      schema_version: AGENT_SCHEMA_VERSION,
      agent_id: agentId,
      birth_generation: birthGeneration,
      pane_id: 'palace:W',
      pane_generation: paneGeneration,
      configuration: runtime.configuration,
      engine: 'claude',
      wrapper_pid: 4101,
      persona: 'black-shields',
      rank: 'astartes',
      tint: '#111111',
    }));
    expect(await response.json()).toMatchObject({ ok: true, consumed: true });
    expect(await tmux.seatTint('palace:W')).toBe('#111111');
    expect(published.at(-1)).toMatchObject({
      type: 'agent.placement_attested',
      payload: {
        agent_id: agentId,
        birth_generation: birthGeneration,
        pane_id: 'palace:W',
        pane_generation: paneGeneration,
      },
    });
    response = await post(delivery('agent.physical_declared', {
      schema_version: AGENT_SCHEMA_VERSION,
      agent_id: agentId,
      birth_generation: birthGeneration,
      pane_id: 'palace:W',
      pane_generation: paneGeneration,
      configuration: runtime.configuration,
      engine: 'claude',
      wrapper_pid: 4101,
      persona: 'black-shields',
      rank: 'astartes',
      tint: '#111111',
    }));
    expect(await response.json()).toMatchObject({ ok: true, consumed: true });
    expect(published.filter(({ type }) => type === 'agent.placement_attested')).toHaveLength(1);
    await expect(d.comm({
      schema_version: SCHEMA_VERSION,
      source_agent_id: agentId,
      target: agentId,
      message: 'not yet routable',
      ask: false,
      reply: false,
    })).rejects.toThrow('source_not_registered');

    const agent = {
      schema_version: AGENT_SCHEMA_VERSION,
      agent_id: agentId,
      birth_generation: birthGeneration,
      registered_at: '2026-07-29T12:00:00.000Z',
      engine: 'claude',
      launch: {
        argv: [],
        requested_cwd: '/workspace',
      },
      placement: {
        pane_id: 'palace:W',
        pane_generation: paneGeneration,
        machine: 'k12-personal',
        kind: 'local',
        wrapper_pid: 4101,
        transport_witnesses: {},
      },
      configuration: runtime.configuration,
      persona: {
        persona: 'black-shields',
        rank: 'astartes',
        commander: null,
        tint: '#111111',
        voice: null,
        workspace: '/workspace',
        continuity_references: [],
        instruction_package: {
          digest: 'd'.repeat(64),
          sources: [],
          rendered_path: '/workspace/CLAUDE.md',
        },
      },
      resources: [],
    };
    response = await post(delivery('agent.registered', agent));
    expect(await response.json()).toMatchObject({ ok: true, consumed: true });
    expect(await d.comm({
      schema_version: SCHEMA_VERSION,
      source_agent_id: agentId,
      target: agentId,
      message: 'now routable',
      ask: false,
      reply: false,
    })).toMatchObject({
      ok: true,
      targets: [{ agent_id: agentId, seat_id: 'palace:W', persona: 'black-shields' }],
    });
  } finally {
    srv.stop(true);
  }
});

test('a delivered hook.stop is consumed via the SAME ruled stop path, provenance from the bus row', async () => {
  const { store, d, srv, post } = setup();
  try {
    await d.launch({ seat_id: 'palace:W', schema_version: 11, identity: 'i1', persona: 'p', tint: '#1' });
    const res = await post(delivery('hook.stop', { agent_id: 'i1', hook_event_name: 'Stop' }, 41));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      seq: 41,
      consumed: true,
      reason: null,
      receipt: { ok: true, agent_id: 'i1', recorded: true, deduped: false, turn: 'awaiting_input' },
    });
    const stops = (await store.readAll()).filter((e) => e.event_type === 'act.stop_reported');
    expect(stops).toHaveLength(1);
    // The transport receipt points into the bus journal, not at an HTTP header.
    expect(stops[0]!.provenance.transport_receipt).toBe('bus:41');
  } finally {
    srv.stop(true);
  }
});

test('duplicate stop deliveries dedupe (act.receipt_deduped), never a second stop_reported', async () => {
  const { store, d, srv, post } = setup();
  try {
    await d.launch({ seat_id: 'palace:W', schema_version: 11, identity: 'i1', persona: 'p', tint: '#1' });
    await post(delivery('hook.stop', { agent_id: 'i1', schema_version: 11 }));
    const res = await post(delivery('hook.stop', { agent_id: 'i1', schema_version: 11 }));
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
    const res = await post(delivery('hook.stop', { agent_id: '77f7cfb4-orphan', schema_version: 11 }));
    // 2xx (busd must not retry a ghost forever), but honestly not consumed…
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, consumed: false, reason: 'no_such_agent' });
    // …and the whole point: no phantom row, no stop_reported, no dedupe.
    expect(await store.count()).toBe(0);
  } finally {
    srv.stop(true);
  }
});

test('schema-version mismatch inside the stop payload refuses consumption, acks the delivery', async () => {
  const { store, d, srv, post } = setup();
  try {
    await d.launch({ seat_id: 'palace:W', schema_version: 11, identity: 'i1', persona: 'p', tint: '#1' });
    const before = await store.count();
    const res = await post(delivery('hook.stop', { agent_id: 'i1', schema_version: 1099 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, consumed: false, reason: 'schema_version_mismatch' });
    expect(await store.count()).toBe(before);
  } finally {
    srv.stop(true);
  }
});

test('a NATURAL prompt-submit (no comm-message context) is acked-not-consumed — a daily hook can never wedge the lane', async () => {
  const { store, d, srv, post } = setup();
  try {
    await d.launch({ seat_id: 'palace:W', schema_version: 11, identity: 'i1', persona: 'p', tint: '#1' });
    const before = await store.count();
    const res = await post(delivery('hook.user_prompt_submit', { agent_id: 'i1', schema_version: 11 }));
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

// The membrane guards IDENTIFIERS, not prose. A stop hook carries the agent's
// last assistant message; scanning it meant an agent that merely QUOTED a pane
// id lost its stop fact entirely. Content is consumed; the id field is judged.
test('a consumed payload whose CONTENT quotes a tmux id is consumed normally', async () => {
  const { store, d, srv, post } = setup();
  try {
    await d.launch({ seat_id: 'palace:W', schema_version: 11, identity: 'i1', persona: 'p', tint: '#1' });
    const before = await store.count();
    const res = await post(
      delivery('hook.stop', { agent_id: 'i1', schema_version: 11, content: 'reporting from pane %7' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, consumed: true });
    expect(await store.count()).toBeGreaterThan(before);
  } finally {
    srv.stop(true);
  }
});

test('a consumed payload whose IDENTIFIER is a raw tmux id is still refused, acked, zero footprint', async () => {
  const { store, d, srv, post } = setup();
  try {
    await d.launch({ seat_id: 'palace:W', schema_version: 11, identity: 'i1', persona: 'p', tint: '#1' });
    const before = await store.count();
    const res = await post(delivery('hook.stop', { agent_id: '%7', schema_version: 11 }));
    expect(res.status).toBe(200);
    // The REASON matters: refused by the identifier schema, not merely absent
    // as an unknown agent — otherwise this passes with the membrane removed.
    expect(await res.json()).toMatchObject({ ok: true, consumed: false, reason: 'invalid_stop_payload' });
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

    const valid = delivery('hook.stop', { agent_id: 'i1', schema_version: 11 });
    res = await post({ ...valid, schema_version: 1099 });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_bus_delivery', field: '$.schema_version' });

    res = await post({ ...valid, event: { ...valid.event, event_type: 'UnDotted' } });
    expect(res.status).toBe(422);
    expect(await store.count()).toBe(0);
  } finally {
    srv.stop(true);
  }
});
