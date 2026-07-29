// Adversarial: the act.send_* lifecycle stays dead — no vocabulary member,
// no entity kind, no contract export, and no store or replay tolerance may
// resurrect it. Route-level death (POST /agents/send → 404) is pinned in
// routes.test.ts alongside the other dead routes.

import { describe, expect, test } from 'bun:test';
import * as contracts from '@terminus-os/contracts';
import {
  ACT_EVENT_NAMES,
  ENTITY_TYPES,
  EVENT_TYPES,
  EntityTypeSchema,
  EventRecordSchema,
  EventTypeSchema,
} from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';

const DEAD_EVENT_TYPES = [
  'act.send_enqueued',
  'act.send_gated',
  'act.send_submit_observed',
  'act.send_delivered',
  'act.send_cancelled',
] as const;

describe('adversarial: act.send_* stays dead', () => {
  test('no send lifecycle member survives in the event vocabulary', () => {
    for (const dead of DEAD_EVENT_TYPES) {
      expect(EVENT_TYPES as readonly string[]).not.toContain(dead);
      expect(() => EventTypeSchema.parse(dead)).toThrow();
    }
    for (const name of ACT_EVENT_NAMES) expect(name).not.toMatch(/^send_/);
  });

  test('the send entity kind is gone', () => {
    expect(ENTITY_TYPES as readonly string[]).not.toContain('send');
    expect(() => EntityTypeSchema.parse('send')).toThrow();
  });

  test('no contract export resurrects the send door', () => {
    const resurrected = Object.keys(contracts).filter((name) => /send/i.test(name));
    expect(resurrected).toEqual([]);
  });

  test('the store refuses act.send_* ingress loudly', async () => {
    const store = new MemoryEventStore();
    for (const dead of DEAD_EVENT_TYPES) {
      await expect(store.append({
        entity_type: 'message',
        entity_id: 'm1',
        event_type: dead,
        payload: { target: 'palace:W' },
        provenance: { source: 'wrapper', transport_receipt: null, emitter_version: 1 },
        occurred_at: '2026-07-28T00:00:00.000Z',
      } as never)).rejects.toThrow();
    }
    expect(await store.count()).toBe(0);
    await store.close();
  });

  test('the replay boundary refuses a resurrected persisted act.send_* row', () => {
    expect(() => EventRecordSchema.parse({
      seq: 1,
      entity_type: 'message',
      entity_id: 'm1',
      event_type: 'act.send_enqueued',
      payload: { target: 'palace:W' },
      provenance: { source: 'wrapper', transport_receipt: null, emitter_version: 7 },
      occurred_at: '2026-07-28T00:00:00.000Z',
      recorded_at: '2026-07-28T00:00:00.000Z',
    })).toThrow();
  });
});
