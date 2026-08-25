// Behavioral-pin lane: a genuine engine Stop may produce two independently
// correlated effects. Open asks receive their stop callback, while the source
// agent's current registration commander receives one ordinary comm whose
// payload is the exact final output. Identity comes only from current txd
// registration and its live pane generation; replay never repeats transport.

import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { commanderEchoFrame, commFrameTokens } from '../src/comm-frame.ts';
import { makeServer } from '../src/server.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const build = { version: 'test', git_sha: 'head', bun: Bun.version };
const provenance = {
  source: 'observer' as const,
  transport_receipt: null,
  emitter_version: SCHEMA_VERSION,
};

type RigTmux = FakeTmux;

function stableEchoMessageId(stopSeq: number, targetAgentId: string): string {
  const bytes = createHash('sha256')
    .update('txd-commander-echo')
    .update('\0')
    .update(`${stopSeq}\0${targetAgentId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function register(
  daemon: Daemon,
  store: MemoryEventStore,
  seat: string,
  agentId: string,
  persona: string,
  rank: string,
  commander: string | null,
): Promise<void> {
  const launched = await daemon.launch({
    schema_version: SCHEMA_VERSION,
    seat_id: seat,
    identity: agentId,
    persona,
    rank,
    commander: commander ?? undefined,
    tint: '#454000',
  });
  if (!launched.ok) throw new Error(`fixture launch failed: ${launched.reason}`);
  await store.append({
    entity_type: 'agent',
    entity_id: agentId,
    event_type: 'reg.agent_registered',
    payload: { persona, rank, commander },
    provenance,
    occurred_at: '2026-08-25T00:00:00.000Z',
  });
}

async function rig(tmux: RigTmux = new FakeTmux()) {
  const store = new MemoryEventStore();
  const daemon = new Daemon(store, tmux, undefined, undefined, null, null, async () => {});
  await daemon.constructEstate();
  await register(daemon, store, 'palace:W', 'source-agent', 'imperial-fists', 'astartes', 'council:orchestrator');
  await register(daemon, store, 'council:orchestrator', 'commander-agent', 'orchestrator', 'overseer', null);
  return { store, tmux, daemon };
}

async function stop(daemon: Daemon, content?: string, extra: Record<string, unknown> = {}) {
  const server = makeServer({ bind: '127.0.0.1', port: 0, daemon, build, machine: 'test' });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/ingress/hooks/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-edge-proxy': 'edge_proxy' },
      body: JSON.stringify({
        agent_id: 'source-agent',
        schema_version: SCHEMA_VERSION,
        ...(content === undefined ? {} : { last_assistant_message: content }),
        ...extra,
      }),
    });
    expect(response.status).toBe(200);
    return await response.json() as Record<string, any>;
  } finally {
    server.stop(true);
  }
}

test('behavioral pin: a fresh Stop echoes one byte-faithful final output with exact source attribution', async () => {
  const { store, tmux, daemon } = await rig();
  const content = 'landed\n\n{"unicode":"λ","quoted":"  exact  "}\n';
  const response = await stop(daemon, content, { commander: 'council:custodes' });

  expect(response.commander_echo).toMatchObject({
    status: 'staged',
    source_agent_id: 'source-agent',
    source_seat_id: 'palace:W',
    source_persona: 'imperial-fists',
    commander_identity: 'council:orchestrator',
    target_agent_id: 'commander-agent',
  });
  const frame = tmux.sends('council:orchestrator')[0]!;
  expect(frame).toMatch(/^\[tx comm from imperial-fists at palace:W agent source-agent #[A-Za-z0-9_-]{22}\]\n/);
  expect(frame.slice(frame.indexOf('\n') + 1)).toBe(content);
  expect(commFrameTokens(frame)).toHaveLength(1);

  const accepted = (await store.readAll()).find((event) =>
    event.event_type === 'reg.comm_accepted' && event.payload.effect === 'commander_echo');
  expect(accepted?.payload).toMatchObject({
    source_agent_id: 'source-agent',
    target_agent_ids: ['commander-agent'],
    ask_id: null,
    message: content,
    commander_echo: {
      source_stop_event_seq: response.commander_echo.source_stop_event_seq,
      commander_identity: 'council:orchestrator',
      target_agent_id: 'commander-agent',
    },
  });
});

test('behavioral pin: a worker with no commander records a typed unresolved fact and sends nothing', async () => {
  const { store, tmux, daemon } = await rig();
  await store.append({
    entity_type: 'agent', entity_id: 'source-agent', event_type: 'reg.agent_registered',
    payload: { persona: 'imperial-fists', rank: 'astartes', commander: null }, provenance,
    occurred_at: '2026-08-25T00:00:01.000Z',
  });

  const response = await stop(daemon, 'no commander');
  expect(response.commander_echo).toMatchObject({ status: 'refused', reason: 'commander_absent' });
  expect(tmux.sends('council:orchestrator')).toEqual([]);
  const health = await daemon.health('test', build);
  expect(health.ok).toBe(false);
  expect(health.commander_echo).toMatchObject({ state: 'degraded' });
  expect(health.commander_echo.unresolved).toContainEqual(expect.objectContaining({
    source_agent_id: 'source-agent', reason: 'commander_absent',
  }));
});

test('behavioral pin: a stale source pane generation refuses before commander transport', async () => {
  const { store, tmux, daemon } = await rig();
  tmux.forceSeatGeneration('palace:W', crypto.randomUUID());
  const response = await stop(daemon, 'stale source');
  expect(response.commander_echo).toMatchObject({ status: 'refused', reason: 'source_generation_stale' });
  expect(tmux.sends('council:orchestrator')).toEqual([]);
  expect((await store.readAll()).some((event) =>
    event.event_type === 'act.commander_echo_refused'
    && event.payload.reason === 'source_generation_stale')).toBe(true);
});

test('behavioral pin: a late Stop from a retired source never routes through an archived registration row', async () => {
  const { store, tmux, daemon } = await rig();
  await store.append({
    entity_type: 'agent', entity_id: 'source-agent', event_type: 'reg.retired',
    payload: {}, provenance, occurred_at: '2026-08-25T00:00:02.000Z',
  });
  await store.append({
    entity_type: 'seat', entity_id: 'palace:W', event_type: 'reg.seat_cleared',
    payload: {}, provenance, occurred_at: '2026-08-25T00:00:02.000Z',
  });

  const response = await stop(daemon, 'late corpse output');
  expect(response.commander_echo).toMatchObject({ status: 'refused', reason: 'source_not_current' });
  expect(tmux.sends('council:orchestrator')).toEqual([]);
  expect((await store.readAll()).some((event) =>
    event.event_type === 'act.commander_echo_refused'
    && event.payload.reason === 'source_not_current')).toBe(true);
});

test('behavioral pin: replay and daemon restart stage a stable source-stop/commander echo at most once', async () => {
  const { store, tmux, daemon } = await rig();
  const first = await stop(daemon, 'one stop, one echo');
  const repeated = await stop(daemon, 'one stop, one echo');
  const restarted = new Daemon(store, tmux, undefined, undefined, null, null, async () => {});
  const afterRestart = await stop(restarted, 'one stop, one echo');

  expect(first.commander_echo.status).toBe('staged');
  expect(repeated.commander_echo.status).toBe('deduped');
  expect(afterRestart.commander_echo.status).toBe('deduped');
  expect(repeated.commander_echo.message_id).toBe(first.commander_echo.message_id);
  expect(afterRestart.commander_echo.message_id).toBe(first.commander_echo.message_id);
  expect(tmux.sends('council:orchestrator')).toHaveLength(1);
  expect((await store.readAll()).filter((event) =>
    event.event_type === 'reg.comm_accepted' && event.payload.effect === 'commander_echo')).toHaveLength(1);
});

test('behavioral pin: restart after admission but before transport terminalizes without resending', async () => {
  const { store, tmux, daemon } = await rig();
  const stopped = await daemon.stop({
    schema_version: SCHEMA_VERSION,
    agent_id: 'source-agent',
    content: 'admitted before crash',
  });
  expect(stopped).toMatchObject({ ok: true, recorded: true });
  const stopEvent = (await store.readAll()).find((event) =>
    event.entity_id === 'source-agent' && event.event_type === 'act.stop_reported')!;
  const messageId = stableEchoMessageId(stopEvent.seq, 'commander-agent');
  const source = { persona: 'imperial-fists', seat_id: 'palace:W' };
  const target = { agent_id: 'commander-agent', seat_id: 'council:orchestrator', persona: 'orchestrator' };
  const frame = commanderEchoFrame(messageId, source, 'source-agent', 'admitted before crash');
  await store.append({
    entity_type: 'message', entity_id: messageId, event_type: 'reg.comm_accepted',
    payload: {
      source_agent_id: 'source-agent', source, target_agent_ids: ['commander-agent'], targets: [target],
      ask_id: null, reply_to_ask_id: null, kind: 'message', name: null,
      rendered_frame: frame, message: 'admitted before crash', effect: 'commander_echo',
      commander_echo: {
        source_stop_event_seq: stopEvent.seq,
        commander_identity: 'council:orchestrator',
        target_agent_id: 'commander-agent',
      },
    },
    provenance, occurred_at: '2026-08-25T00:00:08.000Z',
  });
  await store.append({
    entity_type: 'message', entity_id: messageId, event_type: 'reg.comm_target_snapshotted',
    payload: { message_id: messageId, targets: [target] }, provenance,
    occurred_at: '2026-08-25T00:00:08.000Z',
  });

  const restarted = new Daemon(store, tmux, undefined, undefined, null, null, async () => {});
  const response = await stop(restarted, 'admitted before crash');
  expect(response.commander_echo).toMatchObject({
    status: 'refused', reason: 'transport_failed', message_id: messageId,
  });
  expect(tmux.sends('council:orchestrator')).toEqual([]);
  const receipts = (await store.readAll()).filter((event) =>
    event.entity_id === messageId && event.event_type === 'act.comm_bytes_sent');
  expect(receipts).toHaveLength(1);
  expect(receipts[0]!.payload).toMatchObject({
    target_agent_id: 'commander-agent', submit_verdict: 'transport_failed',
    failure_reason: 'transport_process_ended', bytes: 0,
  });
  expect((await daemon.health('test', build)).commander_echo.state).toBe('degraded');
});

test('behavioral pin: empty output produces neither a commander comm nor a false success', async () => {
  const { store, tmux, daemon } = await rig();
  const response = await stop(daemon, '');
  expect(response.commander_echo).toMatchObject({ status: 'suppressed', reason: 'empty_output' });
  expect(tmux.sends('council:orchestrator')).toEqual([]);
  expect((await store.readAll()).filter((event) => event.event_type === 'reg.comm_accepted')).toEqual([]);
});

test('behavioral pin: ask stop callback and commander echo are distinct correlated effects', async () => {
  const { store, tmux, daemon } = await rig();
  const askId = 'ask-one';
  const askMessageId = crypto.randomUUID();
  const target = { agent_id: 'source-agent', seat_id: 'palace:W', persona: 'imperial-fists' };
  await store.append({
    entity_type: 'message', entity_id: askMessageId, event_type: 'reg.comm_accepted',
    payload: { source_agent_id: 'asker', target_agent_ids: ['source-agent'], targets: [target], ask_id: askId },
    provenance, occurred_at: '2026-08-25T00:00:03.000Z',
  });
  await store.append({
    entity_type: 'ask', entity_id: askId, event_type: 'reg.comm_target_snapshotted',
    payload: { message_id: askMessageId, targets: [target] }, provenance,
    occurred_at: '2026-08-25T00:00:03.000Z',
  });

  const response = await stop(daemon, 'shared opaque output');
  const events = await store.readAll();
  const callback = events.find((event) => event.event_type === 'act.comm_callback_asserted');
  const echo = events.find((event) =>
    event.event_type === 'reg.comm_accepted' && event.payload.effect === 'commander_echo');
  expect(callback?.payload).toMatchObject({
    ask_id: askId, target_agent_id: 'source-agent', content: 'shared opaque output', source: 'stop',
  });
  expect(echo?.payload).toMatchObject({ ask_id: null, reply_to_ask_id: null, message: 'shared opaque output' });
  expect(echo?.entity_id).toBe(response.commander_echo.message_id);
  expect(callback?.entity_id).not.toBe(echo?.entity_id);
  expect(tmux.sends('council:orchestrator')).toHaveLength(1);
});

class RefusingTmux extends FakeTmux {
  override async sendVerifiedToSeat(...args: Parameters<FakeTmux['sendVerifiedToSeat']>) {
    if (args[0] === 'council:orchestrator') return { bytes: 0, verdict: 'transport_failed' as const };
    return super.sendVerifiedToSeat(...args);
  }
}

test('behavioral pin: commander transport refusal is durable and degrades health', async () => {
  const { store, daemon } = await rig(new RefusingTmux());
  const response = await stop(daemon, 'transport must speak truth');
  expect(response.commander_echo).toMatchObject({ status: 'refused', reason: 'transport_failed' });
  const refused = (await store.readAll()).find((event) => event.event_type === 'act.commander_echo_refused');
  expect(refused?.payload).toMatchObject({
    source_agent_id: 'source-agent', target_agent_id: 'commander-agent', reason: 'transport_failed', bytes: 0,
  });
  const health = await daemon.health('test', build);
  expect(health.ok).toBe(false);
  expect(health.commander_echo.unresolved).toContainEqual(expect.objectContaining({
    source_agent_id: 'source-agent', target_agent_id: 'commander-agent', reason: 'transport_failed',
  }));
});

test('behavioral pin: a turn created by a commander echo cannot recursively echo', async () => {
  const { store, tmux, daemon } = await rig();
  const inboundEchoId = crypto.randomUUID();
  await store.append({
    entity_type: 'message', entity_id: inboundEchoId, event_type: 'reg.comm_accepted',
    payload: {
      source_agent_id: 'another-agent', target_agent_ids: ['source-agent'],
      targets: [{ agent_id: 'source-agent', seat_id: 'palace:W', persona: 'imperial-fists' }],
      ask_id: null, effect: 'commander_echo',
    }, provenance, occurred_at: '2026-08-25T00:00:04.000Z',
  });
  await store.append({
    entity_type: 'agent', entity_id: 'source-agent', event_type: 'act.prompt_submitted',
    payload: { agent_id: 'source-agent', message_ids: [inboundEchoId], comm_tokens: [], content: 'echo frame' },
    provenance, occurred_at: '2026-08-25T00:00:04.000Z',
  });

  const response = await stop(daemon, 'do not recurse');
  expect(response.commander_echo).toMatchObject({ status: 'suppressed', reason: 'echo_loop_prevented' });
  expect(tmux.sends('council:orchestrator')).toEqual([]);
});

test('behavioral pin: a self-target commander edge refuses without transport', async () => {
  const { store, tmux, daemon } = await rig();
  await store.append({
    entity_type: 'agent', entity_id: 'source-agent', event_type: 'reg.agent_registered',
    payload: { persona: 'imperial-fists', rank: 'astartes', commander: 'source-agent' }, provenance,
    occurred_at: '2026-08-25T00:00:05.000Z',
  });
  const response = await stop(daemon, 'must not self echo');
  expect(response.commander_echo).toMatchObject({ status: 'refused', reason: 'commander_self_target' });
  expect(tmux.sends('palace:W')).toEqual([]);
  expect(tmux.sends('council:orchestrator')).toEqual([]);
});

test('behavioral pin: an ambiguous commander identity refuses instead of guessing a persona label', async () => {
  const { store, tmux, daemon } = await rig();
  await register(daemon, store, 'palace:E', 'duplicate-one', 'duplicate-commander', 'overseer', null);
  await register(daemon, store, 'palace:N', 'duplicate-two', 'duplicate-commander', 'overseer', null);
  await store.append({
    entity_type: 'agent', entity_id: 'source-agent', event_type: 'reg.agent_registered',
    payload: { persona: 'imperial-fists', rank: 'astartes', commander: 'duplicate-commander' }, provenance,
    occurred_at: '2026-08-25T00:00:06.000Z',
  });
  const response = await stop(daemon, 'ambiguous must refuse');
  expect(response.commander_echo).toMatchObject({ status: 'refused', reason: 'commander_identity_ambiguous' });
  expect(tmux.sends('palace:E')).toEqual([]);
  expect(tmux.sends('palace:N')).toEqual([]);
});

test('behavioral pin: a commander-root overseer with no commander terminates the chain without degrading health', async () => {
  const { store, tmux, daemon } = await rig();
  await store.append({
    entity_type: 'agent', entity_id: 'source-agent', event_type: 'reg.agent_registered',
    payload: { persona: 'imperial-fists', rank: 'overseer', commander: null }, provenance,
    occurred_at: '2026-08-25T00:00:07.000Z',
  });
  const response = await stop(daemon, 'root output');
  expect(response.commander_echo).toMatchObject({ status: 'suppressed', reason: 'commander_root' });
  expect(tmux.sends('council:orchestrator')).toEqual([]);
  expect((await daemon.health('test', build)).commander_echo.state).toBe('ready');
});
