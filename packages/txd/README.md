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
  tmux session (`main`) at boot: flat `mechanicus`, compass `palace`
  (W/N/S/E), remote compass `somnium` (W/N/S/NE/SE), one four-pane `council`
  window, and flat overflow pages `palace_fleet` and `somnium_fleet`. Council is an
  explicit weighted 2×2 grid: Custodes NW and Pax NE receive roughly two thirds
  of the vertical room; Fabricator-General SW and Orchestrator SE share the
  remaining third. Every pane is resolved only through `@canonical_id`.
  Construction is idempotent. Mitosis worker panes retain flexible native
  tiled geometry; arbitrary or foreign pages are refused before mutation.
  txd is the constructor; tx never constructs.
- **Boot observes; it never closes a live pane.** A restart arrives with every
  merge in txd's closure, so boot is not a repair site. An existing page that
  still holds a live tagged pane is accepted as it stands however far it has
  drifted: the drift is flagged as a `page_drift` contradiction on the page
  entity and named by the `/health` estate probe (page + failed clause,
  `seats` or `geometry`) while `estate_generation` reads `recoverable`. Boot
  repairs a dead or missing seat alone, in place, exactly as the lifecycle
  ingress does, and rebuilds only a page with no live tagged pane left.
  Repairing an occupied page is an explicit operator verb (`tx estate`
  page/pane reset) that computes the page's foreground workloads and refuses
  `estate_busy` unless forced.
- **Static Council singletons.** Custodes (Claude) and Fabricator-General
  (Codex) are compile-time declarations launched through the Fleet wrapper.
  A private one-time handshake binds each fresh agent only after txd
  attests the wrapper-selected executable, process pair, and expected physical
  seat, then applies
  and reads back the declaration's pane tint. Custodes is `#302800`;
  Fabricator-General is `#300808`. Pax and Orchestrator remain live, unbound,
  untinted shells. Any Council reconstruction wipes all four panes and launches
  fresh Custodes and Fabricator-General agents.
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
| GET    | `/health`               | Strict STC observation verdict and typed evidence |
| GET    | `/inspect`              | Strict STC holdings walk without a verdict       |
| POST   | `/ctl/reconcile`        | Replay-driven reconcile; p0 on contradiction     |
| POST   | `/ctl/estate/abandon` | Overseer abandonment of exact noncanonical seats already proven unbound and physically absent |
| POST   | `/ctl/estate/rotate`    | Explicit estate, border-total page, or pane reset |
| POST   | `/ctl/clipboard/push`   | Read the transient `tx-clipboard` buffer for an explicit client-side push |
| POST   | `/ctl/clipboard/pull`   | Load UTF-8 into the transient, non-executing `tx-clipboard` buffer |
| POST   | `/ctl/clipboard/selection` | Commit bounded UTF-8 through txd to `tx-clipboard` and the invoking client's transport-bound WSL or phone origin |
| POST   | `/ingress/tmux`         | Typed `pane-died` / `pane-exited` / page-less `pane-killed` ingress; repairs each faulted seat alone, rebuilding a page only when no tagged pane survives on it |
| POST   | `/ingress/hooks/user_prompt_submit` | Receiving-engine delivery attestation for comm receipts |
| POST   | `/ingress/hooks/stop`    | Receiving-engine stop fact for lifecycle and ask callbacks |
| POST   | `/agents/launch`        | Atomic reg-audited seat bind / handover          |
| POST   | `/agents/close`         | Remote close (`tx close`, overseer-gated): reap N processes individually, keep estate panes, seats → freelist; explicit stopped targets are intended closes, other live/unobservable targets refuse absent force |
| POST   | `/agents/comm`          | Typed message or engine-neutral command/skill admission |
| POST   | `/agents/comm/lifecycle-effect` | Generation-fenced, idempotent ordinary-comm actuator for a caller-owned lifecycle effect |
| POST   | `/agents/comm/receipt`  | Event-driven, fixed 30-second delivery receipt rendezvous |
| POST   | `/agents/comm/wait`     | Read the durable callback fold for one admitted ask |
| POST   | `/agents/mode`          | Engine-aware, event-before-effect plan-mode transition (enter / toggle / approve a posed plan) |
| POST   | `/agents/run`           | One shell command against one pane (`tx run`): a registered agent seat gets the engine's `!` shell escape; a bare declared seat executes in its idle pane shell and returns captured stdout/stderr + exit code |
| POST   | `/ingress/lifecycle`    | lifecycled typed lifecycle-fact door: consumes `wrapper_started`; 422 only for envelope skew, acks everything else so the lane never wedges |
| GET    | `/tmux/read/estate`     | Estate observation: seats, bindings, and tint readiness |
| GET    | `/tmux/read/diagnostics/hooks` | Bounded typed view of tmux-hook records captured in journald |

