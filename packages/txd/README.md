# txd — `@terminus-os/txd`

The estate daemon for k12 boxes: the authoritative, event-sourced tmux control
plane (Bun/TypeScript), defined by the ruled `txd-extraction-spec` (namespace LOCKED:
**txd** primary; **tx** is its single rote auxiliary client — "tx pings txd;
txd does the thing"). The daemon's design is the ruled `k12-daemon-spec`
(§1–§12); behavior did not change in the move, only the home, the name, the
contracts source, and the public route shape.

## What it is

- **Event-sourced core.** One append-only Postgres event stream (`txd.events`)
  is the single source of truth; the three day-one read models
  (`current_bindings`, `freelist`, `activity_board`) are pure projections
  rebuilt by replay — nobody writes them.
- **Canonical-id membrane.** Raw tmux `%id`s never cross upward. Every response,
  log line, and event is scrubbed (`assertNoTmuxId`); a breach fails loud.
- **Reconcile = replay.** Out-of-band pane death surfaces as a
  `contradiction_flagged` event (p0, fail-loud in bring-up mode), never a
  silently synthesized lifecycle.
- **Boot-time estate constructor.** `constructEstate()` stands one persistent
  tmux session (`main`) at boot: `reservists` (W/N/S/E), `palace` (W/N/S/E),
  `somnium` (W/N/S/NE/SE), and one four-pane `council` window. Council is an
  explicit 2×2 grid: Custodes NW, Fabricator-General SW, Pax NE, and
  Orchestrator SE. Every pane is resolved only through `@canonical_id`.
  Construction is idempotent. The exact preceding five-seat Council plus
  two-seat Mechanicus generation is migrated once; arbitrary or foreign
  shapes are refused before mutation. txd is the constructor; tx never
  constructs.
- **Static Council singletons.** Custodes (Claude) and Fabricator-General
  (Codex) are compile-time declarations launched through the Fleet wrapper.
  A private one-time handshake binds each fresh instance only after txd
  attests the wrapper-selected executable, process pair, and expected physical
  seat, then applies
  and reads back the declaration's pane tint. Custodes is `#302800`;
  Fabricator-General is `#300808`. Pax and Orchestrator remain live, unbound,
  untinted shells. Any Council reconstruction wipes all four panes and launches
  fresh Custodes and Fabricator-General instances.
- **Tint is binding evidence.** A bound pane's declared tint is applied and
  physically verified before `reg.bound`; bind failure compensates fail-dark.
  Close and reconstruction clear it. Health and estate reads expose tint
  readiness, and reconcile reports physical drift as a binding contradiction.
  There is no public tint mutation route or CLI. The ruled future birth-service
  boundary is recorded in [registration-architecture.md](registration-architecture.md).

## HTTP surface — the RATIFIED planes

Bound to loopback only; ingress is via the per-box edge proxy ONLY, under the
`/txd` route prefix. Routes are grouped by caller/trust plane; behavior under
each route is the ruled daemon behavior, unchanged.

| Method | Path                    | Purpose                                          |
|--------|-------------------------|--------------------------------------------------|
| GET    | `/ctl/health`           | Honest liveness + build + tmux/tint attestation  |
| POST   | `/ctl/reconcile`        | Replay-driven reconcile; p0 on contradiction     |
| POST   | `/ctl/estate/rotate`    | Explicit estate, border-total page, or pane reset |
| POST   | `/ctl/clipboard/push`   | Read the transient `tx-clipboard` buffer for an explicit client-side push |
| POST   | `/ctl/clipboard/pull`   | Load UTF-8 into the transient, non-executing `tx-clipboard` buffer |
| POST   | `/ctl/clipboard/selection` | Commit bounded UTF-8 through txd to `tx-clipboard` and one validated attached client |
| POST   | `/ingress/tmux`         | Typed `pane-died` / `pane-exited` event ingress; reconstructs a damaged canonical page |
| POST   | `/ingress/static-launch`| Private wrapper attestation for a pending static launch |
| POST   | `/agents/launch`        | Atomic reg-audited seat bind / handover          |
| POST   | `/agents/close`         | Generic close: reap process, keep estate pane, seat → freelist |
| POST   | `/agents/subscribe`     | Bound-keyed close-on-next-stop subscription (satiated-once) |
| POST   | `/ingress/bus`          | Central-bus delivery door: consumes `hook.stop` (record / dedupe / refuse-ghost; fires auto-close) and `hook.user_prompt_submit`; acks everything else |
| GET    | `/tmux/read/estate`     | Estate observation: seats, bindings, and tint readiness |

- `/agents/*` is the **deliberate-action plane**: every route directly under it
  is a deliberate action, one-for-one.
- `/ingress/bus` is txd's **bus subscription door** (central-bus ruling): hook
  fan-in terminates at busd (`packages/busd`), which journals every vendor hook
  type as a `hook.<type>` bus event; txd consumes its two hook types as a
  normal bus subscriber (subscription `txd`, pattern `hook.%`) and 2xx-acks
  every other delivered event (ack ≠ consume — bus delivery is head-of-line
  per subscription). The direct `/ingress/hooks/*` surface and its 410 tail
  are REMOVED, no crumbs. The hook-type enumeration stays pinned in
  `@terminus-os/contracts/hooks` from the actual claude-code and codex hook
  contracts.
- `/ingress/tmux` is the tmux witness door. The managed estate keeps exited
  panes observable and forwards their canonical page through the thin `tx`
  client. `txd` compares that observation to `TXD_WINDOWS`; only `txd` decides
  whether to reconstruct. A page reconstruction wipes every process, history,
  pane-local option, and split inside that page border, then rebuilds the full
  declared geometry before retiring the old bindings in event truth.
- `/ingress/static-launch` is a private, one-time wrapper door. A request must
  match a pending launch's token, instance, engine, and physical Council seat.
  Forged, duplicated, stale, or mismatched handshakes create no binding.
- `/tmux/read/*` is txd's ONLY public read surface — side-effect-free by
  construction. "entities" is dead as public API vocabulary, and the old
  per-entity event-history endpoint is REMOVED: agent-biography serving is not
  txd's job. The internal event stream stays the private replay/reconcile truth.

## Contracts

The lifecycle vocabulary (`schema_version`, the seed event types, axes,
comm/stop/close/subscribe shapes) lives in `@terminus-os/contracts` (`./txd`
module) — the daemon pins `SCHEMA_VERSION` exactly. No `file:` links, no
external registry dependency and no compatibility layer.

## Config

Env/config-driven — no hardcoded machine values. A JSON file pointed at by
`TXD_CONFIG` wins; otherwise env vars; otherwise localhost-safe defaults. Keys
(see `txd.config.example.json`):

| Key                   | Env                                | Default                                    |
|-----------------------|------------------------------------|--------------------------------------------|
| `bind`                | `TXD_BIND`                         | `127.0.0.1`                                |
| `port`                | `TXD_PORT`                         | `7781`                                     |
| `machine`             | `IMPERIUM_MACHINE`                 | **none — fail loud** (never guess the box) |
| `db`                  | `TXD_DB_SOCKET_DIR` / `TXD_DB_DATABASE` | socket `/var/run/postgresql`, db `terminus`|
| `tmuxSocket`          | `TXD_TMUX_SOCKET`                  | `k12`                                      |
| `agentWrapper`        | `TXD_AGENT_WRAPPER`                | **none — fail loud**                       |
| `personaWorkspaceRoot`| `TXD_PERSONA_WORKSPACE_ROOT`       | **none — fail loud**                       |

`machine` has **no default**: a daemon that guesses its own box identity is a
bug, so config load fails loud when it is unset.

`db` is a `@terminus-os/db` endpoint object (strict-validated — unknown fields
refuse loud). On fleet boxes it is the sanctioned shape: the native PostgreSQL
18 cluster's peer-auth unix socket — no password field exists.

## Persistence — PostgreSQL 18

The event stream lives in the `terminus` database, schema `txd`, table
`txd.events` — the 8 ruled columns, nothing derived:

| Column        | Type     | Notes                                             |
|---------------|----------|---------------------------------------------------|
| `seq`         | `bigint` | identity, monotonic — assigned by the store       |
| `entity_type` | `text`   | `seat` \| `instance` \| `message`                 |
| `entity_id`   | `text`   | canonical id (never a raw tmux `%id`)             |
| `event_type`  | `text`   | pinned vocabulary (`@terminus-os/contracts`)      |
| `payload`     | `jsonb`  | dumb facts only, never derived state              |
| `provenance`  | `jsonb`  | source + transport receipt + emitter version      |
| `occurred_at` | `text`   | attested ISO-8601, stored verbatim                |
| `recorded_at` | `text`   | daemon clock; skew vs `occurred_at` is visible    |

Append-only is STRUCTURAL: triggers raise on `UPDATE`, `DELETE`, and
`TRUNCATE`. The schema ships as `packages/db/migrations/0002_txd_events.sql`
(the shared forward-only migrations home) and the daemon applies pending
migrations at boot — a pristine database and a current one converge on the
same shape.

### Config bootstrap — seeding `~/secrets/txd/txd.json`

The unit sets `TXD_CONFIG=%h/secrets/txd/txd.json` and guards it with
`ConditionPathExists` on the same path: while the file is absent the unit is
**skipped cleanly** (visible condition-failed status in
`systemctl --user status txd`), never a crashloop. The Token-Fleet apply leg
ensures only the `~/secrets/txd` dir (mode 700) — the file itself is a
one-time per-box seed.

No key is a secret: every field is an operational value (peer auth means no
credential exists). On a k12 box the seed is the example config verbatim
(adjust `machine` per box):

```bash
install -m 600 /dev/null ~/secrets/txd/txd.json
cat > ~/secrets/txd/txd.json <<'EOF'
{
  "bind": "127.0.0.1",
  "port": 7781,
  "machine": "k12-personal",
  "db": {
    "kind": "socket",
    "socket_dir": "/var/run/postgresql",
    "database": "terminus",
    "application_name": "txd"
  },
  "tmuxSocket": "k12"
}
EOF
systemctl --user restart txd
```

### tmux server privilege boundary

`txd.service` runs with `NoNewPrivileges=true`, but the persistent tmux server
must not be its child. Linux carries `NoNewPrivileges` across fork and exec; a
server started by txd therefore passes `NoNewPrivs=1` to every pane, making
setuid/capability-dependent tools such as `sudo`, `snap-confine`, and `lxc`
unusable estate-wide. `tx-estate.service` is the dedicated unsandboxed server
owner. txd only connects to its socket and refuses loudly if that external
server is absent; it never falls back to starting the server itself.

For a one-off command that needs an unsandboxed scope before the durable unit
is deployed, use `systemd-run --user --pipe --wait <cmd>`.

The units' boundary and directive lines (WorkingDirectory under the box's
`live/` checkout, ordering, condition guard, NoNewPrivileges split, KillMode,
ExecStart, and PrivateTmp absence) are pinned in `test/systemd-unit.test.ts`.

