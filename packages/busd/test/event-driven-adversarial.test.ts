import { expect, test } from "bun:test";

test("adversarial: durable delivery never regains polling, cooldown sleeps, or volatile retry backoff", async () => {
  const source = await Bun.file(new URL("../src/dispatcher.ts", import.meta.url)).text();
  for (const forbidden of ["setInterval(", "Bun.sleep(", "backoffBaseMs", "backoffCapMs", "repairIntervalMs"]) {
    expect(source).not.toContain(forbidden);
  }
});
