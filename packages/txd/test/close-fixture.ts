import { SCHEMA_VERSION, type RetirementConsultation } from '@terminus-os/contracts';
import type { EventStore } from '../src/store.ts';
import type { Daemon } from '../src/core.ts';

export const OVERSEER_SOURCE = 'test-overseer-source';
export const retirementClear = async (): Promise<RetirementConsultation> => ({
  ok: true as const,
  ticket_id: '48f891b0-2140-4a70-ad1e-50cabca36e61',
  open_node_count: 0 as const,
  reason: null,
});

/**
 * The registered overseer binding an authorized close request speaks as —
 * shared by every suite that exercises /agents/close as a utility. Closing is
 * an overseer capability, so a fixture caller must hold the recorded rank.
 */
export async function bindOverseerSource(d: Daemon, store: EventStore): Promise<void> {
  const launched = await d.launch({
    seat_id: 'council:custodes',
    schema_version: SCHEMA_VERSION,
    identity: OVERSEER_SOURCE,
    persona: 'custodes',
    rank: 'overseer',
    tint: '#5f00d7',
  });
  if (!launched.ok) throw new Error(`overseer fixture launch failed: ${launched.reason}`);
  await store.append({
    entity_type: 'agent',
    entity_id: OVERSEER_SOURCE,
    event_type: 'reg.agent_registered',
    payload: { persona: 'custodes', rank: 'overseer', commander: null },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-08-01T00:00:00.000Z',
  });
}

export function closeRequest(targets: string[], options: { force?: boolean } = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    source_agent_id: OVERSEER_SOURCE,
    targets,
    ...(options.force ? { force: true } : {}),
  };
}
