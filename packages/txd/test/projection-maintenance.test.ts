// Behavioral-pin: txd folds the durable stream once, then maintains that fold
// at the append boundary. Public reads never replay the full log.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION, type EventLogCompactionRequest, type EventRecord } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

class ReadAllSpyStore extends MemoryEventStore {
  reads = 0;

  override async readAll(signal?: AbortSignal) {
    this.reads += 1;
    return super.readAll(signal);
  }
}

class RewritingStore extends ReadAllSpyStore {
  override async compact(request: EventLogCompactionRequest) {
    const state = this as unknown as { events: EventRecord[]; nextSeq: number };
    state.events = [{
      seq: 1,
      entity_type: 'seat',
      entity_id: 'somnium:N',
      event_type: 'reg.pane_created',
      payload: { pane_state: 'live' },
      provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
      occurred_at: '2026-08-28T00:00:00.000Z',
      recorded_at: '2026-08-28T00:00:00.000Z',
    }];
    state.nextSeq = 2;
    return {
      ok: true as const,
      boundary_seq: 1,
      archived_events: 1,
      retained_events: 1,
      archived_digest: 'sha256:compacted',
      reset_journal_head: request.reset_journal_head,
    };
  }
}

test('boot folds once and reads plus appends maintain the projection without replay', async () => {
  const store = new ReadAllSpyStore();
  const daemon = new Daemon(store, new FakeTmux());

  for (let i = 0; i < 5; i += 1) expect(await daemon.estateRows()).toEqual([]);

  const launched = await daemon.launch({
    seat_id: 'palace:W',
    schema_version: SCHEMA_VERSION,
    identity: 'maintained-agent',
    persona: 'ultramarines',
    tint: '#111111',
  });
  expect(launched.ok).toBe(true);
  expect((await daemon.estateRows()).find((row) => row.seat_id === 'palace:W'))
    .toMatchObject({ binding: 'bound', entity_id: 'maintained-agent' });

  expect(store.reads).toBe(1);
});

test('a log rewrite rebuilds the maintained fold before the lock is released', async () => {
  const store = new RewritingStore();
  await store.append({
    entity_type: 'seat', entity_id: 'palace:W', event_type: 'reg.pane_created',
    payload: { pane_state: 'live' },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-08-28T00:00:00.000Z',
  });
  const daemon = new Daemon(store, new FakeTmux());
  expect((await daemon.estateRows()).map((row) => row.seat_id)).toEqual(['palace:W']);

  await daemon.compactEventLog({
    schema_version: SCHEMA_VERSION,
    reset_journal_head: 1,
    archive_attestation: 'snapshot=test;restore-proof=journal.head=1',
    source_agent_id: 'projection-test',
  });

  expect((await daemon.estateRows()).map((row) => row.seat_id)).toEqual(['somnium:N']);
  expect(store.reads).toBe(2);
});
