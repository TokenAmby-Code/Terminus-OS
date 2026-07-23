// Dispatcher — per-subscription cursored HTTP fan-out (transactional outbox).
//
// busd is the journal's single writer, so no LISTEN/NOTIFY machinery exists:
// every append wakes the dispatcher in-process, and a repair tick (30s) covers
// what a wake cannot see — out-of-band psql inserts (a one-writer-doctrine
// violation, but repaired anyway), revived subscribers, restored connectivity.
//
// Per subscription, deliveries are STRICTLY SERIAL and IN SEQ ORDER: one full
// journal row per POST, 2xx advances the durable cursor, anything else retries
// the SAME event with full-jitter exponential backoff — head-of-line by design,
// never a skip. Lanes are independent: one dead subscriber never stalls
// another. Retry state is in-memory only; a busd restart resumes from the
// durable cursor (at-least-once delivery is the contract — subscribers dedupe).
//
// A subscription whose cursor was never seeded is SKIPPED LOUD: seeding is a
// deliberate runbook step (0 = full replay, max(seq) = from-now), never a
// silent default.

import { BUS_SCHEMA_VERSION, type BusDelivery, type BusEventRecord, type BusSubscriptionRow } from '@terminus-os/contracts';
import type { BusStore } from './store.ts';

export type DispatcherOpts = {
  repairIntervalMs: number;
  deliveryTimeoutMs: number;
  batchSize: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  /** Test seams — real defaults: global fetch, Bun.sleep, Math.random. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

/** Full-jitter exponential backoff: uniform in [0, min(cap, base·2^(failures−1))]. */
export function backoffDelayMs(failures: number, baseMs: number, capMs: number, random: () => number): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, failures - 1));
  return Math.floor(random() * ceiling);
}

type Lane = { running: boolean; wakeRequested: boolean };

export class Dispatcher {
  private lanes = new Map<string, Lane>();
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private random: () => number;

  constructor(
    private store: BusStore,
    private opts: DispatcherOpts,
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
    this.random = opts.random ?? Math.random;
  }

  /** Begin the repair tick and run an immediate catch-up pass. */
  start(): void {
    this.timer = setInterval(() => this.wake(), this.opts.repairIntervalMs);
    this.wake();
  }

  /** In-process wake — called after every journal append (and by the repair tick). */
  wake(): void {
    void this.pass();
  }

  /**
   * Stop scheduling new work. A lane mid-backoff finishes its current sleep
   * before observing the flag; daemon shutdown does not wait for that (the
   * cursor is durable, so an interrupted retry simply re-runs after restart).
   */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async pass(): Promise<void> {
    if (this.stopped) return;
    let subs: BusSubscriptionRow[];
    try {
      subs = await this.store.activeSubscriptions();
    } catch (err) {
      // DB down: 5xx posture, no fallback — the repair tick retries.
      console.error(JSON.stringify({ level: 'error', event: 'subscriptions_unreadable', error: String(err) }));
      return;
    }
    for (const sub of subs) this.runLane(sub);
  }

  private runLane(sub: BusSubscriptionRow): void {
    const lane = this.lanes.get(sub.name) ?? { running: false, wakeRequested: false };
    this.lanes.set(sub.name, lane);
    if (lane.running) {
      lane.wakeRequested = true;
      return;
    }
    lane.running = true;
    void this.drain(sub)
      .catch((err) => {
        // Store failure mid-drain (fail-loud, no fallback): the repair tick re-runs the lane.
        console.error(JSON.stringify({ level: 'error', event: 'lane_error', subscription: sub.name, error: String(err) }));
      })
      .finally(() => {
        lane.running = false;
        if (lane.wakeRequested && !this.stopped) {
          lane.wakeRequested = false;
          this.runLane(sub);
        }
      });
  }

  private async drain(sub: BusSubscriptionRow): Promise<void> {
    const seeded = await this.store.cursor(sub.name);
    if (seeded === null) {
      console.error(JSON.stringify({ level: 'error', event: 'subscription_unseeded', subscription: sub.name, hint: 'seed bus.cursors deliberately: 0 = full replay, max(seq) = from-now' }));
      return;
    }
    let acked = seeded;
    let failures = 0;
    while (!this.stopped) {
      const batch = await this.store.readSince(acked, sub.event_pattern, this.opts.batchSize);
      if (batch.length === 0) return;
      for (const event of batch) {
        while (!this.stopped) {
          const outcome = await this.deliver(sub, event);
          if (outcome.ok) {
            await this.store.advanceCursor(sub.name, event.seq);
            acked = event.seq;
            failures = 0;
            console.log(JSON.stringify({ level: 'info', event: 'bus_delivered', subscription: sub.name, seq: event.seq, event_type: event.event_type }));
            break;
          }
          failures += 1;
          const delay = backoffDelayMs(failures, this.opts.backoffBaseMs, this.opts.backoffCapMs, this.random);
          console.error(JSON.stringify({ level: 'error', event: 'delivery_failed', subscription: sub.name, seq: event.seq, event_type: event.event_type, detail: outcome.detail, failures, next_delay_ms: delay }));
          await this.sleep(delay);
        }
        if (this.stopped) return;
      }
    }
  }

  private async deliver(
    sub: BusSubscriptionRow,
    event: BusEventRecord,
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    const body: BusDelivery = { schema_version: BUS_SCHEMA_VERSION, subscription: sub.name, event };
    try {
      const resp = await this.fetchImpl(sub.delivery_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.deliveryTimeoutMs),
      });
      if (resp.ok) return { ok: true };
      return { ok: false, detail: `status_${resp.status}` };
    } catch (err) {
      return { ok: false, detail: String(err) };
    }
  }
}
