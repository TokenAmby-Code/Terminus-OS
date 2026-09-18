import { afterEach, expect, test } from "bun:test";
import { makeServer } from "../src/server.ts";
import type { TelemetryStore } from "../src/store.ts";
import type { Observation, ObservationStore, ObservedProbeReading } from "@tokenamby-code/stc-contract/observation";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const servers: ReturnType<typeof makeServer>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

class MemoryObservationStore implements ObservationStore {
  async recordWalk(_readings: ObservedProbeReading[]): Promise<void> {}
}
function serve(postgres: Observation): string {
  const store: TelemetryStore = {
    async record() { return true; },
    async recordPhoneHook() {},
    async observePostgres() { return postgres; },
    async close() {},
  };
  const server = makeServer({ store, observationStore: new MemoryObservationStore(), build: { version: "test", git_sha: "abc", bun: Bun.version }, port: 0 });
  servers.push(server);
  return `http://${server.hostname}:${server.port}`;
}
// Spawned asynchronously: the daemon it reads is served by THIS process, so a
// synchronous spawn would block the loop the server answers on.
async function tm(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", cli, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out.trim(), err: err.trim() };
}

test("tm version names the identity and the executing STC package, touching no daemon", async () => {
  const result = await tm(["version"], { TM_URL: "http://127.0.0.1:1" });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toEqual({ service: "telemetryd", daemon: "telemetryd", cli: "tm", version: "0.1.0", stc_version: "1.7.1" });
});

test("tm health exits with the health report's four-verdict code", async () => {
  const green = await tm(["health"], { TM_URL: serve({ state: "ready", evidence: { select_1: 1 } }) });
  expect(green.code).toBe(0);
  expect(JSON.parse(green.out)).toMatchObject({ ok: true, verdict: "OK", code: 0, serving: true });
  const critical = await tm(["health"], { TM_URL: serve({ state: "failed", detail: "postgres down" }) });
  expect(critical.code).toBe(2);
  expect(JSON.parse(critical.out)).toMatchObject({ ok: false, verdict: "CRITICAL", code: 2, serving: false });
  const unknown = await tm(["health"], { TM_URL: serve({ state: "undetermined", detail: "observation unavailable" }) });
  expect(unknown.code).toBe(3);
  expect(JSON.parse(unknown.out)).toMatchObject({ ok: false, verdict: "UNKNOWN", code: 3, serving: false });
});

test("tm inspect prints quantities with no verdict", async () => {
  const result = await tm(["inspect"], { TM_URL: serve({ state: "ready" }) });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).not.toHaveProperty("ok");
});

test("tm refuses anything else with usage and exit 64", async () => {
  for (const args of [[], ["health", "extra"], ["event"]]) {
    const result = await tm(args);
    expect(result.code).toBe(64);
    expect(result.err).toContain("usage: tm <health|inspect|version>");
  }
});
