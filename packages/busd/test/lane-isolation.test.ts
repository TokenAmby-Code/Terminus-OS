// Lane isolation (the ledgered backoff/dead-lane defect, 2026-08-02 outage):
// a delivery await that never settles must fold to a loud stall — never a
// silently dead lane — and a blocked lane must back off instead of retrying
// on every append-wake. The outage evidence: lifecycled-hook froze mid-drain
// two seconds after boot with zero journal lines while its target answered
// probes in <1ms, and githubd-fleet retried a refused fact at sub-second
// cadence, once per append, for hours.

import { expect, test } from "bun:test";
import type { BusEventInput } from "@terminus-os/contracts";
import { Dispatcher } from "../src/dispatcher.ts";
import { MemoryBusStore } from "../src/store.ts";

const DELIVERY_URL = "http://127.0.0.1:7999/event";

function busEvent(eventType = "hook.stop"): BusEventInput {
  return {
    event_type: eventType,
    source: "test",
    payload: {},
    provenance: { ingress: "hooks", transport_receipt: null, machine: "test" },
    occurred_at: "2026-07-26T17:00:00.000Z",
  };
}

function subscription(store: MemoryBusStore, name: string, pattern: string): void {
  store.setSubscription({ name, delivery_url: DELIVERY_URL, event_pattern: pattern, active: true });
  store.seedCursor(name, 0);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a delivery that never settles folds to a loud stall, never a silent lane death", async () => {
  const store = new MemoryBusStore();
  subscription(store, "stuck", "hook.%");
  subscription(store, "healthy", "act.%");
  await store.append(busEvent("hook.stop"));
  await store.append(busEvent("act.ping"));
  const delivered: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { subscription: string };
    if (body.subscription === "stuck") return new Promise(() => {}) as Promise<Response>;
    delivered.push(body.subscription);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const dispatcher = new Dispatcher(store, { deliveryTimeoutMs: 30, batchSize: 100, fetchImpl });
  dispatcher.start();
  // The stuck lane's await never settles on its own; the dispatcher must own
  // the bound and fold the pass anyway. On the pre-fix code settled() hangs
  // forever, so the race is the RED assertion.
  const settled = await Promise.race([
    dispatcher.settled().then(() => "settled" as const),
    sleep(500).then(() => "hung" as const),
  ]);
  expect(settled).toBe("settled");
  // The healthy lane delivered and advanced; the stuck lane stayed exactly
  // where it was — stalled loud, cursor untouched, nothing skipped.
  expect(delivered).toEqual(["healthy"]);
  expect(await store.cursor("healthy")).toBe(2);
  expect(await store.cursor("stuck")).toBe(0);
  await dispatcher.stop();
});

test("a blocked lane backs off: append-wakes inside the window do not retry", async () => {
  const store = new MemoryBusStore();
  subscription(store, "blocked", "hook.%");
  await store.append(busEvent());
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    return new Response("{}", { status: 422 });
  }) as unknown as typeof fetch;
  const dispatcher = new Dispatcher(store, { deliveryTimeoutMs: 120, batchSize: 100, fetchImpl });
  dispatcher.start();
  await dispatcher.settled();
  expect(attempts).toBe(1);
  // The storm shape: every append wakes the dispatcher. Inside the backoff
  // window none of these wakes may produce another attempt on the blocked
  // fact — pre-fix each wake retried immediately (sub-second storm).
  for (let i = 0; i < 10; i += 1) {
    await store.append(busEvent("act.noise"));
    dispatcher.wake();
    await dispatcher.settled();
  }
  expect(attempts).toBe(1);
  await dispatcher.stop();
});

test("a blocked lane retries by its own deadline without traffic, and success clears the streak", async () => {
  const store = new MemoryBusStore();
  subscription(store, "recovering", "hook.%");
  await store.append(busEvent());
  let attempts = 0;
  let healthy = false;
  const fetchImpl = (async () => {
    attempts += 1;
    return new Response("{}", { status: healthy ? 200 : 503 });
  }) as unknown as typeof fetch;
  const dispatcher = new Dispatcher(store, { deliveryTimeoutMs: 40, batchSize: 100, fetchImpl });
  dispatcher.start();
  await dispatcher.settled();
  expect(attempts).toBe(1);
  healthy = true;
  // No appends arrive. The backoff deadline itself must re-drive the lane —
  // a blocked lane whose only retry signal is fresh traffic stays blocked
  // exactly when the bus is quiet.
  await sleep(120);
  await dispatcher.settled();
  expect(attempts).toBe(2);
  expect(await store.cursor("recovering")).toBe(1);
  await dispatcher.stop();
});

test("a stalled lane recovers after the stall: the next drive redelivers and advances", async () => {
  const store = new MemoryBusStore();
  subscription(store, "wedged-once", "hook.%");
  await store.append(busEvent());
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) return new Promise(() => {}) as Promise<Response>;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const dispatcher = new Dispatcher(store, { deliveryTimeoutMs: 30, batchSize: 100, fetchImpl });
  dispatcher.start();
  await Promise.race([dispatcher.settled(), sleep(400)]);
  // The stall backs off like a failure, then the deadline re-drives the lane
  // and the second attempt lands.
  await sleep(120);
  await dispatcher.settled();
  expect(calls).toBeGreaterThanOrEqual(2);
  expect(await store.cursor("wedged-once")).toBe(1);
  await dispatcher.stop();
});
