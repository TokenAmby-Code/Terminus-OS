import { createHash, randomUUID } from 'node:crypto';
import type { SQL } from 'bun';
import { PostgresJournalPublisher } from './journal/publisher.ts';

export type TxdPublishedEventType =
  | 'agent.dispatch_attested'
  | 'agent.dispatch_refused'
  | 'agent.pane_attested'
  | 'agent.pane_refused'
  | 'agent.placement_attested'
  | 'agent.placement_refused'
  | 'agent.perpetual_seat_vacant'
  | 'agent.estate_occupancy_census'
  | 'agent.retired'
  | 'agent.unregistered_closed'
  | 'agent.composer_interactive';

function eventIdentity(eventType: TxdPublishedEventType, payload: Record<string, unknown>): string {
  const occurrence = payload.dispatch_id
    ?? payload.hook_request_id
    ?? payload.birth_generation
    ?? payload.message_id
    ?? payload.observed_at
    ?? payload.retired_at
    ?? payload.closed_at
    // The census is the estate speaking at one instant; the instant is the
    // occurrence, so re-asserting the same fold is the same event.
    ?? payload.taken_at
    // A vacancy is an observation that may recur after a later occupant leaves;
    // it has no producer-owned occurrence id, so each observation is distinct.
    ?? randomUUID();
  const subject = ['agent_id', 'seat_id', 'target_agent_id', 'machine']
    .filter((field) => payload[field] !== undefined && payload[field] !== null)
    .map((field) => `${field}=${String(payload[field])}`)
    .join('|');
  return `${eventType}:${subject}:${String(occurrence)}`;
}

function eventId(key: string): string {
  const bytes = createHash('sha256').update('txd-journal-v1\0').update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function occurredAt(payload: Record<string, unknown>): string {
  for (const field of ['observed_at', 'retired_at', 'closed_at', 'taken_at']) {
    if (typeof payload[field] === 'string') return payload[field];
  }
  return new Date().toISOString();
}

export function makeJournalPublisher(
  sql: Pick<SQL, 'begin'>,
  machine: string,
): (eventType: TxdPublishedEventType, payload: Record<string, unknown>) => Promise<void> {
  const publisher = new PostgresJournalPublisher(sql, 'txd');
  return async (eventType, payload) => {
    const key = eventIdentity(eventType, payload);
    await publisher.publish({
      eventId: eventId(key),
      eventType,
      schemaVersion: 1,
      idempotencyKey: key,
      occurredAt: occurredAt(payload),
      payload,
      provenance: { ingress: 'txd', machine },
    });
  };
}
