// systemd/busd.service pins — behavioral-pin lane for the deployed unit.
//
// The unit file is deploy-critical config shipped verbatim by the Token-Fleet
// apply-busd leg; a wrong line is a box outage, not a style nit. Each ruled
// directive is pinned byte-exactly (txd's systemd-unit.test.ts precedent):
//
// - WorkingDirectory: the k12 box layout keeps the checkout under `live/`
//   (txd Defect A: shipping the path without live/ produced a CHDIR crashloop).
// - Postgres socket wait: user units cannot order After= the SYSTEM
//   postgresql.service, so a path unit consumes the peer-socket appearance
//   event. No poll loop or magic startup timeout is permitted.
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

  test('loads machine-owned durable subscriptions', () => {
    pin('Environment=BUSD_CONFIG=%h/.config/token-fleet/busd.json');
  });

  test('loads the signed GitHub ingress secret from systemd encrypted credentials', () => {
    pin('Environment=BUSD_GITHUB_WEBHOOK_SECRET_FILE=%d/busd.github-webhook');
    pin('LoadCredentialEncrypted=busd.github-webhook:%E/credstore.encrypted/busd.github-webhook');
  });

  test('contains no PostgreSQL polling or magic startup timeout', () => {
    expect(unit).not.toContain("ExecStartPre=");
    expect(unit).not.toContain("TimeoutStartSec=");
    expect(unit).not.toContain("RestartSec=");
  });

  test("PostgreSQL readiness is a path event rather than a poll", async () => {
    const pathUnit = await Bun.file(
      new URL("../systemd/busd-postgres.path", import.meta.url),
    ).text();
    expect(pathUnit).toContain("PathExists=/var/run/postgresql/.s.PGSQL.5432");
    expect(pathUnit).toContain("Unit=busd.service");
    expect(pathUnit).toContain("WantedBy=default.target");
    expect(pathUnit).not.toMatch(/\bsleep\b|\buntil\b|OnUnitActiveSec/);
  });

  test('fail-loud restart policy — no fallback path exists, recovery is the restart', () => {
    pin('Restart=on-failure');
    pin('NoNewPrivileges=true');
  });

  test('box identity is explicit and service activation belongs to the path unit', () => {
    expect(unit).not.toContain("WantedBy=");
    pin('Environment=IMPERIUM_MACHINE=k12-personal');
  });
});
