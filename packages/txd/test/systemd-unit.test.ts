// systemd/txd.service pins — behavioral-pin lane for the deployed unit.
//
// The unit file is deploy-critical config shipped verbatim by the Token-Fleet
// apply leg; a wrong line is a box outage, not a style nit. Each ruled
// directive is pinned byte-exactly:
//
// - WorkingDirectory: the k12 box layout is
//   ~/runtimes/Terminus-OS/{live,battlefield,config,Terminus-OS.git} — the
//   checkout lives under `live/`. The extraction PR shipped the path without
//   `live/`, producing a status=200/CHDIR crashloop (2026-07-20 §5 acceptance
//   FAIL, Defect A).
// - ConditionPathExists on TXD_CONFIG's path: a missing config must skip the
//   unit cleanly with a visible condition-failed status, not crashloop every
//   RestartSec (Defect B). The guard path must match the TXD_CONFIG env line.
// - KillMode=process / Restart / ExecStart: ruled in the extraction spec —
//   restarts must never SIGTERM the daemon-spawned tmux estate.
// - No PrivateTmp: documented pin (txd-extraction-spec §3.3) — tmux children
//   and test fixtures deliberately share the real /tmp namespace.

import { describe, expect, test } from 'bun:test';

const unitPath = new URL('../systemd/txd.service', import.meta.url).pathname;
const unit = await Bun.file(unitPath).text();
const lines = unit.split('\n');

function pin(exact: string): void {
  expect(lines).toContain(exact);
}

describe('systemd/txd.service pins', () => {
  test('WorkingDirectory targets the live/ checkout on the box', () => {
    pin('WorkingDirectory=%h/runtimes/Terminus-OS/live/packages/txd');
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
});
