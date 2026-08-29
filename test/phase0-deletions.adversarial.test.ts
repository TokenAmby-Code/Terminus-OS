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
