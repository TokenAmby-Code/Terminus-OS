# Terminus-OS

The typed-contracts lifecycle manager for Terminus services. Contracts are
authored here as TypeScript + [Zod](https://zod.dev) types and consumed over
language-neutral service boundaries.

> Naming: this repo is **Terminus-OS**. Its packages are namespaced **`@terminus-os/*`**.

## Layout

```
packages/
  contracts/          @terminus-os/contracts
    src/
      registration.ts   instance registration row  (foundation)
      bind.ts           bind lifecycle state machine (foundation)
      ledger.ts         wrapper-ledger seat occupancy (foundation)
      envelope.ts       generic ok/error loopback envelope
      tmuxctld.ts        tmuxctld op contracts — CONSUME the foundation types
      ephemeral.ts       temporary ephemeral-channel capability policy
      index.ts
    test/
  telemetryd/          typed desktop-fact ingress; PostgreSQL NOTIFY feeds enforcement consumers
    src/
    systemd/
    test/
  busd/                central event bus: append-only journal + subscription HTTP fan-out (transactional outbox)
    src/
    systemd/
    test/
```

The foundation is registration / bind / ledger. The `tmuxctld` op envelopes
(`/freelist`, `/close-pane`) are **consumers** of those types — a freed pane references a
registered seat; the fault that takes down a freelist scan is a ledger occupancy state. The
ops-cockpit read-model converges into this foundation later; the seams are designed for that
convergence but it is not built here yet.

## Ephemeral channel

`@terminus-os/contracts` is the authority for ephemeral-channel availability. The current
contract is **`temporarily_disabled`**: every attempted send must return the exported exact
fail-loud error envelope, with automatic reprompt and retry both disabled. This repository does
not yet contain a daemon endpoint or other runtime enforcement path; the contract deliberately
adds none.

Revival requires replacing the temporary contract state **and** implementing the parked
canonical instance-ID resolution fix in the delivery path. The temporary state is not a
permanent prohibition and must not be bypassed with a compatibility shim, silent no-op, prompt
hook, or retry worker.

## Develop

```bash
bun install
bun run typecheck   # tsc --noEmit, strict
bun test
```

Discipline: **red-first**. Contract tests are written against live specimen data (including its
inconsistencies) before the schema exists, and must fail first. This is the TS/bun lane where
that discipline actually applies.
