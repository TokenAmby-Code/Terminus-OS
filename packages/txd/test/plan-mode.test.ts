// Typed plan-mode transition contract — behavioral-pin lane.

import { expect, test } from 'bun:test';
import {
  SCHEMA_VERSION,
  type EventInput,
  type ModeTransitionRequest,
} from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const occurred_at = '2026-07-28T00:00:00Z';
const provenance = { source: 'observer' as const, transport_receipt: null, emitter_version: SCHEMA_VERSION };

async function bound(engine: 'claude' | 'codex') {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  await tmux.createSeat('somnium:N');
  const generation = await tmux.seatGeneration('somnium:N');
  const event: EventInput = {
    entity_type: 'seat',
    entity_id: 'somnium:N',
    event_type: 'reg.bound',
    payload: {
      wrapper_id: `wrapper-${engine}`,
      instance_id: `instance-${engine}`,
      persona: 'astartes',
      tint: '#101010',
      rank: 'astartes',
      commander: 'council:custodes',
      pane_generation: generation,
      engine,
      wrapper_pid: 100,
      engine_pid: 101,
      engine_executable: `/sanctioned/${engine}`,
    },
    provenance,
    occurred_at,
  };
  await store.append(event);
  return { store, tmux, daemon: new Daemon(store, tmux, () => occurred_at) };
}

function request(
  engine: 'claude' | 'codex',
  intent: ModeTransitionRequest['intent'] = 'enter_plan',
): ModeTransitionRequest {
  return {
    schema_version: SCHEMA_VERSION,
    target: `instance-${engine}`,
    intent,
    trigger: 'operator',
  };
}

test.each(['claude', 'codex'] as const)(
  'enter_plan resolves the %s engine from binding truth and records request before attestation',
  async (engine) => {
    const { store, tmux, daemon } = await bound(engine);
    tmux.setAgentMode('somnium:N', 'work');

    const response = await daemon.transitionMode(request(engine));

    expect(response).toMatchObject({
      ok: true,
      target: `instance-${engine}`,
      seat_id: 'somnium:N',
      instance_id: `instance-${engine}`,
      engine,
      intent: 'enter_plan',
      trigger: 'operator',
      before: 'work',
      after: 'plan',
      changed: true,
      verified: true,
    });
    expect(tmux.modeInputs('somnium:N')).toEqual(engine === 'codex' ? ['/plan'] : ['BTab']);
    const events = (await store.readAll()).filter((event) => event.entity_id === `instance-${engine}`);
    expect(events.map((event) => event.event_type)).toEqual([
      'act.mode_transition_requested',
      'act.mode_transition_attested',
    ]);
    expect(events[0]!.seq).toBeLessThan(events[1]!.seq);
    expect(response.event_ids).toEqual(events.map((event) => event.seq));
  },
);

test('enter_plan is idempotent and records an attested no-op without sending input', async () => {
  const { store, tmux, daemon } = await bound('codex');
  tmux.setAgentMode('somnium:N', 'plan');

  const response = await daemon.transitionMode(request('codex', 'enter_plan'));

  expect(response).toMatchObject({
    ok: true,
    before: 'plan',
    after: 'plan',
    changed: false,
    verified: true,
  });
  expect(tmux.modeInputs('somnium:N')).toEqual([]);
  expect((await store.readAll()).slice(-2).map((event) => event.event_type)).toEqual([
    'act.mode_transition_requested',
    'act.mode_transition_attested',
  ]);
});

test('toggle_plan exits plan mode with one native mode-cycle input', async () => {
  const { tmux, daemon } = await bound('codex');
  tmux.setAgentMode('somnium:N', 'plan');

  const response = await daemon.transitionMode(request('codex', 'toggle_plan'));

  expect(response).toMatchObject({
    ok: true,
    before: 'plan',
    after: 'work',
    changed: true,
    verified: true,
  });
  expect(tmux.modeInputs('somnium:N')).toEqual(['BTab']);
});

test('failed physical verification is a durable failed fact, never a false attestation', async () => {
  const { store, tmux, daemon } = await bound('claude');
  tmux.setAgentMode('somnium:N', 'work');
  tmux.failModeTransition('somnium:N');

  const response = await daemon.transitionMode({
    ...request('claude'),
    trigger: 'preplan',
  });

  expect(response).toMatchObject({
    ok: false,
    verified: false,
    trigger: 'preplan',
    reason: 'transition_unverified',
  });
  expect((await store.readAll()).slice(-2).map((event) => event.event_type)).toEqual([
    'act.mode_transition_requested',
    'act.mode_transition_failed',
  ]);
});

test('absent and ambiguous identities refuse before any event or tmux input', async () => {
  const { store, tmux, daemon } = await bound('codex');
  await expect(daemon.transitionMode({
    schema_version: SCHEMA_VERSION,
    target: 'absent',
    intent: 'enter_plan',
    trigger: 'operator',
  })).rejects.toThrow('identity_absent');
  expect(await store.count()).toBe(1);
  expect(tmux.modeInputs('somnium:N')).toEqual([]);
});
