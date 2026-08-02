import { expect, test } from "bun:test";

// Amended under the 2026-08-02 dead-lane ruling (Custodes, ledgered busd
// backoff defect): the dispatcher owns two deadline mechanisms — the per-await
// delivery bound and the blocked-lane retry deadline — both derived from the
// one configured transport contract. Everything the original ruling killed
// stays dead: no polling intervals, no cooldown sleeps inside a drain, no
// volatile backoff knobs, and no timer anywhere else in busd.
test("adversarial: durable delivery never regains polling, cooldown sleeps, or volatile retry knobs", async () => {
  const [dispatcher = "", ...others] = await Promise.all(
    ["dispatcher.ts", "replay-store.ts", "store.ts", "daemon.ts", "server.ts"].map((name) =>
      Bun.file(new URL(`../src/${name}`, import.meta.url)).text()),
  );
  for (const forbidden of [
    "setInterval(",
    "Bun.sleep(",
    "backoffBaseMs",
    "backoffCapMs",
    "repairIntervalMs",
  ]) {
    expect([dispatcher, ...others].join("\n")).not.toContain(forbidden);
  }
  // Timers outside the dispatcher stay dead entirely.
  expect(others.join("\n")).not.toContain("setTimeout(");
  // Inside the dispatcher a timer exists only as the two owned deadline
  // mechanisms; a third use is a new defect, not an allowance.
  const timerSites = dispatcher.split("setTimeout(").length - 1;
  expect(timerSites).toBe(2);
  expect(dispatcher).toContain("LaneStallError");
  expect(dispatcher).toContain("armRetry");
});
