import { expect, test } from "bun:test";


const unit = await Bun.file(new URL("../systemd/telemetryd.service", import.meta.url)).text();

test("telemetryd stays loopback-only behind the Fleet edge", () => {
  expect(unit).toContain("Environment=TELEMETRYD_BIND=127.0.0.1");
  expect(unit).toContain("Environment=TELEMETRYD_PORT=7784");
});

// Without these two lines the daemon's readiness datagram is written into a
// void: systemd never waits for it, so `systemctl restart` returns on fork and
// every caller that reads that return as readiness is wrong.
test("telemetryd's start job completes on the daemon's own readiness edge", () => {
  expect(unit).toMatch(/^Type=notify$/m);
  expect(unit).toMatch(/^NotifyAccess=main$/m);
});

test("telemetryd runs from the deploy-owned Terminus runtime with Fleet Bun", () => {
  expect(unit).toContain("WorkingDirectory=%h/runtimes/Terminus-OS/live/packages/telemetryd");
  expect(unit).toContain("ExecStart=%h/.bun/bin/bun src/daemon.ts");
  expect(unit).toContain("Restart=on-failure");
});
