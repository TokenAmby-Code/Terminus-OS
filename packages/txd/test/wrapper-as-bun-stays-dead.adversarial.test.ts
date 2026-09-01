// Adversarial lane: the wrapper-as-Bun hook invocation stays dead.
//
// Live regression (k12-personal, 2026-08-31): every installed lifecycle hook
// spelled `~/.bun/bin/bun ~/.local/bin/tx …` — but the stamped `tx` launcher
// is a Bash wrapper, so Bun parsed `set -euo pipefail` as JavaScript and every
// pane-death ingress died at the hook while `|| true` reported success. The
// somnium:S corpse sat unretired with its agent still projected bound.
//
// The stamped tx executable contract: hooks invoke the launcher DIRECTLY (its
// shebang and stamped environment are the contract), capture through
// systemd-cat's exec form so the journal keeps the diagnostics AND a failed
// ingress keeps its non-zero exit. No `bun <wrapper>`, no `|| true`, in any
// generated or static hook source.

import { expect, test } from 'bun:test';
import { RealTmux, type TmuxCommandResult } from '../src/tmux.ts';

const LIFECYCLE_HOOKS = ['pane-died', 'pane-exited', 'after-kill-pane', 'window-unlinked'] as const;

function installingTmux(installedByHook: Map<string, string>) {
  return new RealTmux('scratch', {
    run: async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
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
}

test('no generated lifecycle hook invokes the Bash tx launcher through bun or swallows its failure', async () => {
  const installedByHook = new Map<string, string>();
  await installingTmux(installedByHook).ensureLifecycleHooks();

  expect([...installedByHook.keys()].sort()).toEqual([...LIFECYCLE_HOOKS].sort());
  for (const [hook, command] of installedByHook) {
    // The launcher is executed as itself — never handed to bun as source.
    expect(command).toContain('systemd-cat --identifier=txd-tmux-hook $HOME/.local/bin/tx estate event');
    expect(command).not.toContain('bun');
    expect(command).not.toContain('|| true');
    expect(command).not.toContain('2>&1 |');
    if (hook === 'pane-died' || hook === 'pane-exited') {
      expect(command).toContain(`tx estate event ${hook} page=#{q:window_name}`);
    } else {
      expect(command).toContain('tx estate event pane-killed');
      expect(command).not.toContain('page=');
    }
  }
});

test('hook attestation refuses a server still carrying the buried wrapper-as-Bun spelling', async () => {
  const buried = new Map<string, string>([
    ['pane-died', 'run-shell -b "$HOME/.bun/bin/bun $HOME/.local/bin/tx estate event pane-died page=#{q:window_name} 2>&1 | systemd-cat --identifier=txd-tmux-hook || true"'],
    ['pane-exited', 'run-shell -b "$HOME/.bun/bin/bun $HOME/.local/bin/tx estate event pane-exited page=#{q:window_name} 2>&1 | systemd-cat --identifier=txd-tmux-hook || true"'],
    ['after-kill-pane', 'run-shell -b "$HOME/.bun/bin/bun $HOME/.local/bin/tx estate event pane-killed 2>&1 | systemd-cat --identifier=txd-tmux-hook || true"'],
    ['window-unlinked', 'run-shell -b "$HOME/.bun/bin/bun $HOME/.local/bin/tx estate event pane-killed 2>&1 | systemd-cat --identifier=txd-tmux-hook || true"'],
  ]);
  const tmux = new RealTmux('scratch', {
    run: async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
      if (args[0] === 'show-hooks') {
        const hook = args.at(-1)!;
        return { code: 0, stdout: `${hook}[0] ${buried.get(hook) ?? ''}\n`, stderr: '' };
      }
      throw new Error(`unexpected command ${args[0]}`);
    },
    audit: () => {},
  });

  const readiness = await tmux.lifecycleHookReadiness();
  expect(readiness.state).toBe('degraded');
  expect(readiness.pane_died).toBe(false);
  expect(readiness.pane_exited).toBe(false);
});

test('tx.conf carries no lifecycle-hook installation and no bun-invoked tx launcher', async () => {
  const conf = await Bun.file(new URL('../tmux/tx.conf', import.meta.url).pathname).text();
  // txd exclusively owns the four lifecycle witnesses; a config reload must
  // never be able to replace an attested witness with a stale spelling.
  for (const hook of LIFECYCLE_HOOKS) expect(conf).not.toContain(`set-hook -g ${hook}`);
  expect(conf).not.toContain('tx estate event');
  // The Bash launcher is never handed to bun anywhere in the static config.
  expect(conf).not.toContain('bun $HOME/.local/bin/tx');
  expect(conf).not.toContain('|| true');
});
