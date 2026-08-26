// Behavioral-pin lane for txd's narrow lifecycle comm actuator. lifecycled
// owns every decision that precedes this request; txd validates exact current
// instances and runs the ordinary one-way comm transport.

import { expect, test } from 'bun:test';
import {
  SCHEMA_VERSION,
  type LifecycleCommEffectRequest,
} from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { attributedCommFrame, commFrameTokens, commTokenForMessageId } from '../src/comm-frame.ts';
import { makeServer } from '../src/server.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const SOURCE_AGENT = '11111111-1111-4111-8111-111111111111';
const TARGET_AGENT = '22222222-2222-4222-8222-222222222222';
const SOURCE_BIRTH = '33333333-3333-4333-8333-333333333333';
const TARGET_BIRTH = '44444444-4444-4444-8444-444444444444';
const EFFECT_ID = '55555555-5555-4555-8555-555555555555';
const provenance = {
  source: 'observer' as const,
  transport_receipt: null,
  emitter_version: SCHEMA_VERSION,
};

async function bind(
  store: MemoryEventStore,
  tmux: FakeTmux,
  seatId: string,
  agentId: string,
  persona: string,
  birthGeneration: string,
): Promise<string> {
  const paneGeneration = await tmux.seatGeneration(seatId);
  if (!paneGeneration) throw new Error('fixture pane generation absent');
  await store.append({
    entity_type: 'seat',
    entity_id: seatId,
    event_type: 'reg.bound',
    payload: {
      agent_id: agentId,
      persona,
      rank: 'astartes',
      commander: null,
      tint: '#454000',
      birth_generation: birthGeneration,
      pane_generation: paneGeneration,
    },
    provenance,
    occurred_at: '2026-08-25T00:00:00.000Z',
  });
  await store.append({
    entity_type: 'agent',
    entity_id: agentId,
    event_type: 'reg.agent_registered',
    payload: { persona, rank: 'astartes', commander: null },
    provenance,
    occurred_at: '2026-08-25T00:00:00.001Z',
  });
  return paneGeneration;
}

async function rig(
  tmux = new FakeTmux(),
  watch: ConstructorParameters<typeof Daemon>[6] = async () => {},
) {
  const store = new MemoryEventStore();
  const daemon = new Daemon(store, tmux, undefined, undefined, null, null, watch);
  await daemon.constructEstate();
  const sourcePane = await bind(store, tmux, 'palace:W', SOURCE_AGENT, 'imperial-fists', SOURCE_BIRTH);
  const targetPane = await bind(store, tmux, 'council:orchestrator', TARGET_AGENT, 'orchestrator', TARGET_BIRTH);
  const request: LifecycleCommEffectRequest = {
    schema_version: SCHEMA_VERSION,
    effect_id: EFFECT_ID,
    source: {
      agent_id: SOURCE_AGENT,
      seat_id: 'palace:W',
      persona: 'imperial-fists',
      birth_generation: SOURCE_BIRTH,
      pane_generation: sourcePane,
    },
    target: {
      agent_id: TARGET_AGENT,
      seat_id: 'council:orchestrator',
      birth_generation: TARGET_BIRTH,
      pane_generation: targetPane,
    },
    message: 'landed\n\n{"unicode":"λ","quoted":"  exact  "}\n',
  };
  return { store, tmux, daemon, request };
}

