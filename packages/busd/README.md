# busd — the central event bus

Postgres-as-bus, transactional-outbox shape. Emitters append ONE event to the
central journal (`bus.events` — busd is its single writer); the
`bus.subscriptions` config table decides which services receive it — zero, one,
or all, invisible to the emitter. busd delivers over HTTP per subscription,
strictly in seq order, from a durable per-subscriber cursor. A consumer that is
down simply catches up from its cursor when it returns — replay is free.

DB triggers do NOT deliver, and there is no broker: appends wake the dispatcher
in-process (busd is the one writer, so no LISTEN/NOTIFY machinery exists) and a
30s repair tick covers everything a wake cannot see.

## Surfaces

| Route | Plane |
| --- | --- |
| `GET /ctl/health` | ok + build + per-subscription lag (the `bus.lag` view) |
| `POST /ingress/hooks/<type>` | hook shim: one door per pinned vendor hook type (30), ALL consumed — journals `hook.<type>`. No 410 tail exists. |
| `POST /ingress/events` | generic publish door (loopback emitters). `hook.*` is reserved and rejected here. |

Harness hooks arrive via the local edge proxy (`hookConsumers` fan-in — busd is
the only consumer); the `x-edge-proxy` header is the transport receipt woven
into journal provenance.

## Delivery contract

- One full journal row per POST (`BusDeliverySchema`: `schema_version`,
  `subscription`, `event{seq, event_type, source, payload, provenance,
  occurred_at, recorded_at}`).
- **Subscribers MUST 2xx events they do not care about** (ack ≠ consume).
  Delivery is head-of-line per subscription — busd never skips — so a non-2xx
  on an irrelevant event wedges that subscriber's own lane (and only its own).
- At-least-once: subscribers dedupe. Retry state is in-memory; a busd restart
  retries from the durable cursor.
- Backoff: full-jitter exponential, 500ms base, 60s cap; 10s delivery timeout;
  batch reads of 100; per-subscription independent serial lanes.

## Subscribing (runbook)

```sql
INSERT INTO bus.subscriptions (name, delivery_url, event_pattern, active)
VALUES ('txd', 'http://127.0.0.1:7781/ingress/bus', 'hook.%', true);

-- Cursor seeding is DELIBERATE (busd skips-loud an unseeded subscription):
--   0          = full replay from the beginning of the journal
--   max(seq)   = from-now
INSERT INTO bus.cursors (subscription_name, acked_seq)
SELECT 'txd', coalesce(max(seq), 0) FROM bus.events;
```

`event_pattern` is a SQL `LIKE` pattern over `event_type`; matching lives in
the delivery query, so psql answers exactly what busd will deliver. Deactivate
with `UPDATE bus.subscriptions SET active = false WHERE name = ...` — the
cursor stays put for a later revival.

Observability: `SELECT * FROM bus.lag;` or `curl localhost:7782/ctl/health`.

## Config

txd's B1 pattern: `BUSD_CONFIG` JSON file → env → defaults. `machine` must come
from `IMPERIUM_MACHINE` or config (fail loud). Defaults: bind `127.0.0.1`, port
`7782`, db peer-auth socket `/var/run/postgresql` database `terminus`,
`repairIntervalMs` 30000, `deliveryTimeoutMs` 10000, `batchSize` 100,
`backoffBaseMs` 500, `backoffCapMs` 60000.

## No-fallback posture (ruled)

Postgres down ⇒ busd 5xxs its doors (hook adapters are fail-open; the proxy
logs `hook_broadcast_partial`) and boot fails loud. There is NO queueing
outside the database and NO fallback code path. DB down = the box is fubar;
events during an outage are lost, exactly like the pre-bus posture.
