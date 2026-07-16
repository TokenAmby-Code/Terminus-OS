# Terminus-OS

The typed-contracts lifecycle-manager that begins the supplanting of the Token-OS Python
monolith. Contracts are authored here as TypeScript + [Zod](https://zod.dev) types; Token-OS
validates against them at its boundary. New surfaces are built nexus-side. No Python is ported.

> Naming: this repo is **Terminus-OS**. Its packages are namespaced **`@terminus-os/*`** — never
> `@token-os/*`. The deprecated Python monolith keeps its name; nothing new here carries a
> relative name to it.

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
      index.ts
    test/
```

The foundation is registration / bind / ledger. The `tmuxctld` op envelopes
(`/freelist`, `/close-pane`) are **consumers** of those types — a freed pane references a
registered seat; the fault that takes down a freelist scan is a ledger occupancy state. The
ops-cockpit read-model converges into this foundation later; the seams are designed for that
convergence but it is not built here yet.

## Develop

```bash
bun install
bun run typecheck   # tsc --noEmit, strict
bun test
```

Discipline: **red-first**. Contract tests are written against live specimen data (including its
inconsistencies) before the schema exists, and must fail first. This is the TS/bun lane where
that discipline actually applies.
