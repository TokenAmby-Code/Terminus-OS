import { expect, test } from 'bun:test';
import { BUS_SCHEMA_VERSION } from '@terminus-os/contracts';
import { MemoryBusStore } from '../src/store.ts';
import { makeServer } from '../src/server.ts';

const build = { version: '0.1.0', git_sha: 'test', bun: '1.0' };

function fixture() {
  const store = new MemoryBusStore(() => '2026-07-22T00:00:00.000Z');
  let wakes = 0;
  const srv = makeServer({
    bind: '127.0.0.1',
    port: 0,
    store,
    onAppend: () => {
      wakes += 1;
    },
    build,
    machine: 'k12-personal',
    clock: () => '2026-07-22T00:00:00.000Z',
  });
  return { store, srv, wakes: () => wakes };
}

// ── the hook shim door ──────────────────────────────────────────────────────

test('a hook POST journals hook.<type> with harness attribution, proxy receipt, and machine provenance', async () => {
  const { store, srv, wakes } = fixture();
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/ingress/hooks/stop`, {
      method: 'POST',
      headers: { 'x-edge-proxy': 'edge_proxy' },
      body: JSON.stringify({ harness: 'codex', session_id: 's1', instance_id: 'i1', schema_version: 6 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, seq: 1, event_type: 'hook.stop' });
    const [rec] = await store.readSince(0, '%', 10);
    expect(rec).toEqual({
      seq: 1,
      event_type: 'hook.stop',
      source: 'codex',
      payload: { harness: 'codex', session_id: 's1', instance_id: 'i1', schema_version: 6 },
      provenance: { ingress: 'hooks', transport_receipt: 'edge_proxy', machine: 'k12-personal' },
      occurred_at: '2026-07-22T00:00:00.000Z',
      recorded_at: '2026-07-22T00:00:00.000Z',
    });
    expect(wakes()).toBe(1); // every append wakes the dispatcher in-process
  } finally {
    srv.stop(true);
  }
});

test('a hook body without the harness marker journals source=unknown (absence is data, not refusal)', async () => {
  const { store, srv } = fixture();
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/ingress/hooks/notification`, {
      method: 'POST',
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(res.status).toBe(200);
    const [rec] = await store.readSince(0, '%', 10);
    expect(rec!.source).toBe('unknown');
    expect(rec!.provenance.transport_receipt).toBeNull(); // direct hit, no proxy receipt
  } finally {
    srv.stop(true);
  }
});

test('malformed hook bodies are 422 and journal nothing', async () => {
  const { store, srv, wakes } = fixture();
  try {
    for (const body of ['not json {{', '"a string"', '[1,2]', '']) {
      const res = await fetch(`http://127.0.0.1:${srv.port}/ingress/hooks/stop`, { method: 'POST', body });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_hook_payload');
    }
    expect(await store.count()).toBe(0);
    expect(wakes()).toBe(0);
  } finally {
    srv.stop(true);
  }
});

// ── the generic publish door ────────────────────────────────────────────────

test('POST /ingress/events journals a generic event with ingress=events provenance', async () => {
  const { store, srv, wakes } = fixture();
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/ingress/events`, {
      method: 'POST',
      body: JSON.stringify({
        schema_version: BUS_SCHEMA_VERSION,
        event_type: 'obsidian.note_ingested',
        source: 'obsidian-ingress',
        payload: { path: 'daily/2026-07-22.md' },
        occurred_at: '2026-07-22T00:00:00.000Z',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, seq: 1, event_type: 'obsidian.note_ingested' });
    const [rec] = await store.readSince(0, '%', 10);
    expect(rec!.provenance).toEqual({ ingress: 'events', transport_receipt: null, machine: 'k12-personal' });
    expect(rec!.occurred_at).toBe('2026-07-22T00:00:00.000Z'); // emitter's attested clock, verbatim
    expect(wakes()).toBe(1);
  } finally {
    srv.stop(true);
  }
});

test('the generic door rejects the reserved hook.* namespace — a hook cannot be forged past the shim', async () => {
  const { store, srv } = fixture();
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/ingress/events`, {
      method: 'POST',
      body: JSON.stringify({
        schema_version: BUS_SCHEMA_VERSION,
        event_type: 'hook.stop',
        source: 'forger',
        payload: {},
        occurred_at: '2026-07-22T00:00:00.000Z',
      }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_publish_request');
    expect(await store.count()).toBe(0);
  } finally {
    srv.stop(true);
  }
});

test('the generic door refuses malformed envelopes and schema-version skew loud', async () => {
  const { store, srv } = fixture();
  try {
    const valid = {
      schema_version: BUS_SCHEMA_VERSION,
      event_type: 'probe.ping',
      source: 'probe',
      payload: {},
      occurred_at: '2026-07-22T00:00:00.000Z',
    };
    let res = await fetch(`http://127.0.0.1:${srv.port}/ingress/events`, {
      method: 'POST',
      body: JSON.stringify({ ...valid, event_type: 'UnDotted' }),
    });
    expect(res.status).toBe(422);
    res = await fetch(`http://127.0.0.1:${srv.port}/ingress/events`, {
      method: 'POST',
      body: JSON.stringify({ ...valid, schema_version: 999 }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('schema_version_mismatch');
    expect(await store.count()).toBe(0);
  } finally {
    srv.stop(true);
  }
});

test('a dead store 5xxs the doors — the ruled no-fallback posture', async () => {
  const store = new MemoryBusStore();
  store.append = async () => {
    throw new Error('db down');
  };
  const srv = makeServer({ bind: '127.0.0.1', port: 0, store, onAppend: () => {}, build, machine: 'test' });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/ingress/hooks/stop`, {
      method: 'POST',
      body: JSON.stringify({ harness: 'claude' }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('internal_error');
  } finally {
    srv.stop(true);
  }
});
