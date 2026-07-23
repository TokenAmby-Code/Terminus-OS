// systemd/busd.service pins — behavioral-pin lane for the deployed unit.
//
// The unit file is deploy-critical config shipped verbatim by the Token-Fleet
// apply-busd leg; a wrong line is a box outage, not a style nit. Each ruled
// directive is pinned byte-exactly (txd's systemd-unit.test.ts precedent):
//
// - WorkingDirectory: the k12 box layout keeps the checkout under `live/`
//   (txd Defect A: shipping the path without live/ produced a CHDIR crashloop).
// - Postgres socket wait: user units cannot order After= the SYSTEM
//   postgresql.service, so ExecStartPre polls the peer-auth socket, bounded by
//   TimeoutStartSec — then Restart=on-failure owns recovery (no fallback code).
// - Loopback bind: busd sits behind the edge proxy; it must never bind wide.

import { describe, expect, test } from 'bun:test';

const unitPath = new URL('../systemd/busd.service', import.meta.url).pathname;
const unit = await Bun.file(unitPath).text();
const lines = unit.split('\n');

function pin(exact: string): void {
  expect(lines).toContain(exact);
}

describe('systemd/busd.service pins', () => {
  test('WorkingDirectory targets the live/ checkout on the box', () => {
    pin('WorkingDirectory=%h/runtimes/Terminus-OS/live/packages/busd');
  });

  test('ExecStart runs the daemon via the pinned fleet bun', () => {
    pin('ExecStart=%h/.bun/bin/bun src/daemon.ts');
  });

  test('loopback-only behind the edge proxy', () => {
    pin('Environment=BUSD_BIND=127.0.0.1');
  });

  test('waits for the postgres peer-auth socket, bounded — user units cannot After= system postgres', () => {
    pin("ExecStartPre=/bin/sh -c 'until test -S /var/run/postgresql/.s.PGSQL.5432; do sleep 2; done'");
    pin('TimeoutStartSec=180');
  });

  test('fail-loud restart policy — no fallback path exists, recovery is the restart', () => {
    pin('Restart=on-failure');
    pin('RestartSec=2');
    pin('NoNewPrivileges=true');
  });

  test('user-unit install target and box identity', () => {
    pin('WantedBy=default.target');
    pin('Environment=IMPERIUM_MACHINE=k12-personal');
  });
});
