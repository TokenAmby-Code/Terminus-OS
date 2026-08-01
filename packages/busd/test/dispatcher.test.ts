import { expect, test } from "bun:test";
import type { BusEventInput, ReplayAdmission } from "@terminus-os/contracts";
import { Dispatcher, ReplayDispatcher } from "../src/dispatcher.ts";
import { MemoryReplayStore } from "../src/replay-store.ts";
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

test("legacy bus delivery is ordered and an outage becomes blocked until a new wake", async () => {
  const store = new MemoryBusStore();
  store.setSubscription({ name: "consumer", delivery_url: DELIVERY_URL, event_pattern: "hook.%", active: true });
  store.seedCursor("consumer", 0);
  await store.append(busEvent());
  await store.append(busEvent("hook.notification"));
  const delivered: number[] = [];
  let available = false;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { event: { seq: number } };
    delivered.push(body.event.seq);
    return new Response("{}", { status: available ? 200 : 503 });
  }) as typeof fetch;
  const dispatcher = new Dispatcher(store, { deliveryTimeoutMs: 1_000, batchSize: 100, fetchImpl });
  dispatcher.start();
  await dispatcher.settled();
  expect(delivered).toEqual([1]);
  expect(await store.cursor("consumer")).toBe(0);

  available = true;
  dispatcher.wake();
  await dispatcher.settled();
  expect(delivered).toEqual([1, 1, 2]);
  expect(await store.cursor("consumer")).toBe(2);
  await dispatcher.stop();
});

test("startup reconciliation resumes from the durable cursor without a standing checker", async () => {
  const store = new MemoryBusStore();
  store.setSubscription({ name: "consumer", delivery_url: DELIVERY_URL, event_pattern: "hook.%", active: true });
  store.seedCursor("consumer", 1);
  await store.append(busEvent());
  await store.append(busEvent("hook.notification"));
  const delivered: number[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    delivered.push((JSON.parse(String(init?.body)) as { event: { seq: number } }).event.seq);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const dispatcher = new Dispatcher(store, { deliveryTimeoutMs: 1_000, batchSize: 100, fetchImpl });
  dispatcher.start();
  await dispatcher.settled();
  expect(delivered).toEqual([2]);
  await dispatcher.stop();
});

test("delivery can target a protected Unix socket without opening a loopback port", async () => {
  const store = new MemoryReplayStore(() => "2026-07-26T17:00:01.000Z");
  store.setSubscription({
    name: "githubd-github",
    delivery_url: "http+unix://%2Frun%2Fgithubd%2Fghd.sock/event",
    event_pattern: "github.%",
    active: true,
  });
  const input = {
    replay_id: "d9428888-122b-4c26-b269-0a3f62f4f06b",
    request_hash: "a".repeat(64),
    event: {
      replay_id: "d9428888-122b-4c26-b269-0a3f62f4f06b",
      event_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      event_type: "github.pull_request",
      schema_version: 1,
      source: "githubd",
      provenance: { machine: "test", ingress: "replay" },
      causation_event_id: null,
      occurred_at: "2026-07-26T17:00:00.000Z",
      payload: {},
    },
  } satisfies ReplayAdmission;
  await store.admit(input);
  const calls: Array<{ url: string; unix: unknown }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), unix: (init as RequestInit & { unix?: string })?.unix });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const dispatcher = new ReplayDispatcher(store, { deliveryTimeoutMs: 1_000, batchSize: 100, fetchImpl });
  dispatcher.start();
  await dispatcher.settled();
  expect(calls).toEqual([{ url: "http://localhost/event", unix: "/run/githubd/ghd.sock" }]);
  await dispatcher.stop();
});

test("replay outbox records failure durably and retries the same event identity only on a wake", async () => {
  const store = new MemoryReplayStore(() => "2026-07-26T17:00:01.000Z");
  store.setSubscription({ name: "manager", delivery_url: DELIVERY_URL, event_pattern: "githubd.%", active: true });
  const admission: ReplayAdmission = {
    replay_id: "d9428888-122b-4c26-b269-0a3f62f4f06b",
    request_hash: "a".repeat(64),
    event: {
      replay_id: "d9428888-122b-4c26-b269-0a3f62f4f06b",
      event_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      event_type: "githubd.command_accepted",
      schema_version: 1,
      source: "githubd",
      provenance: { machine: "test", ingress: "command" },
      causation_event_id: null,
      occurred_at: "2026-07-26T17:00:00.000Z",
      payload: {},
    },
  };
  await store.admit(admission);
  const identities: string[] = [];
  let available = false;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    identities.push((JSON.parse(String(init?.body)) as { event: { event_id: string } }).event.event_id);
    return new Response("{}", { status: available ? 200 : 429 });
  }) as typeof fetch;
  const dispatcher = new ReplayDispatcher(store, { deliveryTimeoutMs: 1_000, batchSize: 100, fetchImpl });
  dispatcher.start();
  await dispatcher.settled();
  expect(identities).toEqual([admission.event.event_id]);
  expect((await store.projection(admission.replay_id))?.deliveries[0]?.status).toBe("failed");

  available = true;
  dispatcher.wake();
  await dispatcher.settled();
  expect(identities).toEqual([admission.event.event_id, admission.event.event_id]);
  expect((await store.projection(admission.replay_id))?.deliveries[0]).toMatchObject({
    status: "delivered",
    attempts: 2,
  });
  await dispatcher.stop();
});

