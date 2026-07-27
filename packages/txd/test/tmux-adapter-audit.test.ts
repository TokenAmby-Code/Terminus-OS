// Behavioral-pin lane: every real tmux operation crosses one sanitized audit boundary.
import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    { operation: 'resolve_seat', target: 'palace:N', outcome: 'succeeded', stderr_category: 'none' },
    { operation: 'set_seat_tint', target: 'palace:N', outcome: 'failed', stderr_category: 'not_found' },
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

test('scoped reset clears history, replaces the process, and verifies the canonical pane tag', async () => {
  const operations: string[] = [];
  const tmux = new RealTmux('scratch', {
    run: async (_socket, args) => {
      operations.push(args[0]!);
      if (args[0] === 'list-panes') return { code: 0, stdout: '%17\tpalace:N\n', stderr: '' };
      if (args[0] === 'display-message') return { code: 0, stdout: 'palace:N\n', stderr: '' };
      if (args[0] === 'show-options') return { code: 0, stdout: 'default\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    audit: () => {},
  });
  expect(await tmux.resetSeat('palace:N')).toBe(true);
  expect(operations).toEqual([
    'list-panes', 'clear-history', 'respawn-pane', 'display-message',
    'list-panes', 'select-pane', 'list-panes', 'show-options', 'show-options',
  ]);
});

test('persona tint writes both pane-local styles and accepts only exact read-back', async () => {
  let tint = 'default';
  const calls: string[][] = [];
  const tmux = new RealTmux('scratch', {
    run: async (_socket, args) => {
      calls.push(args);
      if (args[0] === 'list-panes') return { code: 0, stdout: '%17\tpalace:N\n', stderr: '' };
      if (args[0] === 'select-pane') {
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
  expect(calls.some((args) => args[0] === 'select-pane' && args.at(-1) === 'bg=#302800')).toBe(true);
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
      if (args[0] === 'select-pane') {
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

test('static launch execs the wrapper as the pane process for physical attestation', async () => {
  const calls: string[][] = [];
  const tmux = new RealTmux('scratch', {
    run: async (_socket, args) => {
      calls.push(args);
      if (args[0] === 'list-panes') {
        return { code: 0, stdout: '%17\tcouncil:custodes\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    audit: () => {},
  });

  expect(await tmux.startStaticAgent({
    seatId: 'council:custodes',
    engine: 'claude',
    wrapper: '/fleet/agent-wrapper',
    workspace: '/personas/custodes',
    environment: { TXD_STATIC_LAUNCH_ID: 'launch-1' },
  })).toBe(true);

  expect(calls.at(-1)?.at(-1)).toBe("exec '/fleet/agent-wrapper' claude");
});

test('physical attestation reads live procfs parent and engine identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'txd-attestation-'));
  const engine = join(directory, 'claude');
  copyFileSync('/usr/bin/sleep', engine);
  chmodSync(engine, 0o700);
  const child = Bun.spawn([engine, '600'], { stdout: 'ignore', stderr: 'ignore' });
  try {
    const tmux = new RealTmux('scratch', {
      run: async (_socket, args) => {
        if (args[0] === 'list-panes') {
          return { code: 0, stdout: '%17\tcouncil:custodes\n', stderr: '' };
        }
        if (args[0] === 'display-message') {
          return { code: 0, stdout: `${process.pid}\t0\n`, stderr: '' };
        }
        throw new Error(`unexpected tmux call: ${args[0]}`);
      },
      audit: () => {},
    });

    expect(await tmux.attestStaticAgent('council:custodes', process.pid, child.pid, 'claude', engine)).toBe(true);
  } finally {
    child.kill(9);
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('physical attestation rejects prefix-spoofed engine process names', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'txd-attestation-spoof-'));
  const engine = join(directory, 'claude-rogue');
  copyFileSync('/usr/bin/sleep', engine);
  chmodSync(engine, 0o700);
  const child = Bun.spawn([engine, '600'], { stdout: 'ignore', stderr: 'ignore' });
  try {
    const tmux = new RealTmux('scratch', {
      run: async (_socket, args) => {
        if (args[0] === 'list-panes') return { code: 0, stdout: '%17\tcouncil:custodes\n', stderr: '' };
        if (args[0] === 'display-message') return { code: 0, stdout: `${process.pid}\t0\n`, stderr: '' };
        throw new Error(`unexpected tmux call: ${args[0]}`);
      },
      audit: () => {},
    });

    expect(await tmux.attestStaticAgent('council:custodes', process.pid, child.pid, 'claude', engine)).toBe(false);
  } finally {
    child.kill(9);
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('physical attestation rejects an exact-name rogue executable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'txd-attestation-exe-spoof-'));
  const rogue = join(directory, 'claude');
  copyFileSync('/usr/bin/sleep', rogue);
  chmodSync(rogue, 0o700);
  const child = Bun.spawn([rogue, '600'], { stdout: 'ignore', stderr: 'ignore' });
  try {
    const tmux = new RealTmux('scratch', {
      run: async (_socket, args) => {
        if (args[0] === 'list-panes') return { code: 0, stdout: '%17\tcouncil:custodes\n', stderr: '' };
        if (args[0] === 'display-message') return { code: 0, stdout: `${process.pid}\t0\n`, stderr: '' };
        throw new Error(`unexpected tmux call: ${args[0]}`);
      },
      audit: () => {},
    });

    expect(await tmux.attestStaticAgent(
      'council:custodes',
      process.pid,
      child.pid,
      'claude',
      '/sanctioned/claude',
    )).toBe(false);
  } finally {
    child.kill(9);
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
});
