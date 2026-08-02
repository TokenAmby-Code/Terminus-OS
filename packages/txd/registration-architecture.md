# Agent registration, placement, and lifecycle

Status: ruled for implementation. Council rotation is outside this change.

## Authorities

`registrationd` is the only logical identity authority. It mints `agent_id`,
owns the durable birth transaction, assembles the complete instruction and
persona package, and writes the final agent record.

`txd` is the physical tmux authority. It constructs panes, observes process
ancestry, attests canonical placement and pane generation, applies and reads
back tint, and maintains the physical routing projection. It never mints an
agent ID or selects a persona.

`lifecycled` (`lcd`, CLI `lc`) correlates registration preparation, current txd
placement signoff, and literal engine lifecycle hooks. It persists each input
before acknowledging bus delivery and emits generation-bound readiness,
stopping, inactivity, and retirement facts. It owns no identity allocation.

edge-proxy and busd provide content-agnostic hook ingress and immutable event
delivery. A bus event is always a one-way fact and never a return value.

## Identity and placement

The sole logical identity is `agent_id`. The sole fleet identity variable in
an engine environment is `AGENT_ID`. It is an identifier, not a credential.
Transport authentication and registration truth, not an environment string,
authorize persona-sensitive operations.

`PANE_ID` is placement context. txd installs the canonical seat label in each
pane's process environment with tmux's per-pane `-e PANE_ID=<seat>` option.
Every creation path does this: the initial session, new windows, split panes,
page reconstruction, dynamic seats, and perpetual remote launch panes. Every
respawn explicitly restamps the current canonical value; disposable tmux 3.5a
proof showed that plain `respawn-pane -k` drops the pane-local environment. A
canonical-seat change replaces the pane process with the new `PANE_ID`.

The wrapper reports `claimed_pane_id`, wrapper PID, engine choice, cwd, and
machine in `hook.wrapper_start`. txd walks the wrapper PID's ancestry to a live
tmux pane and reads txd's pane option and generation. The final agent package
contains only the attested `pane_id`; claims and witnesses remain transaction
evidence. A wrapper outside a managed pane is refused before engine spawn.

Engine session or conversation IDs are transcript metadata. Wrapper and
engine PIDs are physical witnesses. A `hook_request_id` is an ephemeral
one-request callback capability. None is an agent or lifecycle namespace.

## Agent contract

registrationd owns the strict Zod contract. Unknown fields are refused. The
final immutable registration snapshot contains:

- schema version, `agent_id`, birth generation, and terminal registration time;
- engine and normalized launch metadata;
- attested pane ID, pane generation, machine, placement kind, wrapper PID,
  and transport witnesses;
- the configuration generation and digest used by both registrationd and txd;
- optional persona, rank, commander, tint, workspace, continuity references,
  and the instruction-package digest and sources;
- generation-bound resource receipts created for dispatched births.

Persona, rank, commander, tint, instruction sources, workspace, and continuity
references are one configuration-generation package. The claimed pane may
start provisional file reads, but txd's attested pane selects the complete
package. A digest mismatch between registrationd's allocation view and txd's
physical view refuses birth. Tint and pane options never confer persona
authority.

The contract is published from registrationd into Token-Fleet. Terminus-OS
keeps a strict semantic mirror for txd, lifecycled integration, and `tx`; both
repositories run a drift checker in coordinated CI. Deployed repositories do
not import each other's runtime code.

## Generic hook reply

The generic reply mechanism is proxy-held HTTP with a private control reply:

1. A hook caller that requires a reply marks the request with the generic
   one-shot reply mode and a configured deadline class. It does not mint the
   callback ID.
2. edge-proxy mints a collision-resistant `hook_request_id`, adds it as hook
   ingress metadata, forwards the hook to busd, and holds the original HTTP
   response.
3. Exactly one authorized service posts a strict reply envelope to the
   proxy-owned `/hooks/reply` control surface. The envelope carries the
   request ID, HTTP status, content type, and response body.
