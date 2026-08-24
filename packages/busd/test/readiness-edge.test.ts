// busd's readiness edge — behavioral-pin lane.
//
// The datagram is pinned where it lives (@terminus-os/systemd) and the unit's
// notify shape in systemd-unit.test.ts. What is left is busd's own half: that
// it signals at the edge it claims — the bus bound and both dispatchers
// scheduling, not fork.
import { describe, expect, test } from 'bun:test';

const daemon = await Bun.file(new URL('../src/daemon.ts', import.meta.url).pathname).text();

describe('busd readiness edge', () => {
  test('signals at the listen edge, after the server is serving', () => {
    const listening = daemon.indexOf("event: 'listening'");
    const signal = daemon.indexOf('notifyReady()');
    expect(listening).toBeGreaterThan(-1);
    expect(signal).toBeGreaterThan(listening);
  });

  test('readiness is an edge, never a timer', () => {
    // A delay before the signal would be a magic number standing in for the
    // real edge, and the edge is already in hand.
    expect(daemon).not.toMatch(/setTimeout|setInterval|Bun\.sleep/);
  });
});
