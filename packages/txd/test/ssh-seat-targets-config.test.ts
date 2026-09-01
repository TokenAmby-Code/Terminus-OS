// Behavioral-pin lane: remote placement is one validated daemon configuration,
// shared by launch composition, placement attestation, and zombie inventory.

import { expect, test } from 'bun:test';
import { assertConfig } from '../src/config.ts';

const base = {
  machine: 'k12-personal',
  agentWrapper: '/fleet/agent-wrapper',
};

test('default configuration preserves the current k12-work placement generation', () => {
  const config = assertConfig(base);
  expect(config.sshSeatTargets.targetFor('somnium:NE')).toBe('k12-work');
  expect(config.sshSeatTargets.targetFor('somnium_fleet:worker-id')).toBe('k12-work');
  expect(config.sshSeatTargets.targetFor('council:pax')).toBe('k12-work');
  expect(config.sshSeatTargets.targetFor('palace:S')).toBeUndefined();
});

test('the adopter supplies its public schema without changing the machine endpoint shape', () => {
  const config = assertConfig({
    ...base,
    db: {
      kind: 'socket',
      socket_dir: '/var/run/postgresql',
      database: 'terminus',
      application_name: 'txd',
      max: 1,
    },
  });
  expect(config.db.schema).toBe('public');
});

test('config selects remote targets by page and by exact attended seat', () => {
  const config = assertConfig({
    ...base,
    sshSeatTargets: {
      pages: { somnium: 'k12-work', somnium_fleet: 'k12-work' },
      seats: {
        'council:pax': 'k12-work',
        'council:orchestrator': 'k12-work',
        'palace:S': 'wsl',
      },
    },
  });

  expect(config.sshSeatTargets.targetFor('somnium:NE')).toBe('k12-work');
  expect(config.sshSeatTargets.targetFor('somnium_fleet:worker-id')).toBe('k12-work');
  expect(config.sshSeatTargets.targetFor('palace:S')).toBe('wsl');
  expect(config.sshSeatTargets.targetFor('palace:N')).toBeUndefined();
  expect(config.sshSeatTargets.targets).toEqual(['k12-work', 'wsl']);
});

test('config refuses unknown pages and seats', () => {
  expect(() => assertConfig({
    ...base,
    sshSeatTargets: { pages: { cockpit: 'wsl' }, seats: {} },
  })).toThrow('sshSeatTargets.pages contains unknown page cockpit');

  expect(() => assertConfig({
    ...base,
    sshSeatTargets: { pages: {}, seats: { 'palace:attended': 'wsl' } },
  })).toThrow('sshSeatTargets.seats contains unknown canonical seat palace:attended');
});

test('config refuses ambiguous page and exact-seat selectors', () => {
  expect(() => assertConfig({
    ...base,
    sshSeatTargets: {
      pages: { palace: 'k12-work' },
      seats: { 'palace:S': 'wsl' },
    },
  })).toThrow('sshSeatTargets selects palace:S by both page and seat');
});

test('config refuses exact selectors for dynamic stack seats', () => {
  expect(() => assertConfig({
    ...base,
    sshSeatTargets: {
      pages: {},
      seats: { 'somnium_fleet:new': 'k12-work' },
    },
  })).toThrow('sshSeatTargets.seats must select stack page somnium_fleet by page');
});
