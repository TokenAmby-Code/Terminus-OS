import { afterEach, expect, test } from "bun:test";
import type { DesktopTelemetryEventT } from "@terminus-os/contracts";
import { makeServer } from "../src/server.ts";
import type { TelemetryStore } from "../src/store.ts";


class MemoryStore implements TelemetryStore {
  readonly events: DesktopTelemetryEventT[] = [];

  async record(event: DesktopTelemetryEventT): Promise<boolean> {
    if (this.events.some((candidate) => candidate.event_id === event.event_id)) return false;
    this.events.push(event);
    return true;
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
