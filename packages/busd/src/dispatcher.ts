// Durable delivery uses wakeups only. Every append enters through busd and
// wakes in-process; startup and explicit reconciliation recover a lost wake.
// Durable cursors/outbox attempts are authority; a wake may be
// lost or duplicated without changing event identity or correctness.

import {
  BUS_SCHEMA_VERSION,
  REPLAY_SCHEMA_VERSION,
  type BusDelivery,
  type BusEventRecord,
  type BusSubscriptionRow,
} from "@terminus-os/contracts";
import {
  publicationTaskIdentity,
  type PublicationTaskIdentity,
  type ReplayStore,
} from "./replay-store.ts";
import type { BusStore } from "./store.ts";

export type DispatcherOpts = {
  deliveryTimeoutMs: number;
  batchSize: number;
  fetchImpl?: typeof fetch;
};

type Lane = { running: boolean; wakeRequested: boolean };

export class Dispatcher {
  private lanes = new Map<string, Lane>();
  private stopped = false;
  private fetchImpl: typeof fetch;

  constructor(private store: BusStore, private opts: DispatcherOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  start(): void {
    this.wake();
  }

  wake(): void {
    void this.pass();
  }

  stop(): void {
    this.stopped = true;
  }

  private async pass(): Promise<void> {
    if (this.stopped) return;
    let subscriptions: BusSubscriptionRow[];
    try {
      subscriptions = await this.store.activeSubscriptions();
    } catch {
      console.error(JSON.stringify({ level: "error", event: "subscriptions_unreadable", error_code: "store_unavailable" }));
      return;
    }
    for (const subscription of subscriptions) this.runLane(subscription);
  }

  private runLane(subscription: BusSubscriptionRow): void {
    const lane = this.lanes.get(subscription.name) ?? { running: false, wakeRequested: false };
    this.lanes.set(subscription.name, lane);
    if (lane.running) {
      lane.wakeRequested = true;
      return;
    }
    lane.running = true;
    void this.drain(subscription)
      .catch(() => {
        console.error(JSON.stringify({
          level: "error",
          event: "lane_error",
          subscription: subscription.name,
          error_code: "delivery_lane_failed",
        }));
      })
      .finally(() => {
        lane.running = false;
        if (lane.wakeRequested && !this.stopped) {
          lane.wakeRequested = false;
          this.runLane(subscription);
        }
      });
  }

  private async drain(subscription: BusSubscriptionRow): Promise<void> {
    const seeded = await this.store.cursor(subscription.name);
    if (seeded === null) {
      console.error(JSON.stringify({
        level: "error",
        event: "subscription_unseeded",
        subscription: subscription.name,
      }));
      return;
    }
    let acknowledged = seeded;
    while (!this.stopped) {
      const batch = await this.store.readSince(acknowledged, subscription.event_pattern, this.opts.batchSize);
      if (!batch.length) return;
      for (const event of batch) {
        const outcome = await this.deliver(subscription, event);
        if (!outcome.ok) {
          console.error(JSON.stringify({
            level: "error",
            event: "delivery_failed",
            subscription: subscription.name,
            event_id: event.seq,
            detail: outcome.detail,
            state: "externally_blocked",
          }));
          return;
        }
        await this.store.advanceCursor(subscription.name, event.seq);
        acknowledged = event.seq;
        console.log(JSON.stringify({
          level: "info",
          event: "bus_delivered",
          subscription: subscription.name,
          event_id: event.seq,
          event_type: event.event_type,
        }));
      }
    }
  }

  private async deliver(
    subscription: BusSubscriptionRow,
    event: BusEventRecord,
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    const body: BusDelivery = { schema_version: BUS_SCHEMA_VERSION, subscription: subscription.name, event };
    return deliver(this.fetchImpl, subscription.delivery_url, body, this.opts.deliveryTimeoutMs);
  }
}

export class ReplayDispatcher {
  private running = false;
  private wakeRequested = false;
  private stopped = false;
  private fetchImpl: typeof fetch;

  constructor(private store: ReplayStore, private opts: DispatcherOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  start(): void {
    this.wake();
  }

  wake(): void {
    if (this.stopped) return;
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    this.running = true;
    void this.reconcile()
      .catch(() => {
        console.error(JSON.stringify({ level: "error", event: "replay_delivery_error", error_code: "store_unavailable" }));
      })
      .finally(() => {
        this.running = false;
        if (this.wakeRequested && !this.stopped) {
          this.wakeRequested = false;
          this.wake();
        }
      });
  }

  stop(): void {
    this.stopped = true;
  }

  private async reconcile(): Promise<void> {
    const attempted = new Set<PublicationTaskIdentity>();
    while (!this.stopped) {
      const tasks = await this.store.pendingDeliveries(this.opts.batchSize, attempted);
      if (!tasks.length) return;
      for (const task of tasks) {
        const identity = publicationTaskIdentity(task.event.event_id, task.subscription);
        attempted.add(identity);
        const outcome = await deliver(this.fetchImpl, task.delivery_url, {
          schema_version: REPLAY_SCHEMA_VERSION,
          subscription: task.subscription,
          event: task.event,
        }, this.opts.deliveryTimeoutMs);
        await this.store.recordDelivery(
          task.event.event_id,
          task.subscription,
          outcome.ok,
          outcome.ok ? null : outcome.detail,
        );
        if (!outcome.ok) {
          console.error(JSON.stringify({
            level: "error",
            event: "replay_delivery_failed",
            replay_id: task.event.replay_id,
            event_id: task.event.event_id,
            subscription: task.subscription,
            detail: outcome.detail,
            state: "externally_blocked",
          }));
        }
      }
      if (tasks.length < this.opts.batchSize) return;
    }
  }
}

async function deliver(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok ? { ok: true } : { ok: false, detail: `status_${response.status}` };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof DOMException && error.name === "TimeoutError"
        ? "transport_timeout"
        : "transport_unavailable",
    };
  }
}
