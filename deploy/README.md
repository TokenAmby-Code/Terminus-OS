# Terminus-OS Discord tenant — k12-personal deploy surface

The Discord tenant is a `systemctl --user` service on k12-personal (matching the fleet's service
convention — cf. Token-Fleet edge-proxy). Terminus-OS owns the executable tenant and its typed
contracts; Token-Fleet owns applying the unit and provisioning the host credential file. This
directory is the boundary between them.

## Contents

| Path | Owner | Purpose |
|------|-------|---------|
| `systemd/terminus-discord.service` | Terminus-OS (authoritative unit) | The service definition Token-Fleet installs on k12-personal. |
| `env/terminus-discord.env.example` | Terminus-OS | The host credential CONTRACT — the exact variable names the tenant requires. Names only, never values. |

## The credential contract

Credentials are env-only. Token-Fleet writes the real environment file to
`~/secrets/token-os/discord.env` (user-owned, `0600`) from its secret store; the user unit loads
it via `EnvironmentFile=`. The complete required set is `env/terminus-discord.env.example`. The
loader (`packages/discord/src/config.ts`) is fail-loud and aggregate — a mis-provisioned host
names every gap in one pass and refuses to start.

## What this end-state replaces

The k12 tenant is built as the end-state, not a port of the fragile Mac daemon. Each assumption
the old daemon carried is designed out:

- **launchd → `systemctl --user`.** Linux user-service management; ordering is
  `network-online.target`, not a NAS mount and not Token-API.
- **macOS Keychain → `EnvironmentFile`.** No Keychain reads; secrets arrive as environment.
- **Mac paths → local Linux checkout.** `WorkingDirectory` is `%h/runtimes/Terminus-OS/live`;
  the hot path never traverses the NAS/SMB mount (recon §6).
- **`say` → OpenAI voice, env-keyed.** No macOS TTS binary; the voice credential is
  `TERMINUS_DISCORD_VOICE_OPENAI_API_KEY`, replacing the old daemon's inline OpenAI secret.
- **Token-API / tmuxctld coupling → none.** The tenant is standalone; routing is Discord-native
  (the notification router), not a tmux pane-paste transport.
- **Name-based Inquisition self-test → none.** Behaviour is capability-driven, not name-driven.

## Applying (Token-Fleet)

Token-Fleet's k12-personal apply chain installs the unit and enables it. The apply-side helper
and the `machines/k12-personal/apply.sh` entry live in the Token-Fleet repo; the unit and the
credential contract above are its inputs.

## Current bring-up state (remove when closed)

- The **discord.js gateway adapter** (`packages/discord/src/gateway.ts`) is the one transport
  seam deferred to the consolidation wave. Until it is installed, `main.ts` resolves config,
  plans the tenant, and then fails loud with `GatewayAdapterMissing`. The unit is therefore
  installable and its config path is provable, but it cannot reach `active (running)` until the
  adapter and valid credentials are in place.
- **Unit validation** is static here (this authoring host is darwin, not the k12 Linux target):
  run `systemd-analyze --user verify systemd/terminus-discord.service` on k12 before enable.