test("one blocked replay delivery does not strand an unrelated batch", async () => {
  const store = new MemoryReplayStore(() => "2026-07-26T17:00:01.000Z");
  store.setSubscription({ name: "blocked", delivery_url: "http://blocked/event", event_pattern: "githubd.%", active: true });
  store.setSubscription({ name: "healthy", delivery_url: "http://healthy/event", event_pattern: "githubd.%", active: true });
  const admission: ReplayAdmission = {
    replay_id: "d9428888-122b-4c26-b269-0a3f62f4f06b",
    request_hash: "a".repeat(64),
    event: {
      replay_id: "d9428888-122b-4c26-b269-0a3f62f4f06b",
      event_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      event_type: "githubd.command_accepted",
      schema_version: 1,
      source: "githubd",
      provenance: { machine: "test", ingress: "command" },
      causation_event_id: null,
      occurred_at: "2026-07-26T17:00:00.000Z",
      payload: {},
    },
  };
  await store.admit(admission);
  const delivered: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    delivered.push(String(url));
    return new Response("{}", { status: String(url).includes("blocked") ? 503 : 200 });
  }) as typeof fetch;
  const dispatcher = new ReplayDispatcher(store, { deliveryTimeoutMs: 1_000, batchSize: 1, fetchImpl });
  dispatcher.start();
  await dispatcher.settled();
  expect(new Set(delivered)).toEqual(new Set(["http://blocked/event", "http://healthy/event"]));
  const projection = await store.projection(admission.replay_id);
  expect(projection?.deliveries.find((item) => item.subscription === "blocked")?.status).toBe("failed");
  expect(projection?.deliveries.find((item) => item.subscription === "healthy")?.status).toBe("delivered");
  await dispatcher.stop();
});

test("worker loss after an external 2xx redelivers the same immutable event identity", async () => {
  const store = new MemoryReplayStore(() => "2026-07-26T17:00:01.000Z");
  store.setSubscription({ name: "manager", delivery_url: DELIVERY_URL, event_pattern: "githubd.%", active: true });
  const admission: ReplayAdmission = {
    replay_id: "d9428888-122b-4c26-b269-0a3f62f4f06b",
    request_hash: "a".repeat(64),
    event: {
      replay_id: "d9428888-122b-4c26-b269-0a3f62f4f06b",
      event_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      event_type: "githubd.command_accepted",
      schema_version: 1,
      source: "githubd",
      provenance: { machine: "test", ingress: "command" },
      causation_event_id: null,
      occurred_at: "2026-07-26T17:00:00.000Z",
      payload: {},
    },
  };
  await store.admit(admission);
  const originalRecord = store.recordDelivery.bind(store);
  let loseWorker = true;
  store.recordDelivery = async (...args) => {
    if (loseWorker) {
      loseWorker = false;
      throw new Error("injected worker loss after 2xx");
    }
    await originalRecord(...args);
  };
  const identities: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    identities.push((JSON.parse(String(init?.body)) as { event: { event_id: string } }).event.event_id);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const dispatcher = new ReplayDispatcher(store, { deliveryTimeoutMs: 1_000, batchSize: 10, fetchImpl });
  dispatcher.start();
  await dispatcher.settled();
  dispatcher.wake();
  await dispatcher.settled();
  expect(identities).toEqual([admission.event.event_id, admission.event.event_id]);
  expect((await store.projection(admission.replay_id))?.deliveries[0]).toMatchObject({
    status: "delivered",
    attempts: 1,
  });
  await dispatcher.stop();
});

test("graceful stop awaits an admitted replay delivery before closing its store boundary", async () => {
  const store = new MemoryReplayStore(() => "2026-07-26T17:00:01.000Z");
  store.setSubscription({ name: "manager", delivery_url: DELIVERY_URL, event_pattern: "githubd.%", active: true });
  const admission: ReplayAdmission = {
    replay_id: "d9428888-122b-4c26-b269-0a3f62f4f06b",
    request_hash: "a".repeat(64),
    event: {
      replay_id: "d9428888-122b-4c26-b269-0a3f62f4f06b",
      event_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      event_type: "githubd.command_accepted",
      schema_version: 1,
      source: "githubd",
      provenance: { machine: "test", ingress: "command" },
      causation_event_id: null,
      occurred_at: "2026-07-26T17:00:00.000Z",
      payload: {},
    },
  };
  await store.admit(admission);

  let release!: () => void;
  let deliveryStarted!: () => void;
  const started = new Promise<void>((resolve) => { deliveryStarted = resolve; });
  const response = new Promise<Response>((resolve) => {
    release = () => resolve(new Response("{}", { status: 200 }));
  });
  const fetchImpl = (async () => {
    deliveryStarted();
    return response;
  }) as unknown as typeof fetch;
  const dispatcher = new ReplayDispatcher(store, { deliveryTimeoutMs: 1_000, batchSize: 10, fetchImpl });
  dispatcher.start();
  await started;

  let stopped = false;
  const stopping = dispatcher.stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await stopping;
  expect(stopped).toBe(true);
  expect((await store.projection(admission.replay_id))?.deliveries[0]?.status).toBe("delivered");
});

test("a settled 2xx cannot park its delivery lane or graceful shutdown in body disposal", async () => {
  const store = new MemoryBusStore();
  store.setSubscription({ name: "consumer", delivery_url: DELIVERY_URL, event_pattern: "hook.%", active: true });
  store.seedCursor("consumer", 0);
  await store.append(busEvent());

  let disposalObserved!: () => void;
  const observed = new Promise<void>((resolve) => { disposalObserved = resolve; });
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    body: {
      cancel: () => {
        disposalObserved();
        return new Promise<void>(() => {});
      },
    },
  })) as unknown as typeof fetch;
  const dispatcher = new Dispatcher(store, { deliveryTimeoutMs: 1_000, batchSize: 100, fetchImpl });
  dispatcher.start();

  await observed;
  await Promise.resolve();
  await Promise.resolve();

  expect(await store.cursor("consumer")).toBe(1);
  await dispatcher.stop();
});
