import { expect, test } from 'bun:test';
import { SEND_PRESENCE_ACTIVITY_WINDOW_MS, type SendReceipt } from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';

// Spec §5 typing-guard: operator presence = a point-in-time READ of
// server-maintained client_activity, taken at BOTH decision points (admission +
// drain, rung 4). No keystroke hook, no shadow model.

function base() {
  const store = new MemoryEventStore();
  return store;
}

const SEAT = 'somnium:NE';

async function bareSeat(d: Daemon) {
  await d.constructEstate();
}

async function boundSeat(d: Daemon) {
  await d.launch({
    seat_id: SEAT,
    schema_version: 4,
    identity: 'agent-instance',
    persona: 'astartes',
    tint: '#302800',
  });
}

// A tmux fake whose presence answer is scripted PER CALL, so a test can prove
// the daemon reads presence at admission AND again at drain (and which read
// drove the gate). Extends FakeTmux to keep createSeat/sendToSeat behaviour.
class SequencedTmux extends FakeTmux {
  calls = 0;
  constructor(private seq: boolean[]) {
    super();
  }
  override async presentSeats(_windowMs: number, _nowMs?: number): Promise<Set<string>> {
    const present = this.seq[Math.min(this.calls, this.seq.length - 1)] ?? false;
    this.calls++;
    return new Set(present ? [SEAT] : []);
  }
}

test('present WITHIN window → gated; window echoed in the decision', async () => {
  const store = base();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux);
  await bareSeat(d);
  tmux.setPresence(SEAT, Date.now());
  const res = (await d.send({ target: SEAT, text: 'hi', schema_version: 4 })) as SendReceipt;
  expect(res.verdict).toBe('enqueued_gated');
  expect(res.activity_window_ms).toBe(SEND_PRESENCE_ACTIVITY_WINDOW_MS);
});

test('last activity OUTSIDE window → delivers (scrolling long ago does not gate)', async () => {
  const store = base();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux);
  await bareSeat(d);
  tmux.setPresence(SEAT, Date.now() - SEND_PRESENCE_ACTIVITY_WINDOW_MS - 5_000);
  const res = (await d.send({ target: SEAT, text: 'hi', schema_version: 4 })) as SendReceipt;
  expect(res.verdict).toBe('delivered');
});

test('present at ADMISSION → gated (defer this pass), even if idle by drain', async () => {
  const store = base();
  const tmux = new SequencedTmux([true, false]); // admission present, drain idle
  const d = new Daemon(store, tmux);
  await bareSeat(d);
  const res = (await d.send({ target: SEAT, text: 'hi', schema_version: 4 })) as SendReceipt;
  expect(res.verdict).toBe('enqueued_gated'); // the admission read gated it
  expect(tmux.calls).toBe(1); // gated at admission → send returns without the drain read
});

test('idle at admission but present at DRAIN → gated (drain read is consulted)', async () => {
  const store = base();
  const tmux = new SequencedTmux([false, true]); // admission idle, became active by drain
  const d = new Daemon(store, tmux);
  await bareSeat(d);
  const res = (await d.send({ target: SEAT, text: 'hi', schema_version: 4 })) as SendReceipt;
  expect(res.verdict).toBe('enqueued_gated'); // the drain read gated it
  expect(tmux.calls).toBe(2); // presence was read at admission AND drain
});

test('idle at BOTH admission and drain → delivered (both decision points read)', async () => {
  const store = base();
  const tmux = new SequencedTmux([false, false]);
  const d = new Daemon(store, tmux);
  await bareSeat(d);
  const res = (await d.send({ target: SEAT, text: 'hi', schema_version: 4 })) as SendReceipt;
  expect(res.verdict).toBe('delivered');
  expect(tmux.calls).toBe(2); // read at admission AND drain before delivering
});

test('continuously active bound agent pane delivers immediately', async () => {
  const store = base();
  const tmux = new SequencedTmux([true, true]);
  const d = new Daemon(store, tmux);
  await boundSeat(d);

  const res = (await d.send({ target: SEAT, text: 'report', schema_version: 4 })) as SendReceipt;

  expect(res.verdict).toBe('delivered');
  expect(tmux.calls).toBe(0);
});

test('recent operator input on an unbound pane holds, then releases on guard expiry', async () => {
  const store = base();
  const tmux = new FakeTmux();
  let nowMs = 1_000_000;
  let release: (() => void | Promise<void>) | undefined;
  const d = new Daemon(
    store,
    tmux,
    () => new Date(nowMs).toISOString(),
    (callback, delayMs) => {
      expect(delayMs).toBe(SEND_PRESENCE_ACTIVITY_WINDOW_MS);
      release = callback;
    },
    () => nowMs,
  );
  await bareSeat(d);
  tmux.setPresence(SEAT, nowMs);

  const res = (await d.send({ target: SEAT, text: 'held', schema_version: 4 })) as SendReceipt;
  expect(res.verdict).toBe('enqueued_gated');
  expect(release).toBeDefined();

  nowMs += SEND_PRESENCE_ACTIVITY_WINDOW_MS + 1;
  await release!();

  const sendEvents = (await store.readAll()).filter((event) => event.entity_type === 'send');
  expect(sendEvents.map((event) => event.event_type)).toEqual([
    'act.send_enqueued',
    'act.send_gated',
    'act.send_submit_observed',
    'act.send_submit_observed',
    'act.send_submit_observed',
    'act.send_delivered',
  ]);
  expect(sendEvents.filter((event) => event.event_type === 'act.send_submit_observed').map((event) => event.payload.kind)).toEqual([
    'literal_insert',
    'submit_enter',
    'submit_verify',
  ]);
  expect(sendEvents.at(-1)?.payload).toMatchObject({ release_reason: 'typing_guard_expired' });
});

test('held message for occupant A is cancelled before replacement occupant B can receive it', async () => {
  class RecordingTmux extends FakeTmux {
    deliveries: Array<{ seat: string; text: string }> = [];

    override async sendToSeat(seat: string, text: string) {
      this.deliveries.push({ seat, text });
      return super.sendToSeat(seat, text);
    }
  }

  const store = base();
  const tmux = new RecordingTmux();
  let nowMs = 1_000_000;
  let release: (() => void | Promise<void>) | undefined;
  const d = new Daemon(
    store,
    tmux,
    () => new Date(nowMs).toISOString(),
    (callback) => { release = callback; },
    () => nowMs,
  );
  await bareSeat(d);
  tmux.setPresence(SEAT, nowMs);

  const held = (await d.send({ target: SEAT, text: 'only for A', schema_version: 4 })) as SendReceipt;
  expect(held.verdict).toBe('enqueued_gated');

  // The frozen generation was the bare/operator occupant. A new ledger binding
  // is a replacement generation and must never inherit the held text.
  await d.launch({ seat_id: SEAT, schema_version: 4, identity: 'occupant-B', persona: 'astartes', tint: '#302800' });
  nowMs += SEND_PRESENCE_ACTIVITY_WINDOW_MS + 1;
  await release!();

  expect(tmux.deliveries).toEqual([]);
  const terminal = (await store.readAll()).filter((event) => event.entity_type === 'send').at(-1);
  expect(terminal?.event_type).toBe('act.send_cancelled');
  expect(terminal?.payload).toMatchObject({ reason: 'binding_changed', resolved_seq: 0 });
});
