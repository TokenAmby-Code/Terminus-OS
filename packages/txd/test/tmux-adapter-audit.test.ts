// Behavioral-pin lane: every real tmux operation crosses one sanitized audit boundary.
import { expect, test } from 'bun:test';
import { RealTmux, type TmuxAuditRecord, type TmuxCommandResult } from '../src/tmux.ts';

test('adapter emits sanitized structured audit records without arguments or raw tmux ids', async () => {
  const audits: TmuxAuditRecord[] = [];
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    if (args[0] === 'list-panes' && args.at(-1)?.includes('pane_dead')) return { code: 0, stdout: 'palace:N\t0\n', stderr: '' };
    if (args[0] === 'list-panes') return { code: 0, stdout: '%17\tpalace:N\n', stderr: '' };
    return { code: 1, stdout: '', stderr: 'pane %17 is missing from session $4' };
  };
  const tmux = new RealTmux('scratch', { run, audit: (record) => audits.push(record) });

  expect(await tmux.listSeats()).toEqual([{ seat_id: 'palace:N', pane: 'live' }]);
  expect(await tmux.reapSeat('palace:N', null)).toBe(false);

  expect(audits.map(({ operation, target, outcome, stderr_category }) => ({ operation, target, outcome, stderr_category }))).toEqual([
    { operation: 'observe_seats', target: 'estate', outcome: 'succeeded', stderr_category: 'none' },
    { operation: 'resolve_seat', target: 'palace:N', outcome: 'succeeded', stderr_category: 'none' },
    { operation: 'observe_default_shell', target: 'palace:N', outcome: 'failed', stderr_category: 'not_found' },
  ]);
  for (const record of audits) {
    expect(Object.keys(record).sort()).toEqual(['duration_ms', 'operation', 'outcome', 'stderr_category', 'target']);
    expect(record.duration_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(record)).not.toMatch(/[%@$]\d+/);
    expect(JSON.stringify(record)).not.toContain('list-panes');
    expect(JSON.stringify(record)).not.toContain('respawn-pane');
  }
});

test('adapter failures expose only a stderr category', async () => {
  const tmux = new RealTmux('scratch', {
    run: async () => ({ code: 1, stdout: '', stderr: 'permission denied for pane %91 in $2' }),
    audit: () => {},
  });
  await expect(tmux.ensureEstate()).rejects.toThrow('tmux server is not externally owned');
  await expect(tmux.ensureEstate()).rejects.not.toThrow(/%91|\$2|permission denied/);
});

test('lifecycle hook commands shell-quote the tmux-supplied page name', async () => {
  const installed: string[] = [];
  const installedByHook = new Map<string, string>();
  const tmux = new RealTmux('scratch', {
    run: async (_socket, args) => {
      if (args[0] === 'set-hook') {
        installed.push(args.at(-1)!);
        installedByHook.set(args.at(-2)!, args.at(-1)!);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'show-hooks') {
        return { code: 0, stdout: `${args.at(-1)}[0] ${installedByHook.get(args.at(-1)!) ?? ''}\n`, stderr: '' };
      }
      throw new Error(`unexpected command ${args[0]}`);
    },
    audit: () => {},
  });

  await tmux.ensureLifecycleHooks();
  expect(installed).toHaveLength(4);
  for (const [hook, command] of installedByHook) {
    // `tx inspect hooks` reads the txd-tmux-hook journal identifier, so every
    // installed witness captures through systemd-cat's exec form — the journal
    // keeps the diagnostics AND a failed death ingress keeps its non-zero
    // exit. The Bash tx launcher is executed directly, never handed to bun,
    // and no `|| true` may convert a failed ingress into success.
    expect(command).toContain('systemd-cat --identifier=txd-tmux-hook $HOME/.local/bin/tx estate event');
    expect(command).not.toContain('bun');
    expect(command).not.toContain('|| true');
    if (hook === 'pane-died' || hook === 'pane-exited') {
      expect(command).toContain('#{q:window_name}');
      expect(command).not.toContain('\\"#{window_name}\\"');
    }
  }
});

