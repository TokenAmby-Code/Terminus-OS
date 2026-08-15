// Adversarial lane: the engine-session leg of registration is dead
// (Emperor ruling 2026-07-31: tint at wrapper placement, not engine start).
//
// txd binds, tints, and attests placement on `agent.physical_declared`. There
// is no `hook.session_start` consumption, no engine-process attestation, and
// no engine identity in the placement or agent contracts. This lane fails
// loud if any of it grows back.

import { describe, expect, test } from 'bun:test';
import { AgentSchema, PlacementAttestedSchema } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux, RealTmux } from '../src/tmux.ts';
import { buildRoutes } from '../src/server.ts';

describe('adversarial: the session_start registration leg stays dead', () => {
  test('txd does not consume hook.session_start', () => {
    const daemon = new Daemon(new MemoryEventStore(), new FakeTmux());
    const routes = buildRoutes(daemon, { version: 'test', git_sha: 'test', bun: 'test' }, 'test');
    expect(routes.every((route) => route.match('/ingress/hooks/session_start') === null)).toBeTrue();
  });

  test('the daemon has no engine-session attestation', () => {
    expect((Daemon.prototype as unknown as Record<string, unknown>)['attestEngineSession']).toBeUndefined();
  });

  test('the tmux control plane has no engine-process attestation', () => {
    expect((FakeTmux.prototype as unknown as Record<string, unknown>)['attestEnginePlacement']).toBeUndefined();
    expect((RealTmux.prototype as unknown as Record<string, unknown>)['attestEnginePlacement']).toBeUndefined();
  });

  test('placement attests no engine process', () => {
    const shape = PlacementAttestedSchema.shape as Record<string, unknown>;
    expect(shape['engine_pid']).toBeUndefined();
    expect(shape['engine_binary']).toBeUndefined();
    expect(shape['cwd']).toBeUndefined();
  });

  test('the agent record carries no engine-process identity', () => {
    const launch = AgentSchema.shape.launch.shape as Record<string, unknown>;
    expect(launch['engine_binary']).toBeUndefined();
    const placement = AgentSchema.shape.placement.shape as Record<string, unknown>;
    expect(placement['engine_pid']).toBeUndefined();
    expect(placement['cwd']).toBeUndefined();
  });
});
