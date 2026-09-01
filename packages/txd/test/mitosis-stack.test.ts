// Behavioral pins for mitosis pages: topology is flexible, identity is not.

import { expect, test } from 'bun:test';
import { RealTmux, type TmuxCommandResult } from '../src/tmux.ts';

test('opening a mitosis pane invokes the built-in tiled rebalancer exactly once', async () => {
  const calls: string[][] = [];
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'show-options') return { code: 0, stdout: 'off\n', stderr: '' };
    if (args[0] === 'set-environment') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'split-window') return { code: 0, stdout: '%41\n', stderr: '' };
    if (args[0] === 'set-option') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'list-panes') return { code: 0, stdout: '%41\tpalace_fleet:worker-1\n', stderr: '' };
    if (args[0] === 'select-layout') return { code: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected tmux call: ${args[0]}`);
  };
  const tmux = new RealTmux('scratch', { run });

  await tmux.createStackSeat('palace_fleet', 'palace_fleet:worker-1');

  expect(calls.filter((args) => args[0] === 'select-layout')).toEqual([
    ['select-layout', '-t', 'main:=palace_fleet', 'tiled'],
  ]);
});

test('closing a mitosis pane is wired to one built-in tiled rebalance hook', async () => {
  const installedByHook = new Map<string, string>();
  const tmux = new RealTmux('scratch', {
    run: async (_socket, args) => {
      if (args[0] === 'set-hook') {
        installedByHook.set(args.at(-2)!, args.at(-1)!);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'show-hooks') {
        const hook = args.at(-1)!;
        return { code: 0, stdout: `${hook}[0] ${installedByHook.get(hook) ?? ''}\n`, stderr: '' };
      }
      throw new Error(`unexpected command ${args[0]}`);
    },
    audit: () => {},
  });
  await tmux.ensureLifecycleHooks();
  const rebalancers = [...installedByHook.entries()].filter(([, command]) =>
    command.includes('select-layout') && command.includes('tiled'),
  );
  expect(rebalancers.map(([hook]) => hook)).toEqual(['after-kill-pane']);
});
