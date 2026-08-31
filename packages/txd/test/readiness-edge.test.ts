// txd's readiness edge — behavioral-pin lane.
//
// The datagram is pinned where it lives (stc-contract) and the unit's
// notify shape in systemd-unit.test.ts. What is left is txd's own half: which
// edge it calls ready.
import { describe, expect, test } from 'bun:test';

const daemon = await Bun.file(new URL('../src/daemon.ts', import.meta.url).pathname).text();

describe('txd readiness edge', () => {
  test('signals once the control plane is serving, never at fork', () => {
    const listening = daemon.indexOf("event: 'listening'");
    const signal = daemon.indexOf("notifySystemd('ready')");
    expect(listening).toBeGreaterThan(-1);
    expect(signal).toBeGreaterThan(listening);
    expect(daemon.slice(0, listening)).not.toContain("notifySystemd('ready')");
    expect(daemon.match(/notifySystemd\('ready'\)/g)).toHaveLength(1);
  });

  // Standing the estate reconciles external tmux state. Gating txd's own
  // readiness on it would make a wedged estate able to hold the control plane
  // down — and /health is the surface that says the estate is what is
  // wrong, so it has to be answering precisely then.
  test('availability is not hostage to the estate rung', () => {
    const signal = daemon.indexOf("notifySystemd('ready')");
    const estate = daemon.indexOf('constructEstateAtBoot()');
    expect(estate).toBeGreaterThan(-1);
    // An absent signal would satisfy `signal < estate` for the wrong reason.
    expect(signal).toBeGreaterThan(-1);
    expect(signal).toBeLessThan(estate);
  });

  test('readiness is an edge, never a timer', () => {
    const boot = daemon.slice(0, daemon.indexOf('async function shutdown'));
    expect(boot).not.toMatch(/setTimeout|setInterval|Bun\.sleep/);
  });

  test('announces the stopping phase before cleanup begins', () => {
    const shutdown = daemon.indexOf('async function shutdown');
    const stopping = daemon.indexOf("notifySystemd('stopping')", shutdown);
    const serverStop = daemon.indexOf('server.stop()', shutdown);
    expect(shutdown).toBeGreaterThan(-1);
    expect(stopping).toBeGreaterThan(shutdown);
    expect(stopping).toBeLessThan(serverStop);
  });
});
