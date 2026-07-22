import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import type { EstateRotationBarrier } from '../src/rotation-lock.ts';

async function setup() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const daemon = new Daemon(store, tmux);
  await daemon.constructEstate();
  return { store, tmux, daemon };
}

test('non-force rotation refuses bound seats without touching tmux', async () => {
  const { store, tmux, daemon } = await setup();
  await daemon.launch({ seat_id: 'palace:W', schema_version: SCHEMA_VERSION, identity: 'i1', persona: 'p', tint: '#1' });
  const result = await daemon.requestEstateRotation({ schema_version: SCHEMA_VERSION, force: false });
  expect(result).toMatchObject({ accepted: false, reason: 'estate_busy', bound_seats: ['palace:W'] });
  expect(tmux.killed).toBe(false);
  expect((await store.readAll()).at(-1)?.event_type).toBe('estate.rotation_refused');
});

test('non-force rotation refuses a foreground command by canonical seat only', async () => {
  const { tmux, daemon } = await setup();
  tmux.setCommand('somnium:NE', 'codex');
  const result = await daemon.requestEstateRotation({ schema_version: SCHEMA_VERSION, force: false });
  expect(result.foreground_workloads).toEqual([{ seat_id: 'somnium:NE', command: 'codex' }]);
  expect(tmux.killed).toBe(false);
});

test('forced rotation durably records sacrifices before explicit execution', async () => {
  const { store, tmux, daemon } = await setup();
  tmux.setCommand('somnium:NE', 'codex');
  const result = await daemon.requestEstateRotation({ schema_version: SCHEMA_VERSION, force: true });
  expect(result.accepted).toBe(true);
  expect(tmux.killed).toBe(false);
  expect((await store.readAll()).at(-1)?.event_type).toBe('estate.rotation_requested');
  await daemon.executeEstateRotation();
  expect(tmux.killed).toBe(true);
});

test('new daemon generation completes the latest pending rotation once', async () => {
  const { store, daemon } = await setup();
  const request = await daemon.requestEstateRotation({ schema_version: SCHEMA_VERSION, force: true });
  expect(request.rotation_id).not.toBeNull();
  await daemon.finalizeEstateRotation();
  await daemon.finalizeEstateRotation();
  const completions = (await store.readAll()).filter((event) => event.event_type === 'estate.rotation_completed');
  expect(completions).toHaveLength(1);
  expect(completions[0]?.entity_id).toBe(request.rotation_id!);
});

test('forced rotation holds the lifecycle barrier from durable request through reconstruction', async () => {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const calls: string[] = [];
  const barrier: EstateRotationBarrier = {
    async begin() { calls.push('begin'); },
    async complete() { calls.push('complete'); },
    async abort() { calls.push('abort'); },
  };
  const daemon = new Daemon(store, tmux, undefined, undefined, undefined, barrier);
  await daemon.constructEstate();
  await daemon.requestEstateRotation({ schema_version: SCHEMA_VERSION, force: true });
  expect(calls).toEqual(['begin']);
  await daemon.executeEstateRotation();
  expect(calls).toEqual(['begin']);
  await daemon.finalizeEstateRotation();
  expect(calls).toEqual(['begin', 'complete']);
});
