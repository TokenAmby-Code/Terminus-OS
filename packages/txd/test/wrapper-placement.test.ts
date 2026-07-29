import { expect, test } from 'bun:test';
import { RealTmux, type TmuxCommandResult } from '../src/tmux.ts';

const GENERATION = '786b72b2-58d5-4294-8f95-928289984d6f';

function observer(paneRootPid: number): RealTmux {
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    if (args[0] !== 'list-panes') throw new Error(`unexpected tmux call: ${args[0]}`);
    return {
      code: 0,
      stdout: `palace:W\t${paneRootPid}\t0\t${GENERATION}\n`,
      stderr: '',
    };
  };
  return new RealTmux('disposable', { run, audit: () => undefined });
}

test('an exec wrapper is attested when the wrapper is the pane root process', async () => {
  const attestation = await observer(process.pid).attestWrapperPlacement(process.pid);
  expect(attestation).toMatchObject({
    ok: true,
    pane_id: 'palace:W',
    pane_generation: GENERATION,
    wrapper_pid: process.pid,
    pane_root_pid: process.pid,
  });
});

test('a manually launched wrapper is attested beneath the pane shell ancestry', async () => {
  const child = Bun.spawn(['/usr/bin/sleep', '30']);
  try {
    const attestation = await observer(process.pid).attestWrapperPlacement(child.pid);
    expect(attestation).toMatchObject({
      ok: true,
      pane_id: 'palace:W',
      pane_generation: GENERATION,
      wrapper_pid: child.pid,
      pane_root_pid: process.pid,
    });
    expect(attestation.ok && attestation.ancestry.slice(0, 2)).toEqual([child.pid, process.pid]);
  } finally {
    child.kill();
    await child.exited;
  }
});

test('a live wrapper without a managed tmux ancestor is refused', async () => {
  const attestation = await observer(999_999_999).attestWrapperPlacement(process.pid);
  expect(attestation).toEqual({ ok: false, reason: 'wrapper_not_in_managed_pane' });
});
