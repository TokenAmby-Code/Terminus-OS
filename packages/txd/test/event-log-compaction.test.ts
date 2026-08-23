// Behavioral-pin lane: a sanctioned compaction replaces only a fully closed
// estate-generation prefix, and boot replay from that compacted stream must
// rebuild the exact same estate read model with the historical rows absent.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION, type EventInput, type EventRecord } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { compactEventRecords } from '../src/event-log-compaction.ts';
import { buildProjections } from '../src/projections.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const provenance = { source: 'observer' as const, transport_receipt: null, emitter_version: SCHEMA_VERSION };

function record(seq: number, input: EventInput): EventRecord {
  return { ...input, seq, recorded_at: input.occurred_at };
}

function event(
  seq: number,
  event_type: EventInput['event_type'],
  entity_type: EventInput['entity_type'],
  entity_id: string,
  payload: Record<string, unknown>,
): EventRecord {
  const occurred_at = `2026-08-16T14:10:${String(seq).padStart(2, '0')}.000Z`;
  return record(seq, { entity_type, entity_id, event_type, payload, provenance, occurred_at });
}

function fixture(): EventRecord[] {
  return [
    event(1, 'reg.pane_created', 'seat', 'palace:W', { pane_state: 'live' }),
    event(2, 'reg.bound', 'seat', 'palace:W', {
      agent_id: 'old-agent', birth_generation: 'old-birth', pane_generation: 'old-pane',
      persona: 'salamanders', rank: 'astartes', commander: 'council:custodes', tint: '#112233',
    }),
    event(3, 'reg.comm_accepted', 'message', 'open-message', {
      source_agent_id: 'old-agent', targets: [{ agent_id: 'old-target', seat_id: 'palace:N', persona: 'astartes' }],
      target_agent_ids: ['old-target'], ask_id: null, kind: 'message', message: 'still open',
    }),
    event(4, 'reg.comm_target_snapshotted', 'message', 'open-message', {
      message_id: 'open-message', targets: [{ agent_id: 'old-target', seat_id: 'palace:N', persona: 'astartes' }],
    }),
    event(5, 'estate.rotation_requested', 'estate', 'rotation-closed', { force: true }),
    event(6, 'reg.retired', 'agent', 'old-agent', {}),
    event(7, 'reg.process_reaped', 'seat', 'palace:W', {}),
    event(8, 'reg.seat_cleared', 'seat', 'palace:W', {}),
    event(9, 'estate.rotation_completed', 'estate', 'rotation-closed', { canonical_seats: 1 }),
    event(10, 'reg.launch_composed', 'seat', 'palace:W', {
      seat_id: 'palace:W', agent_id: 'current-agent', launch_nonce: 'nonce',
      pane_generation: 'current-pane', target_machine: null, worktree: null,
    }),
    event(11, 'reg.transport_claimed', 'seat', 'palace:W', {
      kind: 'local', pane_generation: 'current-pane', target_machine: null,
      launch_nonce: null, envelope_session: null,
    }),
    event(12, 'reg.bound', 'seat', 'palace:W', {
      agent_id: 'current-agent', birth_generation: 'current-birth', pane_generation: 'current-pane',
      persona: 'salamanders', rank: 'astartes', commander: 'council:custodes', tint: '#334455',
    }),
    event(13, 'reg.agent_registered', 'agent', 'current-agent', {
      persona: 'salamanders', rank: 'astartes', commander: 'council:custodes',
    }),
    event(14, 'act.stop_reported', 'agent', 'current-agent', {}),
  ];
}

test('boot replay rebuilds the identical estate model with a superseded generation absent', async () => {
  const before = fixture();
  const expected = buildProjections(before);
  const compacted = compactEventRecords(before, {
    boundary_seq: 9,
    archive_attestation: 'snapshot=~/backups/reset-point-2026-08-23;restore-proof=journal.head=8739',
    reset_journal_head: 8722,
  });

  expect(compacted.map((row) => row.entity_id)).not.toContain('old-agent');
  expect(compacted.filter((row) => row.entity_id === 'open-message').map((row) => row.event_type)).toEqual([
    'reg.comm_accepted', 'reg.comm_target_snapshotted',
  ]);
  expect(compacted.find((row) => row.event_type === 'estate.compaction_checkpoint')).toMatchObject({
    seq: 9,
    entity_type: 'estate',
    event_type: 'estate.compaction_checkpoint',
    payload: { boundary_seq: 9, reset_journal_head: 8722 },
  });
  expect(buildProjections(compacted)).toEqual(expected);

  const restarted = MemoryEventStore.fromRecords(compacted);
  const daemon = new Daemon(restarted, new FakeTmux());
  expect(await daemon.estateRows()).toEqual(expected.seatBoard);
});

test('compaction refuses an absent archive attestation before changing the stream', () => {
  expect(() => compactEventRecords(fixture(), {
    boundary_seq: 9,
    archive_attestation: '',
    reset_journal_head: 8722,
  })).toThrow('archive_attestation_required');
});

test('compaction refuses a restore proof that does not reach the reset journal head', () => {
  expect(() => compactEventRecords(fixture(), {
    boundary_seq: 9,
    archive_attestation: 'snapshot=/verified/reset-point;restore-proof=journal.head=8721',
    reset_journal_head: 8722,
  })).toThrow('archive_restore_before_reset_head');
});

test('compaction refuses an open rotation and never consumes the current generation', () => {
  const events = fixture();
  events.splice(8, 1);
  expect(() => compactEventRecords(events, {
    boundary_seq: 9,
    archive_attestation: 'snapshot=/verified/reset-point;restore-proof=journal.head=8739',
    reset_journal_head: 8722,
  })).toThrow('estate_generation_not_closed');
  expect(events.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14]);
});
