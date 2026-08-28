import { createHash } from 'node:crypto';
import {
  EventRecordSchema,
  type EventLogCompactionRequest,
  type EventRecord,
} from '@terminus-os/contracts';
import { buildProjections, type Projections } from './projections.ts';

export type ResolvedEventLogCompaction = Pick<EventLogCompactionRequest,
  'reset_journal_head' | 'archive_attestation'> & {
  boundary_seq: number;
};

export type EventLogCompactionResult = {
  ok: true;
  boundary_seq: number;
  archived_events: number;
  retained_events: number;
  archived_digest: string;
  reset_journal_head: number;
};

export type ProjectionDifference = {
  path: string;
  expected: unknown;
  actual: unknown;
};

const missingProjectionValue = { type: 'missing' } as const;

function diagnosticValue(value: unknown): unknown {
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'bigint') return { type: 'bigint', value: String(value) };
  return value;
}

function objectPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** Return the first concrete difference behind the compaction equality gate. */
export function firstProjectionDifference(expected: unknown, actual: unknown, path = '$'): ProjectionDifference | null {
  if (Bun.deepEquals(expected, actual)) return null;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const commonLength = Math.min(expected.length, actual.length);
    for (let index = 0; index < commonLength; index += 1) {
      const difference = firstProjectionDifference(expected[index], actual[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return { path: `${path}.length`, expected: expected.length, actual: actual.length };
  }
  if (expected instanceof Map && actual instanceof Map) {
    const keys = [...new Set([...expected.keys(), ...actual.keys()])].map(String).sort();
    for (const key of keys) {
      const expectedHas = expected.has(key);
      const actualHas = actual.has(key);
      const keyPath = objectPath(path, key);
      if (!expectedHas || !actualHas) {
        return {
          path: keyPath,
          expected: expectedHas ? diagnosticValue(expected.get(key)) : missingProjectionValue,
          actual: actualHas ? diagnosticValue(actual.get(key)) : missingProjectionValue,
        };
      }
      const difference = firstProjectionDifference(expected.get(key), actual.get(key), keyPath);
      if (difference) return difference;
    }
  }
  if (expected instanceof Set && actual instanceof Set) {
    return {
      path,
      expected: [...expected].map(diagnosticValue).sort(),
      actual: [...actual].map(diagnosticValue).sort(),
    };
  }
  if (expected !== null && actual !== null && typeof expected === 'object' && typeof actual === 'object') {
    const expectedObject = expected as Record<string, unknown>;
    const actualObject = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(expectedObject), ...Object.keys(actualObject)])].sort();
    for (const key of keys) {
      const expectedHas = Object.hasOwn(expectedObject, key);
      const actualHas = Object.hasOwn(actualObject, key);
      const keyPath = objectPath(path, key);
      if (!expectedHas || !actualHas) {
        return {
          path: keyPath,
          expected: expectedHas ? diagnosticValue(expectedObject[key]) : missingProjectionValue,
          actual: actualHas ? diagnosticValue(actualObject[key]) : missingProjectionValue,
        };
      }
      const difference = firstProjectionDifference(expectedObject[key], actualObject[key], keyPath);
      if (difference) return difference;
    }
  }
  return { path, expected: diagnosticValue(expected), actual: diagnosticValue(actual) };
}

export class ProjectionMismatchError extends Error {
  readonly code = 'compacted_replay_projection_mismatch';

  constructor(readonly detail: ProjectionDifference) {
    super(`compacted_replay_projection_mismatch ${JSON.stringify(detail)}`);
    this.name = 'ProjectionMismatchError';
  }
}

const ARCHIVE_ATTESTATION = /^snapshot=(.+);restore-proof=journal\.head=([1-9][0-9]*)$/;

export function parseArchiveAttestation(value: string): {
  snapshot_path: string;
  restore_journal_head: number;
} {
  const match = ARCHIVE_ATTESTATION.exec(value);
  if (!match) throw new Error('archive_attestation_required');
  const restoreJournalHead = Number(match[2]);
  if (!Number.isSafeInteger(restoreJournalHead)) throw new Error('archive_attestation_required');
  return { snapshot_path: match[1]!, restore_journal_head: restoreJournalHead };
}