test('scoped reset clears history, replaces the process, and verifies the canonical pane tag', async () => {
  const operations: string[] = [];
  const calls: string[][] = [];
  const tmux = new RealTmux('scratch', {
    run: async (_socket, args) => {
      operations.push(args[0]!);
      calls.push(args);
      if (args[0] === 'list-panes') return { code: 0, stdout: '%17\tpalace:N\n', stderr: '' };
      if (args[0] === 'display-message') return { code: 0, stdout: 'palace:N\n', stderr: '' };
      if (args[0] === 'show-options') {
        return { code: 0, stdout: args.at(-1) === 'default-shell' ? '/bin/bash\n' : '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    audit: () => {},
  });
  expect(await tmux.resetSeat('palace:N')).toBe(true);
  expect(operations).toEqual([
    'list-panes', 'show-options', 'clear-history', 'set-environment', 'respawn-pane', 'set-option', 'display-message',
    'list-panes', 'set-option', 'set-option', 'list-panes', 'show-options', 'show-options',
  ]);
  // The replacement process is a new pane lifecycle: the reset mints a fresh
  // @txd_generation so nothing fenced to the corpse generation can land on it.
  expect(calls.find((args) => args[0] === 'set-option' && args.includes('@txd_generation'))).toBeDefined();
  expect(calls.find((args) => args[0] === 'set-environment')).toEqual([
    'set-environment', '-u', '-t', '%17', 'AGENT_ID',
  ]);
  expect(calls.find((args) => args[0] === 'respawn-pane')).toContain('AGENT_ID');
});

test('persona tint writes both pane-local styles without selecting the pane and accepts only exact read-back', async () => {
  let tint = 'default';
  const calls: string[][] = [];
  const tmux = new RealTmux('scratch', {
    run: async (_socket, args) => {
      calls.push(args);
      if (args[0] === 'list-panes') return { code: 0, stdout: '%17\tpalace:N\n', stderr: '' };
      if (args[0] === 'set-option') {
        tint = args.at(-1) ?? '';
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'show-options') return { code: 0, stdout: `${tint}\n`, stderr: '' };
      throw new Error(`unexpected command ${args[0]}`);
    },
    audit: () => {},
  });

  expect(await tmux.setSeatTint('palace:N', '#302800')).toBe(true);
  expect(await tmux.seatTint('palace:N')).toBe('#302800');
  expect(await tmux.setSeatTint('palace:N', null)).toBe(true);
  expect(await tmux.seatTint('palace:N')).toBeNull();
  expect(calls.some((args) => args[0] === 'select-pane')).toBe(false);
  expect(calls.filter((args) => args[0] === 'set-option')).toEqual([
    ['set-option', '-p', '-t', '%17', 'window-style', 'bg=#302800'],
    ['set-option', '-p', '-t', '%17', 'window-active-style', 'bg=#302800'],
    ['set-option', '-p', '-t', '%17', 'window-style', 'default'],
    ['set-option', '-p', '-t', '%17', 'window-active-style', 'default'],
  ]);
});

test('absent pane-local style options attest an untinted seat', async () => {
  const tmux = new RealTmux('scratch', {
    run: async (_socket, args) => {
      if (args[0] === 'list-panes') return { code: 0, stdout: '%17\tpalace:N\n', stderr: '' };
      if (args[0] === 'show-options') return { code: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected command ${args[0]}`);
    },
    audit: () => {},
  });

  expect(await tmux.seatTint('palace:N')).toBeNull();
});

test('failed reap restores the exact observed pane styles when the caller omits a prior tint', async () => {
  const styles = new Map([
    ['window-style', 'fg=#c0ffee'],
    ['window-active-style', 'bg=#302800,italics'],
  ]);
  const tmux = new RealTmux('scratch', {
    run: async (_socket, args) => {
      if (args[0] === 'list-panes') return { code: 0, stdout: '%17\tpalace:N\n', stderr: '' };
      if (args[0] === 'show-options') {
        return { code: 0, stdout: `${styles.get(args.at(-1)!) ?? ''}\n`, stderr: '' };
      }
      if (args[0] === 'set-option') {
        styles.set('window-style', args.at(-1) ?? '');
        styles.set('window-active-style', args.at(-1) ?? '');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'set-option') {
        styles.set(args.at(-2)!, args.at(-1) ?? '');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'respawn-pane') return { code: 1, stdout: '', stderr: 'forced failure' };
      throw new Error(`unexpected command ${args[0]}`);
    },
    audit: () => {},
  });

  expect(await tmux.reapSeat('palace:N')).toBe(false);
  expect(Object.fromEntries(styles)).toEqual({
    'window-style': 'fg=#c0ffee',
    'window-active-style': 'bg=#302800,italics',
  });
});
