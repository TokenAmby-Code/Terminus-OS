import { expect, test } from "bun:test";


const unit = await Bun.file(new URL("../systemd/telemetryd.service", import.meta.url)).text();

test("telemetryd stays loopback-only behind the Fleet edge", () => {
  expect(unit).toContain("Environment=TELEMETRYD_BIND=127.0.0.1");
  expect(unit).toContain("Environment=TELEMETRYD_PORT=7784");
});

test("telemetryd runs from the deploy-owned Terminus runtime with Fleet Bun", () => {
  expect(unit).toContain("WorkingDirectory=%h/runtimes/Terminus-OS/live/packages/telemetryd");
  expect(unit).toContain("ExecStart=%h/.bun/bin/bun src/daemon.ts");
  expect(unit).toContain("Restart=on-failure");
});