function checkpointPayload(projection: Projections, request: ResolvedEventLogCompaction) {
  return {
    boundary_seq: request.boundary_seq,
    reset_journal_head: request.reset_journal_head,
    current_bindings: projection.currentBindings,
    seat_board: projection.seatBoard,
    open_contradictions: projection.openContradictions,
    turn_by_agent: [...projection.turnByAgent],
    ever_bound_agents: [...projection.everBoundAgents],
    physical_declarations: [...projection.physicalDeclarations.values()],
    placement_attested_agents: [...projection.placementAttestedAgents],
    abandoned_seats: [...projection.abandonedSeats],
    launch_compositions: [...projection.launchCompositions.values()],
    transport_claims: [...projection.transportClaims.values()],
  };
}

function digest(events: readonly EventRecord[]): string {
  const hash = createHash('sha256');
  for (const event of events) hash.update(JSON.stringify(event)).update('\n');
  return `sha256:${hash.digest('hex')}`;
}

function field(event: EventRecord, name: string): string | null {
  const value = event.payload[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function openEventSeqs(events: readonly EventRecord[], boundarySeq: number): Set<number> {
  const openEntityIds = new Set<string>();
  const openDispatchIds = new Set<string>();
  const openPrepareIds = new Set<string>();
  const openMessageIds = new Set<string>();
  const openAskIds = new Set<string>();

  for (const kind of ['rotation', 'scoped_reset'] as const) {
    const requestType = `estate.${kind}_requested`;
    const closedTypes = new Set([`estate.${kind}_completed`, `estate.${kind}_failed`]);
    for (const request of events.filter((event) => event.seq <= boundarySeq && event.event_type === requestType)) {
      if (!events.some((event) => event.entity_id === request.entity_id && closedTypes.has(event.event_type))) {
        openEntityIds.add(request.entity_id);
      }
    }
  }

  for (const request of events.filter((event) => event.seq <= boundarySeq
    && event.event_type === 'reg.dispatch_requested' && event.payload.request !== undefined)) {
    const dispatchId = field(request, 'dispatch_id');
    if (dispatchId && !events.some((event) => event.event_type === 'reg.dispatch_requested'
      && field(event, 'dispatch_id') === dispatchId && event.payload.outcome !== undefined)) {
      openDispatchIds.add(dispatchId);
    }
  }
  for (const prepared of events.filter((event) => event.seq <= boundarySeq && event.event_type === 'reg.binding_prepared')) {
    const prepareId = field(prepared, 'prepare_id');
    if (prepareId && !events.some((event) => event.event_type === 'reg.bound'
      && field(event, 'binding_prepare_id') === prepareId)) openPrepareIds.add(prepareId);
  }

  for (const accepted of events.filter((event) => event.seq <= boundarySeq && event.event_type === 'reg.comm_accepted')) {
    const messageId = accepted.entity_id;
    const askId = field(accepted, 'ask_id');
    const snapshot = events.find((event) => event.event_type === 'reg.comm_target_snapshotted'
      && field(event, 'message_id') === messageId);
    const targets = (snapshot?.payload.targets ?? accepted.payload.targets ?? []) as Array<{ agent_id?: unknown }>;
    const targetIds = targets.flatMap((target) => typeof target.agent_id === 'string' ? [target.agent_id] : []);
    const deliveryResolved = targetIds.length > 0 && targetIds.every((targetId) => events.some((event) =>
      (event.event_type === 'act.comm_delivery_asserted' || event.event_type === 'act.comm_delivery_failed')
      && field(event, 'message_id') === messageId && field(event, 'target_agent_id') === targetId));
    const callbacksResolved = !askId || targetIds.every((targetId) => events.some((event) =>
      event.event_type === 'act.comm_callback_asserted'
      && field(event, 'ask_id') === askId && field(event, 'target_agent_id') === targetId));
    if (!deliveryResolved || !callbacksResolved) {
      openMessageIds.add(messageId);
      if (askId) openAskIds.add(askId);
    }
  }

  return new Set(events.filter((event) => {
    if (event.seq > boundarySeq) return false;
    const dispatchId = field(event, 'dispatch_id');
    const prepareId = field(event, 'prepare_id') ?? field(event, 'binding_prepare_id');
    const messageId = field(event, 'message_id');
    const askId = field(event, 'ask_id');
    const messageIds = Array.isArray(event.payload.message_ids) ? event.payload.message_ids : [];
    return openEntityIds.has(event.entity_id)
      || (dispatchId !== null && openDispatchIds.has(dispatchId))
      || (prepareId !== null && openPrepareIds.has(prepareId))
      || openMessageIds.has(event.entity_id)
      || openAskIds.has(event.entity_id)
      || (messageId !== null && openMessageIds.has(messageId))
      || (askId !== null && openAskIds.has(askId))
      || messageIds.some((id) => typeof id === 'string' && openMessageIds.has(id));
  }).map((event) => event.seq));
}

export function archivedEventDigest(events: readonly EventRecord[]): string {
  return digest(events);
}

export function compactEventRecords(
  events: readonly EventRecord[],
  request: ResolvedEventLogCompaction,
): EventRecord[] {
  const attestation = parseArchiveAttestation(request.archive_attestation);
  if (!Number.isSafeInteger(request.reset_journal_head) || request.reset_journal_head < 1) {
    throw new Error('invalid_reset_journal_head');
  }
  if (attestation.restore_journal_head < request.reset_journal_head) {
    throw new Error('archive_restore_before_reset_head');
  }
  if (!Number.isSafeInteger(request.boundary_seq) || request.boundary_seq < 1) {
    throw new Error('invalid_estate_generation_boundary');
  }
  const boundary = events.find((event) => event.seq === request.boundary_seq);
  if (!boundary || boundary.event_type !== 'estate.rotation_completed') {
    throw new Error('estate_generation_not_closed');
  }
  if (!events.some((event) => event.seq < boundary.seq
    && event.entity_id === boundary.entity_id
    && event.event_type === 'estate.rotation_requested')) {
    throw new Error('estate_generation_not_closed');
  }

  const projection = buildProjections([...events]);
  // A checkpoint is the fold at its own sequence. Serializing the final fold
  // here would seed future state and then apply every post-boundary event to it
  // a second time (duplicating contradictions and perturbing collection order).
  const boundaryProjection = buildProjections(events.filter((event) => event.seq <= boundary.seq));
  const checkpoint = EventRecordSchema.parse({
    seq: boundary.seq,
    entity_type: 'estate',
    entity_id: boundary.entity_id,
    event_type: 'estate.compaction_checkpoint',
    payload: checkpointPayload(boundaryProjection, request),
    provenance: { source: 'observer', transport_receipt: null, emitter_version: boundary.provenance.emitter_version ?? null },
    occurred_at: boundary.occurred_at,
    recorded_at: boundary.recorded_at,
  });
  const open = openEventSeqs(events, boundary.seq);
  const compacted = [
    ...events.filter((event) => event.seq < boundary.seq && open.has(event.seq)),
    checkpoint,
    ...events.filter((event) => event.seq > boundary.seq),
  ];
  const compactedProjection = buildProjections(compacted);
  if (!Bun.deepEquals(compactedProjection, projection)) {
    throw new ProjectionMismatchError(firstProjectionDifference(projection, compactedProjection)!);
  }
  return compacted;
}

export function compactionResult(
  before: readonly EventRecord[],
  after: readonly EventRecord[],
  request: ResolvedEventLogCompaction,
): EventLogCompactionResult {
  const open = openEventSeqs(before, request.boundary_seq);
  const archived = before.filter((event) => event.seq <= request.boundary_seq && !open.has(event.seq));
  return {
    ok: true,
    boundary_seq: request.boundary_seq,
    archived_events: archived.length,
    retained_events: after.length,
    archived_digest: archivedEventDigest(archived),
    reset_journal_head: request.reset_journal_head,
  };
}
