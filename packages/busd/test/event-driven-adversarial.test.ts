import { expect, test } from "bun:test";

test("adversarial: durable delivery never regains polling, cooldown sleeps, or volatile retry backoff", async () => {
  const sources = await Promise.all(
    ["dispatcher.ts", "replay-store.ts", "store.ts", "daemon.ts", "server.ts"].map((name) =>
      Bun.file(new URL(`../src/${name}`, import.meta.url)).text()),
  );
  for (const forbidden of [
    "setInterval(",
    "setTimeout(",
    "Bun.sleep(",
    "backoffBaseMs",
    "backoffCapMs",
    "repairIntervalMs",
  ]) {
    expect(sources.join("\n")).not.toContain(forbidden);
  }
});
