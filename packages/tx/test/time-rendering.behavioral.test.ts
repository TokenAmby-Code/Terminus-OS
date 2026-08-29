// Human-facing instant conversion — behavioral-pin lane.

import { expect, test } from 'bun:test';
import { runCli, type CliDependencies } from '../src/cli.ts';

test('UTC-stored listener instants render as exact MST wall time in tx health', async () => {
  const stdout: string[] = [];
  const response = {
    ok: true,
    probes: [{
      name: 'journal-listener',
      evidence: {
        registeredAt: '2026-08-29T03:05:00.000Z',
        lastNotificationAt: '2026-08-29T03:15:30Z',
      },
    }],
  };
  const deps = {
    request: async () => response,
    stdout: (line: string) => stdout.push(line),
    stderr: () => {},
    observation: { health: async () => response, inspect: async () => response } as never,
    timezone: async () => 'America/Phoenix',
  } as CliDependencies;

  expect(await runCli(['health'], deps)).toBe(0);
  expect(stdout.join('\n')).toContain('2026-08-28 20:05:00 MST');
  expect(stdout.join('\n')).toContain('2026-08-28 20:15:30 MST');
  expect(stdout.join('\n')).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
});

test('tx inspect and subcommand documents share the same instant formatter', async () => {
  const response = { recorded_at: '2026-08-29T03:05:00.000Z' };
  for (const argv of [['inspect'], ['estate', 'show']]) {
    const stdout: string[] = [];
    const deps = {
      request: async () => response,
      stdout: (line: string) => stdout.push(line),
      stderr: () => {},
      observation: { health: async () => response, inspect: async () => response } as never,
      timezone: async () => 'America/Phoenix',
    } as CliDependencies;
    expect(await runCli(argv, deps)).toBe(0);
    expect(stdout.join('\n')).toContain('2026-08-28 20:05:00 MST');
    expect(stdout.join('\n')).not.toContain('2026-08-29T03:05:00.000Z');
  }
});

test('tx transport refusals cannot leak embedded ISO-Z instants to stderr', async () => {
  const stderr: string[] = [];
  const deps = {
    request: async () => { throw new Error('refused at 2026-08-29T03:05:00.000Z'); },
    stdout: () => {},
    stderr: (line: string) => stderr.push(line),
    timezone: async () => 'America/Phoenix',
  } as CliDependencies;

  expect(await runCli(['estate', 'show'], deps)).toBe(1);
  expect(stderr).toEqual(['tx: refused at 2026-08-28 20:05:00 MST']);
});
