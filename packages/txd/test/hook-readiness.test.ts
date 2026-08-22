// Behavioral-pin lane: a restarted daemon must not report green until its
// persistent tmux server has both lifecycle witnesses installed and read back.
import { expect, test } from 'bun:test';
import { Daemon } from '../src/core.ts';
import { buildRoutes } from '../src/server.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const build = { version: 'test', git_sha: 'restart-candidate', bun: Bun.version };

test('daemon restart with stripped tmux hooks stays degraded until boot re-attests them', async () => {
  const tmux = new FakeTmux();
  const first = new Daemon(new MemoryEventStore(), tmux);
  await first.constructEstateAtBoot();
  tmux.stripLifecycleHooks();

  // A new daemon process inherits the persistent tmux server, including its
  // missing hooks. Health is callable before boot convergence completes.
  const restarted = new Daemon(new MemoryEventStore(), tmux);
  const healthRoute = buildRoutes(restarted, build, 'k12-personal')
    .find((route) => route.label === 'GET /ctl/health')!;
  const degraded = await healthRoute.handler(new Request('http://txd/ctl/health'), {});

  expect(degraded.status).toBe(503);
  expect(await degraded.json()).toMatchObject({
    ok: false,
    hooks: {
      state: 'degraded',
      pane_died: false,
      pane_exited: false,
    },
  });

  await restarted.constructEstateAtBoot();

  const ready = await healthRoute.handler(new Request('http://txd/ctl/health'), {});
  expect(ready.status).toBe(200);
  expect(await ready.json()).toMatchObject({
    ok: true,
    hooks: {
      state: 'ready',
      pane_died: true,
      pane_exited: true,
    },
  });
});

test('boot re-attests lifecycle hooks after estate convergence changes them', async () => {
  class HookStrippingEstateTmux extends FakeTmux {
    override async ensureEstate() {
      const estate = await super.ensureEstate();
      this.stripLifecycleHooks();
      return estate;
    }
  }

  const tmux = new HookStrippingEstateTmux();
  const daemon = new Daemon(new MemoryEventStore(), tmux);

  await daemon.constructEstateAtBoot();

  expect(await tmux.lifecycleHookReadiness()).toEqual({
    state: 'ready',
    pane_died: true,
    pane_exited: true,
  });
});
