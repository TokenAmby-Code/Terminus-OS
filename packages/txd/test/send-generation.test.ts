import { expect, test } from 'bun:test';
import type { EventInput, EventRecord, SendReceipt } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { registration } from './registration-fixture.ts';

const SEAT = 'palace:W';
const OTHER_SEAT = 'palace:E';

class RecordingTmux extends FakeTmux {
  deliveries: Array<{ seat: string; text: string }> = [];

  override async sendToSeat(seat: string, text: string) {
    this.deliveries.push({ seat, text });
    return super.sendToSeat(seat, text);
  }
}

class MutatingAfterEnqueueStore extends MemoryEventStore {
  mutation: EventInput[] = [];
  private injected = false;

  override async append(input: EventInput): Promise<EventRecord> {
    const record = await super.append(input);
    if (!this.injected && input.event_type === 'act.send_enqueued') {
      this.injected = true;
      await super.appendAll(this.mutation);
    }
    return record;
  }
}

const provenance = { source: 'observer' as const, transport_receipt: null, emitter_version: 5 };
const occurred_at = '2026-07-20T00:00:00.000Z';

function event(input: Pick<EventInput, 'entity_type' | 'entity_id' | 'event_type' | 'payload'>): EventInput {
  return { ...input, provenance, occurred_at };
}

for (const scenario of ['disappeared', 'changed generation', 'retired', 'moved'] as const) {
  test(`frozen bound send is cancelled when its binding ${scenario}`, async () => {
    const store = new MutatingAfterEnqueueStore();
    const tmux = new RecordingTmux();
    const daemon = new Daemon(store, tmux);
    await daemon.constructEstate();
    await daemon.launch(registration(SEAT, 'occupant-A'));

    if (scenario === 'disappeared') {
      store.mutation = [event({ entity_type: 'seat', entity_id: SEAT, event_type: 'reg.teardown_started', payload: {} })];
    } else if (scenario === 'changed generation') {
      store.mutation = [
        event({ entity_type: 'seat', entity_id: SEAT, event_type: 'reg.seat_cleared', payload: {} }),
        event({ entity_type: 'seat', entity_id: SEAT, event_type: 'reg.bound', payload: { instance_id: 'occupant-B', persona: 'astartes', tint: '#302800' } }),
      ];
    } else if (scenario === 'retired') {
      store.mutation = [event({ entity_type: 'instance', entity_id: 'occupant-A', event_type: 'reg.retired', payload: { seat_id: SEAT } })];
    } else {
      store.mutation = [
        event({ entity_type: 'seat', entity_id: SEAT, event_type: 'reg.seat_cleared', payload: {} }),
        event({ entity_type: 'seat', entity_id: OTHER_SEAT, event_type: 'reg.bound', payload: { instance_id: 'occupant-A', persona: 'astartes', tint: '#302800' } }),
      ];
    }

    const receipt = (await daemon.send({ target: 'occupant-A', text: 'frozen for A', schema_version: 5 })) as SendReceipt;

    expect(receipt).toMatchObject({ verdict: 'cancelled', cancellation_reason: 'binding_changed', bytes_delivered: 0 });
    expect(tmux.deliveries).toEqual([]);
    const sendEvents = (await store.readAll()).filter((candidate) => candidate.entity_type === 'send');
    expect(sendEvents.map((candidate) => candidate.event_type)).toEqual(['act.send_enqueued', 'act.send_cancelled']);
    expect(sendEvents.at(-1)?.payload).toMatchObject({ reason: 'binding_changed' });
  });
}