4. edge-proxy atomically consumes the pending entry and completes the exact
   waiting request. A second, late, unknown, malformed, or conflicting reply
   is refused.

The reply surface is available only on a private Unix control socket and also
requires a service credential delivered through machine configuration.
Ingress callers never receive that credential. The callback ID is random,
one-use, absent from logs except as a redacted correlation suffix, and never
persisted as identity or exposed as an addressing target.

Pending proxy requests are deliberately memory-only. A proxy stop closes every
waiting request with a transport failure; pending replies do not survive
restart. registrationd's birth stream remains durable and compensates or
resumes the incomplete generation, while the wrapper exits without spawning
an engine. A late reply after restart is refused as unknown.

Deadline classes are generated from the owning service's declared maximum
transaction ceiling plus the proxy transport margin. Callers select a named
class, never a numeric timeout. A missing reply ends the invocation with a
typed timeout response and causes the waiting wrapper or vendor hook to follow
its declared denial policy. There is no callback poll, database poll, sleep
loop, or secondary timeout.

Wrapper birth requires a successful JSON reply with `agent_id` and the
generation-bound launch package. Any non-2xx, malformed body, timeout,
disconnect, or denial exits before the engine process exists. Vendor adapters
translate the generic HTTP result into each engine's documented stdout, JSON,
and exit-status contract. Pre-tool denial is an ordinary typed hook reply; the
bus remains one-way.

## Birth transaction

The wrapper is the sole caller of raw Claude and Codex binaries:

1. It posts `hook.wrapper_start` through edge-proxy and waits for the generic
   reply.
2. busd journals the immutable hook. registrationd and txd consume it
   independently.
3. registrationd admits an idempotent durable birth stream and mints
   `agent_id`.
4. txd emits `agent.pane_attested` with observed pane, generation, placement,
   process ancestry, and configuration digest, or `agent.pane_refused`.
5. registrationd recomputes the full package from the attested pane, renders
   instruction resources, records `agent.registration_prepared`, and replies
   through the proxy control surface.
6. The wrapper exports `AGENT_ID`, removes all registration-only inputs, and
   starts the raw engine.
7. registrationd emits `agent.placement_declared`. txd verifies the current
   generation, binds the seat, applies and reads back tint, updates physical
   occupancy, and emits `agent.placement_attested` or
   `agent.placement_refused` — all at wrapper placement, before the engine
   takes a first turn.
8. lifecycled durably joins registration preparation and txd placement, then
   emits `agent.lifecycle_ready`.
9. registrationd verifies the same generation, commits the final row, and
   emits the sole authoritative `agent.registered` snapshot.

Prepared registration, a pane claim, a tint, or physical signoff alone never
makes an agent routable. Consumers activate only from `agent.registered`.

`hook.wrapper_stop`, literal engine stop hooks, pane death, transport loss,
replacement generations, and retirement use the same event discipline.
Pane death is observed at the moment it happens: process exits fire the
`pane-died`/`pane-exited` tmux hooks with the dying pane's own page, and kill
commands — which fire neither pane hook and whose hook context cannot name
the emptied page — forward a page-less `pane-killed` event that makes txd
sweep the estate. Either way txd retires exactly the faulted seat and repairs
its pane in place; a page rebuild happens only when no tagged pane survives
on the page. This holds for every pane kind, including future ssh-envelope
panes.
registrationd emits `agent.registration_compensated` or
`agent.registration_failed` for terminal birth failures; post-birth it never
initiates retirement. txd emits factual placement contradictions and, at every
`reg.retired` append (close, pane death, estate reset, topology migration),
publishes `agent.retired` — the reactive retirement fact consumers use to
terminalize the agent row. lifecycled emits generation-bound lifecycle stop
and retirement facts and owns the proactive retirement leg.

## Persistence

registrationd owns one PostgreSQL schema containing the birth event stream,
idempotency keys, pending hook correlations, agent rows, resource receipts,
compensation progress, and terminal outcomes. It records intent before every
resource effect and records the typed receipt afterward. Startup reconciliation
resumes unfinished generations from this stream.

