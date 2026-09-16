// Behavioral pin: txd derives a deterministic idempotency key and event id from
// a producer-owned occurrence, and journal.publish folds occurred_at into the
// content hash it compares under that key. A publication whose instant moves
// between deliveries is therefore unpublishable forever, and the lane that
// carried it parks on the refusal rather than skipping the fact.
//
// The specimen: hook fact 1339, palace:W, wrapper_pid 3776288, refused
// wrapper_process_missing. Its first delivery timed out on lifecycled's side
// after the publication had already committed as journal.events seq 78185;
// every redelivery afterwards answered idempotency_conflict, parking the
// txd-wrapper service lane at cursor 1338 and starving every subsequent birth
// on the machine of its agent.pane_attested fact.

import { expect, test } from 'bun:test';
import { makeJournalPublisher } from '../src/events.ts';

const MACHINE = 'k12-personal';
const HOOK_REQUEST_ID = 'd8819e90-7426-4c7c-980b-1a79c8bdbd88';
const FACT_OCCURRED_AT = '2026-09-16T04:21:25.477Z';

const paneRefusal = (hookRequestId = HOOK_REQUEST_ID) => ({
  hook_request_id: hookRequestId,
  claimed_pane_id: 'palace:W',
  machine: MACHINE,
  wrapper_pid: 3_776_288,
  reason: 'wrapper_process_missing',
});

/**
 * journal.publish's admission rule, transcribed from the deployed function: a
 * matching (producer, idempotency_key) or event_id is a duplicate only when the
 * whole content hash matches, and occurred_at is one of the hashed fields.
 */
function fakeJournal() {
  const rows = new Map<string, { eventId: string; hash: string; seq: number }>();
  const byEventId = new Map<string, string>();
  let seq = 0;
  const contentHash = (p: unknown[]): string => JSON.stringify({
    event_id: p[1], event_type: p[2], schema_version: p[3], idempotency_key: p[4],
    occurred_at: p[5], payload: p[6], stream_id: p[7], stream_seq: p[8],
    causation_event_id: p[9], correlation_id: p[10], provenance: p[11],
  });
  const transaction = {
    unsafe: async (_text: string, params: unknown[]) => {
      const key = `${String(params[0])}::${String(params[4])}`;
      const existing = rows.get(key) ?? rows.get(byEventId.get(String(params[1])) ?? '');
      const hash = contentHash(params);
      if (existing) {
        if (existing.eventId !== params[1] || existing.hash !== hash) {
          throw new Error('idempotency_conflict');
        }
        return [{
          seq: existing.seq, event_id: existing.eventId, event_type: params[2],
          schema_version: params[3], recorded_at: new Date().toISOString(), duplicate: true,
        }];
      }
      seq += 1;
      rows.set(key, { eventId: String(params[1]), hash, seq });
      byEventId.set(String(params[1]), key);
      return [{
        seq, event_id: params[1], event_type: params[2], schema_version: params[3],
        recorded_at: new Date().toISOString(), duplicate: false,
      }];
    },
  };
  const sql = { begin: async <T>(fn: (t: typeof transaction) => Promise<T>) => await fn(transaction) };
  return { sql, count: () => rows.size };
}

test('a redelivered pane refusal republishes as a duplicate instead of parking the lane', async () => {
  const journal = fakeJournal();
  const publish = makeJournalPublisher(journal.sql as never, MACHINE);

  await publish('agent.pane_refused', paneRefusal(), FACT_OCCURRED_AT);
  await publish('agent.pane_refused', paneRefusal(), FACT_OCCURRED_AT);
  await publish('agent.pane_refused', paneRefusal(), FACT_OCCURRED_AT);

  expect(journal.count()).toBe(1);
});

test('a redelivered pane attestation republishes as a duplicate', async () => {
  const journal = fakeJournal();
  const publish = makeJournalPublisher(journal.sql as never, MACHINE);
  const attestation = {
    hook_request_id: HOOK_REQUEST_ID,
    claimed_pane_id: 'palace:W',
    pane_id: 'palace:W',
    pane_generation: 'ea40bb8a-8eba-4be6-b449-a59fb0701525',
    machine: MACHINE,
    kind: 'local',
    agent_id: '54cd37f2-3d80-4b0a-86b8-99ee96dfd8b4',
    wrapper_pid: 3_776_288,
    configuration: { generation: 'estate-1', digest: 'c'.repeat(64) },
    worktree: null,
    process_witnesses: {},
  };

  await publish('agent.pane_attested', attestation, FACT_OCCURRED_AT);
  await publish('agent.pane_attested', attestation, FACT_OCCURRED_AT);

  expect(journal.count()).toBe(1);
});

test('negative control: the conflict guard still refuses changed content under one key', async () => {
  const journal = fakeJournal();
  const publish = makeJournalPublisher(journal.sql as never, MACHINE);

  await publish('agent.pane_refused', paneRefusal(), FACT_OCCURRED_AT);
  await expect(publish(
    'agent.pane_refused',
    { ...paneRefusal(), reason: 'pane_dead' },
    FACT_OCCURRED_AT,
  )).rejects.toThrow('idempotency_conflict');
  await expect(publish(
    'agent.pane_refused',
    paneRefusal(),
    '2026-09-16T04:21:58.848Z',
  )).rejects.toThrow('idempotency_conflict');

  expect(journal.count()).toBe(1);
});

test('negative control: a distinct occurrence is still a distinct event', async () => {
  const journal = fakeJournal();
  const publish = makeJournalPublisher(journal.sql as never, MACHINE);

  await publish('agent.pane_refused', paneRefusal(), FACT_OCCURRED_AT);
  await publish(
    'agent.pane_refused',
    paneRefusal('9e07de2b-5845-43a1-8861-b8da98fb0ba0'),
    '2026-09-16T04:45:11.639Z',
  );

  expect(journal.count()).toBe(2);
});