test('behavioral pin: the actuator transports one opaque frame with exact source attribution and no ask', async () => {
  const { store, tmux, daemon, request } = await rig();
  const result = await daemon.lifecycleCommEffect(request);

  expect(result).toMatchObject({
    message_id: EFFECT_ID,
    source_agent_id: SOURCE_AGENT,
    staged: true,
    replayed: false,
  });
  expect(result.targets).toEqual([expect.objectContaining({
    agent_id: TARGET_AGENT,
    seat_id: 'council:orchestrator',
  })]);
  const frame = tmux.sends('council:orchestrator')[0]!;
  expect(frame).toBe(attributedCommFrame(
    EFFECT_ID,
    { persona: 'imperial-fists', seat_id: 'palace:W' },
    SOURCE_AGENT,
    request.message,
  ));
  expect(frame.slice(frame.indexOf('\n') + 1)).toBe(request.message);
  expect(commFrameTokens(frame)).toEqual([commTokenForMessageId(EFFECT_ID)]);

  const accepted = (await store.readAll()).find((event) =>
    event.entity_id === EFFECT_ID && event.event_type === 'reg.comm_accepted');
  expect(accepted?.payload).toMatchObject({
    ask_id: null,
    reply_to_ask_id: null,
    effect: 'lifecycle_comm',
    message: request.message,
    lifecycle_effect: { effect_id: EFFECT_ID },
  });

  await daemon.promptSubmitted({
    schema_version: SCHEMA_VERSION,
    agent_id: TARGET_AGENT,
    comm_tokens: [commTokenForMessageId(EFFECT_ID)],
  });
  expect((await daemon.commDelivery(EFFECT_ID)).deliveries[0]).toMatchObject({
    delivered: true,
    target: { agent_id: TARGET_AGENT },
  });
});

test('behavioral pin: caller effect replay and daemon restart never repeat transport', async () => {
  const { store, tmux, daemon, request } = await rig();
  const first = await daemon.lifecycleCommEffect(request);
  const replay = await daemon.lifecycleCommEffect(request);
  const restarted = new Daemon(store, tmux, undefined, undefined, null, null, async () => {});
  const afterRestart = await restarted.lifecycleCommEffect(request);

  expect(first).toMatchObject({ staged: true, replayed: false });
  expect(replay).toMatchObject({ staged: true, replayed: true, message_id: EFFECT_ID });
  expect(afterRestart).toMatchObject({ staged: true, replayed: true, message_id: EFFECT_ID });
  expect(tmux.sends('council:orchestrator')).toHaveLength(1);
  expect((await store.readAll()).filter((event) =>
    event.entity_id === EFFECT_ID && event.event_type === 'reg.comm_accepted')).toHaveLength(1);
});

test('behavioral pin: source and target generation witnesses are strict admission fences', async () => {
  const { store, tmux, daemon, request } = await rig();
  await expect(daemon.lifecycleCommEffect({
    ...request,
    source: { ...request.source, pane_generation: '66666666-6666-4666-8666-666666666666' },
  })).rejects.toThrow('source_effect_binding_mismatch');
  await expect(daemon.lifecycleCommEffect({
    ...request,
    target: { ...request.target, birth_generation: '77777777-7777-4777-8777-777777777777' },
  })).rejects.toThrow('target_effect_binding_mismatch');
  expect(tmux.sends('council:orchestrator')).toEqual([]);
  expect((await store.readAll()).filter((event) => event.event_type === 'reg.comm_accepted')).toEqual([]);
});

test('behavioral pin: a target rebind while the comm watch arms refuses before transport', async () => {
  let rebound = false;
  let store!: MemoryEventStore;
  const tmux = new FakeTmux();
  const watched = async (input: { target_agent_id: string }) => {
    if (input.target_agent_id !== TARGET_AGENT || rebound) return;
    rebound = true;
    const original = [...await store.readAll()].reverse().find((event) =>
      event.entity_id === 'council:orchestrator' && event.event_type === 'reg.bound')!;
    await store.append({
      entity_type: 'seat',
      entity_id: 'council:orchestrator',
      event_type: 'reg.seat_cleared',
      payload: {},
      provenance,
      occurred_at: '2026-08-25T00:00:01.000Z',
    });
    await store.append({
      entity_type: 'seat',
      entity_id: 'council:orchestrator',
      event_type: 'reg.bound',
      payload: original.payload,
      provenance,
      occurred_at: '2026-08-25T00:00:01.001Z',
    });
  };
  const built = await rig(tmux, watched);
  store = built.store;

  await expect(built.daemon.lifecycleCommEffect(built.request))
    .rejects.toThrow('target_binding_changed');
  expect(tmux.sends('council:orchestrator')).toEqual([]);
  expect((await store.readAll()).filter((event) =>
    event.entity_id === EFFECT_ID && event.event_type === 'reg.comm_accepted')).toHaveLength(1);
});

