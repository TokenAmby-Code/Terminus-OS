import { expect, test } from 'bun:test';
import { LaunchRequestSchema, type EventInput, type EventRecord } from '@terminus-os/contracts';
import { Daemon, type LaunchChain } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { registration } from './registration-fixture.ts';

test('incomplete registration is rejected by the HTTP boundary contract', () => {
  expect(LaunchRequestSchema.safeParse({ schema_version: 5, seat_id: 'palace:W', instance_id: 'i1' }).success).toBe(false);
});

test('launch records the ordered chain and opens only the ready current generation', async () => {
  const store = new MemoryEventStore();
  const d = new Daemon(store, new FakeTmux());
  const res = await d.launch(registration('palace:W'));
  expect(res).toMatchObject({ ok: true, handover: true });
  expect((await store.readAll()).map((e) => e.event_type).slice(-7)).toEqual([
    'reg.dispatch_requested', 'reg.pane_observed', 'reg.wrapper_started', 'reg.session_started',
    'reg.bound', 'reg.readiness_attested', 'reg.route_activated',
  ]);
  expect((await d.estateRows())[0]).toMatchObject({ registration: 'registered', readiness: 'ready', routing: 'active' });
});

test('exact retry returns the existing generation and appends nothing', async () => {
  const store = new MemoryEventStore(); const d = new Daemon(store, new FakeTmux()); const req = registration('palace:W');
  const first = await d.launch(req); const before = await store.count(); const retry = await d.launch(req);
  expect(retry.binding_generation).toBe(first.binding_generation); expect(await store.count()).toBe(before);
});

test('conflicting seat and duplicate instance refuse before mutation', async () => {
  const store = new MemoryEventStore(); const tmux = new FakeTmux(); const d = new Daemon(store, tmux);
  await d.launch(registration('palace:W', 'i1')); const before = await store.count(); const seats = await tmux.listSeats();
  expect((await d.launch(registration('palace:W', 'i2'))).reason).toContain('seat_occupied');
  expect((await d.launch(registration('palace:N', 'i1'))).reason).toContain('instance_already_bound');
  expect(await store.count()).toBe(before); expect(await tmux.listSeats()).toEqual(seats);
});

test('launch chain failure compensates in reverse and never activates a route', async () => {
  const calls: string[] = [];
  const chain: LaunchChain = {
    async startWrapper() { calls.push('wrapper:start'); },
    async startEngineSession() { calls.push('session:start'); throw new Error('engine failed'); },
    async stopEngineSession() { calls.push('session:stop'); },
    async stopWrapper() { calls.push('wrapper:stop'); },
  };
  const store = new MemoryEventStore(); const d = new Daemon(store, new FakeTmux(), undefined, chain);
  expect((await d.launch(registration('palace:W'))).ok).toBe(false);
  expect(calls).toEqual(['wrapper:start', 'session:start', 'wrapper:stop']);
  expect((await store.readAll()).some((e) => e.event_type === 'reg.route_activated')).toBe(false);
});

class DerivedFailureStore extends MemoryEventStore {
  override appendDerived(inputs: EventInput[], derive: (written: EventRecord[]) => EventInput[]): Promise<EventRecord[]> {
    return super.appendDerived(inputs, (written) => [
      ...derive(written),
      { ...inputs[0]!, event_type: 'invalid.derived' } as unknown as EventInput,
    ]);
  }
}

test('registration persistence failure is distinct, compensates, and leaves no generation events', async () => {
  const calls: string[] = [];
  const chain: LaunchChain = {
    async startWrapper() { calls.push('wrapper:start'); },
    async startEngineSession() { calls.push('session:start'); },
    async stopEngineSession() { calls.push('session:stop'); },
    async stopWrapper() { calls.push('wrapper:stop'); },
  };
  const store = new DerivedFailureStore();
  const d = new Daemon(store, new FakeTmux(), undefined, chain);
  const result = await d.launch(registration('palace:W'));
  expect(result.reason).toContain('registration_persistence_failed');
  expect(calls).toEqual(['wrapper:start', 'session:start', 'session:stop', 'wrapper:stop']);
  const generationTypes = (await store.readAll()).map((event) => event.event_type).filter((type) =>
    ['reg.dispatch_requested', 'reg.pane_observed', 'reg.wrapper_started', 'reg.session_started', 'reg.bound',
      'reg.readiness_attested', 'reg.route_activated'].includes(type));
  expect(generationTypes).toEqual([]);
});
