# busd — replay and event authority

PostgreSQL 18 stores the append-only replay stream and publication intent in
one transaction. `replay_id` binds one canonical SHA-256 request hash;
`event_id` is globally unique; `sequence` is monotonic inside one replay.
Current state and event-delivery status are folds over immutable events and
delivery attempts.

Wakeups carry no correctness. busd is the sole replay writer; every daemon
publishes through its strict HTTP surface, and a committed append wakes the
dispatcher in-process. Startup and `POST /ctl/reconcile` reconcile durable
unfinished work. Lost or duplicate wakeups are harmless; there is no interval
checker, cooldown sleep, or volatile retry journal.

`bus.events` serves vendor-hook subscribers with the same event-only posture:
a failed subscriber becomes externally blocked until a new wake or service
restart.

## Surfaces

| Route | Plane |
| --- | --- |
| `GET /ctl/health` | ok + build + per-subscription lag (the `bus.lag` view) |
| `POST /ctl/reconcile` | explicit bounded wake for durable pending delivery |
| `POST /ctl/cursors/advance` | exact, audited compare-and-swap for sanctioned retirement of a known matching event set |
| `POST /v1/replays/admit` | bind a replay to its request hash and atomically append its first event |
| `POST /v1/replays/<replay_id>/events` | append an immutable event and publication intent |
| `GET /v1/replays/<replay_id>` | fold event and delivery state |
| `GET /v1/replays?source=<service>&unfinished=true&limit=<n>&after=<replay_id>` | bounded, cursor-paginated startup reconciliation index |
| `GET /v1/events?limit=<n>&after=<event_id>` | bounded immutable journal feed for projection rebuild |
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
- At-least-once: replay subscribers dedupe by `event_id`; legacy `bus.events`
  subscribers dedupe by `seq`. Every replay delivery attempt is durable and
  the projection is rebuildable. Protected local consumers may use an
  `http+unix://<percent-encoded-absolute-socket>/path` delivery URL instead of
  opening a TCP listener.
- A failed delivery records `externally_blocked`; it is not followed by a sleep
  or repeated API request. A later event, explicit reconciliation wake, or
  startup reconciliation continues the durable intent.

## Subscribing

Normal machine subscriptions are declared in `BUSD_CONFIG`. busd transactionally
upserts them at startup, seeds a new cursor from the beginning or current end
as configured, and deactivates managed rows removed from configuration. Rows
created directly by an operator remain unmanaged and are never changed by
configuration convergence.

```json
{
  "machine": "k12-personal",
  "subscriptions": [{
    "name": "githubd-github",
    "delivery_url": "http+unix://%2Frun%2Fgithubd%2Fghd.sock/event",
    "event_pattern": "github.%",
    "active": true,
    "seed": "beginning"
  }]
}
```

Direct SQL remains an operator-only recovery/debugging surface:

```sql
INSERT INTO bus.subscriptions (name, delivery_url, event_pattern, active)
VALUES ('txd', 'http://127.0.0.1:7781/ingress/bus', 'hook.%', true);

-- Cursor seeding is DELIBERATE (busd skips-loud an unseeded subscription):
--   0          = full replay from the beginning of the journal
--   max(seq)   = from-now
INSERT INTO bus.cursors (subscription_name, acked_seq)
SELECT 'txd', coalesce(max(seq), 0) FROM bus.events;
```

That SQL seeds a new subscription only. Never use SQL to move an existing
cursor. A sanctioned administrative retirement uses the typed loopback door:

```bash
curl --fail-with-body http://127.0.0.1:7782/ctl/cursors/advance \
  --header 'content-type: application/json' \
  --data '{
    "schema_version": 1,
    "subscription": "example-consumer",
    "expected_acked_seq": 42,
    "through_seq": 57,
    "expected_matching_seqs": [47,57],
    "reason": "retire the approved dead event generation"
  }'
```

Busd locks and compares the durable cursor, derives every event matching the
subscription pattern through the cutoff, and refuses on either mismatch. A
successful transaction advances the cursor and appends a
`bus.cursor_advanced` audit event; its response includes that audit sequence.

`event_pattern` is a SQL `LIKE` pattern over `event_type`; matching lives in
the delivery query, so psql answers exactly what busd will deliver. Deactivate
with `UPDATE bus.subscriptions SET active = false WHERE name = ...` — the
cursor stays put for a later revival.

Observability: `SELECT * FROM bus.lag;` or `curl localhost:7782/ctl/health`.

## Config

txd's B1 pattern: `BUSD_CONFIG` JSON file → env → defaults. `machine` must come
from `IMPERIUM_MACHINE` or config (fail loud). Defaults: bind `127.0.0.1`, port
`7782`, db peer-auth socket `/var/run/postgresql` database `terminus`,
`deliveryTimeoutMs` 10000 and `batchSize` 100. The optional `subscriptions`
array is the machine-owned delivery topology.

## No-fallback posture (ruled)

Postgres down ⇒ busd 5xxs its doors (hook adapters are fail-open; the proxy
logs `hook_broadcast_partial`) and boot fails loud. There is NO queueing
outside the database and NO fallback code path. DB down = the box is fubar;
events during an outage are lost, exactly like the pre-bus posture.