- `/agents/*` is the **deliberate-action plane**: every route directly under it
  is a deliberate action, one-for-one.
- `tx estate abandon <seat>...` is the repair leg for a reconcile-proven
  phantom. The batch is atomic and overseer-gated; every target must be
  noncanonical, projected unbound, absent from tmux, and carry an open
  `pane_absent` contradiction naming `seat_abandoned`. Canonical seats
  remain reconstruction work and a live or merely unobserved target refuses.
- After `/agents/comm` stages the bytes, `tx comm` waits on
  `act.comm_delivery_asserted` for at most 30 seconds. An on-time receiving
  engine hook returns the delivery-confirmed receipt directly. At the bound,
  the CLI returns the bytes-sent receipt; a later hook stages the confirmation
  through the sender's ordinary agent input path and persists that follow-up's
  own `act.agent_input_injected` receipt. The wait has no delivery-state poll.
- `POST /agents/comm/lifecycle-effect` is the narrow actuator for a lifecycle-
  owned comm effect. The caller supplies its stable effect id and exact source
  and target generation witnesses; txd validates them, admits that id through
  the ordinary one-way comm pipeline, and reports its existing transport and
  delivery/refusal facts. It does not decide why the effect exists or resolve
  either endpoint from lifecycle policy. If txd restarts after admitting the
  effect but before snapshotting its targets, replay reconstructs that one
  snapshot from the admitted comm and terminalizes the interrupted transport;
  later replays create neither another snapshot nor another send attempt.
- `tx comm <identity> command=<name> [-- args]` invokes the named slash
  command. `tx comm <identity> skill=<name> [-- args]` invokes a target skill.
  Callers never supply `/`, `$`, or an engine flag: txd resolves the target's
  registrationd-minted binding engine and renders `/name` for Claude skills,
  `$name` for Codex skills, and `/name` for commands on both engines. Txd types
  the complete name, presses one Tab to commit/collapse the engine palette,
  then types any arguments and submits through the existing verified-send
  gate. V1 deliberately performs no skill-name preflight; the engine owns
  validation. Any future preflight must consume Token-Fleet's canonical skill
  configuration rather than create a txd-local registry.
- `tx run <target> <command>` branches on txd's event-sourced agent-presence
  truth, never a process sniff. A target resolving to a REGISTERED binding is
  an agent pane: txd stages the engine's shell escape (Claude enters bash mode
  with a literal `!` keystroke, then pastes the command and drives Enter;
  Codex takes the whole `!<command>` line through the verified send path), so
  the command's output lands in that agent's conversation, and the injection
  is recorded as `act.agent_input_injected`
  (`input_class: harness_shell`). A bare declared seat executes the command in
  its idle pane shell: the command bytes live in a script file, the one staged
  line carries only fixed paths, and completion is the pane's own
  `tmux wait-for` signal — armed before the line is typed, no polling loop, no
  deadline — after which the caller receives the exact captured stdout,
  stderr, and exit code (each stream bounded by `MAX_RUN_CAPTURE_BYTES`,
  truncation reported). Refusals are loud and typed: `identity_absent`,
  `identity_ambiguous`, `seat_unresolved`, `pane_busy: <command>`,
  `seat_binding_pending`, `scoped_reset_pending`, `pane_dead`,
  `seat_abandoned`, `engine_unattested`, `stage_failed`,
  `run_not_staged`, and a mid-run pane replacement fails the run with
  `pane_lost_mid_run` instead of hanging on a dead signal.
- Ordinary comm payloads are opaque and have no caller-visible length mode or
  size ceiling. Txd loads every verified text segment into a private,
  one-use tmux buffer over stdin. An ordinary message injects as one bracketed
  paste followed by Enter; a command or skill send is a sequence — paste the
  prefix, send Tab, paste the suffix, then Enter — so a submission is not
  always a single paste. Existing visible paint never gates a comm. Callers
  never split, spill, encode, or select a transport. A failed transport or
  submit records its possible-effect byte count but remains permanently
  undelivered.