### Migrating an existing estate

At boot, txd recognizes only the exact preceding generation: the ruled
five-seat Council and two-seat Mechanicus windows alongside the unchanged
estate pages. It persists `estate.topology_migration_requested` before any
tmux mutation, rebuilds Council as the ruled 2×2 page, retires Mechanicus,
decommissions the five displaced canonical seats in event truth, and records
completion. A boot interrupted after the request resumes deterministically.
Any unrequested partial migration or foreign shape fails before mutation.

The migration is page-scoped: non-Council panes and processes are preserved.
Do not kill the tmux server or clear the estate socket for this migration.

## Develop

Bun-native — TypeScript source runs directly, no build step. From the repo root:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test packages/txd
bun packages/txd/src/daemon.ts   # run (needs IMPERIUM_MACHINE or TXD_CONFIG)
```

## Deploy — systemd `--user` via the Token-Fleet apply leg

`systemd/tx-estate.service` owns the unsandboxed persistent tmux server;
`systemd/txd.service` requires it and owns only the sandboxed daemon. Both are
user-scoped. Delivery/installation is a Token-Fleet apply leg scoped to k12-personal —
apply legs install units to `~/.config/systemd/user/` and reload, root-free —
including the runtime write-lock cycle (unlock via scoped CI sudo → propagate →
re-lock). Config is provisioned at `~/secrets/txd/txd.json` — the `~/secrets/txd`
subdir (mode 700) is what the Token-Fleet apply leg (`shared/bin/apply-txd`)
ensures on the box, resolving the extraction spec's sole open minor (§3.5/§7)
in favor of the fleet leg that actually provisions it.

```bash
systemctl --user enable --now tx-estate.service txd.service
tx probes it by name: systemctl --user start txd; GET /ctl/health; POST /ctl/reconcile
```