test('behavioral pin: restart after acceptance but before target snapshot recovers and never resends', async () => {
  const { store, tmux, request } = await rig();
  const source = { persona: request.source.persona, seat_id: request.source.seat_id };
  const target = {
    agent_id: request.target.agent_id,
    seat_id: request.target.seat_id,
    persona: 'orchestrator',
    logical_identity: { kind: 'agent_instance' as const, agent_id: request.target.agent_id },
  };
  await store.append({
    entity_type: 'message',
    entity_id: EFFECT_ID,
    event_type: 'reg.comm_accepted',
    payload: {
      source_agent_id: SOURCE_AGENT,
      source,
      target_agent_ids: [TARGET_AGENT],
      targets: [target],
      ask_id: null,
      reply_to_ask_id: null,
      kind: 'message',
      name: null,
      rendered_frame: attributedCommFrame(EFFECT_ID, source, SOURCE_AGENT, request.message),
      message: request.message,
      effect: 'lifecycle_comm',
      lifecycle_effect: {
        target_pane_generation: request.target.pane_generation,
        target_birth_generation: TARGET_BIRTH,
        source_pane_generation: request.source.pane_generation,
        source_birth_generation: SOURCE_BIRTH,
        effect_id: EFFECT_ID,
      },
    },
    provenance,
    occurred_at: '2026-08-25T00:00:02.000Z',
  });
  const restarted = new Daemon(store, tmux, undefined, undefined, null, null, async () => {});
  const response = await restarted.lifecycleCommEffect(request);
  const replay = await restarted.lifecycleCommEffect(request);
  expect(response).toMatchObject({ message_id: EFFECT_ID, staged: false, replayed: true });
  expect(replay).toMatchObject({ message_id: EFFECT_ID, staged: false, replayed: true });
  expect(tmux.sends('council:orchestrator')).toEqual([]);
  expect((await store.readAll()).filter((event) =>
    event.entity_id === EFFECT_ID && event.event_type === 'reg.comm_target_snapshotted')).toHaveLength(1);
  const receipts = (await store.readAll()).filter((event) =>
    event.entity_id === EFFECT_ID && event.event_type === 'act.comm_bytes_sent');
  expect(receipts).toHaveLength(1);
  const receipt = receipts[0];
  expect(receipt?.payload).toMatchObject({
    target_agent_id: TARGET_AGENT,
    submit_verdict: 'transport_failed',
    failure_reason: 'transport_process_ended',
    bytes: 0,
  });
});

class RefusingTmux extends FakeTmux {
  override async sendVerifiedToSeat(...args: Parameters<FakeTmux['sendVerifiedToSeat']>) {
    if (args[0] === 'council:orchestrator') {
      return { bytes: 0, verdict: 'transport_failed' as const };
    }
    return super.sendVerifiedToSeat(...args);
  }
}

test('behavioral pin: transport refusal remains ordinary txd comm evidence', async () => {
  const { store, daemon, request } = await rig(new RefusingTmux());
  const response = await daemon.lifecycleCommEffect(request);
  expect(response).toMatchObject({ staged: false, replayed: false });
  const transport = (await store.readAll()).find((event) =>
    event.entity_id === EFFECT_ID && event.event_type === 'act.comm_bytes_sent');
  expect(transport?.payload).toMatchObject({
    target_agent_id: TARGET_AGENT,
    submit_verdict: 'transport_failed',
    bytes: 0,
  });
});

test('behavioral pin: the HTTP edge is strict and carries no commander policy input', async () => {
  const { daemon, request } = await rig();
  const server = makeServer({
    bind: '127.0.0.1',
    port: 0,
    daemon,
    machine: 'test',
  });
  try {
    const invalid = await fetch(`http://127.0.0.1:${server.port}/agents/comm/lifecycle-effect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, commander_identity: 'council:orchestrator' }),
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({
      ok: false,
      error: 'invalid_lifecycle_comm_effect_request',
    });

    const valid = await fetch(`http://127.0.0.1:${server.port}/agents/comm/lifecycle-effect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({
      ok: true,
      message_id: EFFECT_ID,
      staged: true,
      replayed: false,
    });
  } finally {
    server.stop(true);
  }
});
