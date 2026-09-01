// Behavioral-pin lane: a restarted daemon must not report green until its
// persistent tmux server has both lifecycle witnesses installed and read back.
import { expect, test } from 'bun:test';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

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
    after_kill_pane: true,
    window_unlinked: true,
  });
});
