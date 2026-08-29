// systemd/txd.service pins — behavioral-pin lane for the deployed unit.
//
// The unit file is deploy-critical config shipped verbatim by the Token-Fleet
// apply leg; a wrong line is a box outage, not a style nit. Each ruled
// directive is pinned byte-exactly:
//
// - WorkingDirectory is absent: the apply leg owns the realized generation
//   root through its generation.conf drop-in.
// - ConditionPathExists on TXD_CONFIG's path: a missing config must skip the
//   unit cleanly with a visible condition-failed status, not crashloop every
//   RestartSec (Defect B). The guard path must match the TXD_CONFIG env line.
// - tx-estate.service supervises the foreground server outside txd's
//   NoNewPrivileges sandbox. A lost server deactivates txd; the recovered
//   owner activation starts txd so its boot constructor rebuilds from event
//   truth, without periodically reasserting an unchanged deterministic fault.
// - No PrivateTmp: documented pin (txd-extraction-spec §3.3) — tmux children
//   and test fixtures deliberately share the real /tmp namespace.

import { describe, expect, test } from 'bun:test';

const unitPath = new URL('../systemd/txd.service', import.meta.url).pathname;
const unit = await Bun.file(unitPath).text();
const lines = unit.split('\n');
const tmuxUnitPath = new URL('../systemd/tx-estate.service', import.meta.url).pathname;
const tmuxUnit = await Bun.file(tmuxUnitPath).text();
const tmuxLines = tmuxUnit.split('\n');
const tmuxSource = await Bun.file(new URL('../src/tmux.ts', import.meta.url)).text();

function pin(exact: string): void {
  expect(lines).toContain(exact);
}

describe('systemd/txd.service pins', () => {
  test('WorkingDirectory belongs to the apply-leg drop-in', () => {
    expect(lines.filter((line) => line.startsWith('WorkingDirectory='))).toEqual([]);
  });

  // Without these two lines the daemon's readiness datagram is written into a
  // void: systemd never waits for it, so `systemctl restart` returns at fork and
  // every caller reading that return as readiness is wrong.
  test('the start job completes on the daemon\'s own serving edge', () => {
    expect(lines.filter((line) => line.startsWith('Type='))).toEqual(['Type=notify']);
    pin('NotifyAccess=main');
  });

  test('missing config skips the unit via ConditionPathExists — no crashloop', () => {
    pin('ConditionPathExists=%h/secrets/txd/txd.json');
  });

  test('ConditionPathExists guards the exact TXD_CONFIG path', () => {
    pin('Environment=TXD_CONFIG=%h/secrets/txd/txd.json');
    const condition = lines.find((l) => l.startsWith('ConditionPathExists='));
    const env = lines.find((l) => l.startsWith('Environment=TXD_CONFIG='));
    expect(condition?.slice('ConditionPathExists='.length)).toBe(
      env?.slice('Environment=TXD_CONFIG='.length),
    );
  });

  test('estate-preserving process teardown and restart policy', () => {
    pin('KillMode=process');
    pin('Restart=on-failure');
    pin('RestartSec=2');
  });

  // A deterministic startup failure must fail loud once. The default limit
  // (5 starts / 10s) never trips against a ~2.3s crash cycle, which is how the
  // 2026-07-26/27 estate-recovery defect crashlooped 8832 times unbounded.
  test('a deterministic startup failure lands in failed instead of crashlooping', () => {
    pin('StartLimitIntervalSec=60');
    pin('StartLimitBurst=5');
    const startLimit = lines.findIndex((l) => l.startsWith('StartLimitIntervalSec='));
    const service = lines.findIndex((l) => l === '[Service]');
    expect(startLimit).toBeGreaterThan(lines.indexOf('[Unit]'));
    expect(startLimit).toBeLessThan(service);
  });

  test('sandboxed txd is lifecycle-bound to the unsandboxed tmux server owner', () => {
    pin('BindsTo=tx-estate.service');
    pin('After=network-online.target tx-estate.service');
    pin('NoNewPrivileges=true');
  });

  test('ExecStart runs the daemon via the pinned fleet bun', () => {
    pin('ExecStart=%h/.bun/bin/bun src/daemon.ts');
  });

  test('no PrivateTmp — the daemon shares the real /tmp namespace', () => {
    expect(unit).not.toMatch(/^PrivateTmp=/m);
  });

  test('user-unit install target and box identity', () => {
    pin('WantedBy=default.target');
    pin('Environment=IMPERIUM_MACHINE=k12-personal');
  });

  test('rotation lock path is the fleet attach lifecycle boundary', () => {
    pin('Environment=TXD_ROTATION_LOCK_FILE=%h/.local/state/txd/estate-rotation.lock');
    pin('Environment=TXD_ROTATION_SIGNAL_FIFO=%h/.local/state/txd/estate-rotation.signal');
  });

  test('the generic agent wrapper resolves through the converged Fleet location', () => {
    pin('Environment=TXD_AGENT_WRAPPER=%h/runtimes/Token-Fleet/live/shared/bin/agent-wrapper');
  });

  test('clipboard origin identity resolves through generated fleet machine configuration', () => {
    pin('Environment=TXD_MACHINE_REGISTRY=%h/runtimes/Token-Fleet/live/shared/generated/registry.json');
    pin('Environment=TOKEN_FLEET_MACHINE_CONFIG_ROOT=%h/runtimes/Token-Fleet/live/machines');
    pin('AssertPathExists=%h/runtimes/Token-Fleet/live/shared/generated/registry.json');
    pin('ExecStartPre=/usr/bin/test -r %h/runtimes/Token-Fleet/live/shared/generated/registry.json');
  });

  test('timezone config is unit-owned without an EnvironmentFile dependency', () => {
    expect(unit).not.toMatch(/^EnvironmentFile=.*timezone/m);
  });
});

describe('systemd/tx-estate.service boundary', () => {
  test('systemd supervises the real foreground tmux server outside the txd sandbox', () => {
    expect(tmuxLines).toContain('NoNewPrivileges=false');
    expect(tmuxLines).toContain('Environment=TXD_TMUX_SOCKET=k12');
    expect(tmuxLines).toContain('Type=simple');
    expect(tmuxLines).toContain('ExecStart=/usr/bin/tmux -D -L ${TXD_TMUX_SOCKET} -f %h/.local/lib/terminus-os/txd/packages/txd/tmux/tx.conf');
    expect(tmuxLines).toContain('ExecStop=/usr/bin/tmux -L ${TXD_TMUX_SOCKET} kill-server');
    expect(tmuxLines).toContain('Restart=always');
    expect(tmuxLines).toContain('RestartSec=2');
    expect(tmuxLines).toContain('Wants=txd.service');
    expect(tmuxLines).not.toContain('Upholds=txd.service');
    expect(tmuxLines).not.toContain('RemainAfterExit=yes');
  });

  test('txd never starts a missing tmux server inside its own sandbox', () => {
    expect(tmuxSource).not.toContain("await run(this.socket, ['start-server'])");
    expect(tmuxSource).toContain('tmux server is not externally owned');
  });
});