txd and lifecycled write only their own PostgreSQL schemas and projections.
They never update registrationd tables. Every bus handler persists enough
idempotent domain state keyed by event sequence or stable generation before it
acknowledges delivery.

Dispatched births may add exact githubd worktree and session-document receipts.
Compensation is receipt-addressed and idempotent. Raw manual births remain the
minimal path and require no dispatch resources.

## Persona configuration and perpetual panes

Token-Fleet owns one canonical pane allocation source. Generated,
digest-bearing views provide txd only pane construction and tint projection
facts, and registrationd the complete optional persona package.

A perpetual persona is an ordinary pane whose configuration automatically
starts the same wrapper a human invokes. Custodes and Fabricator-General are
the equivalence proof. Their colors remain `#302800` and `#300808`.
Restart and reconstruction relaunch the wrapper and create a new generic birth
generation. txd contains no persona allocation or identity policy.

For k12-work placement, the canonical pane remains in the k12-personal
estate and its configured command is the LOCAL agent-wrapper. An ssh seat is
declared in `estate.ts` (`SSH_SEAT_TARGETS`) with a target machine named by
machines.json alias, never by address. txd composes the launch environment on
the pane: `PANE_ID`, `AGENT_ID` (minted by registrationd at dispatch and
stamped on `agent.dispatch_requested` — identity never rides the birth
reply), `TXD_LAUNCH_NONCE` (per-launch correlation, remembered against the
pane generation), and `TXD_SSH_TARGET`. The wrapper fires its birth one-shot
on the loopback proxy exactly as for local birth, verifies the remote
instruction package digest, then creates and attaches a one-pane
`tmux new-session -A` envelope on the target named from the seat and the
nonce; the engine lives in that envelope with `IMPERIUM_MACHINE` naming the
target machine.

The placement adapter attests the local wrapper through the unchanged `/proc`
ancestry walk and audits the remote half by correlation at Door 1: the seat
must be a declared ssh seat, the wrapper's transport claim must name the
seat's configured target, and the claimed nonce must match the launch
composition for the live pane generation (`placement_kind_incoherent`,
`placement_machine_incoherent`, `launch_nonce_contradicted` refusals).
Placement then attests `kind: 'ssh'` with the target as its machine and ssh
transport witnesses (wrapper pid and start ticks, target alias, nonce digest,
envelope session name). Remote start ticks are not comparable across kernels
and are not collected; the transport plus the envelope guard the remote half.
Tint stays local. Transport loss is reconnect-first — the wrapper holds the
pane and probes reattach by the envelope's nonce-bearing name at the ssh
keepalive contract's cadence; envelope death (session-ended evidence) and
pane kill retire the binding. An envelope alive after its binding retired is
a zombie: `tx estate zombies` inventories live envelopes on each declared
target and lists any without a live binding.

## CLI context

Every STC-generated CLI reads `AGENT_ID` into a typed `AgentContext` and adds
it to service requests when present. `version`, `config:validate`, and health
remain available without agent context. Agent-only operations call the common
required-context guard and refuse when `AGENT_ID` is absent. Caller-selected
`--agent-id` flags do not exist. `tx comm --self` resolves on the server from
the implicitly supplied caller agent.

## Events

The locked event vocabulary is:

- ingress: `hook.wrapper_start`, `hook.wrapper_stop`, and literal
  `hook.stop` and related vendor hooks;
- registrationd: `agent.registration_prepared`,
  `agent.placement_declared`, `agent.registration_compensated`,
  `agent.registration_failed`, and `agent.registered`;
- txd: `agent.pane_attested`, `agent.pane_refused`,
  `agent.placement_attested`, `agent.placement_refused`,
  `agent.placement_contradicted`, and `agent.retired`;
- lifecycled: `agent.lifecycle_ready`, `agent.lifecycle_stopped`,
  `agent.lifecycle_inactive`, and `agent.lifecycle_retired`.

Every event carries an immutable snapshot or generation-bound references
sufficient to prevent a cross-generation join.
