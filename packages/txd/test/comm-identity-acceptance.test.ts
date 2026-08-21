// Behavioral-pin lane: the comm funnel mouth's acceptance softness.
//
// The daemon accepts a caller-supplied comm identity in any casing, and lets a
// bare council persona name stand for its council seat. Everything the daemon
// then records is canonical — lowercase and page-qualified — so the softness
// exists only at the mouth and never reaches the event stream.
import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { acceptCommIdentity } from '../src/comm-identity.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const COUNCIL = [
  ['council:custodes', 'custodes'],
  ['council:fabricator-general', 'fabricator-general'],
  ['council:pax', 'pax'],
  ['council:orchestrator', 'orchestrator'],
] as const;

async function rig() {
  const now = Date.parse('2026-08-21T09:00:00.000Z');
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const daemon = new Daemon(store, tmux, () => new Date(now).toISOString(), undefined, null, null, async () => {});
  const seats: [string, string, string][] = [
    ['palace:W', 'sender', 'space-wolves'],
    ...COUNCIL.map(([seat, persona]) => [seat, `agent-${persona}`, persona] as [string, string, string]),
  ];
  for (const [seat, identity, persona] of seats) {
    await daemon.launch({ seat_id: seat, schema_version: SCHEMA_VERSION, identity, persona, tint: '#1' });
    await store.append({
      entity_type: 'agent', entity_id: identity, event_type: 'reg.agent_registered',
      payload: { persona, rank: 'astartes', commander: null },
      provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
      occurred_at: new Date(now).toISOString(),
    });
  }
  return { daemon, store };
}

const send = (daemon: Daemon, target: string) => daemon.comm({
  schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target, message: 'orders', ask: false, reply: false,
});

// The live specimen, 2026-08-21: `tx comm Custodes` refused identity_absent at
// the daemon while `tx comm council:custodes` delivered.
test('a mis-cased council seat id addresses the same seat as its canonical form', async () => {
  const { daemon } = await rig();
  const accepted = await send(daemon, 'COUNCIL:PAX');
  expect(accepted.targets).toEqual([{ agent_id: 'agent-pax', seat_id: 'council:pax', persona: 'pax' }]);
});

test('a mis-cased bare council name addresses its council seat', async () => {
  const { daemon } = await rig();
  const accepted = await send(daemon, 'Custodes');
  expect(accepted.targets).toEqual([{ agent_id: 'agent-custodes', seat_id: 'council:custodes', persona: 'custodes' }]);
});

test('every bare council persona name resolves to its page-qualified seat', async () => {
  const { daemon } = await rig();
  for (const [seatId, persona] of COUNCIL) {
    const accepted = await send(daemon, persona);
    expect(accepted.targets).toEqual([{ agent_id: `agent-${persona}`, seat_id: seatId, persona }]);
  }
});

test('acceptance softness never reaches the event stream: recorded targets stay canonical', async () => {
  const { daemon, store } = await rig();
  await send(daemon, 'Fabricator-General');
  const accepted = (await store.readAll()).filter((event) => event.event_type === 'reg.comm_accepted');
  expect(accepted).toHaveLength(1);
  expect(accepted[0]!.payload.targets).toEqual([
    { agent_id: 'agent-fabricator-general', seat_id: 'council:fabricator-general', persona: 'fabricator-general' },
  ]);
  expect(JSON.stringify(accepted[0]!.payload)).not.toContain('Fabricator-General');
});

test('a bare name naming nobody keeps the loud typed absence refusal', async () => {
  const { daemon } = await rig();
  await expect(send(daemon, 'Ghost-Target')).rejects.toThrow('identity_absent: Ghost-Target');
});

// A page name is not an identity. Nothing about it names one seat, so it must
// stay absent rather than be guessed into one.
test('a bare exclusive or fleet page name is not softened into a seat', async () => {
  const { daemon } = await rig();
  for (const page of ['mechanicus', 'inquisitor', 'palace_fleet', 'somnium_fleet']) {
    await expect(send(daemon, page)).rejects.toThrow(`identity_absent: ${page}`);
  }
});

// The roster is the estate's council declaration, so a future council seat
// inherits bare-name addressing without touching the funnel mouth.
test('the funnel mouth resolves bare names against the council roster it is given', () => {
  expect(acceptCommIdentity('Lord-Inquisitor', ['council:lord-inquisitor'])).toBe('council:lord-inquisitor');
  expect(acceptCommIdentity('custodes', ['council:lord-inquisitor'])).toBe('custodes');
  expect(acceptCommIdentity('somnium:NE', ['council:lord-inquisitor'])).toBe('somnium:NE');
});

test('a bare name matching more than one council seat refuses loudly, naming the candidates', () => {
  const roster = ['council:pax', 'palace:pax'];
  expect(() => acceptCommIdentity('Pax', roster)).toThrow('identity_ambiguous: Pax');
  expect(() => acceptCommIdentity('Pax', roster)).toThrow('council:pax, palace:pax');
});

// Nine declared seat ids carry uppercase — palace:W/N/S/E and
// somnium:W/N/S/NE/SE. Softening acceptance must widen what reaches a seat, so
// a seat's OWN canonical id is the one spelling that can never stop working.
test('an uppercase canonical seat id still addresses its seat', async () => {
  const { daemon } = await rig();
  const accepted = await send(daemon, 'palace:W');
  expect(accepted.targets).toEqual([{ agent_id: 'sender', seat_id: 'palace:W', persona: 'space-wolves' }]);
});

test('an uppercase canonical seat id is addressable in any casing', async () => {
  const { daemon } = await rig();
  for (const spelling of ['palace:w', 'PALACE:W', 'Palace:W']) {
    const accepted = await send(daemon, spelling);
    expect(accepted.targets).toEqual([{ agent_id: 'sender', seat_id: 'palace:W', persona: 'space-wolves' }]);
  }
});

test('a persona is addressable in any casing, and answers with its canonical spelling', async () => {
  const { daemon } = await rig();
  const accepted = await send(daemon, 'Space-Wolves');
  expect(accepted.targets).toEqual([{ agent_id: 'sender', seat_id: 'palace:W', persona: 'space-wolves' }]);
});
