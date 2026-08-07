// Adversarial lane: Phase 0's false event paths must stay absent.

import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

test('adversarial: the retired production deployment workflow stays absent', () => {
  expect(existsSync(join(root, '.github/workflows/deploy-production.yml'))).toBeFalse();
});

test('adversarial: desktop telemetry has no private NOTIFY channel', async () => {
  const migration = await Bun.file(join(root, 'packages/db/migrations/0003_desktop_telemetry.sql')).text();
  expect(migration).not.toContain('desktop_events_publish');
  expect(migration).not.toContain('publish_desktop_event');
  expect(migration).not.toContain("pg_notify('desktop_telemetry'");
});

test('adversarial: Phase 0 erases every named false subscription row', async () => {
  const migration = await Bun.file(join(root, 'packages/db/migrations/0015_event_phase_zero_cleanup.sql')).text();
  for (const name of [
    'daily-note-create-work',
    'deployment-personal-github-push',
    'deployment-work-github-push',
    'githubd-deployment',
    'githubd-fleet',
    'githubd-work-battlefield',
    'githubd-work-coderabbit',
    'githubd-work-deployment',
    'githubd-work-github',
    'githubd-work-policy',
    'probe',
    'txd-k12-personal-hook-session-start',
  ]) {
    expect(migration).toContain(`'${name}'`);
  }
  expect(migration).toContain('DELETE FROM bus.subscriptions');
  expect(migration).toMatch(/DROP CONSTRAINT(?: IF EXISTS)? delivery_attempts_subscription_name_fkey/);
});
