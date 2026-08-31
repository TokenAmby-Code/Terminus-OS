// Adversarial lane: removed composer-state outcomes can never manufacture delivery truth.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Daemon } from '../src/core.ts';
import { commTokenForMessageId } from '../src/comm-frame.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

async function filesBelow(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    if (entry.name === 'node_modules' || entry.name === '.git') return [];
    const target = join(path, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  }))).flat();
}

test('adversarial: removed composer transport state has no runtime, contract, route, or documentation residue', async () => {
  const root = join(import.meta.dir, '../../..');
  const self = import.meta.path;
  const forbidden = [
    'composer_draft_present',
    'composer_rollback_failed',
    'comm_redrive',
    'comm_draft_discarded',
    'redriveSeatComm',
    'discardSeatComposer',
    'submit_unverified',
    'CommQueuedReceipt',
  ];
  const offenders: string[] = [];
  for (const path of await filesBelow(root)) {
    if (path === self || !/\.(?:ts|md|json|sql|yaml|yml)$/.test(path)) continue;
    const text = await Bun.file(path).text();
    if (forbidden.some((name) => text.includes(name))) offenders.push(path.slice(root.length + 1));
  }
  expect(offenders).toEqual([]);
});

async function rig() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const daemon = new Daemon(store, tmux, undefined, undefined, null, null, async () => {});
  for (const [seat, identity] of [['council:custodes', 'sender'], ['palace:W', 'target']] as const) {
    await daemon.launch({ seat_id: seat, schema_version: SCHEMA_VERSION, identity, persona: 'p', tint: '#1' });
    await store.append({
      entity_type: 'agent', entity_id: identity, event_type: 'reg.agent_registered',
      payload: { persona: 'p', rank: 'astartes', commander: null },
      provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
      occurred_at: '2026-08-18T00:00:00.000Z',
    });
  }
  return { store, tmux, daemon };
}

for (const specimen of [
  {
    messageId: 'ef475e21-4dba-45fb-a743-d42e0ad569c7',
    verdict: 'frame_absent',
    bytes: 0,
  },
  {
    messageId: '22e4ddc8-6f37-48a1-a231-990ea28d0c04',
    verdict: 'composer_rollback_failed',
    bytes: 675,
  },
] as const) {
  test(`adversarial: non-staged specimen ${specimen.messageId} remains permanently undelivered`, async () => {
    const { store, tmux, daemon } = await rig();
    tmux.sendVerifiedToSeat = async () => ({ bytes: specimen.bytes, verdict: specimen.verdict } as never);

    const accepted = await daemon.comm({
      schema_version: SCHEMA_VERSION,
      source_agent_id: 'sender',
      target: 'target',
      message: specimen.messageId,
      ask: false,
      reply: false,
    });
    expect(accepted.staged).toBe(false);

    const hook = await daemon.promptSubmitted({
      schema_version: SCHEMA_VERSION,
      agent_id: 'target',
      comm_tokens: [commTokenForMessageId(accepted.message_id)],
    });

    expect(hook.observed).toEqual([]);
    expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(false);
    expect((await store.readAll()).filter((event) => event.event_type === 'act.comm_delivery_asserted')).toEqual([]);
  });
}
