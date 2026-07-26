import { expect, test } from "bun:test";
import { MemoryBusStore } from "../src/store.ts";
import { MemoryReplayStore } from "../src/replay-store.ts";
import { makeServer } from "../src/server.ts";

const replayId = "d9428888-122b-4c26-b269-0a3f62f4f06b";
const eventId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function input() {
  return {
    replay_id: replayId,
    request_hash: "a".repeat(64),
    event: {
      replay_id: replayId,
      event_id: eventId,
      event_type: "githubd.command_accepted",
      schema_version: 1,
      source: "githubd",
      provenance: { machine: "test", ingress: "command" },
      causation_event_id: null,
      occurred_at: "2026-07-26T17:00:00.000Z",
      payload: { operation: "repo.synchronize" },
    },
  };
}

test("replay HTTP admission, append, inspection, and unfinished reconciliation", async () => {
  const replayStore = new MemoryReplayStore(() => "2026-07-26T17:01:00.000Z");
  let wakes = 0;
  const server = makeServer({
    bind: "127.0.0.1",
    port: 0,
    store: new MemoryBusStore(),
    replayStore,
    onAppend: () => { wakes += 1; },
    build: { version: "test", git_sha: "test", bun: Bun.version },
    machine: "test",
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    let response = await fetch(`${base}/v1/replays/admit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input()),
    });
    expect(response.status).toBe(201);
    expect(wakes).toBe(1);

    response = await fetch(`${base}/v1/replays/admit`, {
      method: "POST",
      body: JSON.stringify(input()),
    });
    expect(response.status).toBe(200);

    response = await fetch(`${base}/v1/replays?source=githubd&unfinished=true`);
    expect(await response.json()).toEqual({ replays: [replayId] });

    response = await fetch(`${base}/v1/replays/${replayId}/events`, {
      method: "POST",
      body: JSON.stringify({
        event: {
          ...input().event,
          event_id: "9e107d9d-372b-4f4f-9b9d-64a3f5f6b8c1",
          event_type: "githubd.command_completed",
          causation_event_id: eventId,
          payload: { terminal: true, outcome: "succeeded" },
        },
      }),
    });
    expect(response.status).toBe(201);

    response = await fetch(`${base}/v1/replays/${replayId}`);
    const projection = await response.json() as { terminal: boolean; events: unknown[] };
    expect(projection.terminal).toBe(true);
    expect(projection.events).toHaveLength(2);
    expect(wakes).toBe(2);
  } finally {
    server.stop(true);
  }
});

test("changed request hash and changed event identity conflict without mutation", async () => {
  const replayStore = new MemoryReplayStore();
  const server = makeServer({
    bind: "127.0.0.1",
    port: 0,
    store: new MemoryBusStore(),
    replayStore,
    onAppend: () => {},
    build: { version: "test", git_sha: "test", bun: Bun.version },
    machine: "test",
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await fetch(`${base}/v1/replays/admit`, { method: "POST", body: JSON.stringify(input()) });
    const conflict = await fetch(`${base}/v1/replays/admit`, {
      method: "POST",
      body: JSON.stringify({ ...input(), request_hash: "b".repeat(64) }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ ok: false, error: "idempotency_conflict" });
  } finally {
    server.stop(true);
  }
});
