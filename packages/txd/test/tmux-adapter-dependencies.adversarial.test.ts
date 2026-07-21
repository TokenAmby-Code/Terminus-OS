// Adversarial lane: forbidden transports and command-evaluation paths stay below neither adapter nor routes.
import { expect, test } from 'bun:test';
import { buildRoutes } from '../src/server.ts';

const source = await Bun.file(new URL('../src/tmux.ts', import.meta.url)).text();

test('tmux adapter has one private argument-array binary runner and no alternate transport', () => {
  expect(source.match(/Bun\.spawn\(/g)).toHaveLength(1);
  expect(source).toContain("Bun.spawn(['tmux', '-L', socket, ...args]");
  expect(source).not.toMatch(/Bun\.\$|spawnSync|execFile|exec\(|shell\s*:|\bfetch\s*\(|https?:\/\/|edge_proxy|tmuxctld|\['tx'|\"tx\"/);
  expect(source).not.toMatch(/export\s+(?:async\s+)?function\s+(?:run|execute|command)/);
});

test('attach and reconnect are not mutation or arbitrary-command routes', () => {
  const routes = buildRoutes({} as never, { version: 'test', git_sha: 'test', bun: 'test' }, 'test');
  const labels = routes.map((route) => route.label);
  expect(labels.some((label) => /attach|reconnect|command|exec/i.test(label))).toBe(false);
  expect(routes.some((route) => route.match('/tmux/attach') !== null)).toBe(false);
  expect(routes.some((route) => route.match('/tmux/reconnect') !== null)).toBe(false);
});
