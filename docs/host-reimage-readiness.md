# Reimaged-host readiness: Terminus, Discord, and k12-daemon

**Status:** planning evidence only — no credential was read, created, copied, or
validated; no external bot was contacted; no service was enabled or started; no
deploy, merge, checkout, or `FLEET_FREEZE` change was performed.

This is the handoff checklist for the two reimaged hosts. It deliberately does
not make dogfood-nexus acceptance a pre-freeze activity: that work starts only
post-freeze on `k12-personal`, after bootstrap-capable tmux registration.

## Source-derived topology

| Surface | Intended host/runtime | Source contract | Consequence for reconstruction |
|---|---|---|---|
| Terminus-OS | source/contracts only | `README.md`; `packages/contracts/src/tmuxctld.ts` | Terminus-OS currently supplies typed Bun/Zod contracts. There is **no service unit or deployable Terminus runtime** in this checkout. Do not invent or enable one. |
| Discord daemon | Mac / local runtime checkout | `discord-daemon/daemon.js`; `cli-tools/bin/token-restart` | launchd label is `ai.tokenclaw.discord`; it exposes loopback `:7779`. It must run from a local checkout: config resolution rejects NAS paths. |
| tmuxctld | Mac / local runtime checkout | `cli-tools/bin/token-restart`; `tmuxctld/launchd/ai.tokenclaw.tmuxctld.plist` | launchd label is `ai.tokenclaw.tmuxctld`, loopback `:7778`; its availability is a prerequisite for Discord voice routing and post-freeze registration. |
| k12-daemon | `k12-personal` / user systemd | `k12_daemon/README.md`; `k12_daemon/systemd/k12-daemon.service` | Bun process on loopback `127.0.0.1:7781`, `tmux -L k12`, append-only SQLite store. `machine` is mandatory and fails closed if omitted. |
| edge_proxy | k12 user systemd | `edge_proxy/systemd/edge-proxy.service`; `edge_proxy/edge_proxy.config.example.json` | tailnet front door on `:7780`; `/k12` is the only documented ingress to k12-daemon, forwarded to `127.0.0.1:7781`. |
| Token-API/CD | host-specific runtime | `.github/workflows/README.md`; `cli-tools/bin/box-restart` | k12 CD normally updates an immutable detached runtime from a bare cache and restarts user units. This is post-freeze/delegated work only. |

## Pre-freeze work that is safe now

1. Preserve this checklist and the source revisions used to make it.
2. On each reimaged host, inventory only (no changes): OS/user identity,
   `systemctl --user` or launchd availability, Bun/Python availability, the
   expected local runtime path, and absence/presence of the required unit/plist.
3. Verify public, non-secret Git remote provenance and that a runtime path is
   local rather than NAS-backed. Do **not** clone, fetch, checkout, or alter a
   remote during the freeze.
4. Prepare a delegated, out-of-band credential inventory using *names and
   owners only*; never put credential material, IDs, or values in this document,
   Git, terminal transcripts, or chat.

## Credential handoff — Emperor-owned

All rows below require the Emperor's delegated gate. The operator must transfer
or provision each secret directly through the approved secret/key management
path, with the receiving service account present. Agents may record only
completion evidence (owner, target host, service name, timestamp, and a
non-secret health result).

| Consumer | Handoff item (name/category only) | Emperor hand | Completion evidence |
|---|---|---|---|
| Discord daemon (Mac) | Bot credentials referenced by `config.json` / configured keychain-service names | Provision the approved bot credentials to the service account's approved store. Do not use the source fallback file or paste values into `.env`; source shows `.env` is a convenience cache. | `launchctl print gui/<uid>/ai.tokenclaw.discord` is loaded and local `/status` says `connected: true`, after the activation gate. |
| Discord daemon (Mac) | Non-secret `config.json` containing allowed channel/bot topology and local Token-API port | Place only reviewed non-secret configuration in the **local** runtime checkout. Confirm canonical path is not `/Volumes/Imperium` or `/mnt/imperium`; daemon intentionally rejects those mounts. | Config-path safety check passes and daemon can parse it; no bot contact until activation gate. |
| k12-daemon (`k12-personal`) | `~/secrets/token-os/k12_daemon.json` | Create/import only through Emperor-approved secret handoff with mode `0600`; include the reviewed non-secret operational fields (loopback bind, port, machine identity, absolute SQLite path, tmux socket). | File metadata/ownership check performed by Emperor; daemon config parser accepts it after activation gate. Do not expose content. |
| edge_proxy (`k12-personal`) | `~/secrets/token-os/edge_proxy.json` | Create/import only through Emperor-approved secret handoff. It must preserve the reviewed `/k12` route/allowlist to `127.0.0.1:7781` and `/token-api` CD route. | File metadata/ownership and schema validation; no external route probe before gate. |
| Token-API/CD (each host) | Host CD restart bearer/environment plus CI-side deployment configuration | Provision by the documented host-specific owner path. For Mac plist changes, source requires bootout+bootstrap; k12 uses the user service environment. | A delegated post-freeze CD health proof matches the intended Git SHA. Not a pre-freeze task. |

