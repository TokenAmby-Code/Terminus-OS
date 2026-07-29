# Agent birth, persona tint, and lifecycle ownership

Status: ruled for implementation after the static tint trial.

## Persona tint contract

Visible pane tint has exactly one meaning: txd has a current, physically
attested persona binding for that pane generation. An untinted pane is unbound
or its binding failed. Tint is not decoration and has no independent identity
source.

The binding tuple is indivisible:

`instance + persona + rank + commander + tint + pane generation`

One `reg.bound` fact carries the logical tuple. Projections take every field
from that event generation; they never join current persona, rank, commander,
or tint from separately updated rows.

txd owns the physical projection. It applies the declared tint with tmux's
pane-local `select-pane -P bg=<color>` mechanism, reads back both
`window-style` and `window-active-style`, and only then commits `reg.bound`.
Before styling it records `reg.binding_prepared` with the complete tuple and
pane generation. `reg.bound` or `reg.binding_aborted` closes that intent; boot
clears an unclosed preparation only when the same pane generation still exists.
Failure to apply or read back the exact value is compensated to `default`;
the instance remains unbound. A failed event append is also compensated
fail-dark. Clear, retirement, and page reconstruction replace the pane process
and restore both styles to `default` before the logical binding is cleared.

Reconcile treats a missing, changed, unreadable, or manually applied tint as a
binding contradiction. Health is false until the contradiction is resolved
through the same typed lifecycle path as a dead or replaced bound pane.
`tx health` and `tx estate show` expose expected and observed tint readiness.
There is no public tint mutation command.

A durable scoped-reset request fences every named seat from launch, static
acknowledgement, and comm until completion. The request captures each current
binding's event sequence and pane
generation; restart recovery may retire only those exact generations and fails
loud if newer binding truth appears.

The Council trial values are:

| Persona | Seat | Tint |
|---|---|---|
| Custodes | `council:custodes` | `#302800` |
| Fabricator-General | `council:fabricator-general` | `#300808` |

Pax and Orchestrator stay untinted while unbound. Worker birth later supplies
its tint through the same binding declaration; txd gains no worker-specific
color map or persona branch.

Static wrapper acknowledgement also carries the wrapper-resolved raw engine
executable. txd verifies its exact `/proc/<pid>/exe`, process name, parent PID,
seat, and authenticated launch generation; a name-compatible rogue child is
not an engine attestation.

## Birth authority ruling

Adopt **`registrationd` + `rg`**.

`registrationd` is the durable, event-sourced owner of the agent-birth
transaction. It admits a dispatch request, allocates the instance ID, records
the complete persona/rank/commander/tint declaration, coordinates initial
worktree and session-document creation, reserves and attests the txd seat, and
records birth completion. `rg` is a thin endpoint client. Deleting or
restarting `rg` loses no truth.

This is not a forwarding daemon. Its durable value is the birth state machine,
idempotency, replay, and compensation ledger. A restart resumes the same birth
generation from authoritative events.

The options are ruled as follows:

| Option | Ruling | Reason |
|---|---|---|
| `registrationd` + `rg` | selected | Birth has a distinct durable transaction, idempotency, and compensation boundary. |
| Transaction-only `rg` | rejected | Crash recovery would require the CLI to own a hidden database/replay engine or leave a half-born identity across services. |
| `lifedeathd` (`ldd`/`ld`) | rejected | Birth admission/resource creation and post-birth retirement/teardown do not share one invariant or recovery state machine; naming symmetry is not ownership. |
| Registration inside lcd | rejected | Birth coordination would dominate lcd and blur its post-birth health and lifecycle responsibility. |

## Ownership table

“Transaction owner” means the sole writer of the authoritative transition.
Resource authorities remain the only services permitted to mutate their own
physical resources.

| Fact or resource | Sole truth/transaction owner | Physical/resource authority |
|---|---|---|
| Instance identity and birth generation | registrationd | registrationd |
| Dispatch request and admission | registrationd | dispatcher submits; registrationd records/adjudicates |
| Persona, rank, and commander binding | registrationd after the trial cutover | txd attests the pane projection |
| Tint value | registrationd binding declaration | txd applies, clears, and verifies tmux style |
| Initial worktree reference and birth step | registrationd | githubd creates/cleans the worktree |
| Initial session-document reference and birth step | registrationd | session-document authority creates/abandons the document |
| Tmux seat, geometry, process construction, transport | txd | txd |
| Post-birth health/readiness policy | lcd | lcd consumes registrationd and txd attestations |
| Routing readiness, activation, and closure | lcd | delivery resolves only through lcd's current projection |
| Retirement | lcd | registrationd identity becomes terminal from lcd's typed transition |
| Teardown transaction | lcd | txd reaps/reconstructs the physical pane |

No other service writes a mirror of these facts. In particular, txd's current
Door-1 `reg.bound` stream is the static-trial authority only. The registrationd
cutover must move binding truth in one release; it must not add a dual write or
background synchronizer.

## Birth transaction and compensation

The registrationd birth stream records each intent before invoking a resource
authority and records the returned typed receipt before moving to the next
step. Replaying a duplicate request returns the established generation or
continues its incomplete transaction.

1. Admit dispatch and reserve one instance ID and complete binding declaration.
2. Ask githubd for the initial branch-bound worktree; record its receipt.
3. Ask the session-document authority for the initial document; record its receipt.
4. Ask txd to construct/reserve the seat and start the sanctioned wrapper.
5. Receive wrapper/engine, placement, pane-generation, and tint attestations.
6. Commit birth and hand the attested generation to lcd.
7. lcd records routing activation and thereafter owns routing closure with the
   same post-birth lifecycle generation.

If worktree creation fails, no document or instance is activated. If document
creation fails after worktree creation, registrationd asks githubd to clean
the exact uncommitted worktree receipt and records the compensation. If txd
construction, wrapper start, or attestation fails, registrationd asks txd to
reap/reset the reserved generation, asks the document authority to abandon the
unactivated document, cleans the exact worktree receipt, and records terminal
birth failure. Compensation is idempotent and receipt-addressed. It never
guesses paths, deletes a shared document, or manufactures a binding.

There is no cross-service database transaction. The registrationd event stream
is the durable saga authority; resource services remain single writers for
their resources and expose idempotent typed operations. A prepared physical
tint is never routing authority. On restart, registrationd either completes
the matching binding generation or asks txd to clear it.

Registrationd never writes routing state. Before birth completion there is no
route to compensate; after handoff, lcd is its sole writer. Delivery clients
consume lcd's projection and cannot infer activation from a prepared tint,
txd seat, or registrationd birth step.

## Delivery sequence

Fleet wrappers, persona workspaces, CLI availability, trust configuration, and
hooks land and converge before a new registrationd/Terminus birth transition
is activated. Tests use disposable tmux/process fixtures and red-first
behavioral pins. They never mutate the live estate.

The registrationd implementation must pin restart during every birth step,
duplicate replay, stale generation, forged handshake, worktree/document
compensation, and route closure until all attestations are current. Recovery is
event-driven. Polling loops, retry-forever behavior, compatibility aliases,
manual tmux injection, and alternate communication paths are forbidden.
