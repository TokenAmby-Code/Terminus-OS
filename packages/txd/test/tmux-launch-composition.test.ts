// Launch composition is the only place an agent's identity and its orders
// enter the pane. Both travel as shell-quoted argv on the respawn-pane command
// line, so a brief made of backticks, blank lines and `$` arrives at the engine
// byte-for-byte with no second quoting scheme in the way.

import { expect, test } from 'bun:test';
import { RealTmux, type TmuxCommandResult } from '../src/tmux.ts';

function recorder() {
  const calls: string[][] = [];
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, tmux: new RealTmux('scratch', { run }) };
}

const launch = {
  seatId: 'palace:S',
  engine: 'claude' as const,
  wrapper: '/fleet/agent-wrapper',
  agentId: '2ea2d049-0106-4957-8649-31f93bdc8c9a',
  launchNonce: '9f1b1f6a-5d4e-4a0f-9a2b-6c3d4e5f6071',
};

test('orders ride the launch as one shell-quoted argument', async () => {
  const { calls, tmux } = recorder();
  const orders = "Worker E.\n\nRun `rg dispatch` and read $PANE_ID; it's yours.\n";

  expect(await tmux.startSeatEngine({ ...launch, prompt: orders })).toBe(true);

  const respawn = calls.find((args) => args[0] === 'respawn-pane')!;
  const command = respawn.at(-1)!;
  // Single-quoted with every embedded quote broken out: the shell reassembles
  // exactly the bytes handed in, newlines and all.
  expect(command.endsWith(` '${orders.replaceAll("'", "'\"'\"'")}'`)).toBe(true);
  expect(command).toContain("'/fleet/agent-wrapper' 'claude' '");
});

test('a bodiless launch ends at the engine, with no empty argument trailing it', async () => {
  const { calls, tmux } = recorder();

  expect(await tmux.startSeatEngine(launch)).toBe(true);

  const respawn = calls.find((args) => args[0] === 'respawn-pane')!;
  expect(respawn.at(-1)!.endsWith("'/fleet/agent-wrapper' 'claude'")).toBe(true);
});

test('bind stamps AGENT_ID into the pane environment', async () => {
  const { calls, tmux } = recorder();

  expect(await tmux.startSeatEngine(launch)).toBe(true);

  const respawn = calls.find((args) => args[0] === 'respawn-pane')!;
  expect(respawn).toContain(`AGENT_ID=${launch.agentId}`);
});
