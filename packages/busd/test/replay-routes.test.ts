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
      schema_version: 1 as const,
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
    expect(await response.json()).toEqual({ replays: [replayId], next_cursor: null });

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

    response = await fetch(`${base}/v1/events?source=githubd&event_type_prefix=githubd.&limit=1`);
    const firstPage = await response.json() as { events: Array<{ event_id: string }>; next_cursor: string | null };
    expect(firstPage.events.map((event) => event.event_id)).toEqual([eventId]);
    expect(firstPage.next_cursor).toBe(eventId);
    response = await fetch(`${base}/v1/events?source=githubd&event_type_prefix=githubd.&limit=1&after=${firstPage.next_cursor}`);
    const secondPage = await response.json() as { events: Array<{ event_id: string }>; next_cursor: string | null };
    expect(secondPage.events.map((event) => event.event_id)).toEqual([
      "9e107d9d-372b-4f4f-9b9d-64a3f5f6b8c1",
    ]);
    expect(secondPage.next_cursor).toBeNull();
  } finally {
    server.stop(true);
  }
});

test("the append route refuses every event after a stream terminates", async () => {
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
  const terminal = {
    ...input().event,
    event_id: "9e107d9d-372b-4f4f-9b9d-64a3f5f6b8c1",
    event_type: "githubd.command_completed",
    causation_event_id: eventId,
    payload: { terminal: true, outcome: "succeeded" },
  };
  const append = (event: unknown) => fetch(`${base}/v1/replays/${replayId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event }),
  });
  try {
    await fetch(`${base}/v1/replays/admit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input()),
    });
    expect((await append(terminal)).status).toBe(201);
    const forged = await append({
      ...input().event,
      event_id: "3f9d1c22-77aa-4a5b-9c3e-1b8f2d4e6a70",
      event_type: "githubd.convergence_attested",
      causation_event_id: eventId,
      payload: { terminal: true, outcome: "succeeded" },
    });
    expect(forged.status).toBe(409);
    expect(await forged.json()).toEqual({ ok: false, error: "terminal_stream_append" });
    // The refusal is a guard, not a loss of idempotency: the terminal event
    // itself still re-folds, and no wake fires for a refused append.
    const repeated = await append(terminal);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ ok: true, created: false });
    expect(wakes).toBe(2);
    const projection = await (await fetch(`${base}/v1/replays/${replayId}`)).json() as { events: unknown[] };
    expect(projection.events).toHaveLength(2);
  } finally {
    server.stop(true);
  }
});

test("event feed refuses invalid filters and unknown cursors", async () => {
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
    expect((await fetch(`${base}/v1/events?limit=0`)).status).toBe(422);
    expect((await fetch(`${base}/v1/events?event_type_prefix=github.*`)).status).toBe(422);
    expect((await fetch(`${base}/v1/events?after=${crypto.randomUUID()}`)).status).toBe(422);
  } finally {
    server.stop(true);
  }
});

test("unfinished replay reconciliation is bounded and cursor-paginated", async () => {
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
  const firstReplay = "11111111-1111-4111-8111-111111111111";
  const secondReplay = "22222222-2222-4222-8222-222222222222";
  for (const [currentReplay, currentEvent] of [
    [firstReplay, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    [secondReplay, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
  ] as const) {
    await replayStore.admit({
      ...input(),
      replay_id: currentReplay,
      request_hash: currentReplay === firstReplay ? "1".repeat(64) : "2".repeat(64),
      event: { ...input().event, replay_id: currentReplay, event_id: currentEvent },
    });
  }
  const base = `http://127.0.0.1:${server.port}`;
  try {
    let response = await fetch(`${base}/v1/replays?source=githubd&unfinished=true&limit=1`);
    expect(await response.json()).toEqual({ replays: [firstReplay], next_cursor: firstReplay });
    response = await fetch(
      `${base}/v1/replays?source=githubd&unfinished=true&limit=1&after=${firstReplay}`,
    );
    expect(await response.json()).toEqual({ replays: [secondReplay], next_cursor: null });

    expect((await fetch(`${base}/v1/replays?source=githubd&unfinished=true&limit=0`)).status).toBe(422);
    expect((await fetch(
      `${base}/v1/replays?source=githubd&unfinished=true&after=${crypto.randomUUID()}`,
    )).status).toBe(422);
  } finally {
    server.stop(true);
  }
});

test("unfinished command query requires and preserves machine scope with a derived total", async () => {
  const replayStore = new MemoryReplayStore();
  const server = makeServer({
    bind: "127.0.0.1", port: 0, store: new MemoryBusStore(), replayStore,
    onAppend: () => {}, build: { version: "test", git_sha: "test", bun: Bun.version }, machine: "test",
  });
  const local = "55555555-5555-4555-8555-555555555555";
  const foreign = "66666666-6666-4666-8666-666666666666";
  await replayStore.admit({
    ...input(), replay_id: local, request_hash: "5".repeat(64),
    event: { ...input().event, replay_id: local, event_id: crypto.randomUUID() },
  });
  await replayStore.admit({
    ...input(), replay_id: foreign, request_hash: "6".repeat(64),
    event: {
      ...input().event, replay_id: foreign, event_id: crypto.randomUUID(),
      provenance: { machine: "other", ingress: "command" },
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const response = await fetch(
      `${base}/v1/replays?source=githubd&unfinished=true&machine=test&kind=command&limit=10`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ replays: [local], next_cursor: null, total: 1 });
    expect((await fetch(
      `${base}/v1/replays?source=githubd&unfinished=true&kind=command&limit=10`,
    )).status).toBe(422);
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

    const identityConflict = await fetch(`${base}/v1/replays/${replayId}/events`, {
      method: "POST",
      body: JSON.stringify({ event: { ...input().event, payload: { operation: "changed" } } }),
    });
    expect(identityConflict.status).toBe(409);
    expect(await identityConflict.json()).toEqual({ ok: false, error: "event_identity_conflict" });

    const otherReplay = "44444444-4444-4444-8444-444444444444";
    const admissionConflict = await fetch(`${base}/v1/replays/admit`, {
      method: "POST",
      body: JSON.stringify({
        ...input(),
        replay_id: otherReplay,
        request_hash: "c".repeat(64),
        event: { ...input().event, replay_id: otherReplay },
      }),
    });
    expect(admissionConflict.status).toBe(409);
    expect(await admissionConflict.json()).toEqual({ ok: false, error: "event_identity_conflict" });
  } finally {
    server.stop(true);
  }
});

test("replay routes distinguish unknown streams from path and body mismatches", async () => {
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
  const unknownReplay = "33333333-3333-4333-8333-333333333333";
  try {
    expect((await fetch(`${base}/v1/replays/${unknownReplay}`)).status).toBe(404);

    let response = await fetch(`${base}/v1/replays/${unknownReplay}/events`, {
      method: "POST",
      body: JSON.stringify({
        event: {
          ...input().event,
          replay_id: unknownReplay,
          event_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        },
      }),
    });
    expect(response.status).toBe(404);

    response = await fetch(`${base}/v1/replays/${unknownReplay}/events`, {
      method: "POST",
      body: JSON.stringify({ event: input().event }),
    });
    expect(response.status).toBe(422);
  } finally {
    server.stop(true);
  }
});
