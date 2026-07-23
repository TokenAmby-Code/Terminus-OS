// Dispatcher behavior under a fake fetch + fake clock: strict in-seq-order
// delivery, head-of-line blocking (never a skip), full-jitter backoff values,
// per-subscription independence, unseeded-cursor skip, and cursor-durable
// catch-up across a dispatcher "restart".

import { expect, test } from 'bun:test';
import type { BusDelivery, BusEventInput } from '@terminus-os/contracts';
import { MemoryBusStore } from '../src/store.ts';
import { backoffDelayMs, Dispatcher } from '../src/dispatcher.ts';

function ev(over: Partial<BusEventInput> = {}): BusEventInput {
  return {
    event_type: 'hook.stop',
    source: 'claude',
    payload: { session_id: 's1' },
    provenance: { ingress: 'hooks', transport_receipt: 'edge_proxy', machine: 'test' },
    occurred_at: '2026-07-22T00:00:00.000Z',
    ...over,
  };
}

type Call = { url: string; delivery: BusDelivery };

/** Programmable fake subscriber network: per-URL failure budgets, full call log. */
function fakeNet() {
  const calls: Call[] = [];
  const failuresLeft = new Map<string, number>();
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, delivery: JSON.parse(String(init?.body)) as BusDelivery });
    const left = failuresLeft.get(url) ?? 0;
    if (left !== 0) {
      failuresLeft.set(url, left - 1);
      return new Response('boom', { status: 500 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return {
    calls,
    fetchImpl,
    fail: (url: string, times: number) => failuresLeft.set(url, times),
  };
}

// Records the REQUESTED backoff (the assertion surface) but sleeps 1ms of real
// time — a zero-delay fake turns a gated-outage retry loop into a hot spin
// that floods logs and starves the test's polling.
const sleeps: number[] = [];
const instantSleep = async (ms: number) => {
  sleeps.push(ms);
  await Bun.sleep(1);
};

function dispatcher(store: MemoryBusStore, fetchImpl: typeof fetch, random: () => number = () => 1) {
  sleeps.length = 0;
  return new Dispatcher(store, {
    repairIntervalMs: 3_600_000, // effectively off — tests drive wake() directly
    deliveryTimeoutMs: 10_000,
    batchSize: 100,
    backoffBaseMs: 500,
    backoffCapMs: 60_000,
    fetchImpl,
    sleep: instantSleep,
    random,
  });
}

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition never held');
    await Bun.sleep(5);
  }
}

const TXD_URL = 'http://127.0.0.1:7781/ingress/bus';
const PROBE_URL = 'http://127.0.0.1:7999/';

function seedTxd(store: MemoryBusStore, from = 0) {
  store.setSubscription({ name: 'txd', delivery_url: TXD_URL, event_pattern: 'hook.%', active: true });
  store.seedCursor('txd', from);
}

test('backoffDelayMs is full-jitter exponential: uniform under min(cap, base·2^(failures−1))', () => {
  // random()=1 exposes the ceiling exactly: 500, 1000, 2000, ... capped at 60000.
  expect(backoffDelayMs(1, 500, 60_000, () => 1)).toBe(500);
  expect(backoffDelayMs(2, 500, 60_000, () => 1)).toBe(1_000);
  expect(backoffDelayMs(3, 500, 60_000, () => 1)).toBe(2_000);
  expect(backoffDelayMs(8, 500, 60_000, () => 1)).toBe(60_000); // 64000 → cap
  expect(backoffDelayMs(20, 500, 60_000, () => 1)).toBe(60_000); // stays capped
  // The jitter is FULL: the floor of the range is 0, not base.
  expect(backoffDelayMs(5, 500, 60_000, () => 0)).toBe(0);
  expect(backoffDelayMs(2, 500, 60_000, () => 0.5)).toBe(500);
});

test('delivers matching events strictly in seq order, one full journal row per POST, and advances the cursor', async () => {
  const store = new MemoryBusStore(() => '2026-07-22T00:00:00.000Z');
  seedTxd(store);
  await store.append(ev());
  await store.append(ev({ event_type: 'probe.ping' })); // NOT matched by hook.%
  await store.append(ev({ event_type: 'hook.notification' }));
  const net = fakeNet();
  const d = dispatcher(store, net.fetchImpl);
  d.wake();
  await until(() => net.calls.length === 2);
  expect(net.calls.map((c) => c.delivery.event.seq)).toEqual([1, 3]);
  expect(net.calls[0]!.delivery).toEqual({
    schema_version: 1,
    subscription: 'txd',
    event: {
      seq: 1,
      event_type: 'hook.stop',
      source: 'claude',
      payload: { session_id: 's1' },
      provenance: { ingress: 'hooks', transport_receipt: 'edge_proxy', machine: 'test' },
      occurred_at: '2026-07-22T00:00:00.000Z',
      recorded_at: '2026-07-22T00:00:00.000Z',
    },
  });
  await until(() => sleeps.length === 0 && net.calls.length === 2);
  expect(await store.cursor('txd')).toBe(3);
  d.stop();
});

