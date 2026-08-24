// telemetryd's readiness edge — behavioral-pin lane.
//
// telemetryd exited moments after a green `systemctl restart` on 2026-08-24:
// under Type=simple that return proved a process was forked and nothing more.
// These pin the edge that makes the return mean something.
import { describe, expect, test } from "bun:test";

const daemon = await Bun.file(new URL("../src/daemon.ts", import.meta.url).pathname).text();

describe("telemetryd readiness edge", () => {
  test("signals after the ingress is serving, never before", () => {
    const listening = daemon.indexOf('event: "listening"');
    const signal = daemon.indexOf("notifyReady()");
    expect(listening).toBeGreaterThan(-1);
    expect(signal).toBeGreaterThan(listening);
  });

  test("readiness is an edge, never a timer", () => {
    // A delay before the signal would be a magic number standing in for the
    // real edge, and the edge is already in hand.
    expect(daemon).not.toMatch(/setTimeout|setInterval|Bun\.sleep/);
  });
});
