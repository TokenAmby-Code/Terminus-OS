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
  expect(await tmux.reapSeat('palace:N')).toBe(false);

  expect(audits.map(({ operation, target, outcome, stderr_category }) => ({ operation, target, outcome, stderr_category }))).toEqual([
    { operation: 'observe_seats', target: 'estate', outcome: 'succeeded', stderr_category: 'none' },
    { operation: 'resolve_seat', target: 'palace:N', outcome: 'succeeded', stderr_category: 'none' },
    { operation: 'reap_seat', target: 'palace:N', outcome: 'failed', stderr_category: 'not_found' },
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
      return { code: 0, stdout: '', stderr: '' };
    },
    audit: () => {},
  });
  expect(await tmux.resetSeat('palace:N')).toBe(true);
  expect(operations).toEqual(['list-panes', 'clear-history', 'respawn-pane', 'display-message']);
});
