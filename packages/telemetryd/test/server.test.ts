import { afterEach, expect, test } from "bun:test";
import type { DesktopTelemetryEventT, PhoneMacroDroidHookRecordT } from "@terminus-os/contracts";
import { makeServer } from "../src/server.ts";
import type { TelemetryStore } from "../src/store.ts";


class MemoryStore implements TelemetryStore {
  readonly events: DesktopTelemetryEventT[] = [];
  readonly phoneHooks: PhoneMacroDroidHookRecordT[] = [];

  async record(event: DesktopTelemetryEventT): Promise<boolean> {
    if (this.events.some((candidate) => candidate.event_id === event.event_id)) return false;
    this.events.push(event);
    return true;
  }

  async recordPhoneHook(hook: PhoneMacroDroidHookRecordT): Promise<void> {
    this.phoneHooks.push(hook);
  }

  async close(): Promise<void> {}
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { while (servers.length) servers.pop()!.stop(true); });

const event = {
  schema_version: 1,
  event_id: "018f47d2-e083-7d38-9cf8-6f0c3f5e5c77",
  observed_at: "2026-07-22T20:00:00.000Z",
  machine: "wsl",
  source: "windows_event",
  activity: "video",
  application: "brave",
  title: "A useful talk - YouTube",
  foreground: true,
  youtube: true,
};

function serve(store: TelemetryStore) {
  const server = makeServer({ store, build: { version: "test", git_sha: "abc", bun: Bun.version }, port: 0 });
  servers.push(server);
  return `http://${server.hostname}:${server.port}`;
}

test("records one typed desktop event and deduplicates its event id", async () => {
  const store = new MemoryStore();
  const base = serve(store);

  const first = await fetch(`${base}/events`, { method: "POST", body: JSON.stringify(event) });
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true, event_id: event.event_id, recorded: true });

  const duplicate = await fetch(`${base}/events`, { method: "POST", body: JSON.stringify(event) });
  expect(await duplicate.json()).toEqual({ ok: true, event_id: event.event_id, recorded: false });
  expect(store.events).toHaveLength(1);
});

test("rejects enforcement instructions at the ingress boundary", async () => {
  const store = new MemoryStore();
  const base = serve(store);
  const response = await fetch(`${base}/events`, {
    method: "POST",
    body: JSON.stringify({ ...event, action: "close-video" }),
  });

  expect(response.status).toBe(400);
  expect(store.events).toHaveLength(0);
});

test("decodes and records the MacroDroid phone hook envelope", async () => {
  const store = new MemoryStore();
  const base = serve(store);
  const hook = {
    schema_version: 1,
    event_type: "phone.spotify",
    source: "phone.macrodroid",
    payload: { app: "Spotify", playing: "true" },
    occurred_at: "1786752000123",
  } as const;

  const response = await fetch(`${base}/events`, { method: "POST", body: JSON.stringify(hook) });

  expect(response.status).toBe(200);
  const receipt = await response.json() as { ok: boolean; hook_id: string; recorded: boolean };
  expect(receipt.ok).toBe(true);
  expect(receipt.recorded).toBe(true);
  expect(receipt.hook_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(store.phoneHooks).toEqual([{
    hook_id: receipt.hook_id,
    ...hook,
    occurred_at: "2026-08-15T00:00:00.123Z",
    payload: { app: "Spotify", playing: true },
  }]);
});

test("accepts every enabled MacroDroid hook envelope from the live export", async () => {
  const store = new MemoryStore();
  const base = serve(store);
  const hooks = [
    {
      schema_version: 1,
      event_type: "phone.application",
      source: "phone.macrodroid",
      payload: { event: "Application Closed (YouTube)" },
      occurred_at: "1786752000123",
    },
    {
      schema_version: 1,
      event_type: "phone.geofence",
      source: "phone.macrodroid",
      payload: { event: "Entered Home" },
      occurred_at: "1786752000124",
    },
    {
      schema_version: 1,
      event_type: "phone.proxy_egress_macro_probe",
      source: "phone.macrodroid",
      payload: { probe: "proxy-egress-70473da" },
      occurred_at: "2026-07-27T04:05:30Z",
    },
  ] as const;

  for (const hook of hooks) {
    const response = await fetch(`${base}/events`, { method: "POST", body: JSON.stringify(hook) });
    expect(response.status).toBe(200);
  }
  expect(store.phoneHooks.map(({ event_type }) => event_type)).toEqual([
    "phone.application",
    "phone.geofence",
    "phone.proxy_egress_macro_probe",
  ]);
});

test("rejects a forged phone source and unknown phone hook type", async () => {
  const store = new MemoryStore();
  const base = serve(store);
  const hook = {
    schema_version: 1,
    event_type: "phone.spotify",
    source: "phone.macrodroid",
    payload: { app: "Spotify", playing: "false" },
    occurred_at: "1786752000123",
  };
  expect((await fetch(`${base}/events`, {
    method: "POST",
    body: JSON.stringify({ ...hook, source: "phone.forged" }),
  })).status).toBe(400);
  expect((await fetch(`${base}/events`, {
    method: "POST",
    body: JSON.stringify({ ...hook, event_type: "phone.command" }),
  })).status).toBe(400);
  expect(store.phoneHooks).toEqual([]);
});
