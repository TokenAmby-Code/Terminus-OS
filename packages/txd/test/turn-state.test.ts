import { expect, test } from 'bun:test';
import { TURN_STATES } from '@terminus-os/contracts';

// The axis folded from act.prompt_submitted / act.stop_reported / reg.retired
// reports TURN STATE. It has never been positioned to report liveness: nothing
// in that fold observes a process.
//
// Under the old names it read as liveness to every consumer, and both of its
// commonest values meant roughly the opposite of what they said. `stopped` was
// not dead — it was "finished a turn, awaiting input", the normal resting state
// of every healthy agent. `idle` was not alive-and-waiting — it was "no turn
// fact has ever been observed". tx close consumed both as permission to close,
// so any healthy agent between turns was a valid target.
test('the turn axis names what it folds and never spells a liveness word', () => {
  expect([...TURN_STATES].sort()).toEqual(['awaiting_input', 'retired', 'unobserved', 'working']);
});

// `stopped` and `idle` stay dead as turn-state values. A liveness-sounding name
// on a fold that observes no process is what let a working agent be reaped.
test('the misleading turn-state names stay dead', async () => {
  const contracts = await Bun.file(new URL('../../contracts/src/txd.ts', import.meta.url)).text();
  const block = contracts.slice(contracts.indexOf('TURN_STATES'), contracts.indexOf('TURN_STATES') + 200);
  expect(block).not.toInclude("'stopped'");
  expect(block).not.toInclude("'idle'");

  const projections = await Bun.file(new URL('../src/projections.ts', import.meta.url)).text();
  expect(projections).toInclude("'awaiting_input'");
  expect(projections).toInclude("'unobserved'");
});