test('head-of-line: a failing event is retried with backoff and NEVER skipped; later events wait', async () => {
  const store = new MemoryBusStore();
  seedTxd(store);
  await store.append(ev());
  await store.append(ev({ event_type: 'hook.notification' }));
  const net = fakeNet();
  net.fail(TXD_URL, 3);
  const d = dispatcher(store, net.fetchImpl);
  d.wake();
  await until(() => net.calls.length === 5); // 3 failures + retry success + seq2
  // seq 1 four times (3 fails + success), THEN seq 2 — order held, nothing skipped.
  expect(net.calls.map((c) => c.delivery.event.seq)).toEqual([1, 1, 1, 1, 2]);
  // The three recorded backoffs are the deterministic ceilings (random()=1).
  expect(sleeps).toEqual([500, 1_000, 2_000]);
  expect(await store.cursor('txd')).toBe(2);
  d.stop();
});

test('per-subscription independence: one wedged subscriber never stalls another lane', async () => {
  const store = new MemoryBusStore();
  seedTxd(store);
  store.setSubscription({ name: 'probe', delivery_url: PROBE_URL, event_pattern: 'hook.%', active: true });
  store.seedCursor('probe', 0);
  await store.append(ev());
  await store.append(ev({ event_type: 'hook.notification' }));
  const calls: Call[] = [];
  let probeDown = true; // gated (not a counted budget) so the outage cannot end by accident
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, delivery: JSON.parse(String(init?.body)) as BusDelivery });
    if (url === PROBE_URL && probeDown) return new Response('boom', { status: 500 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const d = dispatcher(store, fetchImpl);
  d.wake();
  // txd finishes both deliveries while probe is still head-of-line on seq 1.
  await until(() => calls.filter((c) => c.url === TXD_URL).length === 2);
  await Bun.sleep(10);
  expect(await store.cursor('txd')).toBe(2);
  expect(await store.cursor('probe')).toBe(0);
  const probeSeqs = calls.filter((c) => c.url === PROBE_URL).map((c) => c.delivery.event.seq);
  expect(new Set(probeSeqs)).toEqual(new Set([1])); // still retrying seq 1, never skipped ahead
  // The outage ends: probe drains in order and catches up.
  probeDown = false;
  await until(() => calls.some((c) => c.url === PROBE_URL && c.delivery.event.seq === 2));
  await Bun.sleep(10); // let the final advanceCursor land
  expect(await store.cursor('probe')).toBe(2);
  const probeOrder = calls.filter((c) => c.url === PROBE_URL).map((c) => c.delivery.event.seq);
  expect(probeOrder).toEqual([...Array(probeOrder.length - 1).fill(1), 2]);
  d.stop();
});

test('an unseeded subscription is skipped loud — no delivery, no invented cursor', async () => {
  const store = new MemoryBusStore();
  store.setSubscription({ name: 'txd', delivery_url: TXD_URL, event_pattern: 'hook.%', active: true });
  // deliberately NOT seeded
  await store.append(ev());
  const net = fakeNet();
  const d = dispatcher(store, net.fetchImpl);
  d.wake();
  await Bun.sleep(25);
  expect(net.calls).toHaveLength(0);
  expect(await store.cursor('txd')).toBeNull();
  d.stop();
});

test('catch-up across restart: retry state is in-memory, the cursor is durable', async () => {
  const store = new MemoryBusStore();
  seedTxd(store);
  await store.append(ev());
  const net = fakeNet();
  const d1 = dispatcher(store, net.fetchImpl);
  d1.wake();
  await until(() => net.calls.length === 1);
  d1.stop(); // "busd restart" mid-stream: the cursor (1) survives in the store
  expect(await store.cursor('txd')).toBe(1);

  await store.append(ev({ event_type: 'hook.notification' }));
  await store.append(ev({ event_type: 'hook.session_end' }));
  const d2 = dispatcher(store, net.fetchImpl);
  d2.wake();
  await until(() => net.calls.length === 3);
  // The new dispatcher resumed from the durable cursor: no re-delivery of seq 1.
  expect(net.calls.map((c) => c.delivery.event.seq)).toEqual([1, 2, 3]);
  expect(await store.cursor('txd')).toBe(3);
  d2.stop();
});

test('a wake during an active drain re-runs the lane instead of racing it (single serial lane)', async () => {
  const store = new MemoryBusStore();
  seedTxd(store);
  await store.append(ev());
  const net = fakeNet();
  const d = dispatcher(store, net.fetchImpl);
  d.wake();
  d.wake(); // concurrent wake while lane 1 may still be running
  await store.append(ev({ event_type: 'hook.notification' }));
  d.wake();
  await until(() => net.calls.length >= 2);
  await Bun.sleep(25);
  // Every event delivered exactly once, in order — no duplicate concurrent lanes.
  expect(net.calls.map((c) => c.delivery.event.seq)).toEqual([1, 2]);
  expect(await store.cursor('txd')).toBe(2);
  d.stop();
});
