import { expect, test } from "bun:test";


const unit = await Bun.file(new URL("../systemd/telemetryd.service", import.meta.url)).text();

test("telemetryd stays loopback-only behind the Fleet edge", () => {
  expect(unit).toContain("Environment=TELEMETRYD_BIND=127.0.0.1");
  expect(unit).toContain("Environment=TELEMETRYD_PORT=7784");
  expect(unit).toContain("Environment=TOKEN_FLEET_MACHINE_CONFIG_ROOT=%h/runtimes/Token-Fleet/live/machines");
  expect(unit).not.toMatch(/^EnvironmentFile=.*timezone/m);
});

// Without these two lines the daemon's readiness datagram is written into a
// void: systemd never waits for it, so `systemctl restart` returns on fork and
// every caller that reads that return as readiness is wrong.
test("telemetryd's start job completes on the daemon's own readiness edge", () => {
  expect(unit).toMatch(/^Type=notify$/m);
  expect(unit).toMatch(/^NotifyAccess=all$/m);
});

// The daemon executes from the installed generation apply-telemetryd realizes,
// never from the checkout githubd synchronizes: a dependency install there
// first destroys every node_modules under it, and a daemon running out of that
// tree is one refused realization step away from a stripped runtime.
test("telemetryd runs from its installed generation with Fleet Bun", () => {
  expect(unit).not.toMatch(/^WorkingDirectory=/m);
  expect(unit).toContain("ExecStart=%h/.bun/bin/bun src/daemon.ts");
  expect(unit).toContain("Restart=on-failure");
});