- Delivery requires the exact target's `staged` transport fact joined with an
  engine attestation. An idle engine attests through its exact
  `UserPromptSubmit` message id. A WORKING engine queues a mid-turn frame into
  the running turn and fires no `UserPromptSubmit` for it; there the target's
  own fresh turn stop is the attestation, joined with one composer-at-rest
  capture taken at that stop proving the exact frame no longer sits in the
  visible composer — it left it into the queue the finished turn consumed.
  The capture happens at the stop because the engine is at rest there; a
  send-time capture races the busy engine's repaint and proves nothing. A
  still-painted frame, an invisible composer, a stop alone, or a frame staged
  without observed working turn state never asserts; a later fresh stop
  retries with fresh evidence. Bytes, process success, and an `ok: true`
  envelope are never delivery assertions.
- `/agents/mode` accepts only logical identity plus `enter_plan`,
  `toggle_plan`, or `approve_plan`. It resolves the bound engine from event
  truth, records `act.mode_transition_requested` before input, then records an
  attested or failed read-back fact. Codex enters through `/plan` and the
  `Plan mode` footer; Claude uses its permission-mode cycle and the
  `plan mode on` footer. `approve_plan` accepts a POSED plan dialog read from
  the visible pane only — never scrollback, whose transcript holds every plan
  already approved — and attests success only when the dialog is gone AND the
  agent left plan mode. With no dialog posed, nothing is typed and the
  transition fails loud. No caller sends arbitrary text, keys, raw pane ids, or
  harness guesses.
- Txd owns a durable cursor over `journal.events`. Registration requests and
  lifecycle facts are selected by exact event type; PostgreSQL notification is
  only the wakeup, and startup catch-up closes missed-notification windows.
  Txd publishes its `agent.*` outcomes through `journal.publish`. Raw engine
  hooks remain lifecycled's direct ingress concern and never become a second
  txd HTTP subscription surface.
- `/ingress/tmux` is the tmux witness door. The managed estate keeps exited
  panes observable and forwards their canonical page through the thin `tx`
  client. `txd` compares that observation to `TXD_WINDOWS`; only `txd` decides
  whether to reconstruct. A page reconstruction wipes every process, history,
  pane-local option, and split inside that page border, then rebuilds the full
  declared geometry before retiring the old bindings in event truth.
- The journal cursor consumes dispatch, physical declaration, registration
  abort/finalization, stop, and prompt-submitted facts. Txd attests pane and
  process reality, projects tint, and never allocates identity or persona.
- `/tmux/read/*` is txd's ONLY public read surface — side-effect-free by
  construction. "entities" is dead as public API vocabulary, and the old
  per-entity event-history endpoint is REMOVED: agent-biography serving is not
  txd's job. The internal event stream stays the private replay/reconcile truth.

## Contracts

The lifecycle vocabulary (`schema_version`, the seed event types, axes,
comm/stop/close/mode shapes) lives in `@terminus-os/contracts`
(`./txd` module) — the daemon pins `SCHEMA_VERSION` exactly. No `file:` links,
no external registry dependency and no compatibility layer.

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
| `sshSeatTargets`      | `TXD_SSH_SEAT_TARGETS`             | current k12-work page/overseer placement   |
| `personaWorkspaceRoot`| `TXD_PERSONA_WORKSPACE_ROOT`       | **none — fail loud**                       |

`machine` has **no default**: a daemon that guesses its own box identity is a
bug, so config load fails loud when it is unset.

`db` is a `@terminus-os/db` endpoint object (strict-validated — unknown fields
refuse loud). On fleet boxes it is the sanctioned shape: the native PostgreSQL
18 cluster's peer-auth unix socket — no password field exists.

`sshSeatTargets` has disjoint `pages` and `seats` maps. A page selector covers
every canonical seat on that page, including later dynamic stack seats; a seat
selector names one existing static estate seat. Unknown selectors, exact stack
selectors, and page/seat overlap refuse at config load. The selected value is
the SSH machine alias stamped into the shared agent wrapper as
`TXD_SSH_TARGET`; no target gets a second wrapper implementation.

## Persistence — PostgreSQL 18

The local event stream lives in the `terminus` database, schema `txd`, table
`txd.events`. The same schema owns txd's `journal_cursors` and
`journal_poison` ledger for selected estate-journal facts.

| Column        | Type     | Notes                                             |
|---------------|----------|---------------------------------------------------|
| `seq`         | `bigint` | identity, monotonic — assigned by the store       |
| `entity_type` | `text`   | `seat` \| `agent` \| `message`                 |
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
  "tmuxSocket": "k12",
  "sshSeatTargets": {
    "pages": {
      "somnium": "k12-work",
      "somnium_fleet": "k12-work"
    },
    "seats": {
      "council:pax": "k12-work",
      "council:orchestrator": "k12-work",
      "palace:S": "wsl"
    }
  }
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
tx probes it by name: systemctl --user start txd; GET /health; POST /ctl/reconcile
```
