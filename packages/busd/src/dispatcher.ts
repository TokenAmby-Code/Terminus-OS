// Durable delivery uses wakeups plus two dispatcher-owned deadlines. Every
// append enters through busd and wakes in-process; startup and explicit
// reconciliation recover a lost wake; the per-await delivery bound folds an
// unsettled transport or store promise into a loud stall (a lane must never
// park silently); the blocked-lane retry deadline re-drives a backed-off lane
// without depending on fresh traffic. Both deadlines derive from the one
// configured delivery timeout. Durable cursors/outbox attempts are authority;
// a wake may be lost or duplicated without changing event identity or
// correctness, and backoff is scheduling state only — it never hides a fact.

import {
  BUS_SCHEMA_VERSION,
  REPLAY_SCHEMA_VERSION,
  type BusDelivery,
  type BusEventRecord,
  type BusSubscriptionRow,
} from "@terminus-os/contracts";
import {
  type ReplayStore,
} from "./replay-store.ts";
import type { BusStore } from "./store.ts";

export type DispatcherOpts = {
  deliveryTimeoutMs: number;
  batchSize: number;
  /**
   * Ceiling on a blocked lane's retry backoff. Defaults to 64× the delivery
   * timeout: the operator's declared maximum staleness for an
   * externally-blocked lane, six doublings above the transport contract.
   */
  maxBackoffMs?: number;
  fetchImpl?: typeof fetch;
};