## Git key and repository access — Emperor-owned

1. **Choose the service account per host.** Do not reuse a personal interactive
   key without a named owner and revocation plan.
2. **Emperor action:** provision a least-privilege GitHub deploy/machine key or
   approved host credential to that account using the approved secret path. Do
   not display private material or add it to a repository.
3. **Emperor action:** register the corresponding public key with the authorized
   GitHub scope, then establish host trust for `github.com` using the approved
   host-key verification procedure.
4. **Read-only acceptance:** verify the repository's configured origin is the
   canonical GitHub URL. Token-OS tooling explicitly requires
   `git@github.com:TokenAmby-Code/Token-OS.git` (or its accepted SSH/HTTPS
   equivalent) and rejects the old NAS bare source as dead/quarantined.
5. **Post-freeze, only under a deployment gate:** create/repair the host's bare
   cache and detached runtime through the declared reconstruction path. The
   k12 executor's declared shape is bare-cache fetch → clean detached runtime →
   frozen dependency refresh → ordered service restart. Do not substitute a
   mutable checkout or a NAS-mounted live runtime.

## Service-enable and activation sequence — gated, not executed

### Mac: tmuxctld, Token-API, then Discord

1. **Emperor hand:** install reviewed launchd plists in
   `~/Library/LaunchAgents/` for `ai.tokenclaw.tmuxctld`, Token-API, and
   `ai.tokenclaw.discord`, all pointing at the local runtime. Confirm ownership,
   paths, and non-secret environment references.
2. **Delegated activation after freeze:** bootstrap/rebootstrap launchd plists
   where plist content changed. A plist change is not satisfied by `kickstart`;
   source requires `bootout` then `bootstrap`.
3. **Delegated activation after tmux bootstrap registration:** use the
   authoritative `token-restart` path for tmuxctld/Discord. Do not use the old
   pidfile/nohup manager; it can split-brain the Discord port.
4. **Acceptance:** tmuxctld loopback health on `:7778`; then Discord local
   `/status` on `:7779` reports `connected: true`. Only then may the next
   dogfood phase be considered.

### k12-personal: edge_proxy before k12-daemon

1. **Emperor hand:** install the reviewed user unit files from the local runtime
   into `~/.config/systemd/user/`; confirm `K12_DAEMON_CONFIG`,
   `EDGE_PROXY_CONFIG`, and `IMPERIUM_MACHINE=k12-personal` reference the
   approved locations.
2. **Emperor hand:** ensure user-service reboot survival with
   `loginctl enable-linger "$USER"` for the intended service account.
3. **Delegated activation after freeze:** `systemctl --user daemon-reload`,
   enable the edge-proxy and k12-daemon units, then start edge_proxy **before**
   k12-daemon. Do not use `enable --now` during reconstruction because enable
   and activation are separate gates.
4. **Acceptance:** edge_proxy serves only its declared routes; k12-daemon
   `/health` is reachable through `/k12/health` and reports the expected machine
   identity/build. A direct tailnet bind for k12-daemon is a failure of the
   ingress contract.

## Readiness blockers

1. **Terminus is not yet deployable.** This repository has contracts only; it
   has no service definition or host install contract. A service-enable plan for
   Terminus would be fabricated until its runtime is authored and reviewed.
2. **No credential inventory was inspected.** The required credential owner,
   approved handoff mechanism, and per-host service accounts must be named by
   the Emperor before activation.
3. **tmux registration is a hard dependency.** Dogfood is post-freeze only and
   cannot begin before bootstrap-capable tmux registration on `k12-personal`.
4. **Runtime provenance remains unverified on the reimaged hosts.** The live
   runtime must be local, clean, and detached from a canonical bare cache; the
   reconstruction must not repurpose NAS state.
5. **No service state was inspected or altered.** Unit/plist presence, user
   linger state, local ports, and health are intentionally unknown until the
   delegated post-freeze activation window.

## Evidence index

- Terminus scope: `README.md`, `packages/contracts/src/tmuxctld.ts`.
- k12 daemon config and ingress: `k12_daemon/README.md`,
  `k12_daemon/src/config.ts`, `k12_daemon/systemd/k12-daemon.service`.
- edge proxy routes: `edge_proxy/edge_proxy.config.example.json`,
  `edge_proxy/systemd/edge-proxy.service`.
- Discord local-only config and launchd ownership: `discord-daemon/discord-client.ts`,
  `cli-tools/bin/discord-daemon`, `cli-tools/bin/token-restart`.
- canonical Git origin and k12 deployment shape: `cli-tools/lib/git-remote.sh`,
  `cli-tools/bin/worktree-setup`, `cli-tools/bin/box-restart`,
  `.github/workflows/README.md`.