type Lane = {
  running: boolean;
  wakeRequested: boolean;
  // Consecutive failed/stalled drives; resets on any successful delivery.
  failureStreak: number;
  // Epoch ms before which append-wakes skip this lane; 0 = clear. The lane's
  // own deadline timer re-drives it, so retry never depends on fresh traffic.
  blockedUntil: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * A drain-side await breached the dispatcher-owned bound. The lane folds this
 * pass loudly and backs off; the cursor is untouched, so the next drive
 * redelivers. Every drain await is bounded by the one configured transport
 * contract — a transport or store promise that never settles must never be
 * able to park a lane silently (the 2026-08-02 dead-lane outage).
 */
class LaneStallError extends Error {
  constructor(public readonly phase: string) {
    super(`lane await exceeded the delivery bound during ${phase}`);
  }
}

export class Dispatcher {
  private lanes = new Map<string, Lane>();
  private inFlight = new Set<Promise<void>>();
  private stopped = false;
  private fetchImpl: typeof fetch;
  private maxBackoffMs: number;

  constructor(private store: BusStore, private opts: DispatcherOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxBackoffMs = opts.maxBackoffMs ?? opts.deliveryTimeoutMs * 64;
  }

  start(): void {
    this.wake();
  }

  wake(): void {
    if (this.stopped) return;
    this.track(this.pass());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const lane of this.lanes.values()) {
      if (lane.retryTimer) {
        clearTimeout(lane.retryTimer);
        lane.retryTimer = null;
      }
    }
    await this.settled();
  }

  async settled(): Promise<void> {
    while (this.inFlight.size) {
      await Promise.all([...this.inFlight]);
    }
  }

  private track(promise: Promise<void>): void {
    this.inFlight.add(promise);
    void promise.then(
      () => { this.inFlight.delete(promise); },
      () => { this.inFlight.delete(promise); },
    );
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
    if (this.stopped) return;
    for (const subscription of subscriptions) this.runLane(subscription);
  }

  private runLane(subscription: BusSubscriptionRow): void {
    if (this.stopped) return;
    const lane = this.lanes.get(subscription.name)
      ?? { running: false, wakeRequested: false, failureStreak: 0, blockedUntil: 0, retryTimer: null };
    this.lanes.set(subscription.name, lane);
    if (lane.running) {
      lane.wakeRequested = true;
      return;
    }
    // A blocked lane declines append-wakes until its deadline; its own timer
    // re-drives it, so a quiet bus cannot strand a retry. This is what turns
    // one poisoned fact from a per-append retry storm into a bounded murmur.
    if (lane.blockedUntil > Date.now()) {
      this.armRetry(subscription, lane);
      return;
    }
    lane.running = true;
    const task = this.drain(subscription, lane)
      .catch((error: unknown) => {
        if (error instanceof LaneStallError) {
          // The bound fired on an await that never settled (hung transport,
          // lost store continuation). The pass folds here — loudly — and the
          // backoff below schedules the redrive. Cursor untouched: the next
          // drive redelivers the same fact.
          this.blockLane(subscription, lane);
          console.error(JSON.stringify({
            level: "error",
            event: "lane_stalled",
            subscription: subscription.name,
            phase: error.phase,
            failure_streak: lane.failureStreak,
            retry_at: new Date(lane.blockedUntil).toISOString(),
          }));
          return;
        }
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
    this.track(task);
  }

  /** Exponential backoff from the transport contract: never retry faster than
   * one full delivery attempt, double per consecutive failure, ceiling at the
   * configured maximum staleness. */
  private blockLane(subscription: BusSubscriptionRow, lane: Lane): void {
    lane.failureStreak += 1;
    const backoff = Math.min(
      this.opts.deliveryTimeoutMs * 2 ** (lane.failureStreak - 1),
      this.maxBackoffMs,
    );
    lane.blockedUntil = Date.now() + backoff;
    this.armRetry(subscription, lane);
  }

  private armRetry(subscription: BusSubscriptionRow, lane: Lane): void {
    if (this.stopped || lane.retryTimer) return;
    const delay = Math.max(0, lane.blockedUntil - Date.now());
    const timer = setTimeout(() => {
      lane.retryTimer = null;
      lane.blockedUntil = 0;
      this.runLane(subscription);
    }, delay);
    // A pending retry must not hold the process open on shutdown.
    timer.unref?.();
    lane.retryTimer = timer;
  }

  /** Race an await against the dispatcher-owned bound. The delivery timeout is
   * the one configured ceiling for any single drain-side await — a promise
   * that outlives it is a stall, never a silent park. */
  private bounded<T>(promise: Promise<T>, phase: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new LaneStallError(phase)), this.opts.deliveryTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  private async drain(subscription: BusSubscriptionRow, lane: Lane): Promise<void> {
    const seeded = await this.bounded(this.store.cursor(subscription.name), "cursor_read");
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
      const batch = await this.bounded(
        this.store.readSince(acknowledged, subscription.event_pattern, this.opts.batchSize),
        "journal_read",
      );
      if (!batch.length) return;
      for (const event of batch) {
        const outcome = await this.bounded(this.deliver(subscription, event), "delivery");
        if (!outcome.ok) {
          this.blockLane(subscription, lane);
          console.error(JSON.stringify({
            level: "error",
            event: "delivery_failed",
            subscription: subscription.name,
            event_id: event.seq,
            detail: outcome.detail,
            state: "externally_blocked",
            failure_streak: lane.failureStreak,
            retry_at: new Date(lane.blockedUntil).toISOString(),
          }));
          return;
        }
        await this.bounded(this.store.advanceCursor(subscription.name, event.seq), "cursor_advance");
        acknowledged = event.seq;
        lane.failureStreak = 0;
        lane.blockedUntil = 0;
        console.info(JSON.stringify({
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
  private current: Promise<void> | null = null;
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
    if (this.current) {
      this.wakeRequested = true;
      return;
    }
    const task = this.reconcile()
      .catch(() => {
        console.error(JSON.stringify({ level: "error", event: "replay_delivery_error", error_code: "store_unavailable" }));
      })
      .finally(() => {
        this.current = null;
        if (this.wakeRequested && !this.stopped) {
          this.wakeRequested = false;
          this.wake();
        }
      });
    this.current = task;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.settled();
  }

  async settled(): Promise<void> {
    while (this.current) await this.current;
  }

  private async reconcile(): Promise<void> {
    const attemptWatermark = await this.store.deliveryAttemptWatermark();
    while (!this.stopped) {
      const tasks = await this.store.pendingDeliveries(this.opts.batchSize, attemptWatermark);
      if (!tasks.length) return;
      for (const task of tasks) {
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
        } else {
          console.info(JSON.stringify({
            level: "info",
            event: "replay_delivered",
            replay_id: task.event.replay_id,
            event_id: task.event.event_id,
            subscription: task.subscription,
            event_type: task.event.event_type,
          }));
        }
      }
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
    const target = new URL(url);
    const unix = target.protocol === "http+unix:" ? decodeURIComponent(target.hostname) : null;
    const requestUrl = unix
      ? `http://localhost${target.pathname}${target.search}`
      : url;
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      ...(unix ? { unix } : {}),
    };
    const response = await fetchImpl(requestUrl, init as RequestInit);
    disposeResponseBody(response);
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

function disposeResponseBody(response: Response): void {
  if (!response.body) return;
  try {
    void response.body.cancel().catch(() => {
      console.error(JSON.stringify({
        level: "error",
        event: "response_body_disposal_failed",
        error_code: "transport_cleanup_failed",
      }));
    });
  } catch {
    console.error(JSON.stringify({
      level: "error",
      event: "response_body_disposal_failed",
      error_code: "transport_cleanup_failed",
    }));
  }
}
